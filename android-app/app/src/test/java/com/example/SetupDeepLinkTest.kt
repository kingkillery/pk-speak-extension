package com.example

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.example.data.AppPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SetupDeepLinkTest {

  private lateinit var context: Context

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
  }

  @Test
  fun parseSetupDeepLink_prefersCurrentBaseUrlFormat() {
    val uri = Uri.parse(
      "pi-speak://setup?base_url=http%3A%2F%2F100.93.214.66%3A8767%2F&token=secret&profile_name=MSI&connection_mode=tailscale&default_target=main&workspace_path=C%3A%5Cdev%5Cfork&agent_provider=pi&model=gpt-test"
    )

    val setup = parseSetupDeepLink(uri)

    requireNotNull(setup)
    assertEquals("http://100.93.214.66:8767", setup.baseUrl)
    assertEquals("secret", setup.token)
    assertEquals("MSI", setup.profileName)
    assertEquals("tailscale", setup.connectionMode)
    assertEquals("main", setup.defaultTarget)
    assertEquals("C:\\dev\\fork", setup.workspacePath)
    assertEquals("pi", setup.agentProvider)
    assertEquals("gpt-test", setup.agentModel)
  }

  @Test
  fun parseSetupDeepLink_supportsLegacyHostPortFormatWithGatewayDefaultPort() {
    val uri = Uri.parse("pi-speak://setup?host=100.93.214.66&token=secret")

    val setup = parseSetupDeepLink(uri)

    requireNotNull(setup)
    assertEquals("http://100.93.214.66:8767", setup.baseUrl)
    assertEquals("secret", setup.token)
  }

  @Test
  fun parseSetupDeepLink_rejectsMissingTokenOrUrl() {
    assertNull(parseSetupDeepLink(Uri.parse("pi-speak://setup?base_url=http%3A%2F%2F100.93.214.66%3A8767")))
    assertNull(parseSetupDeepLink(Uri.parse("pi-speak://setup?token=secret")))
  }

  @Test
  fun applySetupDeepLink_writesProfileAndTargetToSeparatePreferences() {
    val prefs = AppPreferences(context)
    val setup = SetupDeepLink(
      baseUrl = "http://100.93.214.66:8767",
      token = "secret",
      profileName = "MSI",
      connectionMode = "tailnet",
      defaultTarget = "main-session",
      agentProvider = "claude",
      agentModel = "gpt-test",
      workspaceRoot = "C:\\dev",
      workspacePath = "C:\\dev\\Desktop-Projects\\oh-my-pk-fork"
    )

    applySetupDeepLink(prefs, setup)

    assertEquals("http://100.93.214.66:8767", prefs.targetIpAddress)
    assertEquals("secret", prefs.remoteToken)
    assertEquals("MSI", prefs.machineProfileName)
    assertEquals("main-session", prefs.codexSessionName)
    assertEquals("Tailscale", prefs.connectionMode)
    assertEquals("Gateway Claude (Claude Code)", prefs.activeAgent)
    assertEquals("gpt-test", prefs.agentModel)
    assertEquals("C:\\dev", prefs.workspaceRoot)
    assertEquals("C:\\dev\\Desktop-Projects\\oh-my-pk-fork", prefs.workspacePath)
  }

  @Test
  fun applySetupDeepLink_mapsOhMyPkProviderToOmpkAgent() {
    val prefs = AppPreferences(context)
    val setup = SetupDeepLink(
      baseUrl = "http://100.93.214.66:8767",
      token = "secret",
      profileName = null,
      connectionMode = null,
      defaultTarget = null,
      agentProvider = "oh-my-pk",
      agentModel = null,
      workspaceRoot = null,
      workspacePath = null
    )

    applySetupDeepLink(prefs, setup)

    assertEquals("Gateway OMPK (oh-my-pk)", prefs.activeAgent)
  }

  @Test
  fun parsePairingSetupInput_urlPlusToken_matchesNativeSetupUri() {
    val synthetic = parsePairingSetupInput("http://100.93.214.66:8767/remote/path", "secret")
    val native = parseSetupDeepLink(
      Uri.parse("pi-speak://setup?base_url=http%3A%2F%2F100.93.214.66%3A8767&token=secret")
    )

    requireNotNull(synthetic)
    requireNotNull(native)
    assertEquals(native.baseUrl, synthetic.baseUrl)
    assertEquals(native.token, synthetic.token)

    val queryToken = parsePairingSetupInput("https://gateway.example:9443/connect?token=query-secret")
    requireNotNull(queryToken)
    assertEquals("https://gateway.example:9443", queryToken.baseUrl)
    assertEquals("query-secret", queryToken.token)

    val syntheticPrefs = AppPreferences(context)
    applySetupDeepLink(syntheticPrefs, synthetic)
    assertEquals("http://100.93.214.66:8767", syntheticPrefs.targetIpAddress)
    assertEquals("secret", syntheticPrefs.remoteToken)
  }

  @Test
  fun applySetupDeepLink_preservesUnrelatedPreferencesWhenRePairing() {
    val prefs = AppPreferences(context)
    prefs.codexSessionName = "main"
    prefs.workspacePath = "C:\\dev\\fork"
    prefs.activeAgent = "Gateway OMPK (oh-my-pk)"
    val rePair = parseSetupDeepLink(
      Uri.parse(
        "pi-speak://setup?base_url=${Uri.encode("http://100.93.214.66:8767")}&token=${Uri.encode("rotated-secret")}"
      )
    )
    requireNotNull(rePair)

    applySetupDeepLink(prefs, rePair)

    assertEquals("http://100.93.214.66:8767", prefs.targetIpAddress)
    assertEquals("rotated-secret", prefs.remoteToken)
    assertEquals("main", prefs.codexSessionName)
    assertEquals("C:\\dev\\fork", prefs.workspacePath)
    assertEquals("Gateway OMPK (oh-my-pk)", prefs.activeAgent)
  }
}
