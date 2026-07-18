package com.example.api

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppPreferences
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class VoiceTurnFallbackTest {

  private lateinit var context: Context
  private lateinit var prefs: AppPreferences
  private lateinit var audioFile: File
  private val servers = mutableListOf<HttpServer>()

  @Before
  fun setUp() {
    System.setProperty("is_testing", "true")
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    prefs = AppPreferences(context)
    audioFile = File.createTempFile("turn", ".wav").apply { writeBytes(ByteArray(64)) }
  }

  @After
  fun tearDown() {
    servers.forEach { it.stop(0) }
    servers.clear()
    audioFile.delete()
  }

  @Test
  fun fallbackDecision_firesOnlyOnConnectionErrorOr429Or502() {
    assertTrue(VoiceAgentClient.shouldFallBackToTextTurn(GatewayTurnResult("t", "r", connectionError = true)))
    assertTrue(VoiceAgentClient.shouldFallBackToTextTurn(GatewayTurnResult("t", "r", statusCode = 429)))
    assertTrue(VoiceAgentClient.shouldFallBackToTextTurn(GatewayTurnResult("t", "r", statusCode = 502)))
    assertFalse(VoiceAgentClient.shouldFallBackToTextTurn(GatewayTurnResult("t", "r", statusCode = 500)))
    assertFalse(VoiceAgentClient.shouldFallBackToTextTurn(GatewayTurnResult("t", "r", statusCode = 401)))
    assertFalse(VoiceAgentClient.shouldFallBackToTextTurn(GatewayTurnResult("t", "r")))
  }

  @Test
  fun voiceTurn502_fallsBackToTextTurnWithLocalTranscript() = kotlinx.coroutines.runBlocking {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/turn/voice") { exchange ->
      exchange.sendResponseHeaders(502, -1)
      exchange.close()
    }
    server.createContext("/v1/turn/text") { exchange ->
      val body = """{"ok":true,"replyText":"text fallback reply"}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    val client = VoiceAgentClient(context, prefs)

    val result = client.sendVoiceTurnDetailed(audioFile, fallbackPrompt = "run the tests")

    assertEquals("text fallback reply", result.replyText)
    assertEquals("run the tests", result.transcript)
  }

  @Test
  fun voiceTurn500_doesNotFallBack() = kotlinx.coroutines.runBlocking {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    var textCalled = false
    server.createContext("/v1/turn/voice") { exchange ->
      exchange.sendResponseHeaders(500, -1)
      exchange.close()
    }
    server.createContext("/v1/turn/text") { exchange ->
      textCalled = true
      exchange.sendResponseHeaders(200, -1)
      exchange.close()
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    val client = VoiceAgentClient(context, prefs)

    val result = client.sendVoiceTurnDetailed(audioFile, fallbackPrompt = "run the tests")

    assertEquals(500, result.statusCode)
    assertTrue(result.replyText.contains("500"))
    assertFalse(textCalled)
  }

  @Test
  fun voiceTurnFallback_skippedWhenPromptIsBlankOrPlaceholder() = kotlinx.coroutines.runBlocking {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    var textCalled = false
    server.createContext("/v1/turn/voice") { exchange ->
      exchange.sendResponseHeaders(502, -1)
      exchange.close()
    }
    server.createContext("/v1/turn/text") { exchange ->
      textCalled = true
      exchange.sendResponseHeaders(200, -1)
      exchange.close()
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    val client = VoiceAgentClient(context, prefs)

    val blank = client.sendVoiceTurnDetailed(audioFile, fallbackPrompt = "   ")
    val listening = client.sendVoiceTurnDetailed(audioFile, fallbackPrompt = "Listening...")

    assertEquals(502, blank.statusCode)
    assertEquals(502, listening.statusCode)
    assertFalse(textCalled)
  }
}
