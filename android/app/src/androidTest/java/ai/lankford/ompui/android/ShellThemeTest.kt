package ai.lankford.ompui.android

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.core.view.WindowCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class ShellThemeTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val preferences get() = context.getSharedPreferences("connection", Context.MODE_PRIVATE)

    @Before fun resetRememberedHost() { assertTrue(preferences.edit().clear().commit()) }
    @After fun clearRememberedHost() { assertTrue(preferences.edit().clear().commit()) }

    @Test fun rootCanvasChangesPreserveLiveDraftSelectionAndScroll() {
        TestHttpHost { TestHttpHost.Response(body = themedPage("#152332")) }.use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                connect(scenario, host.origin)
                assertChrome(scenario, "#152332", false)
                val original = webView(scenario)
                val draft = "Unsent — café e\u0301 🧑🏽‍💻 漢字\nsecond line"
                js(scenario, """
                    const draft = document.querySelector('#draft');
                    draft.value = ${JSONObject.quote(draft)};
                    draft.setSelectionRange(2, 14, 'backward');
                    scrollTo(0, 480);
                """.trimIndent())
                await("The document did not scroll") { js(scenario, "scrollY >= 400") == "true" }
                val state = draftState(scenario)
                assertEquals(draft, JSONObject(state).getString("value"))
                assertEquals(2, JSONObject(state).getInt("start"))
                assertEquals(14, JSONObject(state).getInt("end"))
                assertEquals("backward", JSONObject(state).getString("direction"))

                setCanvas(scenario, "#faf6ee")
                assertChrome(scenario, "#faf6ee", true)
                assertRetainedDraft(scenario, original, state)
                setCanvas(scenario, "#28654b")
                assertChrome(scenario, "#28654b", false)
                assertRetainedDraft(scenario, original, state)

                // Neither the token nor the computed root/body now supplies an opaque color.
                // An invalid/translucent sample must not replace the last usable canvas.
                setCanvas(scenario, "rgba(230, 240, 250, 0.5)")
                assertChromeStays(scenario, "#28654b", false)
                setCanvas(scenario, "not-a-color")
                assertChromeStays(scenario, "#28654b", false)
                js(scenario, """
                    document.documentElement.style.removeProperty('--color-void');
                    document.documentElement.style.backgroundColor = 'rgb(75, 37, 93)';
                """.trimIndent())
                assertChrome(scenario, "#4b255d", false)
                assertRetainedDraft(scenario, original, state)
                assertEquals("Theme updates reloaded the host", 1, host.requests.count { it.target == "/" })
            }
        }
    }

    @Test fun connectionPanelUsesNativeChromeAndReturnsToLatestRetainedCanvas() {
        TestHttpHost { TestHttpHost.Response(body = themedPage("#223b56")) }.use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                assertPanelChrome(scenario)
                connect(scenario, host.origin)
                assertChrome(scenario, "#223b56", false)
                val original = webView(scenario)
                js(scenario, "document.querySelector('#draft').value = 'Still unsent — 日本語 🦊'")
                val state = draftState(scenario)
                val before = navigationState(scenario)
                val documentRequests = host.requests.count { it.target == "/" }

                tap(scenario, "#host-connection")
                await("Host connection gesture did not open the switch sheet") { switcherVisible(scenario) }
                assertChrome(scenario, NATIVE_BACKGROUND, false)
                scenario.onActivity { it.findViewById<Button>(R.id.manage_hosts).performClick() }
                await("Manage hosts did not open the panel") { connectionVisible(scenario) }
                assertPanelChrome(scenario)
                scenario.onActivity {
                    assertSame(original, it.findViewById(R.id.remote_webview))
                    assertEquals(View.INVISIBLE, original.visibility)
                }
                setCanvas(scenario, "#f3e9ce")
                val expectedHiddenChrome = Chrome(Color.parseColor("#f3e9ce"), true, true)
                await("The hidden WebView did not cache its latest canvas") {
                    var cached: Int? = null
                    scenario.onActivity { cached = it.activeHostBackground }
                    cached == expectedHiddenChrome.background
                }
                assertChromeStays(scenario, NATIVE_BACKGROUND, false)
                scenario.onActivity { activity ->
                    activity.findViewById<Button>(R.id.resume_current_view).performClick()
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.connection_panel).visibility)
                    assertEquals("Return must apply the cached canvas before asynchronous renderer callbacks", expectedHiddenChrome, chrome(activity))
                }
                await("The current view did not return") { !connectionVisible(scenario) }
                assertChrome(scenario, "#f3e9ce", true)
                assertRetainedDraft(scenario, original, state)
                assertEquals(before, navigationState(scenario))
                assertEquals("Opening/closing the panel navigated the host", documentRequests, host.requests.count { it.target == "/" })
            }
        }
    }

    @Test fun onlyCurrentTrustedMainFrameCanChangeChrome() {
        val oldMessageQueued = CountDownLatch(1)
        val releaseReplacement = CountDownLatch(1)
        TestHttpHost { request ->
            when (request.target) {
                "/child" -> TestHttpHost.Response(body = frameAttempt("same", "#ffeec8"))
                "/foreign-child" -> TestHttpHost.Response(body = frameAttempt("foreign", "#263e60"))
                "/retired-queued" -> {
                    oldMessageQueued.countDown()
                    TestHttpHost.Response(204, "")
                }
                else -> TestHttpHost.Response(body = themedPage("#17293b"))
            }
        }.use { first ->
            TestHttpHost("127.0.0.1") {
                if (releaseReplacement.await(15, TimeUnit.SECONDS)) {
                    TestHttpHost.Response(body = themedPage("#eed393"))
                } else TestHttpHost.Response(503, "Replacement response was not released")
            }.use { second ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    connect(scenario, first.origin)
                    assertChrome(scenario, "#17293b", false)
                    scenario.onActivity {
                        assertTrue("The provider must exercise actual binary WebMessages", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER))
                    }
                    js(scenario, """
                        window.frameReports = [];
                        addEventListener('message', event => {
                          if (event.data && event.data.themeFrame &&
                              event.source === document.getElementById(event.data.themeFrame + '-frame')?.contentWindow) {
                            window.frameReports.push({name: event.data.themeFrame, color: event.data.color,
                              outcome: event.data.outcome, origin: event.origin});
                          }
                        });
                        const frame = document.createElement('iframe');
                        frame.id = 'same-frame';
                        frame.src = '/child';
                        document.body.appendChild(frame);
                    """.trimIndent())
                    await("The same-origin child did not send its conflicting color") {
                        js(scenario, "window.frameReports.some(report => report.name === 'same' && report.outcome === 'sent')") == "true"
                    }
                    assertChromeStays(scenario, "#17293b", false)
                    postMainColor(scenario, "#e5edf5")
                    assertChrome(scenario, "#e5edf5", true)

                    // The request stays on the allowed HTTP host, but omitting allow-same-origin
                    // gives the script-enabled sandbox an opaque, foreign security origin.
                    js(scenario, """
                        window.foreignFrameLoaded = false;
                        const foreign = document.createElement('iframe');
                        foreign.id = 'foreign-frame';
                        foreign.setAttribute('sandbox', 'allow-scripts');
                        foreign.addEventListener('load', () => { window.foreignFrameLoaded = true; });
                        foreign.src = '/foreign-child';
                        document.body.appendChild(foreign);
                    """.trimIndent())
                    await("The foreign-origin child did not load and attempt its conflicting color") {
                        first.requests.any { it.target == "/foreign-child" } &&
                            js(scenario, """
                                window.foreignFrameLoaded && window.frameReports.some(report =>
                                  report.name === 'foreign' && report.origin === 'null' &&
                                  report.color === '#263e60' && typeof report.outcome === 'string')
                            """.trimIndent()) == "true"
                    }
                    assertChromeStays(scenario, "#e5edf5", true)
                    postMainColor(scenario, "#dfe9cc")
                    assertChrome(scenario, "#dfe9cc", true)

                    val attempts = JSONArray(js(scenario, """
                        (() => {
                          const inputs = [
                            ['malformed', '#12gg45'], ['short', '#abc'], ['alpha', '#ffffff00'],
                            ['whitespace', ' #ffffff'], ['null-string', 'null'], ['null', null],
                            ['oversized', '#112233' + '0'.repeat(65536)],
                            ['json', JSON.stringify({color: '#fff8dc'})],
                            ['object', {color: '#fff8dc'}],
                            ['binary', new TextEncoder().encode('#203b58').buffer]
                          ];
                          return inputs.map(([name, value]) => {
                            try { window.__ompAndroidChrome.postMessage(value); return {name, outcome: 'sent'}; }
                            catch (error) { return {name, outcome: error.name}; }
                          });
                        })()
                    """.trimIndent()))
                    for (index in 0 until attempts.length()) {
                        val attempt = attempts.getJSONObject(index)
                        if (attempt.getString("name") !in setOf("null", "object")) {
                            assertEquals("The ${attempt.getString("name")} payload never reached the real endpoint", "sent", attempt.getString("outcome"))
                        }
                    }
                    assertChromeStays(scenario, "#dfe9cc", true)
                    postMainColor(scenario, "#e6eef6")
                    assertChrome(scenario, "#e6eef6", true)

                    val hidden = webView(scenario)
                    openPanel(scenario)
                    try {
                        scenario.onActivity { activity ->
                            activity.findViewById<EditText>(R.id.host_address).setText(second.origin)
                            activity.findViewById<Button>(R.id.connect_host).performClick()
                        }
                        instrumentation.waitForIdleSync()
                        scenario.onActivity { activity ->
                            assertNotSame(hidden, activity.findViewById(R.id.remote_webview))
                        }
                        // Warm switching retains the old view hidden and live. Its trusted chrome
                        // messages update only its own stored background, never the visible chrome.
                        instrumentation.runOnMainSync {
                            hidden.evaluateJavascript("window.__ompAndroidChrome.postMessage('#faedcb'); fetch('/retired-queued', {cache: 'no-store'});", null)
                        }
                        assertTrue("The hidden view did not post its message", oldMessageQueued.await(5, TimeUnit.SECONDS))
                        instrumentation.waitForIdleSync()
                        // The new HTTP response is still held, so the new document cannot conceal
                        // a wrong color by immediately overwriting it.
                        assertChromeStays(scenario, NATIVE_BACKGROUND, false)
                    } finally { releaseReplacement.countDown() }
                    waitForDocument(scenario, second.origin, "#draft")
                    dismissSaveHostDialog(instrumentation)
                    assertChrome(scenario, "#eed393", true)
                    assertChromeStays(scenario, "#eed393", true)
                    assertFalse(connectionVisible(scenario))
                }
            }
        }
    }

    @Test fun tokenFreeSignInNavigationRecreationAndHttpFailureUseVisibleSurfaceChrome() {
        val workspaceColor = AtomicReference("#254a70")
        val cookie = "shell-theme-sign-in-${System.nanoTime().toString(16)}"
        TestHttpHost { request ->
            when {
                request.target == "/broken" -> TestHttpHost.Response(500, "A real host HTTP failure")
                request.target == "/workspace" -> TestHttpHost.Response(body = themedPage(workspaceColor.get()))
                request.target == "/login" && request.method == "POST" -> TestHttpHost.Response(303, "", headers = mapOf(
                    "Location" to "/workspace",
                    "Set-Cookie" to "$cookie=yes; Path=/; HttpOnly; SameSite=Strict",
                ))
                request.target == "/login" -> TestHttpHost.Response(body = signInPage())
                else -> TestHttpHost.Response(303, "", headers = mapOf(
                    "Location" to if (request.headers["cookie"].orEmpty().contains("$cookie=yes")) "/workspace" else "/login",
                ))
            }
        }.use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                assertPanelChrome(scenario)
                connect(scenario, host.origin, "#password")
                assertChrome(scenario, "#f5ecd7", true)
                assertFalse(connectionVisible(scenario))
                assertEquals(host.origin, preferences.getString("origin", null))
                assertEquals("\"/login\"", js(scenario, "location.pathname"))
                js(scenario, "document.querySelector('#password').value = 'correct'; document.querySelector('form').requestSubmit()")
                waitForDocument(scenario, host.origin, "#draft", expectedPath = "/workspace")
                assertChrome(scenario, "#254a70", false)
                assertEquals("\"/workspace\"", js(scenario, "location.pathname"))
                assertTrue(host.requests.any { it.target == "/login" && it.method == "POST" && it.body == "password=correct" })

                val previous = webView(scenario)
                workspaceColor.set("#f0dba2")
                scenario.recreate()
                waitForDocument(scenario, host.origin, "#draft", expectedPath = "/workspace")
                assertNotSame(previous, webView(scenario))
                assertChrome(scenario, "#f0dba2", true)
                assertEquals("\"/workspace\"", js(scenario, "location.pathname"))
                scenario.onActivity { assertFalse(it.findViewById<WebView>(R.id.remote_webview).url.orEmpty().contains('?')) }

                js(scenario, "location.assign('/broken')")
                await("A real HTTP failure did not restore the native panel") { connectionVisible(scenario) }
                assertPanelChrome(scenario)
                scenario.onActivity {
                    assertTrue(it.findViewById<TextView>(R.id.connection_message).text.contains("HTTP 500"))
                    assertEquals(View.GONE, it.findViewById<Button>(R.id.resume_current_view).visibility)
                }
                assertTrue(host.requests.any { it.target == "/broken" })
            }
        }
    }

    @Test fun systemNightModeChangesRetainLiveWebViewAndKeepNativePanelBlue() {
        val originalNightMode = systemNightMode()
        try {
            setSystemNightMode("yes")
            TestHttpHost { TestHttpHost.Response(body = systemSchemePage()) }.use { host ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    awaitActivityNightMode(scenario, true)
                    assertPanelChrome(scenario)
                    connect(scenario, host.origin)
                    assertChrome(scenario, SYSTEM_DARK_BACKGROUND, false)
                    val original = webView(scenario)
                    val draft = "Follow system — café e\u0301 🧑🏽‍💻 漢字\nStill unsent"
                    js(scenario, """
                        const draft = document.querySelector('#draft');
                        draft.value = ${JSONObject.quote(draft)};
                        draft.setSelectionRange(2, 14, 'backward');
                    """.trimIndent())
                    val state = draftState(scenario)
                    val before = navigationState(scenario)
                    val documentRequests = host.requests.count { it.target == "/" }

                    // Change the OS setting, not a synthetic Activity callback or JS theme hook.
                    // The retained host must receive the media-query change and publish its canvas.
                    for ((night, color) in listOf(false to SYSTEM_LIGHT_BACKGROUND, true to SYSTEM_DARK_BACKGROUND)) {
                        setSystemNightMode(if (night) "yes" else "no")
                        awaitActivityNightMode(scenario, night)
                        assertChrome(scenario, color, !night)
                        assertEquals("WebView media query disagrees with the real Activity uiMode", night.toString(),
                            js(scenario, "matchMedia('(prefers-color-scheme: dark)').matches"))
                        assertRetainedDraft(scenario, original, state)

                        openPanel(scenario)
                        assertPanelChrome(scenario)
                        assertChromeStays(scenario, NATIVE_BACKGROUND, false)
                        assertRetainedDraft(scenario, original, state)
                        scenario.onActivity { it.findViewById<Button>(R.id.resume_current_view).performClick() }
                        await("The retained host did not return from the native panel") { !connectionVisible(scenario) }
                        assertChrome(scenario, color, !night)
                        assertRetainedDraft(scenario, original, state)
                        assertEquals(before, navigationState(scenario))
                    }
                    assertEquals("System scheme changes or the native panel reloaded the host", documentRequests,
                        host.requests.count { it.target == "/" })
                }
            }
        } finally {
            setSystemNightMode(originalNightMode)
        }
    }

    private data class Chrome(val background: Int?, val lightStatus: Boolean, val lightNavigation: Boolean)

    private fun chrome(scenario: ActivityScenario<MainActivity>): Chrome {
        var result: Chrome? = null
        scenario.onActivity { result = chrome(it) }
        return checkNotNull(result)
    }

    private fun chrome(activity: MainActivity): Chrome {
        val root = activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        return Chrome((root.background as? ColorDrawable)?.color, controller.isAppearanceLightStatusBars, controller.isAppearanceLightNavigationBars)
    }

    private fun assertChrome(scenario: ActivityScenario<MainActivity>, color: String, darkIcons: Boolean) {
        val expected = Chrome(Color.parseColor(color), darkIcons, darkIcons)
        await("Native root and both system-bar icon flags did not become $color, darkIcons=$darkIcons") { chrome(scenario) == expected }
        assertEquals(expected, chrome(scenario))
    }

    private fun assertChromeStays(scenario: ActivityScenario<MainActivity>, color: String, darkIcons: Boolean) {
        val expected = Chrome(Color.parseColor(color), darkIcons, darkIcons)
        val deadline = SystemClock.uptimeMillis() + 600
        do {
            assertEquals("An ignored/hidden/retired source changed the visible native chrome", expected, chrome(scenario))
            Thread.sleep(25)
        } while (SystemClock.uptimeMillis() < deadline)
    }

    private fun assertPanelChrome(scenario: ActivityScenario<MainActivity>) {
        assertChrome(scenario, NATIVE_BACKGROUND, false)
        scenario.onActivity {
            val panel = it.findViewById<View>(R.id.connection_panel)
            assertEquals(View.VISIBLE, panel.visibility)
            assertEquals(Color.parseColor(NATIVE_BACKGROUND), (panel.background as ColorDrawable).color)
        }
    }

    private fun setCanvas(scenario: ActivityScenario<MainActivity>, color: String) {
        js(scenario, "document.documentElement.style.setProperty('--color-void', ${JSONObject.quote(color)})")
    }

    private fun postMainColor(scenario: ActivityScenario<MainActivity>, color: String) {
        assertEquals("\"sent\"", js(scenario, "window.__ompAndroidChrome.postMessage(${JSONObject.quote(color)}); 'sent'"))
    }

    private fun draftState(scenario: ActivityScenario<MainActivity>): String = js(scenario, """
        (() => {
          const draft = document.querySelector('#draft');
          return {value: draft.value, start: draft.selectionStart, end: draft.selectionEnd,
                  direction: draft.selectionDirection, scrollX, scrollY};
        })()
    """.trimIndent())

    private fun assertRetainedDraft(scenario: ActivityScenario<MainActivity>, original: WebView, state: String) {
        assertSame(original, webView(scenario))
        assertEquals("Theme synchronization disturbed an unsent draft, selection, or scroll", state, draftState(scenario))
    }

    private fun navigationState(scenario: ActivityScenario<MainActivity>): Triple<String?, Int, Int> {
        var result: Triple<String?, Int, Int>? = null
        scenario.onActivity {
            val view = it.findViewById<WebView>(R.id.remote_webview)
            val history = view.copyBackForwardList()
            result = Triple(view.url, history.currentIndex, history.size)
        }
        return checkNotNull(result)
    }

    private fun webView(scenario: ActivityScenario<MainActivity>): WebView {
        var result: WebView? = null
        scenario.onActivity { result = it.findViewById(R.id.remote_webview) }
        return checkNotNull(result)
    }

    private fun openPanel(scenario: ActivityScenario<MainActivity>) {
        tap(scenario, "#host-connection")
        await("Host connection gesture did not open the switch sheet") { switcherVisible(scenario) }
        scenario.onActivity { it.findViewById<Button>(R.id.manage_hosts).performClick() }
        await("Manage hosts did not open the panel") { connectionVisible(scenario) }
    }

    private fun switcherVisible(scenario: ActivityScenario<MainActivity>): Boolean {
        var showing = false
        scenario.onActivity { showing = it.findViewById<View>(R.id.host_switcher).visibility == View.VISIBLE }
        return showing
    }

    private fun connectionVisible(scenario: ActivityScenario<MainActivity>): Boolean {
        var showing = false
        scenario.onActivity { showing = it.findViewById<View>(R.id.connection_panel).visibility == View.VISIBLE }
        return showing
    }

    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(
        instrumentation.uiAutomation.executeShellCommand(command),
    ).bufferedReader().use { it.readText().trim() }

    private fun systemNightMode(): String {
        val output = shell("cmd uimode night")
        val mode = output.removePrefix("Night mode: ")
        assertTrue("Unexpected OS night-mode response: $output", mode in setOf("auto", "no", "yes", "custom"))
        return mode
    }

    private fun setSystemNightMode(mode: String) {
        val command = if (shell("dumpsys uimode").contains("mNightModeLocked=true")) {
            // Locked Android 10 images reject the shell UID's lack of MODIFY_DAY_NIGHT_MODE.
            // This test requires a disposable userdebug AVD with built-in root su in that case.
            assertTrue("Locked OS night mode requires a disposable userdebug emulator; build=${Build.TYPE}, hardware=${Build.HARDWARE}",
                Build.TYPE == "userdebug" && Build.HARDWARE in setOf("ranchu", "goldfish"))
            assertEquals("Locked OS night mode requires working root su on the disposable userdebug emulator", "0", shell("su 0 id -u"))
            "su 0 cmd uimode night $mode"
        } else "cmd uimode night $mode"
        shell(command)
        await("The OS night-mode setting did not become $mode") { systemNightMode() == mode }
        assertEquals("The OS night-mode setting did not change", mode, systemNightMode())
    }

    private fun awaitActivityNightMode(scenario: ActivityScenario<MainActivity>, night: Boolean) {
        val expected = if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
        await("The real Activity resources did not receive uiMode night=$night") {
            var actual = Configuration.UI_MODE_NIGHT_UNDEFINED
            scenario.onActivity { actual = it.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK }
            actual == expected
        }
    }

    private fun connect(scenario: ActivityScenario<MainActivity>, origin: String, selector: String = "#draft") {
        scenario.onActivity {
            it.findViewById<EditText>(R.id.host_address).setText(origin)
            it.findViewById<Button>(R.id.connect_host).performClick()
        }
        waitForDocument(scenario, origin, selector)
        dismissSaveHostDialog(instrumentation)
    }

    private fun waitForDocument(scenario: ActivityScenario<MainActivity>, origin: String, selector: String, expectedPath: String? = null) {
        val script = "location.origin === ${JSONObject.quote(origin)} && document.readyState === 'complete' && !!document.querySelector(${JSONObject.quote(selector)})"
        await("The host document did not load: $selector, path=$expectedPath") {
            val done = CountDownLatch(1)
            var probing = false
            var ready = false
            scenario.onActivity { activity ->
                val view = activity.findViewById<WebView>(R.id.remote_webview)
                val url = view?.url
                if (view != null && url != null && view.progress == 100 && HostPolicy.isTrusted(url, origin) &&
                    (expectedPath == null || Uri.parse(url).path == expectedPath)) {
                    probing = true
                    view.evaluateJavascript(script) { value -> ready = value == "true"; done.countDown() }
                }
            }
            // A redirect may cancel a probe's callback. Retry within the overall document
            // deadline, without relaxing the strict JS helper used for stable documents.
            probing && done.await(250, TimeUnit.MILLISECONDS) && ready
        }
    }

    private fun tap(scenario: ActivityScenario<MainActivity>, selector: String) {
        val point = JSONObject(js(scenario, """
            (() => {
              const rect = document.querySelector(${JSONObject.quote(selector)}).getBoundingClientRect();
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
            instrumentation.sendPointerSync(event)
            event.recycle()
        }
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

    private fun await(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15000
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        assertTrue(message, condition())
    }

    private fun themedPage(color: String): String = """
        <!doctype html><html style="--color-void:$color;background:var(--color-void)"><head>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body { margin:0; min-height:3600px; background:transparent; }
        #host-connection { display:block; padding:20px; }
        #draft { display:block; margin:20px; width:240px; height:100px; }</style></head><body>
        <a id="host-connection" href="omp-ui://host-connection">Host connection…</a>
        <textarea id="draft" aria-label="Unsent draft"></textarea></body></html>
    """.trimIndent()

    private fun systemSchemePage(): String = themedPage(SYSTEM_DARK_BACKGROUND).replace("</body>", """
        <script>
        const systemScheme = matchMedia('(prefers-color-scheme: dark)');
        function paintSystemScheme() {
          document.documentElement.style.setProperty('--color-void',
            systemScheme.matches ? '$SYSTEM_DARK_BACKGROUND' : '$SYSTEM_LIGHT_BACKGROUND');
        }
        systemScheme.addEventListener('change', paintSystemScheme);
        paintSystemScheme();
        </script></body>
    """.trimIndent())

    private fun signInPage(): String = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html { background:transparent; } body { margin:0; min-height:100vh; background:rgb(245,236,215); }</style>
        </head><body><h1>Sign in</h1><form action="/login" method="post">
        <input id="password" name="password" type="password"><button>Sign in</button></form></body></html>
    """.trimIndent()

    private fun frameAttempt(name: String, color: String): String = """
        <!doctype html><html><body><p>Embedded frame</p><script>
        const color = ${JSONObject.quote(color)};
        let outcome;
        try { window.__ompAndroidChrome.postMessage(color); outcome = 'sent'; }
        catch (error) { outcome = error.name; }
        parent.postMessage({themeFrame:${JSONObject.quote(name)}, color, outcome}, '*');
        </script></body></html>
    """.trimIndent()

    companion object {
        private const val NATIVE_BACKGROUND = "#101820"
        private const val SYSTEM_DARK_BACKGROUND = "#1a2d40"
        private const val SYSTEM_LIGHT_BACKGROUND = "#f7efdb"
    }
}
