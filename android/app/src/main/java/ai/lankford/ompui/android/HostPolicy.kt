package ai.lankford.ompui.android

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Locale

/** The initial URL may carry a pairing token. Only origin is safe to persist or display. */
class HostEndpoint internal constructor(val origin: String, val initialUrl: String)

object HostPolicy {
    fun endpoint(input: String): HostEndpoint {
        val text = input.trim()
        require(text.length in 1..4096) { "Enter the host's HTTP or HTTPS address." }
        val uri = parseNetworkUrl(text)
        require(uri.rawFragment == null) { "Remove the fragment (#…) from the host address." }
        require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") {
            "Use the host's root address, not a page or file path."
        }
        val origin = origin(uri)
        val query = uri.rawQuery
        val initialUrl = if (query == null) {
            "$origin/"
        } else {
            require(query.startsWith("t=") && !query.contains('&') && !query.contains(';')) {
                "Only a host pairing link (?t=…) is accepted."
            }
            val token = try {
                URLDecoder.decode(query.substring(2), "UTF-8")
            } catch (_: IllegalArgumentException) {
                throw IllegalArgumentException("The pairing link has invalid escaping.")
            }
            require(token.isNotBlank() && token.length <= 2048 && token.none { it.isISOControl() }) {
                "The pairing link needs a valid token."
            }
            "$origin/?t=${URLEncoder.encode(token, "UTF-8")}"
        }
        return HostEndpoint(origin, initialUrl)
    }

    fun isTrusted(url: String?, trustedOrigin: String?): Boolean {
        if (url == null || trustedOrigin == null) return false
        return runCatching { origin(parseNetworkUrl(url)) == trustedOrigin }.getOrDefault(false)
    }

    fun isExternalWebUrl(url: String): Boolean = runCatching {
        parseNetworkUrl(url)
        true
    }.getOrDefault(false)

    /** Main-frame requests never inherit the broader HTTPS subresource allowance. */
    fun allowsRequest(url: String, trustedOrigin: String?, mainFrame: Boolean): Boolean =
        if (mainFrame) isTrusted(url, trustedOrigin) else allowsResource(url, trustedOrigin)

    fun opensExternally(url: String, mainFrame: Boolean, gesture: Boolean, method: String): Boolean =
        mainFrame && gesture && method == "GET" && isExternalWebUrl(url)

    /** Only the host's password form owns these error pages; other failures remain native. */
    fun isLoginErrorPage(url: String, trustedOrigin: String?, method: String, status: Int, mime: String?): Boolean =
        method == "POST" && (status == 400 || status == 401 || status == 429) &&
            mime?.substringBefore(';')?.trim()?.equals("text/html", ignoreCase = true) == true &&
            isTrusted(url, trustedOrigin) && runCatching {
                val uri = parseNetworkUrl(url)
                uri.rawPath == "/login" && uri.rawQuery == null
            }.getOrDefault(false)

    /** HTTPS resources retain normal browser semantics; cleartext is limited to this host. */
    fun allowsResource(url: String, trustedOrigin: String?): Boolean {
        if (url.startsWith("https:", ignoreCase = true)) return isExternalWebUrl(url)
        if (url.startsWith("http:", ignoreCase = true)) return isTrusted(url, trustedOrigin)
        if (url.startsWith("blob:")) return isTrusted(url.removePrefix("blob:"), trustedOrigin)
        return url.startsWith("data:") || url == "about:blank"
    }

    fun isTrustedBlob(url: String, trustedOrigin: String?): Boolean =
        url.startsWith("blob:") && isTrusted(url.removePrefix("blob:"), trustedOrigin)

    private fun parseNetworkUrl(text: String): URI {
        require(text.none { it.isWhitespace() || it.isISOControl() || it == '\\' }) {
            "The address cannot contain spaces, control characters, or backslashes."
        }
        val uri = try {
            URI(text)
        } catch (_: Exception) {
            throw IllegalArgumentException("Enter a valid HTTP or HTTPS host address.")
        }
        require(uri.scheme?.lowercase(Locale.ROOT) in setOf("http", "https")) {
            "Use http:// or https://."
        }
        require(uri.rawUserInfo == null && uri.rawAuthority?.contains('@') == false) {
            "URL usernames and passwords are not accepted. Sign in on the host page instead."
        }
        require(!uri.host.isNullOrEmpty() && !uri.host.contains('%')) { "The host address is invalid." }
        val authority = uri.rawAuthority ?: ""
        val suffix = if (authority.startsWith('[')) authority.substringAfter(']', "invalid")
            else authority.removePrefix(uri.host)
        require(suffix.isEmpty() || (suffix.startsWith(':') && suffix.drop(1).isNotEmpty() &&
            suffix.drop(1).all { it in '0'..'9' } && uri.port in 1..65535)) {
            "The port must be between 1 and 65535."
        }
        return uri
    }

    private fun origin(uri: URI): String {
        val scheme = uri.scheme.lowercase(Locale.ROOT)
        val host = uri.host.lowercase(Locale.ROOT)
        val defaultPort = if (scheme == "http") 80 else 443
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }
}

/** Window feature coordinates are physical window pixels; the document converts to CSS pixels. */
object FoldGeometry {
    fun relativeRightEdge(
        separating: Boolean,
        vertical: Boolean,
        flat: Boolean,
        hingeLeft: Int,
        hingeRight: Int,
        webLeft: Int,
        webWidth: Int,
    ): Int? {
        if (!separating || !vertical || flat || webWidth <= 0) return null
        val left = hingeLeft - webLeft
        val right = hingeRight - webLeft
        return if (left >= 0 && right > 0 && right < webWidth) right else null
    }
}
