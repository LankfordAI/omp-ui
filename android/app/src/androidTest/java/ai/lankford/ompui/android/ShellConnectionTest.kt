package ai.lankford.ompui.android

import android.content.Context
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class ShellConnectionTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val preferences get() = context.getSharedPreferences("connection", Context.MODE_PRIVATE)

    @Before fun resetRememberedHost() { preferences.edit().clear().commit() }

    @Test fun passwordErrorsStayInHostHtmlAndCorrectedPasswordSignsIn() {
        loginHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                var original: WebView? = null
                scenario.onActivity { original = it.findViewById(R.id.remote_webview) }
                submitPassword(scenario, "wrong")
                await { js(scenario, "document.querySelector('#login-error')?.textContent") == "\"Wrong password\"" }
                assertHostVisible(scenario)
                submitPassword(scenario, "")
                await { js(scenario, "document.querySelector('#login-error')?.textContent") == "\"Enter a password\"" }
                assertHostVisible(scenario)
                submitPassword(scenario, "correct")
                await { js(scenario, "!!document.querySelector('#signed-in')") == "true" }
                assertHostVisible(scenario)
                scenario.onActivity { assertSame(original, it.findViewById(R.id.remote_webview)) }
                assertTrue(host.requests.any { it.target == "/login" && it.method == "POST" && it.body == "password=correct" })
                val posts = host.requests.count { it.method == "POST" }
                js(scenario, "document.querySelector('#draft').value = 'keep mounted draft'")
                scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
                await { connectionVisible(scenario) }
                assertEquals("\"keep mounted draft\"", js(scenario, "document.querySelector('#draft').value"))
                assertEquals("\"/signed-in\"", js(scenario, "location.pathname"))
                assertEquals(posts, host.requests.count { it.method == "POST" })
                scenario.onActivity { assertSame(original, it.findViewById(R.id.remote_webview)) }
            }
        }
    }

    @Test fun lockoutRemainsHostHtmlInsteadOfNativeRetryForm() {
        loginHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                submitPassword(scenario, "locked")
                await { js(scenario, "document.querySelector('#login-error')?.textContent") == "\"Try again later\"" }
                assertHostVisible(scenario)
                assertEquals("true", js(scenario, "!!document.querySelector('form')"))
            }
        }
    }

    @Test fun nonLoginHttpFailureStillShowsNativeRetryForm() {
        TestHttpHost { request ->
            if (request.target == "/broken") TestHttpHost.Response(500, "Host failure")
            else TestHttpHost.Response(body = TestHttpHost.page())
        }.use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                js(scenario, "location.href = '/broken'")
                await { connectionVisible(scenario) }
                scenario.onActivity { assertTrue(it.findViewById<TextView>(R.id.connection_message).text.contains("HTTP 500")) }
            }
        }
    }

    @Test fun directForeignHttpPostNeverReachesReceiver() {
        TestHttpHost().use { host ->
            TestHttpHost("127.0.0.1").use { receiver ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    connect(scenario, host.origin)
                    postTo(scenario, "${receiver.origin}/receive")
                    await { connectionVisible(scenario) }
                    assertTrue("Blocked main-frame POST reached HTTP receiver", receiver.requests.isEmpty())
                }
            }
        }
    }

    @Test fun directForeignHttpsPostNeverEvenConnectsToReceiver() {
        TestHttpHost().use { host ->
            // A TCP accept would expose even an attempted TLS handshake. No certificate bypass
            // or successful TLS setup is needed to prove a blocked URL never reaches the peer.
            ServerSocket(0).use { receiver ->
                val connections = AtomicInteger()
                val worker = Executors.newSingleThreadExecutor()
                worker.execute {
                    while (!receiver.isClosed) {
                        val socket = try { receiver.accept() } catch (_: java.io.IOException) { break }
                        socket.use { connections.incrementAndGet() }
                    }
                }
                try {
                    // Positive control: receiver is genuinely listening before the navigation.
                    Socket("localhost", receiver.localPort).close()
                    await { connections.get() == 1 }
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        connect(scenario, host.origin)
                        postTo(scenario, "https://localhost:${receiver.localPort}/receive")
                        await { connectionVisible(scenario) }
                        Thread.sleep(250)
                        assertEquals("Blocked HTTPS POST contacted receiver", 1, connections.get())
                    }
                } finally { receiver.close(); worker.shutdownNow() }
            }
        }
    }

    @Test fun ordinaryHostSwitchPreservesBothOriginsCookiesAndDraftStorage() {
        TestHttpHost().use { first ->
            TestHttpHost("127.0.0.1").use { second ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    connect(scenario, first.origin)
                    storeDraftAndCookie(scenario, "first", "shell-first")
                    switchHost(scenario, second.origin)
                    storeDraftAndCookie(scenario, "second", "shell-second")
                    switchHost(scenario, first.origin)
                    assertEquals("\"first\"", js(scenario, "document.querySelector('#draft').value"))
                    scenario.onActivity { assertTrue(CookieManager.getInstance().getCookie(first.origin).orEmpty().contains("shell-first=retained")) }
                    switchHost(scenario, second.origin)
                    assertEquals("\"second\"", js(scenario, "document.querySelector('#draft').value"))
                    scenario.onActivity { assertTrue(CookieManager.getInstance().getCookie(second.origin).orEmpty().contains("shell-second=retained")) }
                }
            }
        }
    }

    @Test fun cancellingClearKeepsCurrentViewRememberedOriginAndAllLocalData() {
        TestHttpHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                storeDraftAndCookie(scenario, "keep me", "shell-cancel")
                openConnection(scenario)
                var original: WebView? = null
                scenario.onActivity {
                    original = it.findViewById(R.id.remote_webview)
                    it.findViewById<Button>(R.id.clear_saved_hosts).performClick()
                }
                clickDialog(R.string.clear_saved_hosts_cancel)
                scenario.onActivity {
                    assertSame(original, it.findViewById(R.id.remote_webview))
                    assertTrue(it.findViewById<Button>(R.id.connect_host).isEnabled)
                    assertTrue(CookieManager.getInstance().getCookie(host.origin).orEmpty().contains("shell-cancel=retained"))
                }
                assertEquals(host.origin, preferences.getString("origin", null))
                assertEquals("\"keep me\"", js(scenario, "localStorage.getItem('shell-connection-draft')"))
            }
        }
    }

    @Test fun unsupportedClearProviderPreservesCookiesDraftAndRememberedOrigin() {
        TestHttpHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                var supportsClear = false
                scenario.onActivity { supportsClear = WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA) }
                assumeFalse("Requires a real older provider without DELETE_BROWSING_DATA", supportsClear)
                storeDraftAndCookie(scenario, "must remain", "shell-unsupported")
                openConnection(scenario)
                var original: WebView? = null
                scenario.onActivity {
                    original = it.findViewById(R.id.remote_webview)
                    it.findViewById<Button>(R.id.clear_saved_hosts).performClick()
                }
                clickDialog(R.string.clear_saved_hosts_confirm)
                await {
                    var unsupported = false
                    scenario.onActivity {
                        unsupported = it.findViewById<TextView>(R.id.connection_message).text.toString() == context.getString(R.string.clear_saved_hosts_unsupported)
                    }
                    unsupported
                }
                scenario.onActivity {
                    assertSame(original, it.findViewById(R.id.remote_webview))
                    assertTrue(it.findViewById<Button>(R.id.connect_host).isEnabled)
                    assertTrue(CookieManager.getInstance().getCookie(host.origin).orEmpty().contains("shell-unsupported=retained"))
                }
                assertEquals(host.origin, preferences.getString("origin", null))
                assertEquals("\"must remain\"", js(scenario, "localStorage.getItem('shell-connection-draft')"))
            }
        }
    }

    @Test fun persistedPendingClearCompletesBeforeAutomaticHostRestoration() {
        TestHttpHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                scenario.onActivity { assertTrue(WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) }
                storeDraftAndCookie(scenario, "pending deletion", "shell-pending")
                // This is the durable intent written before deletion starts. Recreating an
                // Activity must service it before its normal connected-state restoration.
                assertTrue(preferences.edit().putBoolean(LocalDataClearer.PENDING, true).commit())
                host.requests.clear()
                scenario.recreate()
                await {
                    var ready = false
                    scenario.onActivity { ready = it.findViewById<Button>(R.id.connect_host).isEnabled }
                    ready && !preferences.getBoolean(LocalDataClearer.PENDING, false) && preferences.getString("origin", null) == null
                }
                scenario.onActivity {
                    assertNull(it.findViewById<WebView>(R.id.remote_webview))
                    assertTrue(it.findViewById<Button>(R.id.connect_host).isEnabled)
                    assertEquals(View.VISIBLE, it.findViewById<View>(R.id.connection_panel).visibility)
                }
                assertTrue("Pending deletion reconnected to the old host", host.requests.isEmpty())
                connect(scenario, host.origin)
                assertEquals("null", js(scenario, "localStorage.getItem('shell-connection-draft')"))
                assertEquals("\"\"", js(scenario, "document.querySelector('#draft').value"))
                assertTrue(host.requests.first { it.target == "/" }.headers["cookie"].isNullOrEmpty())
            }
        }
    }

    @Test fun confirmedClearRemovesActualCookiesAndDraftsAcrossOriginsBeforeReconnect() {
        TestHttpHost().use { first ->
            TestHttpHost("127.0.0.1").use { second ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    connect(scenario, first.origin)
                    scenario.onActivity { assertTrue("Update the test device's WebView: DELETE_BROWSING_DATA is required", WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) }
                    storeDraftAndCookie(scenario, "erase first", "shell-clear-first")
                    switchHost(scenario, second.origin)
                    storeDraftAndCookie(scenario, "erase second", "shell-clear-second")
                    openConnection(scenario)
                    scenario.onActivity {
                        it.findViewById<Button>(R.id.clear_saved_hosts).performClick()
                    }
                    clickDialog(R.string.clear_saved_hosts_confirm)
                    await {
                        var completed = false
                        scenario.onActivity {
                            completed = it.findViewById<Button>(R.id.connect_host).isEnabled &&
                                it.findViewById<TextView>(R.id.connection_message).text.toString() == context.getString(R.string.clear_saved_hosts_complete)
                        }
                        completed
                    }
                    assertNull(preferences.getString("origin", null))
                    assertFalse(preferences.getBoolean(LocalDataClearer.PENDING, false))
                    scenario.onActivity {
                        assertNull(it.findViewById<WebView>(R.id.remote_webview))
                        assertEquals("", it.findViewById<EditText>(R.id.host_address).text.toString())
                        assertEquals(View.VISIBLE, it.findViewById<View>(R.id.connection_panel).visibility)
                        assertTrue(CookieManager.getInstance().getCookie(first.origin).isNullOrEmpty())
                        assertTrue(CookieManager.getInstance().getCookie(second.origin).isNullOrEmpty())
                    }
                    first.requests.clear()
                    connect(scenario, first.origin)
                    assertEquals("\"\"", js(scenario, "document.querySelector('#draft').value"))
                    assertEquals("null", js(scenario, "localStorage.getItem('shell-connection-draft')"))
                    assertTrue(first.requests.first { it.target == "/" }.headers["cookie"].isNullOrEmpty())
                    second.requests.clear()
                    switchHost(scenario, second.origin)
                    assertEquals("\"\"", js(scenario, "document.querySelector('#draft').value"))
                    assertEquals("null", js(scenario, "localStorage.getItem('shell-connection-draft')"))
                    assertTrue(second.requests.first { it.target == "/" }.headers["cookie"].isNullOrEmpty())
                }
            }
        }
    }

    private fun loginHost() = TestHttpHost { request ->
        if (request.target == "/signed-in") {
            TestHttpHost.Response(body = TestHttpHost.page("<p id='signed-in'>Signed in</p>"))
        } else if (request.target == "/login" && request.method == "POST" && request.body == "password=correct") {
            TestHttpHost.Response(303, "", headers = mapOf("Location" to "/signed-in"))
        } else {
            val error = when (request.body) {
                "password=wrong" -> 401 to "Wrong password"
                "password=" -> 400 to "Enter a password"
                "password=locked" -> 429 to "Try again later"
                else -> 200 to ""
            }
            val form = "<p id='login-error'>${error.second}</p><form action='/login' method='post'><input id='password' name='password'><button>Sign in</button></form>"
            TestHttpHost.Response(error.first, TestHttpHost.page(form))
        }
    }

    private fun submitPassword(scenario: ActivityScenario<MainActivity>, password: String) {
        js(scenario, "window.ready = false; document.querySelector('#password').value = ${JSONObject.quote(password)}; document.querySelector('form').requestSubmit()")
    }

    private fun postTo(scenario: ActivityScenario<MainActivity>, url: String) {
        js(scenario, "const form = document.createElement('form'); form.method = 'post'; form.action = ${JSONObject.quote(url)}; form.innerHTML = '<input name=secret value=never-send>'; document.body.appendChild(form); form.submit()")
    }

    private fun storeDraftAndCookie(scenario: ActivityScenario<MainActivity>, draft: String, cookie: String) {
        js(scenario, "localStorage.setItem('shell-connection-draft', ${JSONObject.quote(draft)}); document.querySelector('#draft').value = ${JSONObject.quote(draft)}; document.cookie = '$cookie=retained; Path=/; Max-Age=3600; SameSite=Strict'")
        scenario.onActivity { CookieManager.getInstance().flush() }
    }

    private fun connect(scenario: ActivityScenario<MainActivity>, origin: String) {
        scenario.onActivity {
            it.findViewById<EditText>(R.id.host_address).setText(origin)
            it.findViewById<Button>(R.id.connect_host).performClick()
        }
        await { js(scenario, "window.ready === true && location.origin === ${JSONObject.quote(origin)}") == "true" }
    }

    private fun switchHost(scenario: ActivityScenario<MainActivity>, origin: String) {
        openConnection(scenario)
        scenario.onActivity {
            it.findViewById<EditText>(R.id.host_address).setText(origin)
            it.findViewById<Button>(R.id.connect_host).performClick()
        }
        clickDialogText("Connect")
        await { js(scenario, "window.ready === true && location.origin === ${JSONObject.quote(origin)}") == "true" }
    }

    private fun openConnection(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        await { connectionVisible(scenario) }
    }

    private fun assertHostVisible(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { assertEquals(View.GONE, it.findViewById<View>(R.id.connection_panel).visibility) }
    }

    private fun connectionVisible(scenario: ActivityScenario<MainActivity>): Boolean {
        var showing = false
        scenario.onActivity { showing = it.findViewById<View>(R.id.connection_panel).visibility == View.VISIBLE }
        return showing
    }

    private fun clickDialog(resource: Int) = clickDialogText(context.getString(resource))

    private fun clickDialogText(text: String) = await {
        val nodes = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText(text).orEmpty()
        val button = nodes.firstOrNull { it.className == "android.widget.Button" && it.text?.toString()?.equals(text, ignoreCase = true) == true }
        button?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        scenario.onActivity {
            val view = it.findViewById<WebView>(R.id.remote_webview)
            if (view == null) done.countDown()
            else view.evaluateJavascript(script) { value -> result = value; done.countDown() }
        }
        assertTrue("JavaScript callback timed out", done.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        assertTrue("Expected shell state was not reached", condition())
    }
}
