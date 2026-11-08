package ai.lankford.ompui.android

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
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
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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

class MainActivity : ComponentActivity() {
    private lateinit var root: LinearLayout
    private lateinit var content: FrameLayout
    private lateinit var progress: ProgressBar
    private lateinit var connection: ScrollView
    private lateinit var address: EditText
    private lateinit var formMessage: TextView
    private lateinit var resume: Button
    private lateinit var clearData: Button
    @Volatile private var clearingData = false
    private lateinit var downloads: WebDownloads
    @Volatile private var webView: WebView? = null
    @Volatile private var trustedOrigin: String? = null
    private var hostBackground: Int? = null
    private var fold: FoldingFeature? = null
    private var failed = false
    private var pendingFiles: ValueCallback<Array<Uri>>? = null
    private var fileOrigin: String? = null
    private val preferences by lazy { getSharedPreferences("connection", MODE_PRIVATE) }

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
            address.setText(remembered)
            if (savedInstanceState?.getBoolean("connected") == true && remembered.isNotBlank()) {
                runCatching { HostPolicy.endpoint(remembered) }.onSuccess { connect(it) }
            }
        }
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
        val background = if (connection.visibility == View.VISIBLE || webView == null || failed || clearingData) {
            BACKGROUND
        } else hostBackground ?: BACKGROUND
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
        form.addView(text("Host address or pairing link", 14), spaced(24))
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
        formMessage = text("Sign in on the host's existing page. Only its address is remembered; pairing tokens are not saved by this form.", 14).apply {
            id = R.id.connection_message
        }
        form.addView(formMessage, spaced(18))
        form.addView(button("Connect", ::requestConnect).apply { id = R.id.connect_host }, spaced(18))
        resume = button("Return to current view") { hideConnection() }.apply {
            id = R.id.resume_current_view
            visibility = View.GONE
        }
        form.addView(resume, spaced(6))
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

    private fun requestConnect() {
        if (clearingData) return
        val endpoint = try {
            HostPolicy.endpoint(address.text.toString())
        } catch (error: IllegalArgumentException) {
            address.error = error.message
            return
        }
        if (webView != null && endpoint.origin == trustedOrigin && endpoint.initialUrl == "${endpoint.origin}/" && !failed) {
            address.setText(endpoint.origin)
            hideConnection()
            return
        }
        val switch = {
            address.setText(endpoint.origin)
            connect(endpoint)
        }
        if (webView != null && !failed) {
            AlertDialog.Builder(this)
                .setTitle("Replace the current view?")
                .setMessage("The current host view will close. Sessions keep running on their host. Plain-text drafts can recover, but unsent file attachments are not retained.")
                .setNegativeButton("Keep current view", null)
                .setPositiveButton("Connect") { _, _ -> switch() }
                .show()
        } else switch()
    }

    private fun connect(endpoint: HostEndpoint) {
        if (clearingData) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showConnection()
            formMessage.text = "Update Android System WebView or Chrome, then try again. This app requires document-start script and web-message listener support for safe host-scoped recovery, folding, and system-bar colors."
            return
        }
        publishViewport(clear = true)
        closeWebView()
        trustedOrigin = endpoint.origin
        preferences.edit().putString("origin", endpoint.origin).apply()
        failed = false
        formMessage.text = "Sign in on the host's existing page. Only its address is remembered."
        formMessage.setTextColor(FOREGROUND)
        val view = createWebView(endpoint.origin)
        webView = view
        content.addView(view, 0, FrameLayout.LayoutParams(-1, -1))
        hideConnection()
        progress.visibility = View.VISIBLE
        view.loadUrl(endpoint.initialUrl)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(origin: String): WebView = WebView(this).apply {
        id = R.id.remote_webview
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
            if (!isMainFrame || view !== webView || origin != trustedOrigin ||
                !HostPolicy.isTrusted(sourceOrigin.toString(), origin) || !HostPolicy.isTrusted(view.url, origin) ||
                clearingData || failed || message.type != WebMessageCompat.TYPE_STRING) return@addWebMessageListener
            val value = message.data ?: return@addWebMessageListener
            if (value.length != 7 || !CHROME_COLOR.matches(value)) return@addWebMessageListener
            val color = Color.parseColor(value)
            if (color == hostBackground) return@addWebMessageListener
            hostBackground = color
            view.setBackgroundColor(color)
            refreshSystemBars()
        }
        WebViewCompat.addDocumentStartJavaScript(this, ShellScripts.documentStart(origin), setOf(origin))
        webViewClient = HostWebViewClient()
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, value: Int) {
                if (view !== webView) return
                this@MainActivity.progress.progress = value
                this@MainActivity.progress.visibility = if (value == 100 || failed) View.GONE else View.VISIBLE
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
        setDownloadListener { url, _, disposition, mime, _ -> downloads.request(url, disposition, mime) }
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> publishViewport() }
    }

    private inner class HostWebViewClient : WebViewClient() {
        private var leavingLogin = false

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (view !== webView || clearingData) return true
            if (url == "omp-ui://host-connection") {
                if (request.isForMainFrame && request.hasGesture() && request.method == "GET" &&
                    HostPolicy.isTrusted(view.url, trustedOrigin)) showConnection()
                return true
            }
            if (HostPolicy.isTrusted(url, trustedOrigin)) return false
            if (HostPolicy.opensExternally(url, request.isForMainFrame, request.hasGesture(), request.method)) openExternal(url)
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // WebView only exposes the initial resource URL here, not redirect destinations.
            // This blocks direct foreign POSTs; it is not an egress firewall. The trusted
            // host must not redirect POSTs to other origins. HTTPS subresources stay browser-owned.
            if (view === webView && !clearingData && HostPolicy.allowsRequest(request.url.toString(), trustedOrigin, request.isForMainFrame)) return null
            return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (view !== webView) return
            if (!HostPolicy.isTrusted(url, trustedOrigin)) {
                view.stopLoading()
                showFailure("Navigation outside the connected host was blocked. Choose another host below.")
            }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView || !HostPolicy.isTrusted(url, trustedOrigin)) return
            val loginPage = Uri.parse(url).path == "/login"
            // Credential forms are not app navigation: Back must not revisit a POST
            // or replace the live renderer with an ERR_CACHE_MISS error page.
            if (loginPage || leavingLogin) view.clearHistory()
            leavingLogin = loginPage
            CookieManager.getInstance().flush()
            // Pairing tokens must not remain in WebView's visible navigation entry.
            view.evaluateJavascript("""
                (() => {
                  if (location.origin !== ${org.json.JSONObject.quote(trustedOrigin)}) return;
                  const u = new URL(location.href);
                  if (u.searchParams.has('t')) { u.searchParams.delete('t'); history.replaceState(history.state, '', u); }
                })();
            """.trimIndent(), null)
            publishViewport()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view === webView && request.isForMainFrame && !failed) {
                showFailure("Could not reach the host. Check that remote access is enabled, the address and port are correct, and this device can reach the LAN or NetBird network.")
            }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (view !== webView || !request.isForMainFrame) return
            if (HostPolicy.isLoginErrorPage(request.url.toString(), trustedOrigin, request.method, response.statusCode, response.mimeType)) return
            if (response.statusCode == 401 || response.statusCode == 403) {
                showFailure("The host did not accept this sign-in. Paste a fresh pairing link, or connect to a host with password sign-in enabled.")
            } else if (response.statusCode >= 400) {
                showFailure("The host returned HTTP ${response.statusCode}. Check the host and its remote web bundle, then retry.")
            }
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (view === webView) showFailure("The HTTPS certificate could not be verified. Fix the host's certificate. Certificate errors are never bypassed.")
        }

        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
            handler.cancel()
            if (view === webView) showFailure("HTTP Basic authentication is not supported. Use omp-ui's own sign-in page or pairing link.")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView) return true
            val origin = trustedOrigin
            closeWebView(rendererGone = true)
            if (origin != null) {
                notice("The web view restarted. Restoring your host view; unsent attachments must be selected again.")
                connect(HostPolicy.endpoint(origin))
            } else showConnection()
            return true
        }
    }

    private fun publishViewport(clear: Boolean = false) {
        val view = webView ?: return
        val origin = trustedOrigin ?: return
        if (!HostPolicy.isTrusted(view.url, origin) || view.width == 0) return
        val location = IntArray(2)
        view.getLocationInWindow(location)
        val feature = if (clear) null else fold
        val edge = feature?.let {
            FoldGeometry.relativeRightEdge(it.isSeparating, it.orientation == FoldingFeature.Orientation.VERTICAL,
                it.state == FoldingFeature.State.FLAT, it.bounds.left, it.bounds.right, location[0], view.width)
        }
        view.evaluateJavascript(ShellScripts.viewport(origin, edge, view.width), null)
    }

    private fun handleBack() {
        if (clearingData) return
        if (connection.visibility == View.VISIBLE) {
            if (webView != null && !failed) hideConnection() else finish()
            return
        }
        val view = webView
        val origin = trustedOrigin
        if (view == null || origin == null || !HostPolicy.isTrusted(view.url, origin)) {
            showConnection()
            return
        }
        view.evaluateJavascript(ShellScripts.back(origin)) { handled ->
            if (view !== webView || connection.visibility == View.VISIBLE || handled == "true") return@evaluateJavascript
            val history = view.copyBackForwardList()
            val previous = history.currentIndex - 1
            if (previous >= 0 && HostPolicy.isTrusted(history.getItemAtIndex(previous).url, origin)) view.goBack()
            else showConnection()
        }
    }

    private fun showConnection() {
        if (clearingData) return
        connection.visibility = View.VISIBLE
        webView?.visibility = View.INVISIBLE
        resume.visibility = if (webView != null && !failed) View.VISIBLE else View.GONE
        address.setText(trustedOrigin ?: preferences.getString("origin", ""))
        refreshSystemBars()
    }

    private fun hideConnection() {
        if (clearingData) return
        if (webView == null) return
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(address.windowToken, 0)
        address.clearFocus()
        connection.visibility = View.GONE
        webView?.visibility = View.VISIBLE
        webView?.requestFocus()
        publishViewport()
        refreshSystemBars()
    }

    private fun showFailure(message: String) {
        failed = true
        progress.visibility = View.GONE
        showConnection()
        formMessage.text = "$message\n\nTap Connect to retry. Your host sessions are unchanged."
        formMessage.setTextColor(WARNING)
    }

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
        // Destroy the browsing context before deleting so no page can recreate cookies/storage.
        closeWebView()
        trustedOrigin = null
        failed = false
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

    private fun closeWebView(rendererGone: Boolean = false) {
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
        fileOrigin = null
        if (::downloads.isInitialized) downloads.cancel(clearPage = !rendererGone)
        val view = webView
        webView = null
        hostBackground = null
        if (view != null) {
            content.removeView(view)
            if (!rendererGone) {
                WebViewCompat.removeWebMessageListener(view, "__ompAndroidChrome")
                view.stopLoading()
            }
            view.removeAllViews()
            view.destroy()
        }
        refreshSystemBars()
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
        outState.putBoolean("connected", webView != null)
        // Do not save WebView history, form values, pairing URLs, or DOM into the Activity bundle.
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        refreshSystemBars()
        val view = webView ?: return
        val origin = trustedOrigin ?: return
        view.post {
            if (view !== webView || origin != trustedOrigin || clearingData || failed ||
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
    override fun onPause() { webView?.onPause(); CookieManager.getInstance().flush(); super.onPause() }
    override fun onDestroy() { closeWebView(); if (::downloads.isInitialized) downloads.close(); super.onDestroy() }

    private fun text(value: String, size: Int) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(FOREGROUND)
        setLineSpacing(dp(3).toFloat(), 1f)
        gravity = Gravity.CENTER_VERTICAL
    }
    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value
        isAllCaps = false
        minHeight = dp(48)
        setOnClickListener { action() }
    }
    private fun spaced(top: Int = 12) = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(top) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()

    companion object {
        private val CHROME_COLOR = Regex("#[0-9a-fA-F]{6}")
        private val BACKGROUND = Color.rgb(16, 24, 32)
        private val FOREGROUND = Color.rgb(238, 243, 247)
        private val MUTED = Color.rgb(163, 180, 192)
        private val WARNING = Color.rgb(243, 201, 132)
    }
}
