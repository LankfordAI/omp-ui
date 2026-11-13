package ai.lankford.ompui.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.SystemClock
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.core.graphics.ColorUtils
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

class MainActivity : ComponentActivity() {
    private lateinit var root: LinearLayout
    private lateinit var content: FrameLayout
    private lateinit var progress: ProgressBar
    private lateinit var connection: ScrollView
    private lateinit var address: EditText
    private lateinit var formMessage: TextView
    private lateinit var resume: Button
    private lateinit var clearData: Button
    private lateinit var savedHeading: TextView
    private lateinit var savedList: LinearLayout
    private lateinit var switcher: FrameLayout
    private lateinit var switcherList: LinearLayout
    @Volatile private var clearingData = false
    private lateinit var downloads: WebDownloads
    private var fold: FoldingFeature? = null
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var fileOrigin: String? = null
    private val preferences by lazy { getSharedPreferences("connection", MODE_PRIVATE) }

    private inner class HostView(val origin: String, token: String?) {
        val view: WebView = createWebView(this)
        @Volatile var closed = false          // read by shouldInterceptRequest on a WebView thread
        var background: Int? = null           // the host's last trusted canvas color
        var failed = false                    // a failure surface was shown for this view
        var loadError = false                 // the current main-frame load reported an error
        var everLoaded = false                // a successful trusted page finished at least once
        var savePrompted = false
        var autoSignInTried = false
        var pendingToken: String? = token     // saved only once the host proves it accepted it
        var shownAtMs = 0L
    }
    private enum class Reason { LOGIN_PAGE, UNAUTHORIZED }
    private val hosts = LinkedHashMap<String, HostView>()   // main thread only
    @Volatile private var active: HostView? = null
    private val webView: WebView? get() = active?.view
    private val trustedOrigin: String? get() = active?.origin
    internal val activeHostBackground: Int? get() = active?.background
    private val savedHosts by lazy { SavedHosts(this) }
    private val signIns by lazy { SavedSignIns(this) }
    private val signInWorker = Executors.newSingleThreadExecutor()

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = pendingFiles
        pendingFiles = null
        val stillTrusted = fileOrigin == trustedOrigin && HostPolicy.isTrusted(webView?.url, trustedOrigin)
        fileOrigin = null
        val uris = if (result.resultCode == RESULT_OK && stillTrusted) {
            val data = result.data
            val values = data?.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } }
                ?: listOfNotNull(data?.data)
            values.filter { it.scheme == "content" }.distinct().take(32).toTypedArray()
        } else null
        callback?.onReceiveValue(uris?.takeIf { it.isNotEmpty() })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        buildChrome()
        downloads = WebDownloads(this, { webView }, { trustedOrigin }, ::notice)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = handleBack()
        })
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                WindowInfoTracker.getOrCreate(this@MainActivity).windowLayoutInfo(this@MainActivity).collect { info ->
                    fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull {
                        it.isSeparating && it.orientation == FoldingFeature.Orientation.VERTICAL &&
                            it.state != FoldingFeature.State.FLAT
                    }
                    publishViewport()
                }
            }
        }
        val pendingClear = preferences.getBoolean(LocalDataClearer.PENDING, false)
        lifecycleScope.launch {
            LocalDataClearer.state.collect { state ->
                when (state) {
                    LocalDataClearer.State.CLEARING -> showDataClearing()
                    LocalDataClearer.State.COMPLETE -> finishDataClearing()
                    LocalDataClearer.State.FAILED -> {
                        showDataClearing()
                        clearData.isEnabled = true
                        formMessage.setText(R.string.clear_saved_hosts_failed)
                    }
                    LocalDataClearer.State.READY -> Unit
                }
            }
        }
        if (pendingClear || LocalDataClearer.state.value == LocalDataClearer.State.CLEARING) {
            showDataClearing()
            startDataClearing()
        } else {
            val remembered = preferences.getString("origin", "") ?: ""
            if (savedInstanceState?.getBoolean("connected") == true && remembered.isNotBlank()) {
                runCatching { HostPolicy.endpoint(remembered) }.onSuccess { open(it) }
            }
        }
        refreshHostLists()
    }

    private fun buildChrome() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            isSaveEnabled = false
        }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
        }
        root.addView(progress, LinearLayout.LayoutParams(-1, dp(2)))
        content = FrameLayout(this)
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        buildConnectionForm()
        buildSwitcher()
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        ViewCompat.requestApplyInsets(root)
        refreshSystemBars()
    }

    private fun refreshSystemBars() {
        val host = active
        val background = if (connection.isVisible || switcher.isVisible || clearingData ||
            host == null || host.failed) {
            BACKGROUND
        } else host.background ?: BACKGROUND
        applyChromeBackground(background)
    }

    private fun applyChromeBackground(color: Int) {
        val opaqueColor = ColorUtils.setAlphaComponent(color, 255)
        root.setBackgroundColor(opaqueColor)
        window.setBackgroundDrawable(ColorDrawable(opaqueColor))
        val luminance = ColorUtils.calculateLuminance(opaqueColor)
        val darkIcons = (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = darkIcons
            isAppearanceLightNavigationBars = darkIcons
        }
    }

    private fun buildConnectionForm() {
        connection = ScrollView(this).apply {
            id = R.id.connection_panel
            setBackgroundColor(BACKGROUND)
            isFillViewport = true
            isSaveEnabled = false
        }
        val centered = FrameLayout(this)
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
        }
        form.addView(text("Connect to your host", 28).apply { setTypeface(typeface, Typeface.BOLD) })
        form.addView(text("Use the remote address shown by omp-ui on your computer. Sessions and processes stay on that host.", 16), spaced())
        savedHeading = heading(getString(R.string.saved_hosts_heading)).apply { visibility = View.GONE }
        form.addView(savedHeading, spaced(24))
        savedList = LinearLayout(this).apply {
            id = R.id.saved_hosts_list
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        form.addView(savedList, spaced(10))
        resume = button("Return to current view") { hideConnection() }.apply {
            id = R.id.resume_current_view
            visibility = View.GONE
        }
        form.addView(resume, spaced(12))
        form.addView(heading(getString(R.string.add_host_heading)), spaced(24))
        form.addView(text("Host address or pairing link", 14), spaced(10))
        address = EditText(this).apply {
            id = R.id.host_address
            hint = "http://192.168.1.20:3000"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(FOREGROUND)
            setHintTextColor(MUTED)
            textSize = 16f
            setSingleLine(true)
            isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, action, _ ->
                if (action == android.view.inputmethod.EditorInfo.IME_ACTION_GO) { requestConnect(); true } else false
            }
        }
        form.addView(address, spaced(6))
        form.addView(text("HTTP is unencrypted. On an untrusted network, others may read your sign-in, prompts, and responses. Use a trusted LAN, NetBird, or HTTPS. Never expose this host directly to the public internet.", 14).apply {
            setTextColor(WARNING)
        }, spaced(18))
        formMessage = text(getString(R.string.connection_intro_message), 14).apply {
            id = R.id.connection_message
        }
        form.addView(formMessage, spaced(18))
        form.addView(button("Connect", ::requestConnect).apply { id = R.id.connect_host }, spaced(18))
        clearData = button(getString(R.string.clear_saved_hosts), ::confirmDataClearing).apply { id = R.id.clear_saved_hosts }
        form.addView(clearData, spaced(18))
        form.addView(text("NetBird: use your host's private DNS name or IP. For adb reverse, use http://localhost:PORT after forwarding that port.", 13).apply {
            setTextColor(MUTED)
        }, spaced(20))
        centered.addView(form, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_HORIZONTAL))
        centered.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
            val desired = minOf(right - left, dp(560))
            if (form.layoutParams.width != desired) form.layoutParams = (form.layoutParams as FrameLayout.LayoutParams).apply { width = desired }
        }
        connection.addView(centered)
        content.addView(connection, FrameLayout.LayoutParams(-1, -1))
    }

    /** Drawn above every WebView and the panel; opened only by the trusted host-connection link. */
    private fun buildSwitcher() {
        switcher = FrameLayout(this).apply {
            id = R.id.host_switcher
            visibility = View.GONE
            isSaveEnabled = false
        }
        switcher.addView(View(this).apply {
            setBackgroundColor(SCRIM)
            setOnClickListener { hideSwitcher() }
        }, FrameLayout.LayoutParams(-1, -1))
        val corner = dp(14).toFloat()
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            isClickable = true
            setPadding(dp(20), dp(18), dp(20), dp(16))
            background = GradientDrawable().apply {
                setColor(BACKGROUND)
                cornerRadii = floatArrayOf(corner, corner, corner, corner, 0f, 0f, 0f, 0f)
            }
        }
        card.addView(heading(getString(R.string.host_switcher_title)))
        switcherList = LinearLayout(this).apply {
            id = R.id.host_switcher_list
            orientation = LinearLayout.VERTICAL
        }
        val list = object : ScrollView(this) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                // The sheet fills content; its own height is still 0 during the first measure after GONE.
                val cap = (content.height * 0.7f).toInt()
                if (cap <= 0) return super.onMeasure(widthMeasureSpec, heightMeasureSpec)
                val mode = View.MeasureSpec.getMode(heightMeasureSpec)
                val limit = if (mode == View.MeasureSpec.UNSPECIFIED) cap else minOf(cap, View.MeasureSpec.getSize(heightMeasureSpec))
                super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(limit, View.MeasureSpec.AT_MOST))
            }
        }
        list.isSaveEnabled = false
        list.addView(switcherList)
        card.addView(list, spaced(12))
        card.addView(button(getString(R.string.manage_hosts)) { hideSwitcher(); showConnection() }.apply { id = R.id.manage_hosts }, spaced(12))
        switcher.addView(card, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        content.addView(switcher, FrameLayout.LayoutParams(-1, -1))
    }

    private fun requestConnect() {
        if (clearingData) return
        val endpoint = try {
            HostPolicy.endpoint(address.text.toString())
        } catch (error: IllegalArgumentException) {
            address.error = error.message
            return
        }
        address.setText(endpoint.origin)
        open(endpoint)
    }

    private fun open(endpoint: HostEndpoint) {
        if (clearingData) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showConnection()
            formMessage.text = "Update Android System WebView or Chrome, then try again. This app requires document-start script and web-message listener support for safe host-scoped recovery, folding, and system-bar colors."
            return
        }
        val existing = hosts[endpoint.origin]
        if (existing != null && !existing.failed && endpoint.token == null) {
            show(existing)
            return
        }
        existing?.let { retire(it) }
        formMessage.setText(R.string.connection_intro_message)
        formMessage.setTextColor(FOREGROUND)
        val host = HostView(endpoint.origin, endpoint.token)
        hosts[endpoint.origin] = host
        host.view.visibility = View.GONE
        content.addView(host.view, 0, FrameLayout.LayoutParams(-1, -1))
        evictBeyondLimit(host)
        show(host)
        host.view.loadUrl(endpoint.initialUrl)
        progress.progress = 0
        progress.visibility = View.VISIBLE
    }

    /** Makes a live view current; only the current view carries R.id.remote_webview. */
    private fun show(host: HostView) {
        val previous = active
        if (previous != null && previous !== host) {
            pendingFiles?.onReceiveValue(null)
            pendingFiles = null
            fileOrigin = null
            if (::downloads.isInitialized) downloads.cancel()
            previous.view.id = View.NO_ID
            previous.view.visibility = View.GONE
        }
        host.view.id = R.id.remote_webview
        active = host
        host.shownAtMs = SystemClock.uptimeMillis()
        // Touch first: a missing list is seeded before "origin" names this not-yet-loaded host.
        savedHosts.touch(host.origin)
        preferences.edit { putString("origin", host.origin) }
        syncProgress()
        hideIme()
        connection.visibility = View.GONE
        switcher.visibility = View.GONE
        host.view.visibility = View.VISIBLE
        host.view.requestFocus()
        publishViewport()
        refreshSystemBars()
    }

    private fun evictBeyondLimit(keep: HostView) {
        while (hosts.size > MAX_LIVE_HOSTS) {
            val victim = hosts.values.filter { it !== keep && it !== active }.minByOrNull { it.shownAtMs } ?: return
            retire(victim)
            notice(getString(R.string.host_evicted, hostLabel(victim.origin)))
        }
    }

    private fun retire(host: HostView, rendererGone: Boolean = false) {
        if (host.closed) return
        host.closed = true
        if (hosts[host.origin] === host) hosts.remove(host.origin)
        if (active === host) {
            pendingFiles?.onReceiveValue(null)
            pendingFiles = null
            fileOrigin = null
            if (::downloads.isInitialized) downloads.cancel(clearPage = !rendererGone)
            active = null
        }
        val view = host.view
        view.id = View.NO_ID
        content.removeView(view)
        if (!rendererGone) {
            WebViewCompat.removeWebMessageListener(view, "__ompAndroidChrome")
            view.stopLoading()
        }
        view.removeAllViews()
        view.destroy()
        refreshSystemBars()
        refreshHostLists()
    }

    private fun closeAllHosts() {
        (hosts.values.toList() + listOfNotNull(active)).distinct().forEach { retire(it) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(host: HostView): WebView = WebView(this).apply {
        val origin = host.origin
        isSaveEnabled = false
        setBackgroundColor(BACKGROUND)
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
            safeBrowsingEnabled = true
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        WebViewCompat.addWebMessageListener(this, "__ompAndroidChrome", setOf(origin)) { view, message, sourceOrigin, isMainFrame, _ ->
            if (!isMainFrame || view !== host.view || host.closed || host.failed || clearingData ||
                !HostPolicy.isTrusted(sourceOrigin.toString(), origin) || !HostPolicy.isTrusted(view.url, origin) ||
                message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
            val value = message.data ?: return@addWebMessageListener
            if (value.length != 7 || !CHROME_COLOR.matches(value)) return@addWebMessageListener
            val color = Color.parseColor(value)
            if (color == host.background) return@addWebMessageListener
            host.background = color
            view.setBackgroundColor(color)
            if (host === active) refreshSystemBars()
        }
        WebViewCompat.addDocumentStartJavaScript(this, ShellScripts.documentStart(origin), setOf(origin))
        webViewClient = HostWebViewClient(host)
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, value: Int) {
                if (host !== active || host.closed) return
                this@MainActivity.progress.progress = value
                this@MainActivity.progress.visibility = if (value == 100 || host.failed) View.GONE else View.VISIBLE
            }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, false, false)
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (view !== webView || !HostPolicy.isTrusted(view.url, trustedOrigin)) return false
                pendingFiles?.onReceiveValue(null)
                pendingFiles = callback
                fileOrigin = trustedOrigin
                val types = params.acceptTypes.filter { it.contains('/') && !it.contains(';') }
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = types.singleOrNull() ?: "*/*"
                    if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try { filePicker.launch(intent) } catch (_: ActivityNotFoundException) {
                    pendingFiles = null
                    fileOrigin = null
                    callback.onReceiveValue(null)
                    notice("No document picker is installed on this device.")
                }
                return true
            }
        }
        setDownloadListener { url, _, disposition, mime, _ -> if (host === active) downloads.request(url, disposition, mime) }
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> if (host === active) publishViewport() }
    }

    private inner class HostWebViewClient(private val host: HostView) : WebViewClient() {
        private var leavingLogin = false

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (host.closed || clearingData) return true
            if (url == "omp-ui://host-connection") {
                if (host === active && request.isForMainFrame && request.hasGesture() && request.method == "GET" &&
                    HostPolicy.isTrusted(view.url, host.origin)) showSwitcher()
                return true
            }
            if (HostPolicy.isTrusted(url, host.origin)) return false
            if (host === active && HostPolicy.opensExternally(url, request.isForMainFrame, request.hasGesture(), request.method)) openExternal(url)
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // WebView only exposes the initial resource URL here, not redirect destinations.
            // This blocks direct foreign POSTs; it is not an egress firewall. The trusted
            // host must not redirect POSTs to other origins. HTTPS subresources stay browser-owned.
            // A hidden live host keeps its own sockets and fetches under its own origin policy.
            if (!host.closed && !clearingData && HostPolicy.allowsRequest(request.url.toString(), host.origin, request.isForMainFrame)) return null
            return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (host.closed) return
            if (HostPolicy.isTrusted(url, host.origin)) {
                host.loadError = false
            } else {
                view.stopLoading()
                showFailure(host, "Navigation outside the connected host was blocked. Choose another host below.")
            }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (host.closed || !HostPolicy.isTrusted(url, host.origin)) return
            val loginPage = Uri.parse(url).path == "/login"
            // Credential forms are not app navigation: Back must not revisit a POST
            // or replace the live renderer with an ERR_CACHE_MISS error page.
            if (loginPage || leavingLogin) view.clearHistory()
            leavingLogin = loginPage
            CookieManager.getInstance().flush()
            // Pairing tokens must not remain in WebView's visible navigation entry.
            view.evaluateJavascript("""
                (() => {
                  if (location.origin !== ${org.json.JSONObject.quote(host.origin)}) return;
                  const u = new URL(location.href);
                  if (u.searchParams.has('t')) { u.searchParams.delete('t'); history.replaceState(history.state, '', u); }
                })();
            """.trimIndent(), null)
            if (host === active) publishViewport()
            onHostPageLoaded(host, url)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (host.closed || !request.isForMainFrame) return
            host.loadError = true
            if (!host.failed) showFailure(host, "Could not reach the host. Check that remote access is enabled, the address and port are correct, and this device can reach the LAN or NetBird network.")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (host.closed || !request.isForMainFrame) return
            val url = request.url.toString()
            if (HostPolicy.isLoginErrorPage(url, host.origin, request.method, response.statusCode, response.mimeType)) return
            if (response.statusCode < 400) return
            host.loadError = true
            if (response.statusCode == 401 || response.statusCode == 403) {
                if (HostPolicy.isTrusted(url, host.origin) && trySavedSignIn(host, Reason.UNAUTHORIZED)) return
                showFailure(host, SIGN_IN_NOT_ACCEPTED)
            } else {
                showFailure(host, "The host returned HTTP ${response.statusCode}. Check the host and its remote web bundle, then retry.")
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (!host.closed) showFailure(host, "The HTTPS certificate could not be verified. Fix the host's certificate. Certificate errors are never bypassed.")
        }

        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, hostName: String, realm: String) {
            handler.cancel()
            if (!host.closed) showFailure(host, "HTTP Basic authentication is not supported. Use omp-ui's own sign-in page or pairing link.")
        }

        // One renderer serves every WebView in this app, so this fires once per live view.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (host.closed) return true
            val wasActive = host === active
            retire(host, rendererGone = true)
            if (wasActive) {
                notice(getString(R.string.renderer_restarted))
                runCatching { HostPolicy.endpoint(host.origin) }.onSuccess { open(it) }
            }
            return true
        }
    }

    private fun publishViewport() {
        val view = webView ?: return
        val origin = trustedOrigin ?: return
        if (!HostPolicy.isTrusted(view.url, origin) || view.width == 0) return
        val location = IntArray(2)
        view.getLocationInWindow(location)
        val edge = fold?.let {
            FoldGeometry.relativeRightEdge(it.isSeparating, it.orientation == FoldingFeature.Orientation.VERTICAL,
                it.state == FoldingFeature.State.FLAT, it.bounds.left, it.bounds.right, location[0], view.width)
        }
        view.evaluateJavascript(ShellScripts.viewport(origin, edge, view.width), null)
    }

    private fun handleBack() {
        if (clearingData) return
        if (switcher.isVisible) {
            hideSwitcher()
            return
        }
        if (connection.isVisible) {
            if (active?.failed == false) hideConnection() else finish()
            return
        }
        val view = webView
        val origin = trustedOrigin
        if (view == null || origin == null || !HostPolicy.isTrusted(view.url, origin)) {
            showConnection()
            return
        }
        view.evaluateJavascript(ShellScripts.back(origin)) { handled ->
            if (view !== webView || connection.isVisible || switcher.isVisible ||
                handled == "true") return@evaluateJavascript
            val history = view.copyBackForwardList()
            val previous = history.currentIndex - 1
            if (previous >= 0 && HostPolicy.isTrusted(history.getItemAtIndex(previous).url, origin)) view.goBack()
            else showConnection()
        }
    }

    private fun showConnection() {
        if (clearingData) return
        switcher.visibility = View.GONE
        connection.visibility = View.VISIBLE
        webView?.visibility = View.INVISIBLE
        resume.visibility = if (active?.failed == false) View.VISIBLE else View.GONE
        refreshHostLists()
        refreshSystemBars()
    }

    private fun hideConnection() {
        if (clearingData) return
        val view = webView ?: return
        hideIme()
        connection.visibility = View.GONE
        view.visibility = View.VISIBLE
        view.requestFocus()
        publishViewport()
        refreshSystemBars()
    }

    private fun showSwitcher() {
        if (clearingData) return
        hideIme()
        switcher.visibility = View.VISIBLE
        refreshHostLists()
        refreshSystemBars()
    }

    private fun hideSwitcher() {
        if (switcher.visibility != View.VISIBLE) return
        switcher.visibility = View.GONE
        if (connection.visibility != View.VISIBLE) webView?.requestFocus()
        refreshSystemBars()
    }

    private fun hideIme() {
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(address.windowToken, 0)
        address.clearFocus()
    }

    private fun showFailure(host: HostView, message: String) {
        if (host.closed || clearingData) return
        if (host !== active) {
            // A hidden view fails silently; it reloads cold when picked again.
            retire(host)
            return
        }
        host.failed = true
        progress.visibility = View.GONE
        if (!host.everLoaded) {
            // A failed connection never costs the view the user came from.
            val fallback = hosts.values.filter { it !== host && !it.failed }.maxByOrNull { it.shownAtMs }
            retire(host)
            fallback?.let { show(it) }
        }
        showConnection()
        address.setText(host.origin)
        formMessage.text = "$message\n\nTap Connect to retry. Your host sessions are unchanged."
        formMessage.setTextColor(WARNING)
    }

    /** Re-renders whichever saved-host lists are showing. Never reads saved hosts while local data is cleared. */
    private fun refreshHostLists() {
        if (clearingData || isDestroyed) return
        val panel = connection.isVisible
        val sheet = switcher.isVisible
        if (!panel && !sheet) return
        val saved = savedHosts.all()
        val current = active?.takeIf { !it.failed }?.origin
        val live = hosts.values.filter { !it.failed }.map { it.origin }.toSet()
        if (panel) {
            HostRows.render(savedList, saved, current, live, ::pickHost, ::showHostMenu)
            savedList.visibility = if (saved.isEmpty()) View.GONE else View.VISIBLE
            savedHeading.visibility = savedList.visibility
        }
        if (sheet) HostRows.render(switcherList, saved, current, live, ::pickHost, ::showHostMenu)
    }

    private fun pickHost(saved: SavedHost) {
        if (clearingData) return
        val current = active
        if (current != null && current.origin == saved.origin && !current.failed) {
            hideSwitcher()
            hideConnection()
            return
        }
        runCatching { HostPolicy.endpoint(saved.origin) }.onSuccess { open(it) }
    }

    private fun showHostMenu(saved: SavedHost) {
        if (!canShowDialog()) return
        val origin = saved.origin
        val hasSignIn = signIns.has(origin)
        val actions = mutableListOf<Pair<String, () -> Unit>>(
            getString(R.string.host_menu_rename) to { promptRename(origin) },
            getString(if (hasSignIn) R.string.host_menu_replace_password else R.string.host_menu_save_password) to {
                promptSignIn(origin, null)
            },
        )
        if (hasSignIn) actions += getString(R.string.host_menu_forget_sign_in) to { signIns.delete(origin) }
        actions += getString(R.string.host_menu_remove) to { confirmRemove(origin) }
        AlertDialog.Builder(this)
            .setTitle(saved.name)
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> if (!clearingData) actions[which].second() }
            .show()
    }

    private fun promptRename(origin: String) {
        if (!canShowDialog()) return
        val current = savedHosts.get(origin) ?: return
        val name = nameField(current.name)
        AlertDialog.Builder(this)
            .setTitle(R.string.rename_title)
            .setView(dialogBody(dialogText(getString(R.string.save_host_name_label)), name))
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.save_host_save) { _, _ ->
                if (clearingData) return@setPositiveButton
                savedHosts.rename(origin, SavedHostRules.cleanName(name.text.toString(), origin))
                refreshHostLists()
            }
            .show()
    }

    private fun confirmRemove(origin: String) {
        if (!canShowDialog()) return
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.remove_title, hostLabel(origin)))
            .setMessage(R.string.remove_message)
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.remove_confirm) { _, _ ->
                if (clearingData) return@setPositiveButton
                savedHosts.remove(origin)
                signIns.delete(origin)
                // The current view stays connected; it only leaves the list.
                hosts[origin]?.takeIf { it !== active }?.let { retire(it) }
                refreshHostLists()
            }
            .show()
    }

    private fun onHostPageLoaded(host: HostView, url: String?) {
        if (host.closed || host.failed || host.loadError || clearingData) return
        host.everLoaded = true
        val origin = host.origin
        val login = url?.let { it.toUri().path } == "/login"
        if (!host.savePrompted && savedHosts.get(origin) == null) {
            host.savePrompted = true
            // The record exists before any dialog: dismissing it keeps the default name.
            if (!savedHosts.add(origin)) notice(getString(R.string.saved_hosts_full, origin))
            else {
                refreshHostLists()
                if (host === active) promptSaveHost(host, login)
            }
        }
        val saved = savedHosts.get(origin) != null
        val token = host.pendingToken
        host.pendingToken = null
        // A login page means the host rejected the pairing token; keep only an accepted one.
        if (!login && token != null && saved) runCatching { signIns.write(origin, SignIn.Token(token)) }
        if (login && saved) trySavedSignIn(host, Reason.LOGIN_PAGE)
    }

    private fun promptSaveHost(host: HostView, login: Boolean) {
        if (!canShowDialog()) return
        val origin = host.origin
        val name = nameField(SavedHostRules.defaultName(origin))
        val password = if (login) passwordField() else null
        val fields = mutableListOf<View>(dialogText(getString(R.string.save_host_name_label)), name)
        if (password != null) {
            fields += dialogText(getString(R.string.save_host_password_label)).apply { setPadding(0, dp(12), 0, 0) }
            fields += password
            fields += dialogText(getString(R.string.save_host_password_note)).apply { textSize = 13f }
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.save_host_title)
            .setView(dialogBody(*fields.toTypedArray()))
            .setPositiveButton(R.string.save_host_save) { _, _ ->
                if (clearingData) return@setPositiveButton
                savedHosts.rename(origin, SavedHostRules.cleanName(name.text.toString(), origin))
                refreshHostLists()
                val secret = password?.text?.toString().orEmpty()
                if (secret.isNotEmpty()) verifyAndSave(origin, SignIn.Password(secret))
            }
            .setNegativeButton(getString(R.string.save_host_default), null)
            .setCancelable(true)
            .show()
    }

    private fun promptSignIn(origin: String, message: String?) {
        if (!canShowDialog()) return
        val password = passwordField()
        val builder = AlertDialog.Builder(this)
            .setTitle(getString(R.string.sign_in_title, hostLabel(origin)))
            .setView(dialogBody(password))
            .setNegativeButton(R.string.dialog_cancel, null)
            .setPositiveButton(R.string.sign_in_confirm) { _, _ ->
                val secret = password.text.toString()
                if (secret.isNotEmpty() && !clearingData) verifyAndSave(origin, SignIn.Password(secret))
            }
        if (message != null) builder.setMessage(message)
        builder.show()
    }

    /** Verifies natively before anything is saved; nothing is kept for a throttled or unreachable host. */
    private fun verifyAndSave(origin: String, signIn: SignIn) {
        if (clearingData) return
        if (trustedOrigin == origin) progress.visibility = View.VISIBLE
        val started = verify(origin, signIn) { result ->
            if (trustedOrigin == origin) syncProgress()
            when (result) {
                is SignInResult.Accepted -> {
                    if (savedHosts.get(origin) != null) runCatching { signIns.write(origin, signIn) }
                    applyCookies(origin, result.cookies)
                    hosts[origin]?.takeIf { !it.closed && it.view.url?.let { url -> url.toUri().path } == "/login" }
                        ?.view?.loadUrl("$origin/")
                }
                SignInResult.Rejected -> promptSignIn(origin, getString(R.string.sign_in_wrong))
                is SignInResult.Throttled -> notice(getString(R.string.sign_in_throttled, hostLabel(origin)))
                is SignInResult.Failed -> notice(getString(R.string.sign_in_unreachable, hostLabel(origin)))
            }
        }
        if (!started && trustedOrigin == origin) syncProgress()
    }

    /** Uses a saved sign-in at most once per view, when the host shows its login page or answers 401/403. */
    private fun trySavedSignIn(host: HostView, reason: Reason): Boolean {
        if (host.autoSignInTried || clearingData || host.closed) return false
        val signIn = signIns.read(host.origin) ?: return false
        host.autoSignInTried = true
        if (host === active) progress.visibility = View.VISIBLE
        val started = verify(host.origin, signIn) { result ->
            if (host.closed) return@verify
            if (host === active) syncProgress()
            val origin = host.origin
            when (result) {
                is SignInResult.Accepted -> {
                    applyCookies(origin, result.cookies)
                    host.view.loadUrl("$origin/")
                }
                SignInResult.Rejected -> {
                    signIns.delete(origin)
                    if (signIn is SignIn.Password) {
                        if (host === active) promptSignIn(origin, getString(R.string.sign_in_saved_rejected, hostLabel(origin)))
                    } else notice(getString(R.string.sign_in_token_rejected, hostLabel(origin)))
                    if (reason == Reason.UNAUTHORIZED) showFailure(host, SIGN_IN_NOT_ACCEPTED)
                }
                is SignInResult.Throttled -> {
                    notice(getString(R.string.sign_in_throttled, hostLabel(origin)))
                    if (reason == Reason.UNAUTHORIZED) showFailure(host, SIGN_IN_NOT_ACCEPTED)
                }
                is SignInResult.Failed -> {
                    notice(getString(R.string.sign_in_unreachable, hostLabel(origin)))
                    if (reason == Reason.UNAUTHORIZED) showFailure(host, SIGN_IN_NOT_ACCEPTED)
                }
            }
        }
        if (!started && host === active) syncProgress()
        return started
    }

    /** Runs one blocking verification off the main thread; results are dropped once this Activity is gone. */
    private fun verify(origin: String, signIn: SignIn, done: (SignInResult) -> Unit): Boolean = try {
        signInWorker.execute {
            val result = try { HostSignIn.verify(origin, signIn) } catch (_: Exception) { SignInResult.Failed(null) }
            runOnUiThread { if (!isDestroyed && !clearingData) done(result) }
        }
        true
    } catch (_: RejectedExecutionException) { false }

    private fun applyCookies(origin: String, cookies: List<String>) {
        val manager = CookieManager.getInstance()
        cookies.forEach { manager.setCookie(origin, it) }
        manager.flush()
    }

    private fun syncProgress() {
        val host = active
        val value = host?.view?.progress ?: 100
        progress.progress = value
        progress.visibility = if (host == null || host.failed || value >= 100) View.GONE else View.VISIBLE
    }

    private fun hostLabel(origin: String): String = savedHosts.get(origin)?.name ?: origin

    private fun canShowDialog() = !(isFinishing || isDestroyed || clearingData)

    private fun confirmDataClearing() {
        if (LocalDataClearer.state.value == LocalDataClearer.State.CLEARING) return
        AlertDialog.Builder(this)
            .setTitle(R.string.clear_saved_hosts_title)
            .setMessage(R.string.clear_saved_hosts_confirmation)
            .setNegativeButton(R.string.clear_saved_hosts_cancel, null)
            .setPositiveButton(R.string.clear_saved_hosts_confirm) { _, _ -> startDataClearing() }
            .show()
    }

    private fun startDataClearing() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
            formMessage.setText(if (clearingData) R.string.clear_saved_hosts_failed else R.string.clear_saved_hosts_unsupported)
            clearData.isEnabled = true
            return
        }
        showDataClearing()
        LocalDataClearer.start(applicationContext)
    }

    private fun showDataClearing() {
        clearingData = true
        // Destroy every browsing context before deleting so no page can recreate cookies/storage.
        closeAllHosts()
        switcher.visibility = View.GONE
        switcherList.removeAllViews()
        savedList.removeAllViews()
        savedList.visibility = View.GONE
        savedHeading.visibility = View.GONE
        connection.visibility = View.VISIBLE
        resume.visibility = View.GONE
        progress.visibility = View.GONE
        address.setText("")
        address.isEnabled = false
        findViewById<Button>(R.id.connect_host).isEnabled = false
        clearData.isEnabled = false
        formMessage.setText(R.string.clear_saved_hosts_pending)
        formMessage.setTextColor(FOREGROUND)
        refreshSystemBars()
    }

    private fun finishDataClearing() {
        if (!clearingData) return
        clearingData = false
        address.isEnabled = true
        address.setText("")
        findViewById<Button>(R.id.connect_host).isEnabled = true
        clearData.isEnabled = true
        formMessage.setText(R.string.clear_saved_hosts_complete)
    }

    private fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { notice("No browser is installed to open this link.") }
    }

    private fun notice(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        ViewCompat.requestApplyInsets(root)
        webView?.post { publishViewport() }
        refreshSystemBars()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("connected", active != null)
        // Do not save WebView history, form values, pairing URLs, or DOM into the Activity bundle.
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        hosts.values.forEach { it.view.onResume() }
        refreshSystemBars()
        val host = active ?: return
        val view = host.view
        val origin = host.origin
        view.post {
            if (host !== active || host.closed || host.failed || clearingData ||
                !HostPolicy.isTrusted(view.url, origin)) return@post
            publishViewport()
            view.evaluateJavascript("""
                (() => {
                  if (window !== window.top || location.origin !== ${org.json.JSONObject.quote(origin)}) return;
                  window.dispatchEvent(new Event('omp-android-chrome'));
                })();
            """.trimIndent(), null)
        }
    }
    override fun onPause() {
        hosts.values.forEach { it.view.onPause() }
        CookieManager.getInstance().flush()
        super.onPause()
    }
    override fun onDestroy() {
        closeAllHosts()
        if (::downloads.isInitialized) downloads.close()
        signInWorker.shutdownNow()
        super.onDestroy()
    }

    private fun text(value: String, size: Int) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(FOREGROUND)
        setLineSpacing(dp(3).toFloat(), 1f)
        gravity = Gravity.CENTER_VERTICAL
    }
    private fun heading(value: String) = text(value, 18).apply { setTypeface(typeface, Typeface.BOLD) }
    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value
        isAllCaps = false
        minHeight = dp(48)
        setOnClickListener { action() }
    }
    private fun dialogText(value: String) = TextView(this).apply {
        text = value
        textSize = 14f
    }
    private fun nameField(value: String) = EditText(this).apply {
        id = R.id.save_host_name
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
        filters = arrayOf(InputFilter.LengthFilter(SavedHostRules.MAX_NAME))
        isSaveEnabled = false
        setText(value)
        setSelection(text.length)
    }
    /** Never offered to autofill or saved into instance state; the app keeps it only through SavedSignIns. */
    private fun passwordField() = EditText(this).apply {
        id = R.id.sign_in_password
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        filters = arrayOf(InputFilter.LengthFilter(MAX_PASSWORD))
        isSaveEnabled = false
    }
    private fun dialogBody(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(24), dp(8), dp(24), 0)
        views.forEach { addView(it, LinearLayout.LayoutParams(-1, -2)) }
    }
    private fun spaced(top: Int = 12) = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(top) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    companion object {
        private const val MAX_LIVE_HOSTS = 4
        private const val MAX_PASSWORD = 1024
        private const val SIGN_IN_NOT_ACCEPTED =
            "The host did not accept this sign-in. Paste a fresh pairing link, or connect to a host with password sign-in enabled."
        private val CHROME_COLOR = Regex("#[0-9a-fA-F]{6}")
        private val BACKGROUND = Color.rgb(16, 24, 32)
        private val FOREGROUND = Color.rgb(238, 243, 247)
        private val MUTED = Color.rgb(163, 180, 192)
        private val WARNING = Color.rgb(243, 201, 132)
        private val SCRIM = Color.argb(0x99, 0, 0, 0)
    }
}
