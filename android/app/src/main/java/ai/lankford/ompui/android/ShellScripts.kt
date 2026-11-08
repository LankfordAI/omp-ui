package ai.lankford.ompui.android

import org.json.JSONObject

internal object ShellScripts {
    fun documentStart(origin: String): String = """
        (() => {
          if (window !== window.top || location.origin !== ${JSONObject.quote(origin)}) return;
          window.__ompAndroidViewport = {bookSplitX: null};
        })();
    """.trimIndent()

    fun viewport(origin: String, relativeHingeRight: Int?, webWidth: Int): String {
        val split = relativeHingeRight?.let { "$it * window.innerWidth / $webWidth" } ?: "null"
        return """
            (() => {
              if (window !== window.top || location.origin !== ${JSONObject.quote(origin)}) return;
              window.__ompAndroidViewport = {bookSplitX: $split};
              window.dispatchEvent(new Event('omp-android-viewport'));
            })();
        """.trimIndent()
    }

    fun back(origin: String): String = """
        (() => {
          if (window !== window.top || location.origin !== ${JSONObject.quote(origin)}) return false;
          return !window.dispatchEvent(new Event('omp-android-back', {cancelable: true}));
        })();
    """.trimIndent()
}
