package com.example

import com.example.api.parseGatewayRoster
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GatewayRosterParserTest {

  @Test
  fun parseGatewayRoster_readsGatewaysAndSkipsMalformedEntries() {
    val json = JSONObject(
      """
      {
        "ok": true,
        "peersProbed": 3,
        "errors": [],
        "gateways": [
          {
            "peer": {"hostName": "mac2", "os": "macOS", "online": true, "ip": "100.109.244.1"},
            "descriptor": {
              "schema": "pi-speak.discovery.v1",
              "name": "Pi Speak on mac2",
              "serverId": "srv-1",
              "version": "0.2.12",
              "authRequired": true,
              "baseUrl": "http://100.109.244.1:8767"
            }
          },
          {"peer": {"hostName": "broken"}},
          {"descriptor": {"baseUrl": "http://100.1.2.3:8767"}},
          {"peer": {"hostName": ""}, "descriptor": {"baseUrl": "http://100.1.2.4:8767"}}
        ]
      }
      """.trimIndent()
    )

    val roster = parseGatewayRoster(json)

    assertEquals(3, roster.peersProbed)
    assertTrue(roster.errors.isEmpty())
    assertEquals(1, roster.gateways.size)
    val gateway = roster.gateways.first()
    assertEquals("mac2", gateway.hostName)
    assertEquals("100.109.244.1", gateway.ip)
    assertEquals("Pi Speak on mac2", gateway.name)
    assertEquals("http://100.109.244.1:8767", gateway.baseUrl)
    assertEquals(true, gateway.online)
    assertEquals(true, gateway.authRequired)
  }

  @Test
  fun parseGatewayRoster_reportsErrorsAndEmptyRoster() {
    val json = JSONObject(
      """{"ok": true, "peersProbed": 0, "gateways": [], "errors": ["tailscale status unavailable: not installed"]}"""
    )

    val roster = parseGatewayRoster(json)

    assertTrue(roster.gateways.isEmpty())
    assertEquals(0, roster.peersProbed)
    assertEquals(1, roster.errors.size)
    assertTrue(roster.errors.first().contains("tailscale"))
  }
}
