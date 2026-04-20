package com.pkkidking.pispeak.data.storage

import org.junit.Assert.assertEquals
import org.junit.Test

class ThemeModeTest {
    @Test
    fun `fromKey falls back to system for unknown value`() {
        assertEquals(ThemeMode.SYSTEM, ThemeMode.fromKey("nope"))
        assertEquals(ThemeMode.SYSTEM, ThemeMode.fromKey(null))
    }

    @Test
    fun `fromKey resolves known modes`() {
        assertEquals(ThemeMode.LIGHT, ThemeMode.fromKey("light"))
        assertEquals(ThemeMode.DARK, ThemeMode.fromKey("dark"))
    }
}
