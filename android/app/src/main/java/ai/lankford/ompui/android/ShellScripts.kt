package ai.lankford.ompui.android

import org.json.JSONObject

internal object ShellScripts {
    fun documentStart(origin: String): String = """
        (() => {
          if (window !== window.top || location.origin !== ${JSONObject.quote(origin)}) return;
          window.__ompAndroidViewport = {bookSplitX: null};
          const install = () => {
            const root = document.documentElement;
            const body = document.body;
            let lastColor = null;
            let pending = false;
            let frame = null;
            const opaqueBackground = (element) => {
              if (!element) return null;
              const value = getComputedStyle(element).backgroundColor.trim();
              const match = /^(?:rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)|rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*1(?:\.0+)?\s*\))${'$'}/.exec(value);
              if (!match) return null;
              const channels = (match[1] === undefined ? match.slice(4, 7) : match.slice(1, 4)).map(Number);
              if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return null;
              return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
            };
            const sample = () => {
              pending = false;
              frame = null;
              const token = getComputedStyle(root).getPropertyValue('--color-void').trim();
              const color = token
                ? (/^#[0-9a-fA-F]{6}${'$'}/.test(token) ? token.toLowerCase() : null)
                : opaqueBackground(body) || opaqueBackground(root);
              if (!color || color === lastColor) return;
              try {
                if (typeof window.__ompAndroidChrome?.postMessage !== 'function') return;
                window.__ompAndroidChrome.postMessage(color);
                lastColor = color;
              } catch (_) {
                // A missing or disconnected native endpoint leaves the last native color intact.
              }
            };
            const schedule = () => {
              if (document.visibilityState !== 'visible') {
                if (frame !== null) {
                  cancelAnimationFrame(frame);
                  frame = null;
                  pending = false;
                }
                if (pending) return;
                pending = true;
                queueMicrotask(sample);
              } else {
                if (pending) return;
                pending = true;
                frame = requestAnimationFrame(sample);
              }
            };
            const observer = new MutationObserver(schedule);
            observer.observe(root, {attributes: true, attributeFilter: ['style', 'class', 'data-theme']});
            if (body) observer.observe(body, {attributes: true, attributeFilter: ['style', 'class']});
            window.addEventListener('load', schedule);
            window.addEventListener('pageshow', schedule);
            document.addEventListener('visibilitychange', schedule);
            window.addEventListener('omp-android-chrome', () => {
              if (window === window.top && location.origin === ${JSONObject.quote(origin)}) schedule();
            });
            schedule();
          };
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', install, {once: true});
          } else {
            install();
          }
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
