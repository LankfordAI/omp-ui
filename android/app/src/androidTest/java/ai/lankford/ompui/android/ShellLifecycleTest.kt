package ai.lankford.ompui.android

import android.content.Context
import android.content.res.Configuration
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ShellLifecycleTest {
    private lateinit var server: ServerSocket
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var origin: String
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before fun startHost() {
        context.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().clear().commit()
        server = ServerSocket(0)
        origin = "http://localhost:${server.localPort}"
        worker.execute {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use {
                    val reader = it.getInputStream().bufferedReader()
                    while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break }
                    val html = """
                        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
                        <script>window.markerAtStart = !!window.__ompAndroidViewport;</script></head>
                        <body><textarea id="draft"></textarea><script>
                        document.querySelector('#draft').value = localStorage.getItem('shell-test-draft') || '';
                        window.ready = true;
                        </script></body></html>
                    """.trimIndent().toByteArray(StandardCharsets.UTF_8)
                    val headers = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${html.size}\r\nSet-Cookie: shell-test=durable; Path=/; HttpOnly; Max-Age=3600; SameSite=Strict\r\nConnection: close\r\n\r\n"
                    it.getOutputStream().apply { write(headers.toByteArray()); write(html); flush() }
                }
            }
        }
    }

    @After fun stopHost() {
        server.close()
        worker.shutdownNow()
        context.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test fun recreateRecoversOnlySanitizedOriginWithDurableWebStorageAndCookies() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.connection_panel).visibility)
                activity.findViewById<EditText>(R.id.host_address).setText("$origin/?t=do-not-persist")
                activity.findViewById<Button>(R.id.connect_host).performClick()
            }
            waitForPage(scenario)
            assertEquals("true", js(scenario, "window.markerAtStart"))
            assertEquals("true", js(scenario, "typeof window.Android === 'undefined'"))
            assertEquals(origin, context.getSharedPreferences("connection", Context.MODE_PRIVATE).getString("origin", null))
            assertFalse(context.getSharedPreferences("connection", Context.MODE_PRIVATE).all.toString().contains("do-not-persist"))
            js(scenario, "localStorage.setItem('shell-test-draft','retained text'); document.querySelector('#draft').value = 'retained text'")
            var old: WebView? = null
            scenario.onActivity { old = it.findViewById(R.id.remote_webview) }
            scenario.recreate()
            waitForPage(scenario)
            scenario.onActivity {
                val view = it.findViewById<WebView>(R.id.remote_webview)
                assertNotSame(old, view)
                assertTrue(HostPolicy.isTrusted(view.url, origin))
                assertFalse(view.url.orEmpty().contains("do-not-persist"))
                assertTrue(CookieManager.getInstance().getCookie(origin).orEmpty().contains("shell-test=durable"))
            }
            assertEquals("\"retained text\"", js(scenario, "document.querySelector('#draft').value"))
            js(scenario, "localStorage.removeItem('shell-test-draft')")
        }
    }

    @Test fun configurationCallbackAndConnectionPanelKeepUnsavedDom() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            connect(scenario)
            var original: WebView? = null
            js(scenario, "document.querySelector('#draft').value = 'unsaved DOM'; window.foldEvents = 0; addEventListener('omp-android-viewport', () => window.foldEvents++)")
            scenario.onActivity { activity ->
                original = activity.findViewById(R.id.remote_webview)
                activity.onConfigurationChanged(Configuration(activity.resources.configuration).apply {
                    orientation = Configuration.ORIENTATION_LANDSCAPE
                })
                assertSame(original, activity.findViewById(R.id.remote_webview))
                activity.findViewById<Button>(R.id.connection_menu).performClick()
                assertSame(original, activity.findViewById(R.id.remote_webview))
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.connection_panel).visibility)
                activity.onBackPressedDispatcher.onBackPressed()
                assertEquals(View.GONE, activity.findViewById<View>(R.id.connection_panel).visibility)
            }
            assertEquals("\"unsaved DOM\"", js(scenario, "document.querySelector('#draft').value"))
            assertEquals("null", js(scenario, "window.__ompAndroidViewport.bookSplitX"))
        }
    }

    @Test fun nativeBackNeverSendsEscapeToFocusedDraftOrPendingControls() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            connect(scenario)
            js(scenario, """
                window.escapeEvents = 0; window.agentActions = 0; window.backEvents = 0;
                document.body.insertAdjacentHTML('beforeend', '<button id="pending-approval">Approve</button><button id="pending-extension">Answer</button>');
                for (const type of ['keydown', 'keyup']) addEventListener(type, e => {
                  if (e.key === 'Escape') { window.escapeEvents++; window.agentActions++; }
                });
                window.closeOverlay = e => { window.backEvents++; e.preventDefault(); };
                addEventListener('omp-android-back', window.closeOverlay);
                document.querySelector('#draft').focus();
            """.trimIndent())
            assertEquals("true", js(scenario, "document.activeElement.id === 'draft'"))
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            await { js(scenario, "window.backEvents") == "1" }
            scenario.onActivity { assertEquals(View.GONE, it.findViewById<View>(R.id.connection_panel).visibility) }
            assertEquals("0", js(scenario, "window.escapeEvents"))
            assertEquals("0", js(scenario, "window.agentActions"))
            assertEquals("true", js(scenario, "!!document.querySelector('#pending-approval') && !!document.querySelector('#pending-extension')"))
            js(scenario, "removeEventListener('omp-android-back', window.closeOverlay)")
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            await {
                var showing = false
                scenario.onActivity { showing = it.findViewById<View>(R.id.connection_panel).visibility == View.VISIBLE }
                showing
            }
            assertEquals("0", js(scenario, "window.escapeEvents"))
            assertEquals("0", js(scenario, "window.agentActions"))
        }
    }

    @Test fun unconsumedBackUsesOnlyTrustedHistoryAndScriptRequiresTopFrameAndOrigin() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            connect(scenario)
            assertEquals("false", js(scenario, ShellScripts.back("https://wrong.example")))
            js(scenario, "window.backEvents = 0; addEventListener('omp-android-back', () => window.backEvents++); document.body.appendChild(document.createElement('iframe'))")
            assertEquals("false", js(scenario, "document.querySelector('iframe').contentWindow.eval(${org.json.JSONObject.quote(ShellScripts.back(origin))})"))
            assertEquals("0", js(scenario, "window.backEvents"))
            js(scenario, """
                const navigate = document.createElement('button');
                navigate.id = 'history-navigation';
                navigate.textContent = 'Navigate';
                navigate.onclick = () => {
                  history.pushState(null, '', '/previous');
                  history.pushState(null, '', '/current');
                };
                document.body.appendChild(navigate);
                navigate.focus();
            """.trimIndent())
            // A DOM focus is not native WebView focus; activate with a real touch instead.
            val point = org.json.JSONObject(js(scenario, """
                (() => {
                  const rect = document.querySelector('#history-navigation').getBoundingClientRect();
                  return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: innerWidth};
                })()
            """.trimIndent()))
            val screen = IntArray(2)
            var scale = 1f
            scenario.onActivity {
                val view = it.findViewById<WebView>(R.id.remote_webview)
                view.getLocationOnScreen(screen)
                scale = (view.width / point.getDouble("width")).toFloat()
            }
            val x = screen[0] + point.getDouble("x").toFloat() * scale
            val y = screen[1] + point.getDouble("y").toFloat() * scale
            val down = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0)
                InstrumentationRegistry.getInstrumentation().sendPointerSync(event)
                event.recycle()
            }
            await { js(scenario, "location.pathname") == "\"/current\"" }
            await {
                var ready = false
                scenario.onActivity {
                    val history = it.findViewById<WebView>(R.id.remote_webview).copyBackForwardList()
                    ready = history.currentIndex >= 2 && history.currentItem?.url == "$origin/current"
                }
                ready
            }
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
            await { js(scenario, "location.pathname") == "\"/previous\"" }
            scenario.onActivity { assertEquals(View.GONE, it.findViewById<View>(R.id.connection_panel).visibility) }
        }
    }

    private fun connect(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity {
            it.findViewById<EditText>(R.id.host_address).setText(origin)
            it.findViewById<Button>(R.id.connect_host).performClick()
        }
        waitForPage(scenario)
    }

    private fun waitForPage(scenario: ActivityScenario<MainActivity>) = await { js(scenario, "window.ready === true") == "true" }

    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        scenario.onActivity { activity ->
            val view = activity.findViewById<WebView>(R.id.remote_webview)
            if (view == null) done.countDown()
            else view.evaluateJavascript(script) { value -> result = value; done.countDown() }
        }
        assertTrue("JavaScript callback timed out", done.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        assertTrue("Expected WebView state was not reached", condition())
    }
}
