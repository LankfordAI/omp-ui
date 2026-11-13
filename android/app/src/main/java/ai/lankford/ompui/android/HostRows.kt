package ai.lankford.ompui.android

import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.toColorInt
import androidx.core.view.isNotEmpty

/** Saved-host rows for the connection panel and the switch sheet; rebuilt on every render. */
internal object HostRows {
    private val FOREGROUND = "#EEF3F7".toColorInt()
    private val MUTED = "#A3B4C0".toColorInt()
    private val BORDER = "#2C3A47".toColorInt()
    private val ACTIVE_BORDER = "#8FC3E0".toColorInt()

    fun render(
        container: LinearLayout,
        hosts: List<SavedHost>,
        activeOrigin: String?,
        liveOrigins: Set<String>,
        onPick: (SavedHost) -> Unit,
        onMenu: (SavedHost) -> Unit,
    ) {
        container.removeAllViews()
        val context = container.context
        val density = context.resources.displayMetrics.density
        fun dp(value: Int) = (value * density + 0.5f).toInt()
        for (host in hosts) {
            val active = host.origin == activeOrigin
            val badge = when {
                active -> context.getString(R.string.host_badge_connected)
                host.origin in liveOrigins -> context.getString(R.string.host_badge_open)
                else -> null
            }
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(56)
                tag = host.origin
                background = GradientDrawable().apply {
                    cornerRadius = dp(8).toFloat()
                    setStroke(dp(1), if (active) ACTIVE_BORDER else BORDER)
                }
            }
            val pick = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(8), dp(8), dp(8))
                isClickable = true
                isFocusable = true
                contentDescription = listOfNotNull(host.name, host.origin, badge).joinToString(", ")
                setOnClickListener { onPick(host) }
                setOnLongClickListener { onMenu(host); true }
            }
            pick.addView(TextView(context).apply {
                text = host.name
                textSize = 16f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(FOREGROUND)
                setSingleLine(true)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            })
            pick.addView(TextView(context).apply {
                text = if (badge == null) host.origin else "${host.origin} · $badge"
                textSize = 12f
                setTextColor(MUTED)
                setSingleLine(true)
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            })
            row.addView(pick, LinearLayout.LayoutParams(0, -2, 1f))
            row.addView(Button(context).apply {
                text = "⋯"
                isAllCaps = false
                minWidth = dp(48)
                minimumWidth = dp(48)
                minHeight = dp(48)
                minimumHeight = dp(48)
                contentDescription = context.getString(R.string.host_more, host.name)
                setOnClickListener { onMenu(host) }
            }, LinearLayout.LayoutParams(dp(48), dp(48)))
            container.addView(row, LinearLayout.LayoutParams(-1, -2).apply { if (container.isNotEmpty()) topMargin = dp(8) })
        }
    }
}
