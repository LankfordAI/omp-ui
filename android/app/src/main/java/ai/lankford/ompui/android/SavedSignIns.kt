package ai.lankford.ompui.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal sealed interface SignIn {
    val secret: String
    data class Password(override val secret: String) : SignIn
    data class Token(override val secret: String) : SignIn
}

/** Sign-ins for saved hosts, encrypted with a non-exportable Android Keystore key. */
internal class SavedSignIns(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** Null when absent or undecryptable; an undecryptable entry is deleted. Never logs secrets. */
    fun read(origin: String): SignIn? {
        val value = preferences.getString(origin, null) ?: return null
        return try {
            val parts = value.split(':')
            require(parts.size == 3 && parts[0] == "v1")
            val key = keyStore().getKey(ALIAS, null) as SecretKey
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)))
            cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
            val plain = String(cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)), Charsets.UTF_8)
            when {
                plain.startsWith("p:") -> SignIn.Password(plain.substring(2))
                plain.startsWith("t:") -> SignIn.Token(plain.substring(2))
                else -> throw IllegalArgumentException()
            }
        } catch (_: Exception) {
            delete(origin)
            null
        }
    }

    fun has(origin: String): Boolean = preferences.contains(origin)

    fun write(origin: String, signIn: SignIn) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
        val prefix = if (signIn is SignIn.Password) "p:" else "t:"
        val sealed = cipher.doFinal((prefix + signIn.secret).toByteArray(Charsets.UTF_8))
        val value = "v1:" + Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
        preferences.edit { putString(origin, value) }
    }

    fun delete(origin: String) {
        preferences.edit { remove(origin) }
    }

    private fun key(): SecretKey {
        (keyStore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        const val FILE = "sign_ins"
        const val ALIAS = "omp-ui-saved-sign-ins"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"

        private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

        /** Deletes every sign-in and the key; false on any failure. */
        fun clearAll(context: Context): Boolean = try {
            val cleared = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().commit()
            keyStore().deleteEntry(ALIAS)
            cleared
        } catch (_: Exception) {
            false
        }
    }
}
