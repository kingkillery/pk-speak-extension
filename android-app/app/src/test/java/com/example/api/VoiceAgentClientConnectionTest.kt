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
    System.setProperty("is_testing", "true")
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
  fun tryAutoConnect_prefersAdvertisedTailscaleBaseUrlWhenConfigured() {
    val server = try {
      startGatewayServer(
        8767,
        descriptor = """{"app":"pi-speak","authRequired":false,"pairingRequired":false,"baseUrls":["http://192.168.1.10:8767","http://100.64.216.11:8767"],"routing":{"currentSession":"Warp"}}"""
      )
    } catch (e: BindException) {
      null
    }
    assumeTrue("localhost:8767 is occupied by another service", server != null)
    prefs.connectionMode = "Tailscale"
    prefs.targetIpAddress = "http://192.0.2.99:8767"
    val client = VoiceAgentClient(context, prefs)

    val result = client.tryAutoConnect(forceVerify = true)

    assertTrue(result.connected)
    assertEquals("http://100.64.216.11:8767", result.baseUrl)
    assertEquals("http://100.64.216.11:8767", prefs.targetIpAddress)
    assertEquals("Warp", prefs.codexSessionName)
    server?.let {
      it.stop(0)
      servers.remove(it)
    }
  }

  @Test
  fun getWarpControlSnapshot_parsesPsmuxSessionsAndPanes() = kotlinx.coroutines.runBlocking {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/warp") { exchange ->
      val body = """
        {
          "ok": true,
          "warp": {
            "available": true,
            "sameTailnet": true,
            "requestRemoteAddress": "100.64.1.2",
            "warpRemoteBaseUrl": "http://100.64.216.11:8767",
            "psmux": {
              "available": true,
              "executable": "psmux.exe",
              "sessions": [
                {
                  "name": "warp-phone",
                  "attached": "0",
                  "windows": [
                    {
                      "session": "warp-phone",
                      "index": "0",
                      "name": "main",
                      "active": true,
                      "panes": [
                        {"session":"warp-phone","window":"0","pane":"0","paneId":"%1","active":true,"command":"pwsh","title":"Warp"}
                      ]
                    }
                  ]
                }
              ]
            }
          }
        }
      """.trimIndent().toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    val client = VoiceAgentClient(context, prefs)

    val snapshot = client.getWarpControlSnapshot()

    assertTrue(snapshot?.available == true)
    assertTrue(snapshot?.sameTailnet == true)
    assertEquals("http://100.64.216.11:8767", snapshot?.warpRemoteBaseUrl)
    assertEquals(1, snapshot?.paneCount)
    assertEquals("warp-phone", snapshot?.sessions?.first()?.name)
    assertEquals("%1", snapshot?.sessions?.first()?.windows?.first()?.panes?.first()?.paneId)
  }

  @Test
  fun createWarpTab_postsCwdToGateway() = kotlinx.coroutines.runBlocking {
    var seenBody = ""
    var seenToken = ""
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/warp/tab") { exchange ->
      seenToken = exchange.requestHeaders.getFirst("X-Pi-Speak-Token") ?: ""
      seenBody = exchange.requestBody.bufferedReader().use { it.readText() }
      val body = """{"ok":true,"message":"Opened Warp tab."}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    val client = VoiceAgentClient(context, prefs)

    val message = client.createWarpTab("C:\\dev\\Desktop-Projects\\warp")

    assertEquals("Opened Warp tab.", message)
    assertEquals("secret-token", seenToken)
    assertTrue(seenBody.contains(""""cwd":"C:\\dev\\Desktop-Projects\\warp""""))
  }

  @Test
  fun openWarpTabConfig_postsNameToGateway() = kotlinx.coroutines.runBlocking {
    var seenBody = ""
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/warp/tab-config") { exchange ->
      seenBody = exchange.requestBody.bufferedReader().use { it.readText() }
      val body = """{"ok":true,"message":"Opened Warp tab config phone_remote."}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    val client = VoiceAgentClient(context, prefs)

    val message = client.openWarpTabConfig("phone_remote", newWindow = true)

    assertEquals("Opened Warp tab config phone_remote.", message)
    assertTrue(seenBody.contains(""""name":"phone_remote""""))
    assertTrue(seenBody.contains(""""newWindow":true"""))
  }

  @Test
  fun sendTextTurnDetailed_postsOmpProviderWorkspaceAndModel() = kotlinx.coroutines.runBlocking {
    var seenBody = ""
    var seenToken = ""
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/turn/text") { exchange ->
      seenToken = exchange.requestHeaders.getFirst("X-Pi-Speak-Token") ?: ""
      seenBody = exchange.requestBody.bufferedReader().use { it.readText() }
      val body = """{"replyText":"model received"}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
    prefs.codexSessionName = "main"
    prefs.workspacePath = "C:\\dev\\Desktop-Projects\\oh-my-pk-fork"
    prefs.agentModel = "gpt-test"
    val client = VoiceAgentClient(context, prefs)

    val result = client.sendTextTurnDetailed("/model")

    assertEquals("model received", result.replyText)
    assertEquals("secret-token", seenToken)
    assertTrue(seenBody.contains("\"agentProvider\":\"oh-my-pk\""))
    assertTrue(seenBody.contains("\"target\":\"main\""))
    assertTrue(seenBody.contains("\"cwd\":\"C:\\\\dev\\\\Desktop-Projects\\\\oh-my-pk-fork\""))
    assertTrue(seenBody.contains("\"model\":\"gpt-test\""))
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
                "aliases": ["one", "ready"],
                "kind": "background",
                "source": "oh-my-pk",
                "model": "gpt-5",
                "role": "reviewer",
                "createdAt": 1782208800000,
                "lastActivity": 1782212400000,
                "subagents": [
                  {
                    "id": "background:abc123/lint-worker",
                    "name": "lint-worker",
                    "status": "parked",
                    "sessionPath": "C:\\Users\\prest\\.omp\\agent\\sessions\\ready\\lint-worker.jsonl",
                    "activity": "background subagent"
                  }
                ]
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
    assertEquals("background", session.kind)
    assertEquals("oh-my-pk", session.source)
    assertEquals("gpt-5", session.model)
    assertEquals("reviewer", session.role)
    assertEquals(1782208800000, session.createdAt)
    assertEquals(1782212400000, session.lastActivity)
    assertEquals(1, session.subagents.size)
    assertEquals("lint-worker", session.subagents.first().name)
    assertEquals("parked", session.subagents.first().status)
    assertEquals("background subagent", session.subagents.first().activity)
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

  @Test
  fun launchColabWorkspace_postsTargetNodeAndWorkspace() = kotlinx.coroutines.runBlocking {
    var seenBody = ""
    var seenToken = ""
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    server.createContext("/v1/sessions/launch") { exchange ->
      seenToken = exchange.requestHeaders.getFirst("X-Pi-Speak-Token") ?: ""
      seenBody = exchange.requestBody.bufferedReader().use { it.readText() }
      val body = """{"ok":true,"message":"Launching Colab deployment colab-test."}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.start()
    servers.add(server)
    prefs.targetIpAddress = "http://127.0.0.1:${server.address.port}"
    prefs.remoteToken = "secret-token"
    prefs.workspacePath = "C:\\dev\\Desktop-Projects\\pi-speak-extension"
    val client = VoiceAgentClient(context, prefs)

    val message = client.launchColabWorkspace()

    assertEquals("Launching Colab deployment colab-test.", message)
    assertEquals("secret-token", seenToken)
    assertTrue(seenBody.contains(""""targetNode":"colab""""))
    assertTrue(seenBody.contains(""""cwd":"C:\\dev\\Desktop-Projects\\pi-speak-extension""""))
  }

  private fun startGatewayServer(
    port: Int = 0,
    descriptor: String = """{"app":"pi-speak","routing":{"currentSession":"Main-Project-Alpha"}}"""
  ): HttpServer {
    val server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
    server.createContext("/health") { exchange ->
      val body = """{"ok":true,"app":"pi-speak","authRequired":true}""".toByteArray()
      exchange.sendResponseHeaders(200, body.size.toLong())
      exchange.responseBody.use { it.write(body) }
    }
    server.createContext("/.well-known/pi-speak") { exchange ->
      val body = descriptor.toByteArray()
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
