package ai.lankford.ompui.android

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

internal sealed interface SignInResult {
    /** Raw Set-Cookie values named omp_ui_token. */
    data class Accepted(val cookies: List<String>) : SignInResult
    data object Rejected : SignInResult
    data class Throttled(val retryAfterSeconds: Int?) : SignInResult
    /** Null status = network error. */
    data class Failed(val status: Int?) : SignInResult
}

internal object HostSignIn {
    private const val COOKIE = "omp_ui_token"

    /** Blocking; call only on the sign-in worker thread. Sends no cookies and follows no redirects. */
    fun verify(origin: String, signIn: SignIn): SignInResult {
        val url = when (signIn) {
            is SignIn.Password -> "$origin/login"
            is SignIn.Token -> "$origin/healthz?t=" + URLEncoder.encode(signIn.secret, "UTF-8")
        }
        require(HostPolicy.isTrusted(url, origin))
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                useCaches = false
                connectTimeout = 15000
                readTimeout = 30000
            }
            if (signIn is SignIn.Password) {
                val body = ("password=" + URLEncoder.encode(signIn.secret, "UTF-8")).toByteArray(Charsets.UTF_8)
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            } else {
                connection.requestMethod = "GET"
            }
            val status = connection.responseCode
            val cookies = connection.headerFields.entries
                .filter { it.key != null && it.key.equals("Set-Cookie", ignoreCase = true) }
                .flatMap { it.value.orEmpty() }
            classify(signIn, status, cookies, connection.getHeaderField("Retry-After"))
        } catch (_: IOException) {
            SignInResult.Failed(null)
        } finally {
            connection?.disconnect()
        }
    }

    /** Pure response classification, unit-tested. */
    fun classify(signIn: SignIn, status: Int, setCookies: List<String>, retryAfter: String?): SignInResult {
        val cookies = setCookies.filter { it.substringBefore('=') == COOKIE }
        return when (signIn) {
            is SignIn.Password -> when {
                (status == 302 || status == 303) && cookies.isNotEmpty() -> SignInResult.Accepted(cookies)
                status == 400 || status == 401 -> SignInResult.Rejected
                status == 429 -> SignInResult.Throttled(retryAfter?.trim()?.toIntOrNull())
                else -> SignInResult.Failed(status)
            }
            is SignIn.Token -> when {
                status == 200 && cookies.isNotEmpty() -> SignInResult.Accepted(cookies)
                status == 401 -> SignInResult.Rejected
                else -> SignInResult.Failed(status)
            }
        }
    }
}
