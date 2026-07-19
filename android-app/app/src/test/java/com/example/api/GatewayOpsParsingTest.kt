package com.example.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GatewayOpsParsingTest {

  @Test
  fun parseGatewayRoute_readsTargetsAndDefaults() {
    val json = JSONObject(
      """
      {"ok":true,"route":{"defaultTarget":"pk one","currentSession":"Main","availableTargets":["Main","pk one","pk two"]}}
      """.trimIndent()
    )

    val route = parseGatewayRoute(json)

    assertEquals("pk one", route?.defaultTarget)
    assertEquals("Main", route?.currentSession)
    assertEquals(listOf("Main", "pk one", "pk two"), route?.availableTargets)
  }

  @Test
  fun parseGatewayRoute_blankDefaultBecomesNull() {
    val json = JSONObject("""{"ok":true,"route":{"defaultTarget":"","currentSession":"Main","availableTargets":[]}}""")

    val route = parseGatewayRoute(json)

    assertNull(route?.defaultTarget)
    assertEquals(emptyList<String>(), route?.availableTargets)
  }

  @Test
  fun parseGatewayRoute_missingRouteReturnsNull() {
    assertNull(parseGatewayRoute(JSONObject("""{"ok":true}""")))
  }

  @Test
  fun parseGatewayRouteSlots_readsMappedAmbiguousAndUnassigned() {
    val json = JSONObject(
      """
      {"ok":true,"slots":[
        {"family":"1","sessionName":"Main","sessionPath":"C:/s/main.jsonl","labels":["pk one","pk1"],"status":"mapped"},
        {"family":"2","labels":["two-a","two-b"],"status":"ambiguous"}
      ]}
      """.trimIndent()
    )

    val slots = parseGatewayRouteSlots(json)

    assertEquals(2, slots.size)
    assertEquals("1", slots[0].family)
    assertEquals("mapped", slots[0].status)
    assertEquals("Main", slots[0].sessionName)
    assertEquals(listOf("pk one", "pk1"), slots[0].labels)
    assertEquals("ambiguous", slots[1].status)
    assertNull(slots[1].sessionName)
  }

  @Test
  fun parseAgentInventory_readsRunningAndRecent() {
    val json = JSONObject(
      """
      {"ok":true,"agents":["codex@repo"],"generatedAt":"2026-07-02T00:00:00Z",
       "running":[{"provider":"codex","pid":4242,"target":"codex@repo","cwd":"C:/dev/repo","source":"process"}],
       "recent":[{"provider":"claude","path":"C:/u/.claude/s.jsonl","title":"Fix bug","cwd":"C:/dev/repo"}]}
      """.trimIndent()
    )

    val inventory = parseAgentInventory(json)

    assertEquals(listOf("codex@repo"), inventory.agents)
    assertEquals(1, inventory.running.size)
    assertEquals("codex@repo", inventory.running[0].target)
    assertEquals(4242L, inventory.running[0].pid)
    assertEquals(1, inventory.recent.size)
    assertEquals("Fix bug", inventory.recent[0].title)
    assertEquals("2026-07-02T00:00:00Z", inventory.generatedAt)
  }

  @Test
  fun parseAgentInventory_toleratesEmptyPayload() {
    val inventory = parseAgentInventory(JSONObject("""{"ok":true}"""))

    assertTrue(inventory.agents.isEmpty())
    assertTrue(inventory.running.isEmpty())
    assertTrue(inventory.recent.isEmpty())
  }

  @Test
  fun parseWorkspaceFilePreview_readsTextPreview() {
    val json = JSONObject(
      """
      {"ok":true,"file":{"name":"README.md","path":"C:/dev/repo/README.md","size":2048,"truncated":false,"binary":false,"content":"# Hello"}}
      """.trimIndent()
    )

    val preview = parseWorkspaceFilePreview(json)

    assertEquals("README.md", preview?.name)
    assertEquals(2048L, preview?.size)
    assertEquals("# Hello", preview?.content)
    assertEquals(false, preview?.binary)
    assertNull(preview?.error)
  }

  @Test
  fun parseWorkspaceFilePreview_flagsBinaryAndTruncated() {
    val json = JSONObject(
      """
      {"ok":true,"file":{"name":"app.bin","path":"C:/dev/app.bin","size":9999999,"truncated":true,"binary":true,"content":""}}
      """.trimIndent()
    )

    val preview = parseWorkspaceFilePreview(json)

    assertTrue(preview?.binary == true)
    assertTrue(preview?.truncated == true)
  }

  @Test
  fun parseGatewayEventData_flattensPayloadIntoSummary() {
    val event = parseGatewayEventData(
      """{"ts":1751414400000,"kind":"session-switched","source":"voice","payload":{"target":"pk one","by":"wake"}}"""
    )

    assertEquals("session-switched", event?.kind)
    assertEquals("voice", event?.source)
    assertEquals(1751414400000L, event?.ts)
    assertTrue(event?.summary?.contains("target=pk one") == true)
    assertTrue(event?.summary?.contains("by=wake") == true)
  }

  @Test
  fun parseGatewayEventData_errorFrameBecomesErrorEvent() {
    val event = parseGatewayEventData("""{"message":"tail failed"}""")

    assertEquals("error", event?.kind)
    assertEquals("tail failed", event?.summary)
  }

  @Test
  fun parseGatewayEventData_rejectsGarbage() {
    assertNull(parseGatewayEventData("not json"))
    assertNull(parseGatewayEventData("""{"noKind":true}"""))
  }

  @Test
  fun workspaceEntry_fileTypeDetection() {
    assertTrue(WorkspaceEntry(name = "a.txt", path = "C:/a.txt", type = "file", size = 12L).isFile)
    assertFalse(WorkspaceEntry(name = "src", path = "C:/src").isFile)
  }
}
