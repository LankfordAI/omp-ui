package ai.lankford.ompui.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SavedHostRulesTest {
    @Test fun defaultNameUsesFirstLabelOrWholeLiteralAuthority() {
        assertEquals("studio", SavedHostRules.defaultName("https://studio.netbird.cloud:3443"))
        assertEquals("192.168.1.20:3000", SavedHostRules.defaultName("http://192.168.1.20:3000"))
        assertEquals("[::1]:3000", SavedHostRules.defaultName("http://[::1]:3000"))
        assertEquals("localhost:3000", SavedHostRules.defaultName("http://localhost:3000"))
        assertEquals("example", SavedHostRules.defaultName("https://example.com"))
        assertEquals("studio", SavedHostRules.defaultName("http://studio"))
    }

    @Test fun cleanNameCollapsesControlsAndCaps() {
        val origin = "https://studio.netbird.cloud"
        assertEquals("studio", SavedHostRules.cleanName("  \t ", origin))
        assertEquals("Desk one two", SavedHostRules.cleanName(" Desk\n\u0007one \r\n two ", origin))
        assertEquals("a".repeat(40), SavedHostRules.cleanName("a".repeat(60), origin))
    }

    @Test fun addRefusesDuplicatesAndFullList() {
        val full = (1..16).map { SavedHost("http://h$it", "h$it", it.toLong()) }
        assertNull(SavedHostRules.add(full, "http://new", 99))
        assertEquals(16, full.size)
        val one = listOf(SavedHost("http://a", "a", 1))
        assertNull(SavedHostRules.add(one, "http://a", 99))
        assertEquals(listOf(SavedHost("http://a", "a", 1)), one)
        assertEquals(SavedHost("http://b.example", "b", 5), SavedHostRules.add(one, "http://b.example", 5)!!.last())
    }

    @Test fun touchReordersAndRemoveTakesOnlyOne() {
        val hosts = listOf(SavedHost("http://a", "a", 1), SavedHost("http://b", "b", 2), SavedHost("http://c", "c", 3))
        assertEquals(listOf("http://c", "http://b", "http://a"), SavedHostRules.ordered(hosts).map { it.origin })
        val touched = SavedHostRules.touch(hosts, "http://a", 10)
        assertEquals(listOf("http://a", "http://c", "http://b"), SavedHostRules.ordered(touched).map { it.origin })
        assertEquals(listOf("http://a", "http://c"), SavedHostRules.remove(hosts, "http://b").map { it.origin })
    }
}
