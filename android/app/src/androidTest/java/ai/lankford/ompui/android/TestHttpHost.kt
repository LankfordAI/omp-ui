package ai.lankford.ompui.android

import java.io.BufferedInputStream
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/** Real loopback HTTP endpoint; records requests before routing, including POST bodies/cookies. */
internal class TestHttpHost(
    hostname: String = "localhost",
    private val handler: (Request) -> Response = { Response(body = page()) },
) : AutoCloseable {
    data class Request(val method: String, val target: String, val headers: Map<String, String>, val body: String)
    data class Response(val status: Int = 200, val body: String, val mime: String = "text/html", val headers: Map<String, String> = emptyMap())
    private val server = ServerSocket(0)
    private val worker = Executors.newSingleThreadExecutor()
    val origin = "http://$hostname:${server.localPort}"
    val requests = ConcurrentLinkedQueue<Request>()

    init {
        worker.execute {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use {
                    it.soTimeout = 3000
                    try {
                        val input = BufferedInputStream(it.getInputStream())
                        val first = readLine(input).split(' ')
                        if (first.size < 2) return@use
                        val headers = mutableMapOf<String, String>()
                        while (true) {
                            val line = readLine(input)
                            if (line.isEmpty()) break
                            headers[line.substringBefore(':').lowercase(Locale.ROOT)] = line.substringAfter(':').trim()
                        }
                        val body = ByteArray(headers["content-length"]?.toIntOrNull() ?: 0)
                        var offset = 0
                        while (offset < body.size) {
                            val count = input.read(body, offset, body.size - offset)
                            if (count < 0) break
                            offset += count
                        }
                        val request = Request(first[0], first[1], headers, String(body, StandardCharsets.UTF_8))
                        requests.add(request)
                        val response = handler(request)
                        val bytes = response.body.toByteArray(StandardCharsets.UTF_8)
                        val extra = response.headers.entries.joinToString("") { entry -> "${entry.key}: ${entry.value}\r\n" }
                        val head = "HTTP/1.1 ${response.status} Test\r\nContent-Type: ${response.mime}; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nCache-Control: no-store\r\n${extra}Connection: close\r\n\r\n"
                        it.getOutputStream().apply { write(head.toByteArray(StandardCharsets.US_ASCII)); write(bytes); flush() }
                    } catch (_: java.io.IOException) {
                        // A navigation cancelled by the shell can close its socket before the response.
                    }
                }
            }
        }
    }

    override fun close() { server.close(); worker.shutdownNow() }

    companion object {
        fun page(content: String = ""): String = """
            <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body><textarea id="draft"></textarea>$content<script>
            document.querySelector('#draft').value = localStorage.getItem('shell-connection-draft') || '';
            window.ready = true;
            </script></body></html>
        """.trimIndent()

        private fun readLine(input: BufferedInputStream): String {
            val value = StringBuilder()
            while (value.length < 16384) {
                val next = input.read()
                if (next < 0 || next == 10) break
                if (next != 13) value.append(next.toChar())
            }
            return value.toString()
        }
    }
}
