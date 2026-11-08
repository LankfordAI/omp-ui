package ai.lankford.ompui.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import org.json.JSONObject
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Uses the system document picker, not storage permissions or a callable JavaScript bridge. */
internal class WebDownloads(
    private val activity: ComponentActivity,
    private val webView: () -> WebView?,
    private val origin: () -> String?,
    private val notice: (String) -> Unit,
) {
    private class Transfer(val url: String, val origin: String, val view: WebView, val key: String) {
        val cancelled = AtomicBoolean(false)
        @Volatile var output: OutputStream? = null
        @Volatile var connection: HttpURLConnection? = null
        var offset = 0
        var size = 0
    }

    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var transfer: Transfer? = null
    private val picker = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val current = transfer ?: return@registerForActivityResult
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri?.scheme != "content" || !isCurrent(current)) {
            cancel()
        } else {
            worker.execute {
                try {
                    val output = activity.contentResolver.openOutputStream(uri, "w")
                        ?: throw IllegalStateException("No writable document")
                    current.output = output
                    if (current.cancelled.get()) { output.close(); return@execute }
                    if (current.url.startsWith("blob:")) {
                        handler.post { awaitBlob(current, 0) }
                    } else streamHttp(current)
                } catch (_: Exception) {
                    handler.post { finish(current, "Could not save the download. Choose a writable document and retry.") }
                }
            }
        }
    }

    fun request(url: String, disposition: String?, mime: String?) {
        val host = origin() ?: return
        val view = webView() ?: return
        if (!HostPolicy.isTrusted(view.url, host)) return
        if (!HostPolicy.isTrusted(url, host) && !HostPolicy.isTrustedBlob(url, host)) {
            notice("Downloads must come from the connected host.")
            return
        }
        if (transfer != null) { notice("Finish or cancel the current download first."); return }
        val current = Transfer(url, host, view, "__ompDownload_${UUID.randomUUID().toString().replace("-", "")}")
        transfer = current
        if (url.startsWith("blob:")) prepareBlob(current)
        val name = URLUtil.guessFileName(url, disposition, mime)
            .replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(120).ifBlank { "omp-ui-download" }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime?.takeIf { it.contains('/') && !it.contains(';') } ?: "application/octet-stream"
            putExtra(Intent.EXTRA_TITLE, name)
        }
        try { picker.launch(intent) } catch (_: ActivityNotFoundException) {
            finish(current, "No document picker is installed on this device.")
        }
    }

    private fun prepareBlob(current: Transfer) {
        evaluate(current, """
            (() => {
              const state = window[${JSONObject.quote(current.key)}] = {prepared:false, error:false};
              fetch(${JSONObject.quote(current.url)}).then(r => r.blob()).then(blob => {
                if (blob.size > $MAX_BYTES) { state.error = true; return; }
                state.blob = blob; state.size = blob.size; state.prepared = true;
              }).catch(() => { state.error = true; });
            })();
        """.trimIndent()) {}
    }

    private fun awaitBlob(current: Transfer, attempts: Int) {
        if (!isCurrent(current)) { cancel(); return }
        if (attempts >= 500) { finish(current, "The download could not be read. Generate it again and retry."); return }
        evaluate(current, """
            (() => { const s = window[${JSONObject.quote(current.key)}];
              return s ? {prepared:s.prepared,error:s.error,size:s.size || 0} : {error:true}; })();
        """.trimIndent()) { value ->
            val state = runCatching { JSONObject(value) }.getOrNull()
            when {
                state == null || state.optBoolean("error") -> finish(current, "The download expired or exceeds the 64 MiB limit. Generate a smaller download and retry.")
                state.optBoolean("prepared") -> {
                    current.size = state.optInt("size")
                    readBlobChunk(current)
                }
                else -> handler.postDelayed({ awaitBlob(current, attempts + 1) }, 30)
            }
        }
    }

    private fun readBlobChunk(current: Transfer) {
        if (!isCurrent(current)) { cancel(); return }
        if (current.offset >= current.size) { finish(current, "Download saved."); return }
        val end = minOf(current.offset + CHUNK_BYTES, current.size)
        evaluate(current, """
            (() => {
              const s = window[${JSONObject.quote(current.key)}];
              if (!s || !s.blob) return;
              s.ready = false; s.chunk = null;
              const reader = new FileReader();
              reader.onload = () => { s.chunk = reader.result.split(',')[1]; s.ready = true; };
              reader.onerror = () => { s.error = true; };
              reader.readAsDataURL(s.blob.slice(${current.offset}, $end));
            })();
        """.trimIndent()) { pollChunk(current, end, 0) }
    }

    private fun pollChunk(current: Transfer, end: Int, attempts: Int) {
        if (!isCurrent(current)) { cancel(); return }
        if (attempts >= 500) { finish(current, "Could not read the download. Generate it again and retry."); return }
        evaluate(current, """
            (() => { const s = window[${JSONObject.quote(current.key)}];
              return s ? {ready:s.ready,error:s.error,chunk:s.chunk} : {error:true}; })();
        """.trimIndent()) { value ->
            val state = runCatching { JSONObject(value) }.getOrNull()
            if (state == null || state.optBoolean("error")) {
                finish(current, "Could not read the download. Generate it again and retry.")
            } else if (!state.optBoolean("ready")) {
                handler.postDelayed({ pollChunk(current, end, attempts + 1) }, 30)
            } else {
                val encoded = state.optString("chunk")
                worker.execute {
                    try {
                        if (current.cancelled.get()) return@execute
                        val chunk = Base64.decode(encoded, Base64.DEFAULT)
                        require(chunk.size == end - current.offset)
                        current.output?.write(chunk) ?: throw IllegalStateException("Document closed")
                        current.offset = end
                        handler.post { readBlobChunk(current) }
                    } catch (_: Exception) {
                        handler.post { finish(current, "Could not save the download. The selected document may be incomplete.") }
                    }
                }
            }
        }
    }

    private fun streamHttp(current: Transfer) {
        try {
            var next = current.url
            var redirects = 0
            while (!current.cancelled.get()) {
                require(HostPolicy.isTrusted(next, current.origin))
                val connection = URL(next).openConnection() as HttpURLConnection
                current.connection = connection
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15000
                connection.readTimeout = 30000
                CookieManager.getInstance().getCookie(next)?.let { connection.setRequestProperty("Cookie", it) }
                try {
                    val status = connection.responseCode
                    if (status in setOf(301, 302, 303, 307, 308)) {
                        require(redirects++ < 5)
                        val location = connection.getHeaderField("Location") ?: error("Missing redirect")
                        next = URL(URL(next), location).toString()
                        continue
                    }
                    require(status in 200..299 && connection.contentLengthLong <= MAX_BYTES)
                    connection.inputStream.use { input ->
                        val buffer = ByteArray(32 * 1024)
                        var total = 0L
                        while (!current.cancelled.get()) {
                            val count = input.read(buffer)
                            if (count == -1) break
                            total += count
                            require(total <= MAX_BYTES)
                            current.output?.write(buffer, 0, count) ?: error("Document closed")
                        }
                    }
                    handler.post { finish(current, "Download saved.") }
                    return
                } finally { connection.disconnect(); current.connection = null }
            }
        } catch (_: Exception) {
            handler.post { finish(current, "Could not save the download. Check host access and the 64 MiB limit. The selected document may be incomplete.") }
        }
    }

    private fun evaluate(current: Transfer, script: String, result: (String) -> Unit) {
        if (!isCurrent(current)) { cancel(); return }
        current.view.evaluateJavascript("""
            (() => { if (location.origin !== ${JSONObject.quote(current.origin)}) return null;
              return $script })();
        """.trimIndent()) { value -> if (isCurrent(current)) result(value) }
    }

    private fun isCurrent(current: Transfer): Boolean = transfer === current && !current.cancelled.get() &&
        origin() == current.origin && webView() === current.view && HostPolicy.isTrusted(current.view.url, current.origin)

    private fun finish(current: Transfer, message: String) {
        if (transfer !== current) return
        cancel()
        notice(message)
    }

    fun cancel(clearPage: Boolean = true) {
        val current = transfer ?: return
        transfer = null
        current.cancelled.set(true)
        current.connection?.disconnect()
        runCatching { current.output?.close() }
        if (clearPage && webView() === current.view && HostPolicy.isTrusted(current.view.url, current.origin)) {
            current.view.evaluateJavascript("delete window[${JSONObject.quote(current.key)}]", null)
        }
    }

    fun close() { cancel(); handler.removeCallbacksAndMessages(null); worker.shutdownNow() }

    companion object {
        private const val MAX_BYTES = 64L * 1024 * 1024
        private const val CHUNK_BYTES = 192 * 1024
    }
}
