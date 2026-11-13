package ai.lankford.ompui.android

import android.app.Instrumentation
import android.view.View
import android.view.inspector.WindowInspector
import android.widget.Button
import java.util.concurrent.TimeUnit

/** Waits for the post-connect save-host dialog and takes its "Use default name" choice. */
internal fun dismissSaveHostDialog(instrumentation: Instrumentation) {
    val label = instrumentation.targetContext.getString(R.string.save_host_default)
    fun button(): Button? {
        var found: Button? = null
        instrumentation.runOnMainSync {
            found = WindowInspector.getGlobalWindowViews()
                .mapNotNull { it.findViewById<View>(android.R.id.button2) as? Button }
                .firstOrNull { it.isShown && it.text.toString() == label }
        }
        return found
    }
    fun await(message: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        check(condition()) { message }
    }
    var target: Button? = null
    await("The save-host dialog did not appear") { button()?.also { target = it } != null }
    instrumentation.runOnMainSync { checkNotNull(target).performClick() }
    await("The save-host dialog did not close") { button() == null }
}
