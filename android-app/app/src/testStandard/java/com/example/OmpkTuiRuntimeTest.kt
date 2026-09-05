package com.example

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.URI

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class OmpkTuiRuntimeTest {
    @Test
    fun reconnectBackoffStartsQuicklyAndCapsAtTenSeconds() {
        assertEquals(1_000L, ompkReconnectDelayMillis(0))
        assertEquals(2_000L, ompkReconnectDelayMillis(1))
        assertEquals(5_000L, ompkReconnectDelayMillis(2))
        assertEquals(10_000L, ompkReconnectDelayMillis(3))
        assertEquals(10_000L, ompkReconnectDelayMillis(20))
    }

    @Test
    fun normalizeGatewayBaseUrl_acceptsOnlyHttpOrigins() {
        assertEquals("https://pixel-host.tailnet.ts.net", normalizeOmpkGatewayBaseUrl("https://pixel-host.tailnet.ts.net/"))
        assertEquals("http://100.64.1.2:8767", normalizeOmpkGatewayBaseUrl("http://100.64.1.2:8767"))
        assertNull(normalizeOmpkGatewayBaseUrl("javascript:alert(1)"))
        assertNull(normalizeOmpkGatewayBaseUrl("https://user@host.example"))
        assertNull(normalizeOmpkGatewayBaseUrl("https://host.example/other"))
    }

    @Test
    fun sameGatewayOrigin_checksSchemeHostAndEffectivePort() {
        assertTrue(sameOmpkGatewayOrigin(URI("https://host.example/app/"), "https://host.example"))
        assertTrue(sameOmpkGatewayOrigin(URI("http://host.example:80/v1/status"), "http://host.example"))
        assertFalse(sameOmpkGatewayOrigin(URI("https://other.example/app/"), "https://host.example"))
        assertFalse(sameOmpkGatewayOrigin(URI("http://host.example/app/"), "https://host.example"))
    }

    @Test
    fun tokenInjectionSeedsSessionStorageWithoutPuttingTokenInNavigationUrl() {
        val token = "secret-token-value"
        val script = buildOmpkTokenInjectionScript(token)
        assertTrue(script.contains(OMPK_WEB_TOKEN_KEY))
        assertTrue(script.contains("sessionStorage.getItem"))
        assertFalse(script.contains(token))
        assertFalse(script.contains("?token="))
    }
}
