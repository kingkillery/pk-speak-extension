package com.example.api

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppPreferences
import com.sun.net.httpserver.HttpServer
import java.net.BindException
import java.net.InetSocketAddress
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class VoiceAgentClientConnectionTest {

  private lateinit var context: Context
  private lateinit var prefs: AppPreferences
  private val servers = mutableListOf<HttpServer>()

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    prefs = AppPreferences(context)
  }

  @After
  fun tearDown() {
    servers.forEach { it.stop(0) }
    servers.clear()
  }

  @Test
  fun pingHealth_recoversAfterGatewayRestart() = kotlinx.coroutines.runBlocking {
    var server = startGatewayServer()
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    val client = VoiceAgentClient(context, prefs)

    assertTrue(client.pingHealth())

    server.stop(0)
    servers.remove(server)
    assertFalse(client.pingHealth())

    server = startGatewayServer(server.address.port)
    assertTrue(client.pingHealth())
  }

  @Test
  fun tryAutoConnect_replacesStaleTargetWithLocalhostAdbReverseGateway() {
    val server = try {
      startGatewayServer(8767)
    } catch (e: BindException) {
      null
    }
    prefs.targetIpAddress = "http://192.0.2.99:8767"
    val client = VoiceAgentClient(context, prefs)

    val result = client.tryAutoConnect(forceVerify = true)

    assumeTrue("localhost:8767 is occupied but is not a reachable Pi Speak gateway", result.connected)
    assertTrue(result.connected)
    assertEquals("http://localhost:8767", result.baseUrl)
    assertEquals("http://localhost:8767", prefs.targetIpAddress)
    assertTrue(result.discovered)
    if (server != null) {
      server.stop(0)
      servers.remove(server)
    }
  }

  @Test
  fun getSessionDashboard_parsesWrapperAndFullSessionEntry() = kotlinx.coroutines.runBlocking {
    var seenToken = ""
    val server = startSessionsServer(
      body = """
        {
          "ok": true,
          "dashboard": {
            "current": "Main",
            "ready": ["Ready"],
            "storePath": "recent CLI sessions",
            "sessions": [
              {
                "name": "Ready",
                "path": "C:\\Users\\prest\\.codex\\ready.jsonl",
                "sessionPath": "C:\\Users\\prest\\.codex\\ready.jsonl",
                "provider": "codex",
                "sessionId": "abc123",
                "resumable": true,
                "resumeCommand": ["codex", "resume", "abc123"],
                "workingDirectory": "C:\\dev\\Ready",
                "cwd": "C:\\dev\\Fallback",
                "current": false,
                "isCurrent": false,
                "ready": true,
                "isReady": true,
                "activity": "idle",
                "aliases": ["one", "ready"]
              }
            ]
          }
        }
      """.trimIndent(),
      onToken = { seenToken = it }
    )
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    val client = VoiceAgentClient(context, prefs)

    val dashboard = client.getSessionDashboard()

    assertEquals("secret-token", seenToken)
    assertEquals("Main", dashboard.current)
    assertEquals(listOf("Ready"), dashboard.ready)
    assertEquals("recent CLI sessions", dashboard.storePath)
    assertEquals(1, dashboard.sessions.size)
    val session = dashboard.sessions.first()
    assertEquals("Ready", session.name)
    assertEquals("C:\\Users\\prest\\.codex\\ready.jsonl", session.path)
    assertEquals("C:\\Users\\prest\\.codex\\ready.jsonl", session.sessionPath)
    assertEquals("codex", session.provider)
    assertEquals("abc123", session.sessionId)
    assertTrue(session.resumable)
    assertEquals(listOf("codex", "resume", "abc123"), session.resumeCommand)
    assertEquals("C:\\dev\\Ready", session.workingDirectory)
    assertEquals("C:\\dev\\Fallback", session.cwd)
    assertTrue(session.ready)
    assertTrue(session.isReady)
    assertEquals("idle", session.activity)
    assertEquals(listOf("one", "ready"), session.aliases)
    assertEquals("C:\\dev\\Ready", session.displayCwd)
  }

  @Test
  fun getSessionDashboard_rejectsTopLevelSessionsWithoutDashboard() = kotlinx.coroutines.runBlocking {
    val server = startSessionsServer("""{"ok":true,"sessions":[]}""")
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    val client = VoiceAgentClient(context, prefs)

    try {
      client.getSessionDashboard()
      throw AssertionError("Expected malformed gateway sessions response")
    } catch (e: GatewaySessionException) {
      assertEquals(GatewaySessionErrorKind.Malformed, e.kind)
    }
  }

  @Test
  fun getSessionDashboard_mapsUnauthorizedAndUnsupportedStatusCodes() = kotlinx.coroutines.runBlocking {
    val unauthorized = startSessionsServer("""{"ok":false}""", status = 401)
    prefs.targetIpAddress = "http://127.0.0.1:${unauthorized.address.port}"
    val client = VoiceAgentClient(context, prefs)

    try {
      client.getSessionDashboard()
      throw AssertionError("Expected unauthorized dashboard response")
    } catch (e: GatewaySessionException) {
      assertEquals(GatewaySessionErrorKind.Unauthorized, e.kind)
    }

    unauthorized.stop(0)
    servers.remove(unauthorized)
    val unsupported = startSessionsServer("""{"ok":false}""", status = 501)
    prefs.targetIpAddress = "http://127.0.0.1:${unsupported.address.port}"

    try {
      client.getSessionDashboard()
      throw AssertionError("Expected unsupported dashboard response")
    } catch (e: GatewaySessionException) {
      assertEquals(GatewaySessionErrorKind.Unsupported, e.kind)
    }
  }

  @Test
  fun gatewaySessionEntry_prefersWorkingDirectoryThenCwdThenUnknown() {
    assertEquals("C:\\work", GatewaySessionEntry(workingDirectory = "C:\\work", cwd = "C:\\fallback").displayCwd)
    assertEquals("C:\\fallback", GatewaySessionEntry(cwd = "C:\\fallback").displayCwd)
    assertEquals("unknown", GatewaySessionEntry().displayCwd)
    assertNull(GatewaySessionEntry().canonicalSessionPath)
  }

  @Test
  fun resumeGatewaySession_postsStoredSessionIdentity() = kotlinx.coroutines.runBlocking {
    var seenBody = ""
    var seenToken = ""
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/sessions/resume") { exchange ->
      seenToken = exchange.requestHeaders.getFirst("X-Pi-Speak-Token") ?: ""
      seenBody = exchange.requestBody.bufferedReader().use { it.readText() }
      val body = """{"ok":true,"message":"Launching codex resume for abc123."}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    val client = VoiceAgentClient(context, prefs)

    val message = client.resumeGatewaySession(
      GatewaySessionEntry(
        provider = "codex",
        sessionId = "abc123",
        sessionPath = "C:\\Users\\prest\\.codex\\ready.jsonl",
        workingDirectory = "C:\\dev\\Ready",
        resumable = true
      )
    )

    assertEquals("Launching codex resume for abc123.", message)
    assertEquals("secret-token", seenToken)
    assertTrue(seenBody.contains(""""provider":"codex""""))
    assertTrue(seenBody.contains(""""sessionId":"abc123""""))
    assertTrue(seenBody.contains(""""sessionPath":"C:\\Users\\prest\\.codex\\ready.jsonl""""))
    assertTrue(seenBody.contains(""""cwd":"C:\\dev\\Ready""""))
  }

  private fun startGatewayServer(port: Int = 0): HttpServer {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
    server.createContext("/health") { exchange ->
      val body = """{"ok":true,"app":"pi-speak","authRequired":true}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.createContext("/.well-known/pi-speak") { exchange ->
      val body = """{"app":"pi-speak","routing":{"currentSession":"Main-Project-Alpha"}}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    return server
  }

  private fun startSessionsServer(
    body: String,
    status: Int = 200,
    onToken: (String) -> Unit = {}
  ): HttpServer {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/sessions") { exchange ->
      onToken(exchange.requestHeaders.getFirst("X-Pi-Speak-Token") ?: "")
      val bytes = body.toByteArray()
      exchange.sendResponseHeaders(status, bytes.size.toLong())
      exchange.responseBody.use { it.write(bytes) }
    }
    server.start()
    servers.add(server)
    return server
  }
}
