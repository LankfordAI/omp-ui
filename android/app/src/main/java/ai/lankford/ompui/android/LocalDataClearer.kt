package ai.lankford.ompui.android

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.webkit.WebStorageCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Application-scoped so an Activity recreation cannot reconnect halfway through deletion. */
internal object LocalDataClearer {
    const val PENDING = "data_clear_pending"
    enum class State { READY, CLEARING, COMPLETE, FAILED }
    private val mutableState = MutableStateFlow(State.READY)
    val state = mutableState.asStateFlow()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    fun start(context: Context) {
        if (mutableState.value == State.CLEARING) return
        val preferences = context.applicationContext.getSharedPreferences("connection", Context.MODE_PRIVATE)
        mutableState.value = State.CLEARING
        scope.launch {
            // Persist intent before asynchronous deletion; a killed process must resume it, not reconnect.
            val recorded = withContext(Dispatchers.IO) {
                preferences.edit().putBoolean(PENDING, true).commit()
            }
            if (!recorded) {
                mutableState.value = State.FAILED
                return@launch
            }
            try {
                // Includes cookies, cache, localStorage, IndexedDB, and other site storage.
                // No legacy deleteAllData fallback: it has neither equivalent scope nor completion.
                WebStorageCompat.deleteBrowsingData(WebStorage.getInstance()) {
                    CookieManager.getInstance().flush()
                    scope.launch {
                        val saved = withContext(Dispatchers.IO) {
                            preferences.edit().remove("origin").remove(PENDING).commit()
                        }
                        mutableState.value = if (saved) State.COMPLETE else State.FAILED
                    }
                }
            } catch (_: UnsupportedOperationException) {
                mutableState.value = State.FAILED
            }
        }
    }
}
