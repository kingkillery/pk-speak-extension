package com.example.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GatewayHubParsingTest {

  @Test
  fun parseHubAgent_readsDescription() {
    val json = JSONObject(
      """
      {"id":"repo/dispatch","displayName":"queue-dispatcher","kind":"background",
       "status":"running","model":"gpt-5","description":"linear queue dispatch worker"}
      """.trimIndent()
    )

    val agent = parseHubAgent(json)

    assertEquals("linear queue dispatch worker", agent?.description)
    assertEquals("queue-dispatcher", agent?.displayName)
  }

  @Test
  fun parseHubAgent_blankOrMissingDescriptionBecomesNull() {
    val blank = parseHubAgent(JSONObject("""{"id":"a","description":""}"""))
    val missing = parseHubAgent(JSONObject("""{"id":"b"}"""))

    assertNull(blank?.description)
    assertNull(missing?.description)
  }

  @Test
  fun parseHubSnapshot_carriesDescriptionsThroughAgents() {
    val json = JSONObject(
      """
      {"ok":true,"generatedAtMs":123,
       "folders":[{"key":"repo","name":"repo","laneCount":1,"isCurrentFolder":true}],
       "agents":[
         {"id":"repo/dispatch","displayName":"queue-dispatcher","kind":"background","description":"linear queue dispatch worker"},
         {"id":"repo/dispatch/researcher","displayName":"researcher","kind":"sub","parentId":"repo/dispatch","description":"background subagent"}
       ]}
      """.trimIndent()
    )

    val snapshot = parseHubSnapshot(json)

    assertEquals(2, snapshot.agents.size)
    assertEquals("linear queue dispatch worker", snapshot.agents[0].description)
    assertEquals("background subagent", snapshot.agents[1].description)
  }
}
