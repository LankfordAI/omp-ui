package ai.lankford.ompui.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPolicyTest {
    @Test fun sanitizesPairingLinkWithoutSavingCredential() {
        val endpoint = HostPolicy.endpoint(" HTTP://Example.COM:80/?t=pair%2Bsecret ")
        assertEquals("http://example.com", endpoint.origin)
        assertEquals("http://example.com/?t=pair%2Bsecret", endpoint.initialUrl)
        assertEquals("https://host.netbird.cloud:3443", HostPolicy.endpoint("https://host.netbird.cloud:3443/").origin)
        assertEquals("http://localhost:3000", HostPolicy.endpoint("http://localhost:3000").origin)
        assertEquals("http://[::1]:3000", HostPolicy.endpoint("http://[::1]:3000").origin)
    }

    @Test fun rejectsAmbiguousOrCredentialBearingEndpoints() {
        listOf(
            "", "file:///etc/passwd", "javascript:alert(1)", "intent://host", "ftp://host",
            "http://user:password@host/", "http://user@host/", "http://host/#token",
            "http://host/login", "http://host/%2f", "http://host/?password=secret",
            "http://host/?t=one&t=two", "http://host/?t=one;extra=two", "http://host/?t=",
            "http://host/?t=%00", "http://host:0", "http://host:65536", "http://host:-1",
            "http://host:", "http://host:abc", "http://host\\@evil/", "http://ho st/",
            "http://host/\n? t=secret", "http://host/?t=%zz", "http://[::1%25eth0]/",
        ).forEach { input -> assertThrows(input, IllegalArgumentException::class.java) { HostPolicy.endpoint(input) } }
    }

    @Test fun locksNavigationToExactSchemeHostAndEffectivePort() {
        val origin = "http://host:3000"
        assertTrue(HostPolicy.isTrusted("http://HOST:3000/login", origin))
        assertTrue(HostPolicy.isTrusted("http://host:3000/assets/main.js", origin))
        listOf("https://host:3000/", "http://host:3001/", "http://host.evil:3000/",
            "http://host:3000@evil/", "http://password@host:3000/", "javascript:alert(1)", "file:///tmp/a",
            "blob:http://host:3000/id").forEach { assertFalse(it, HostPolicy.isTrusted(it, origin)) }
        assertTrue(HostPolicy.isTrusted("http://host:80/login", "http://host"))
        assertFalse(HostPolicy.isTrusted("http://host/", null))
    }

    @Test fun allowsHostResourcesButNotCrossHostCleartextOrLocalFiles() {
        val origin = "http://host:3000"
        assertTrue(HostPolicy.allowsResource("http://host:3000/api/attachment", origin))
        assertTrue(HostPolicy.allowsResource("https://cdn.example.org/font.woff2", origin))
        assertTrue(HostPolicy.allowsResource("blob:http://host:3000/id", origin))
        assertTrue(HostPolicy.allowsResource("data:image/png;base64,AA==", origin))
        assertFalse(HostPolicy.allowsResource("http://evil/image.png", origin))
        assertFalse(HostPolicy.allowsResource("file:///data/data/app/secret", origin))
        assertFalse(HostPolicy.allowsResource("content://media/image/1", origin))
        assertFalse(HostPolicy.isTrustedBlob("blob:http://evil/id", origin))
        assertFalse(HostPolicy.isExternalWebUrl("intent://host"))
        assertFalse(HostPolicy.isExternalWebUrl("https://user:password@host/"))
    }

    @Test fun mainFrameNeverBorrowsHttpsResourceAllowances() {
        val origin = "https://host:3443"
        assertTrue(HostPolicy.allowsRequest("$origin/login", origin, true))
        listOf("https://receiver.example/post", "https://host:443/", "http://host:3443/",
            "blob:$origin/id", "data:text/html,body", "about:blank").forEach {
            assertFalse(it, HostPolicy.allowsRequest(it, origin, true))
        }
        assertTrue(HostPolicy.allowsRequest("https://receiver.example/image", origin, false))
        assertFalse(HostPolicy.allowsRequest("https://host/", null, true))
    }

    @Test fun onlyUserInitiatedExternalGetsCanOpenBrowser() {
        val url = "https://outside.example/"
        assertTrue(HostPolicy.opensExternally(url, true, true, "GET"))
        assertFalse(HostPolicy.opensExternally(url, true, true, "POST"))
        assertFalse(HostPolicy.opensExternally(url, true, true, "PUT"))
        assertFalse(HostPolicy.opensExternally(url, false, true, "GET"))
        assertFalse(HostPolicy.opensExternally(url, true, false, "GET"))
        assertFalse(HostPolicy.opensExternally("intent://outside", true, true, "GET"))
    }

    @Test fun preservesOnlyExactTrustedPasswordFormHtmlErrors() {
        val origin = "http://host:3000"
        listOf(400, 401, 429).forEach { status ->
            assertTrue(HostPolicy.isLoginErrorPage("$origin/login", origin, "POST", status, "text/html"))
        }
        assertTrue(HostPolicy.isLoginErrorPage("$origin/login", origin, "POST", 401, "Text/HTML; charset=utf-8"))
        listOf("$origin/", "$origin/login/", "$origin/%6cogin", "$origin/login?x=y",
            "https://host:3000/login", "http://other:3000/login").forEach {
            assertFalse(it, HostPolicy.isLoginErrorPage(it, origin, "POST", 401, "text/html"))
        }
        assertFalse(HostPolicy.isLoginErrorPage("$origin/login", origin, "GET", 401, "text/html"))
        assertFalse(HostPolicy.isLoginErrorPage("$origin/login", origin, "POST", 403, "text/html"))
        assertFalse(HostPolicy.isLoginErrorPage("$origin/login", origin, "POST", 500, "text/html"))
        assertFalse(HostPolicy.isLoginErrorPage("$origin/login", origin, "POST", 401, "application/json"))
        assertFalse(HostPolicy.isLoginErrorPage("$origin/login", origin, "POST", 401, null))
    }

    @Test fun clearsFlatHorizontalOrOutOfBoundsFold() {
        assertEquals(480, FoldGeometry.relativeRightEdge(true, true, false, 500, 504, 24, 1000))
        assertNull(FoldGeometry.relativeRightEdge(true, true, true, 500, 504, 0, 1000))
        assertNull(FoldGeometry.relativeRightEdge(false, true, false, 500, 504, 0, 1000))
        assertNull(FoldGeometry.relativeRightEdge(true, false, false, 500, 504, 0, 1000))
        assertNull(FoldGeometry.relativeRightEdge(true, true, false, 0, 0, 0, 1000))
        assertNull(FoldGeometry.relativeRightEdge(true, true, false, 500, 504, 0, 0))
        assertNull(FoldGeometry.relativeRightEdge(true, true, false, 500, 1001, 0, 1000))
    }
}
