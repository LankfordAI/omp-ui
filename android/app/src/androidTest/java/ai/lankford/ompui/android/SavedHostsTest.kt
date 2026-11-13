package ai.lankford.ompui.android

import android.content.Context
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.net.URLEncoder
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class SavedHostsTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val connection get() = context.getSharedPreferences("connection", Context.MODE_PRIVATE)
    private val signInPreferences get() = context.getSharedPreferences(SavedSignIns.FILE, Context.MODE_PRIVATE)

    @Before fun resetBefore() { resetState() }
    @After fun resetAfter() { resetState() }

    @Test fun failedConnectKeepsCurrentViewAndSavesOnlyLoadedHosts() {
        plainHost().use { host ->
            // A port that was bound and released refuses connections.
            val unreachable = ServerSocket(0).use { "http://localhost:${it.localPort}" }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                openHost(scenario, host.origin)
                waitFor(scenario, host.origin)
                submitDialog(R.id.save_host_name to "Desk")
                await("Host was not saved as Desk") { SavedHosts(context).get(host.origin)?.name == "Desk" }
                js(scenario, "document.querySelector('#draft').value = 'unsent on A'")
                val original = webView(scenario)

                openHost(scenario, unreachable)
                await("Unreachable host did not show the failure panel") {
                    scenario.query {
                        it.findViewById<View>(R.id.connection_panel).visibility == View.VISIBLE &&
                            it.findViewById<TextView>(R.id.connection_message).text.contains("Could not reach the host")
                    }
                }
                scenario.onActivity {
                    assertEquals(View.VISIBLE, it.findViewById<View>(R.id.resume_current_view).visibility)
                    assertEquals(unreachable, it.findViewById<EditText>(R.id.host_address).text.toString())
                    val list = it.findViewById<ViewGroup>(R.id.saved_hosts_list)
                    assertNull("A failed host was listed", list.findViewWithTag<View>(unreachable))
                    assertNotNull(list.findViewWithTag<View>(host.origin))
                }
                assertNull("A failed host was saved", SavedHosts(context).get(unreachable))
                assertEquals(listOf(host.origin), SavedHosts(context).all().map { it.origin })

                scenario.onActivity { assertTrue(it.findViewById<Button>(R.id.resume_current_view).performClick()) }
                await("Return to current view did not hide the panel") {
                    scenario.query { it.findViewById<View>(R.id.connection_panel).visibility == View.GONE }
                }
                assertSame("The failed connect replaced the current view", original, webView(scenario))
                assertEquals("\"unsent on A\"", js(scenario, "document.querySelector('#draft').value"))
                assertEquals("\"${host.origin}\"", js(scenario, "location.origin"))
            }
        }
    }

    @Test fun warmSwitchReturnsSameViewWithUnsentDomAndNoReload() {
        plainHost().use { first ->
            plainHost("127.0.0.1").use { second ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    connectPlain(scenario, first.origin)
                    js(scenario, "document.querySelector('#draft').value = 'unsent on A'")
                    val firstView = webView(scenario)
                    connectPlain(scenario, second.origin)
                    assertNotSame(firstView, webView(scenario))
                    val roots = rootRequests(first)

                    openSwitcher(scenario)
                    pick(scenario, R.id.host_switcher_list, first.origin)
                    await("The first host's live view was not shown again") { webViewOrNull(scenario) === firstView }
                    await("Picking a host left the switcher open") {
                        scenario.query { it.findViewById<View>(R.id.host_switcher).visibility == View.GONE }
                    }
                    assertEquals("\"unsent on A\"", js(scenario, "document.querySelector('#draft').value"))
                    assertEquals("\"${first.origin}\"", js(scenario, "location.origin"))
                    assertStays("A warm switch reloaded the host", 500) { rootRequests(first) == roots }
                }
            }
        }
    }

    @Test fun savedPasswordIsEncryptedAndSignsInAgainWithoutCookies() {
        PasswordHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                savePassword(scenario, host)
                assertEquals(SignIn.Password(PASSWORD), SavedSignIns(context).read(host.origin))
                assertTrue(signInPreferences.contains(host.origin))
                assertFalse("Saved password is stored in plaintext", signInPreferences.all.toString().contains(PASSWORD))
                assertFalse(connection.all.toString().contains(PASSWORD))
                assertTrue(keyStore().containsAlias(SavedSignIns.ALIAS))
                val verified = host.posts().single()
                assertEquals("password=$PASSWORD", verified.body)
                assertTrue("Native sign-in sent cookies", verified.headers["cookie"].isNullOrEmpty())

                removeCookies()
                scenario.recreate()
                waitFor(scenario, host.origin, "#signed-in")
                assertFalse(dialogShowing(R.id.sign_in_password))
                assertFalse(dialogShowing(R.id.save_host_name))
                val posts = host.posts()
                assertEquals("Saved password was not used exactly once", 2, posts.size)
                assertEquals("password=$PASSWORD", posts[1].body)
                assertTrue("Automatic sign-in sent cookies", posts[1].headers["cookie"].isNullOrEmpty())
            }
        }
    }

    @Test fun rejectedSavedPasswordIsForgottenAndAskedAgain() {
        PasswordHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                savePassword(scenario, host)
                host.password.set("changed")
                removeCookies()
                val before = host.posts().size
                scenario.recreate()
                await("Rejected saved password did not ask again") { dialogShowing(R.id.sign_in_password, without = R.id.save_host_name) }
                assertTrue(dialogHasText(R.id.sign_in_password, context.getString(R.string.sign_in_saved_rejected, "Lab")))
                assertFalse("Rejected sign-in was kept", signInPreferences.contains(host.origin))
                assertNull(SavedSignIns(context).read(host.origin))
                assertNotNull("Rejected sign-in removed the saved host", SavedHosts(context).get(host.origin))
                assertEquals(before + 1, host.posts().size)
                assertEquals("password=$PASSWORD", host.posts().last().body)
                waitFor(scenario, host.origin, "#password")
                clickDialogButton(context.getString(R.string.dialog_cancel))
                await("Sign-in dialog stayed open") { !dialogShowing(R.id.sign_in_password) }
            }
        }
    }

    @Test fun throttledSavedPasswordIsKept() {
        PasswordHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                savePassword(scenario, host)
                host.throttled.set(true)
                removeCookies()
                val before = host.posts().size
                scenario.recreate()
                await("Automatic sign-in did not reach the throttled host") { host.posts().size > before }
                waitFor(scenario, host.origin, "#password")
                assertStays("Throttled sign-in left the host form or asked again", 1000) {
                    probe(scenario, "location.pathname === '/login' && !!document.querySelector('#password')") == "true" &&
                        !dialogShowing(R.id.sign_in_password)
                }
                assertEquals(before + 1, host.posts().size)
                assertEquals(SignIn.Password(PASSWORD), SavedSignIns(context).read(host.origin))
            }
        }
    }

    @Test fun pairingTokenIsSavedEncryptedAndUsedWithoutCookies() {
        tokenHost().use { host ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                openHost(scenario, "${host.origin}/?t=$ENCODED_TOKEN")
                waitFor(scenario, host.origin, "#signed-in")
                dismissSaveHostDialog(instrumentation)
                assertEquals(SignIn.Token(TOKEN), SavedSignIns(context).read(host.origin))
                assertFalse("Pairing token is stored in plain connection preferences", connection.all.toString().contains(TOKEN))
                assertFalse("Pairing token is stored in plaintext", signInPreferences.all.toString().contains(TOKEN))

                removeCookies()
                host.requests.clear()
                scenario.recreate()
                waitFor(scenario, host.origin, "#signed-in")
                assertFalse(dialogShowing(R.id.sign_in_password))
                assertFalse(dialogShowing(R.id.save_host_name))
                val requests = host.requests.toList()
                val check = requests.indexOfFirst { it.target == "/healthz?t=$ENCODED_TOKEN" }
                assertTrue("Saved pairing token was not verified", check >= 0)
                assertTrue("Token verification sent cookies", requests[check].headers["cookie"].isNullOrEmpty())
                assertTrue(requests.take(check).any { it.target == "/" && it.headers["cookie"].isNullOrEmpty() })
                assertTrue("Page did not load with the verified sign-in", requests.drop(check + 1).any { it.target == "/" && hasCookie(it, TOKEN_COOKIE) })
            }
        }
    }

    @Test fun removeForgetsOneHostAndClearDeletesAllSavedState() {
        tokenHost("127.0.0.1").use { paired ->
            PasswordHost().use { password ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    scenario.onActivity { assertTrue("Update the test device's WebView: DELETE_BROWSING_DATA is required", WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) }
                    openHost(scenario, "${paired.origin}/?t=$ENCODED_TOKEN")
                    waitFor(scenario, paired.origin, "#signed-in")
                    dismissSaveHostDialog(instrumentation)
                    savePassword(scenario, password)
                    assertTrue(signInPreferences.contains(paired.origin))
                    assertTrue(signInPreferences.contains(password.origin))

                    showPanel(scenario)
                    scenario.onActivity {
                        val row = it.findViewById<ViewGroup>(R.id.saved_hosts_list).findViewWithTag<View>(paired.origin)
                        assertNotNull("Saved host row missing", row)
                        assertTrue(menuButton(row).performClick())
                    }
                    clickDialogItem(context.getString(R.string.host_menu_remove))
                    clickDialogButton(context.getString(R.string.remove_confirm))
                    await("Removed host row remained") {
                        scenario.query { it.findViewById<ViewGroup>(R.id.saved_hosts_list).findViewWithTag<View>(paired.origin) == null }
                    }
                    assertNull(SavedHosts(context).get(paired.origin))
                    assertFalse("Remove kept the host's sign-in", signInPreferences.contains(paired.origin))
                    assertNotNull(SavedHosts(context).get(password.origin))
                    assertTrue("Remove deleted another host's sign-in", signInPreferences.contains(password.origin))
                    scenario.onActivity { assertNotNull(it.findViewById<ViewGroup>(R.id.saved_hosts_list).findViewWithTag<View>(password.origin)) }

                    scenario.onActivity { assertTrue(it.findViewById<Button>(R.id.clear_saved_hosts).performClick()) }
                    clickDialogButton(context.getString(R.string.clear_saved_hosts_confirm))
                    await("Clear did not complete") {
                        scenario.query {
                            it.findViewById<Button>(R.id.connect_host).isEnabled &&
                                it.findViewById<TextView>(R.id.connection_message).text.toString() == context.getString(R.string.clear_saved_hosts_complete)
                        }
                    }
                    assertNull(connection.getString("origin", null))
                    assertNull(connection.getString(SavedHosts.KEY, null))
                    assertTrue("Clear left saved sign-ins", signInPreferences.all.isEmpty())
                    assertFalse("Clear left the sign-in key", keyStore().containsAlias(SavedSignIns.ALIAS))
                    scenario.onActivity { assertNull(it.findViewById<WebView>(R.id.remote_webview)) }
                }
            }
        }
    }

    @Test fun rendererLossRestoresActiveHostAndOthersReloadWhenPicked() {
        plainHost().use { first ->
            plainHost("127.0.0.1").use { second ->
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    connectPlain(scenario, first.origin)
                    val firstView = webView(scenario)
                    connectPlain(scenario, second.origin)
                    val secondView = webView(scenario)
                    val firstRoots = rootRequests(first)
                    val secondRoots = rootRequests(second)

                    instrumentation.runOnMainSync { secondView.webViewRenderProcess!!.terminate() }
                    await("A fresh view did not replace the lost renderer") {
                        val view = webViewOrNull(scenario)
                        view != null && view !== secondView && view !== firstView
                    }
                    waitFor(scenario, second.origin)
                    assertTrue("Active host was not reloaded", rootRequests(second) > secondRoots)
                    assertFalse(dialogShowing(R.id.save_host_name))

                    val restored = webView(scenario)
                    openSwitcher(scenario)
                    pick(scenario, R.id.host_switcher_list, first.origin)
                    await("Picking the lost host did not open a fresh view") {
                        val view = webViewOrNull(scenario)
                        view != null && view !== firstView && view !== secondView && view !== restored
                    }
                    waitFor(scenario, first.origin)
                    assertTrue("Picked host did not reload", rootRequests(first) > firstRoots)
                }
            }
        }
    }

    @Test fun fifthHostEvictsLeastRecentlyShownView() {
        val hosts = List(5) { plainHost() }
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val views = mutableListOf<WebView>()
                for (host in hosts) {
                    connectPlain(scenario, host.origin)
                    val view = webView(scenario)
                    assertTrue("Opening a new host reused another host's view", views.none { it === view })
                    views.add(view)
                }
                val roots = rootRequests(hosts[0])
                openSwitcher(scenario)
                scenario.onActivity {
                    val list = it.findViewById<ViewGroup>(R.id.host_switcher_list)
                    val open = ", " + context.getString(R.string.host_badge_open)
                    assertFalse("Evicted host still shows as open", rowDescription(list.findViewWithTag(hosts[0].origin)).contains(open))
                    assertTrue(rowDescription(list.findViewWithTag(hosts[1].origin)).contains(open))
                    assertTrue(rowDescription(list.findViewWithTag(hosts[4].origin)).contains(", " + context.getString(R.string.host_badge_connected)))
                }
                pick(scenario, R.id.host_switcher_list, hosts[0].origin)
                await("Evicted host did not open a fresh view") {
                    val view = webViewOrNull(scenario)
                    view != null && views.none { old -> old === view }
                }
                waitFor(scenario, hosts[0].origin)
                assertEquals("Evicted host did not reload", roots + 1, rootRequests(hosts[0]))
                assertFalse(dialogShowing(R.id.save_host_name))
            }
        } finally {
            hosts.forEach { it.close() }
        }
    }

    @Test fun rememberedOriginMigratesToOneSavedHost() {
        val origin = "https://studio.netbird.cloud:3443"
        assertTrue(connection.edit().putString("origin", origin).commit())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            await("Migrated host row did not render") {
                scenario.query { it.findViewById<ViewGroup>(R.id.saved_hosts_list).findViewWithTag<View>(origin) != null }
            }
            scenario.onActivity {
                val list = it.findViewById<ViewGroup>(R.id.saved_hosts_list)
                assertEquals(View.VISIBLE, list.visibility)
                assertEquals(1, list.childCount)
                val row = list.findViewWithTag<View>(origin)
                assertNotNull("Row is not named by its default name", findView(row) { view -> view is TextView && view !is Button && view.text.toString() == "studio" })
            }
            assertEquals("studio", SavedHostRules.defaultName(origin))
            assertEquals(listOf(origin to "studio"), SavedHosts(context).all().map { it.origin to it.name })
            assertNotNull(connection.getString(SavedHosts.KEY, null))
            assertEquals(origin, connection.getString("origin", null))
        }
    }

    /** Mirrors packages/server password sign-in: cookie-gated pages, a login form, and POST /login. */
    private class PasswordHost : AutoCloseable {
        val password = AtomicReference(PASSWORD)
        val throttled = AtomicBoolean(false)
        private val http = TestHttpHost { request ->
            val path = request.target.substringBefore('?')
            when {
                request.method == "POST" && path == "/login" -> when {
                    throttled.get() -> TestHttpHost.Response(429, loginPage("Try again later"), headers = mapOf("Retry-After" to "7"))
                    request.body == "password=" + URLEncoder.encode(password.get(), "UTF-8") -> TestHttpHost.Response(
                        302, "", headers = mapOf("Location" to "/", "Set-Cookie" to "$COOKIE=$PASSWORD_COOKIE; Path=/; HttpOnly; SameSite=Strict"),
                    )
                    else -> TestHttpHost.Response(401, loginPage("Wrong password"))
                }
                hasCookie(request, PASSWORD_COOKIE) -> TestHttpHost.Response(body = signedInPage())
                path == "/login" -> TestHttpHost.Response(body = loginPage(""))
                else -> TestHttpHost.Response(302, "", headers = mapOf("Location" to "/login"))
            }
        }
        val origin get() = http.origin
        fun posts() = http.requests.filter { it.method == "POST" && it.target == "/login" }
        override fun close() = http.close()
    }

    private fun savePassword(scenario: ActivityScenario<MainActivity>, host: PasswordHost) {
        openHost(scenario, host.origin)
        waitFor(scenario, host.origin, "#password")
        submitDialog(R.id.save_host_name to "Lab", R.id.sign_in_password to PASSWORD)
        waitFor(scenario, host.origin, "#signed-in")
    }

    private fun resetState() {
        assertTrue(connection.edit().clear().commit())
        assertTrue(signInPreferences.edit().clear().commit())
        keyStore().let { if (it.containsAlias(SavedSignIns.ALIAS)) it.deleteEntry(SavedSignIns.ALIAS) }
        removeCookies()
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun removeCookies() {
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync {
            CookieManager.getInstance().removeAllCookies {
                CookieManager.getInstance().flush()
                done.countDown()
            }
        }
        assertTrue("Cookies were not removed", done.await(5, TimeUnit.SECONDS))
    }

    private fun rootRequests(host: TestHttpHost) = host.requests.count { it.target == "/" }

    private fun showPanel(scenario: ActivityScenario<MainActivity>) {
        if (scenario.query { it.findViewById<View>(R.id.connection_panel).visibility == View.VISIBLE }) return
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        await("Connection panel did not open") {
            scenario.query { it.findViewById<View>(R.id.connection_panel).visibility == View.VISIBLE }
        }
    }

    private fun openHost(scenario: ActivityScenario<MainActivity>, address: String) {
        showPanel(scenario)
        scenario.onActivity {
            it.findViewById<EditText>(R.id.host_address).setText(address)
            it.findViewById<Button>(R.id.connect_host).performClick()
        }
    }

    private fun connectPlain(scenario: ActivityScenario<MainActivity>, origin: String) {
        openHost(scenario, origin)
        waitFor(scenario, origin)
        dismissSaveHostDialog(instrumentation)
    }

    private fun openSwitcher(scenario: ActivityScenario<MainActivity>) {
        tap(scenario, "#host-connection")
        await("Host switcher did not open") {
            scenario.query { it.findViewById<View>(R.id.host_switcher).visibility == View.VISIBLE }
        }
    }

    private fun pick(scenario: ActivityScenario<MainActivity>, list: Int, origin: String) {
        scenario.onActivity {
            val row = it.findViewById<ViewGroup>(list).findViewWithTag<View>(origin)
            assertNotNull("No row for $origin", row)
            val target = checkNotNull(findView(row) { view -> view !is Button && view.hasOnClickListeners() }) { "Row for $origin has no pick area" }
            assertTrue(target.performClick())
        }
    }

    private fun menuButton(row: View): Button = checkNotNull(findView(row) { it is Button } as Button?) { "Row has no menu button" }

    private fun rowDescription(row: View?): String {
        checkNotNull(row) { "Missing host row" }
        val parts = mutableListOf<String>()
        fun collect(view: View) {
            if (view is Button) return
            view.contentDescription?.let { parts.add(it.toString()) }
            if (view is ViewGroup) for (index in 0 until view.childCount) collect(view.getChildAt(index))
        }
        collect(row)
        return parts.joinToString("\n")
    }

    private fun findView(view: View, match: (View) -> Boolean): View? {
        if (match(view)) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) findView(view.getChildAt(index), match)?.let { return it }
        return null
    }

    /** Main thread only. */
    private fun windowRoots(): List<View> = WindowInspector.getGlobalWindowViews().filter { it.isShown }

    private fun dialogShowing(field: Int, without: Int? = null): Boolean = onMain {
        windowRoots().any { root -> root.findViewById<View>(field)?.isShown == true && (without == null || root.findViewById<View>(without) == null) }
    }

    private fun dialogHasText(field: Int, text: String): Boolean = onMain {
        windowRoots().any { root ->
            root.findViewById<View>(field) != null && findView(root) { it is TextView && it.text.toString() == text } != null
        }
    }

    private fun submitDialog(vararg fields: Pair<Int, String>) = await("Dialog fields did not appear") {
        onMain {
            val root = windowRoots().firstOrNull { root -> fields.all { root.findViewById<View>(it.first)?.isShown == true } }
                ?: return@onMain false
            fields.forEach { (id, value) -> root.findViewById<EditText>(id).setText(value) }
            root.findViewById<Button>(android.R.id.button1).performClick()
        }
    }

    private fun clickDialogButton(text: String) = await("Dialog button $text did not appear") {
        onMain {
            windowRoots().firstNotNullOfOrNull { root ->
                findView(root) { it is Button && it.isShown && it.id in DIALOG_BUTTONS && it.text.toString() == text }
            }?.performClick() == true
        }
    }

    private fun clickDialogItem(text: String) = await("Dialog item $text did not appear") {
        onMain {
            for (root in windowRoots()) {
                val list = findView(root) { it is ListView && it.isShown && it.childCount > 0 } as ListView? ?: continue
                val adapter = list.adapter ?: continue
                val index = (0 until adapter.count).firstOrNull { adapter.getItem(it)?.toString() == text } ?: continue
                return@onMain list.performItemClick(list.getChildAt(index - list.firstVisiblePosition), index, adapter.getItemId(index))
            }
            false
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return checkNotNull(result).getOrThrow()
    }

    private fun <T> ActivityScenario<MainActivity>.query(block: (MainActivity) -> T): T {
        var result: Result<T>? = null
        onActivity { result = runCatching { block(it) } }
        return checkNotNull(result).getOrThrow()
    }

    private fun webViewOrNull(scenario: ActivityScenario<MainActivity>): WebView? = scenario.query { it.findViewById(R.id.remote_webview) }

    private fun webView(scenario: ActivityScenario<MainActivity>): WebView = checkNotNull(webViewOrNull(scenario)) { "No active WebView" }

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

    /** Waits for a stable trusted document; navigation may drop a probe, so probes retry. */
    private fun waitFor(scenario: ActivityScenario<MainActivity>, origin: String, selector: String = "#draft") =
        await("$selector on $origin did not load") {
            probe(scenario, "window.ready === true && document.readyState === 'complete' && location.origin === ${JSONObject.quote(origin)} && !!document.querySelector(${JSONObject.quote(selector)})") == "true"
        }

    private fun probe(scenario: ActivityScenario<MainActivity>, script: String, timeoutMs: Long = 1000): String? {
        val done = CountDownLatch(1)
        var result: String? = null
        var started = false
        scenario.onActivity {
            val view = it.findViewById<WebView>(R.id.remote_webview) ?: return@onActivity
            started = true
            view.evaluateJavascript(script) { value -> result = value; done.countDown() }
        }
        return if (started && done.await(timeoutMs, TimeUnit.MILLISECONDS)) result else null
    }

    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String =
        checkNotNull(probe(scenario, script, 5000)) { "JavaScript callback timed out" }

    private fun await(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        assertTrue(message, condition())
    }

    private fun assertStays(message: String, millis: Long, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + millis
        do {
            assertTrue(message, condition())
            Thread.sleep(50)
        } while (SystemClock.uptimeMillis() < deadline)
    }

    private companion object {
        const val PASSWORD = "correct"
        const val COOKIE = "omp_ui_token"
        const val PASSWORD_COOKIE = "derived"
        const val TOKEN_COOKIE = "paired"
        // Base64 never contains '-', so a match in stored ciphertext can only be the plaintext token.
        const val TOKEN = "tok-plaintext-1167"
        val ENCODED_TOKEN: String = URLEncoder.encode(TOKEN, "UTF-8")
        val DIALOG_BUTTONS = setOf(android.R.id.button1, android.R.id.button2, android.R.id.button3)
        const val LINK = "<a id='host-connection' href='omp-ui://host-connection' style='display:block;padding:16px'>Host connection…</a>"

        fun signedInPage() = TestHttpHost.page("<p id='signed-in'>Signed in</p>$LINK")

        fun loginPage(error: String) = TestHttpHost.page(
            "<p id='login-error'>$error</p><form method='post' action='/login'><input id='password' type='password' name='password'><button>Sign in</button></form>",
        )

        fun hasCookie(request: TestHttpHost.Request, value: String) =
            request.headers["cookie"].orEmpty().split(';').any { it.trim() == "$COOKIE=$value" }

        fun plainHost(hostname: String = "localhost") = TestHttpHost(hostname) { TestHttpHost.Response(body = signedInPage()) }

        /** Mirrors packages/server pairing: a matching ?t= sets the cookie; cookieless requests answer 401. */
        fun tokenHost(hostname: String = "localhost") = TestHttpHost(hostname) { request ->
            val path = request.target.substringBefore('?')
            val paired = request.target.substringAfter('?', "") == "t=$ENCODED_TOKEN"
            val cookie = if (paired) mapOf("Set-Cookie" to "$COOKIE=$TOKEN_COOKIE; Path=/; HttpOnly; SameSite=Strict") else emptyMap()
            when {
                !paired && !hasCookie(request, TOKEN_COOKIE) -> TestHttpHost.Response(401, "unauthorized", "text/plain")
                path == "/healthz" -> TestHttpHost.Response(200, "ok", "text/plain", cookie)
                else -> TestHttpHost.Response(body = signedInPage(), headers = cookie)
            }
        }
    }
}
