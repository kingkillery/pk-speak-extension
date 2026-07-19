package com.example.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AppPreferencesConnectionTest {

  private lateinit var context: Context

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
  }

  @Test
  fun clearGatewayConfigIfAppUpgraded_preservesGatewayOnFirstLaunch() {
    val prefs = AppPreferences(context)
    prefs.targetIpAddress = "http://100.64.0.1:8767"

    prefs.clearGatewayConfigIfAppUpgraded(currentVersionCode = 10)

    assertEquals("http://100.64.0.1:8767", prefs.targetIpAddress)
    assertEquals(10, prefs.lastKnownAppVersionCode)
  }

  @Test
  fun clearGatewayConfigIfAppUpgraded_preservesGatewayWhenVersionUnchanged() {
    val prefs = AppPreferences(context)
    prefs.lastKnownAppVersionCode = 10
    prefs.targetIpAddress = "http://100.64.0.1:8767"

    prefs.clearGatewayConfigIfAppUpgraded(currentVersionCode = 10)

    assertEquals("http://100.64.0.1:8767", prefs.targetIpAddress)
    assertEquals(10, prefs.lastKnownAppVersionCode)
  }

  @Test
  fun clearGatewayConfigIfAppUpgraded_clearsGatewayWhenVersionChanges() {
    val prefs = AppPreferences(context)
    prefs.lastKnownAppVersionCode = 9
    prefs.targetIpAddress = "http://100.64.0.1:8767"

    prefs.clearGatewayConfigIfAppUpgraded(currentVersionCode = 10)

    assertEquals("", prefs.targetIpAddress)
    assertEquals(10, prefs.lastKnownAppVersionCode)
  }

  @Test
  fun defaultWorkspacePath_usesDevWorkspacePreset() {
    val prefs = AppPreferences(context)

    assertEquals(AppPreferences.DEFAULT_WORKSPACE_PATH, prefs.workspaceRoot)
    assertEquals(AppPreferences.DEFAULT_WORKSPACE_PATH, prefs.workspacePath)
  }

  @Test
  fun selectedGatewaySessionPath_persistsSeparatelyFromTargetAndWorkspace() {
    val prefs = AppPreferences(context)
    prefs.codexSessionName = "Main-Project-Alpha"
    prefs.workspacePath = "C:\\dev\\Desktop-Projects\\pi-speak-extension"

    prefs.selectedGatewaySessionPath = "C:\\Users\\prest\\.codex\\sessions\\session.jsonl"

    val reloaded = AppPreferences(context)
    assertEquals("C:\\Users\\prest\\.codex\\sessions\\session.jsonl", reloaded.selectedGatewaySessionPath)
    assertEquals("Main-Project-Alpha", reloaded.codexSessionName)
    assertEquals("C:\\dev\\Desktop-Projects\\pi-speak-extension", reloaded.workspacePath)
  }
}
