package com.example

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
import com.example.data.AppPreferences
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class GatewaySessionSelectionTest {

  private lateinit var context: Context
  private lateinit var prefs: AppPreferences

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    prefs = AppPreferences(context)
    prefs.codexSessionName = "ExistingTarget"
    prefs.workspacePath = "C:\\old"
  }

  @Test
  fun routeCapableSelection_updatesTargetWorkspaceAndSessionPath() {
    val dashboard = GatewaySessionDashboard(current = "Main", ready = listOf("Ready"))
    val entry = GatewaySessionEntry(
      name = "Ready",
      sessionPath = "C:\\Users\\prest\\.codex\\ready.jsonl",
      workingDirectory = "C:\\dev\\Ready",
      ready = true
    )

    applyGatewaySessionSelection(entry, dashboard, prefs)

    assertEquals("Ready", prefs.codexSessionName)
    assertEquals("C:\\dev\\Ready", prefs.workspacePath)
    assertEquals("C:\\Users\\prest\\.codex\\ready.jsonl", prefs.selectedGatewaySessionPath)
  }

  @Test
  fun savedOnlySelection_updatesWorkspaceButDoesNotChangeTarget() {
    val dashboard = GatewaySessionDashboard(current = "none", ready = emptyList())
    val entry = GatewaySessionEntry(
      name = "Codex: pi-speak-extension",
      path = "C:\\Users\\prest\\.codex\\saved.jsonl",
      cwd = "C:\\dev\\Desktop-Projects\\pi-speak-extension",
      activity = "saved"
    )

    applyGatewaySessionSelection(entry, dashboard, prefs)

    assertEquals("ExistingTarget", prefs.codexSessionName)
    assertEquals("C:\\dev\\Desktop-Projects\\pi-speak-extension", prefs.workspacePath)
    assertEquals("C:\\Users\\prest\\.codex\\saved.jsonl", prefs.selectedGatewaySessionPath)
  }
}
