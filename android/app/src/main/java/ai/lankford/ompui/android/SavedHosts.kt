package ai.lankford.ompui.android

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject

internal data class SavedHost(val origin: String, val name: String, val lastUsedMs: Long)

/** Pure list rules with no Android types, so JVM unit tests cover them. */
internal object SavedHostRules {
    const val MAX_HOSTS = 16
    const val MAX_NAME = 40

    fun defaultName(origin: String): String {
        val authority = origin.substringAfter("://")
        val host = if (authority.startsWith("[")) authority.substringBefore(']') + "]" else authority.substringBefore(':')
        val literal = host.startsWith("[") || host == "localhost" || host.all { it.isDigit() || it == '.' }
        return if (literal) authority else host.substringBefore('.')
    }

    fun cleanName(input: String, origin: String): String {
        val cleaned = input.trim().replace(Regex("[\\s\\p{Cntrl}]+"), " ").trim().take(MAX_NAME).trim()
        return cleaned.ifBlank { defaultName(origin) }
    }

    fun add(hosts: List<SavedHost>, origin: String, nowMs: Long): List<SavedHost>? =
        if (hosts.size >= MAX_HOSTS || hosts.any { it.origin == origin }) null
        else hosts + SavedHost(origin, defaultName(origin), nowMs)

    fun touch(hosts: List<SavedHost>, origin: String, nowMs: Long): List<SavedHost> =
        hosts.map { if (it.origin == origin) it.copy(lastUsedMs = nowMs) else it }

    fun rename(hosts: List<SavedHost>, origin: String, name: String): List<SavedHost> =
        hosts.map { if (it.origin == origin) it.copy(name = cleanName(name, origin)) else it }

    fun remove(hosts: List<SavedHost>, origin: String): List<SavedHost> = hosts.filter { it.origin != origin }

    fun ordered(hosts: List<SavedHost>): List<SavedHost> = hosts.sortedByDescending { it.lastUsedMs }
}

/** Persists the list as JSON under key "hosts" in the existing "connection" preferences. */
internal class SavedHosts(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("connection", Context.MODE_PRIVATE)

    /** Ordered, most recently used first. */
    fun all(): List<SavedHost> = SavedHostRules.ordered(load())

    fun get(origin: String): SavedHost? = load().firstOrNull { it.origin == origin }

    /** False when already saved or full. */
    fun add(origin: String): Boolean {
        val next = SavedHostRules.add(load(), origin, System.currentTimeMillis()) ?: return false
        store(next)
        return true
    }

    fun touch(origin: String) {
        val hosts = load()
        if (hosts.any { it.origin == origin }) store(SavedHostRules.touch(hosts, origin, System.currentTimeMillis()))
    }

    fun rename(origin: String, name: String) {
        val hosts = load()
        if (hosts.any { it.origin == origin }) store(SavedHostRules.rename(hosts, origin, name))
    }

    fun remove(origin: String) {
        val hosts = load()
        if (hosts.any { it.origin == origin }) store(SavedHostRules.remove(hosts, origin))
    }

    private fun load(): List<SavedHost> {
        val text = preferences.getString(KEY, null) ?: return migrate()
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        val hosts = ArrayList<SavedHost>()
        for (index in 0 until array.length()) {
            if (hosts.size >= SavedHostRules.MAX_HOSTS) break
            val entry = array.optJSONObject(index) ?: continue
            val origin = entry.optString("origin", "")
            if (!valid(origin) || hosts.any { it.origin == origin }) continue
            val name = SavedHostRules.cleanName(entry.optString("name", ""), origin)
            hosts += SavedHost(origin, name, entry.optLong("lastUsed", 0L))
        }
        return hosts
    }

    /** Seeds from a legacy "origin", or an empty list, so later "origin" writes never count as saved hosts. */
    private fun migrate(): List<SavedHost> {
        val origin = preferences.getString("origin", null)
        val hosts = if (origin.isNullOrBlank() || !valid(origin)) emptyList()
        else listOf(SavedHost(origin, SavedHostRules.defaultName(origin), System.currentTimeMillis()))
        store(hosts)
        return hosts
    }

    private fun store(hosts: List<SavedHost>) {
        val array = JSONArray()
        hosts.forEach { array.put(JSONObject().put("origin", it.origin).put("name", it.name).put("lastUsed", it.lastUsedMs)) }
        preferences.edit { putString(KEY, array.toString()) }
    }

    private fun valid(origin: String) = runCatching { HostPolicy.endpoint(origin).origin == origin }.getOrDefault(false)

    companion object { const val KEY = "hosts" }
}
