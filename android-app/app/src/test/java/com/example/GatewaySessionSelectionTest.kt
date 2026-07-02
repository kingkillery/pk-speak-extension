package com.example

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.example.api.GatewayRoute
import com.example.api.GatewayRouteUpdate
import com.example.api.GatewaySessionDashboard
import com.example.api.GatewaySessionEntry
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

  @Test
  fun gatewaySessionOmpRoutePath_onlyResolvesOmpkBackgroundLanes() {
    assertEquals(
      "C:\\Users\\prest\\.omp\\agent\\sessions\\lane.jsonl",
      gatewaySessionOmpRoutePath(
        GatewaySessionEntry(
          name = "OMP lane",
          sessionPath = "C:\\Users\\prest\\.omp\\agent\\sessions\\lane.jsonl",
          source = "oh-my-pk"
        )
      )
    )
    assertEquals(
      "C:\\Users\\prest\\.omp\\agent\\sessions\\background.jsonl",
      gatewaySessionOmpRoutePath(
        GatewaySessionEntry(
          name = "Background lane",
          path = "C:\\Users\\prest\\.omp\\agent\\sessions\\background.jsonl",
          kind = "background"
        )
      )
    )
    assertNull(
      gatewaySessionOmpRoutePath(
        GatewaySessionEntry(
          name = "Codex session",
          sessionPath = "C:\\Users\\prest\\.codex\\session.jsonl",
          provider = "codex"
        )
      )
    )
  }

  @Test
  fun buildGatewayAgentHubGroups_filtersToOmpkBackgroundLanes() {
    val dashboard = GatewaySessionDashboard(
      current = "Main",
      sessions = listOf(
        GatewaySessionEntry(
          name = "OMP lane",
          sessionPath = "C:\\Users\\prest\\.omp\\agent\\sessions\\lane.jsonl",
          workingDirectory = "C:\\dev\\pi-speak-extension",
          source = "oh-my-pk"
        ),
        GatewaySessionEntry(
          name = "Background lane",
          path = "C:\\Users\\prest\\.omp\\agent\\sessions\\background.jsonl",
          cwd = "C:\\dev\\pi-speak-extension",
          kind = "background"
        ),
        GatewaySessionEntry(
          name = "Codex session",
          sessionPath = "C:\\Users\\prest\\.codex\\session.jsonl",
          workingDirectory = "C:\\dev\\pi-speak-extension",
          provider = "codex"
        )
      )
    )

    val names = buildGatewayAgentHubGroups(
      dashboard = dashboard,
      currentWorkspace = "C:\\dev\\pi-speak-extension",
      query = ""
    ).flatMap { it.sessions }.map { it.name }.toSet()

    assertEquals(setOf("OMP lane", "Background lane"), names)
  }

  @Test
  fun buildGatewayAgentHubGroups_allSessionsModeIncludesNonOmpLanes() {
    val dashboard = GatewaySessionDashboard(
      current = "Main",
      sessions = listOf(
        GatewaySessionEntry(
          name = "OMP lane",
          sessionPath = "C:\\Users\\prest\\.omp\\agent\\sessions\\lane.jsonl",
          workingDirectory = "C:\\dev\\pi-speak-extension",
          source = "oh-my-pk"
        ),
        GatewaySessionEntry(
          name = "Codex session",
          sessionPath = "C:\\Users\\prest\\.codex\\session.jsonl",
          workingDirectory = "C:\\dev\\pi-speak-extension",
          provider = "codex"
        )
      )
    )

    val names = buildGatewayAgentHubGroups(
      dashboard = dashboard,
      currentWorkspace = "C:\\dev\\pi-speak-extension",
      query = "",
      ompOnly = false
    ).flatMap { it.sessions }.map { it.name }.toSet()

    assertEquals(setOf("OMP lane", "Codex session"), names)
  }

  @Test
  fun applyGatewayRouteUpdateToPrefs_ignoresRejectedRouteUpdates() {
    applyGatewayRouteUpdateToPrefs(
      GatewayRouteUpdate(
        message = "Unknown target.",
        route = GatewayRoute(defaultTarget = "ExistingTarget", currentSession = "Main"),
        ok = false
      ),
      "unknown-agent",
      prefs
    )

    assertEquals("ExistingTarget", prefs.codexSessionName)
  }

  @Test
  fun applyGatewayRouteUpdateToPrefs_usesConfirmedDefaultTarget() {
    applyGatewayRouteUpdateToPrefs(
      GatewayRouteUpdate(
        message = "Route updated.",
        route = GatewayRoute(defaultTarget = "CanonicalTarget", currentSession = "Main"),
        ok = true
      ),
      "alias-target",
      prefs
    )

    assertEquals("CanonicalTarget", prefs.codexSessionName)
  }

  @Test
  fun applyGatewayRouteUpdateToPrefs_clearRouteFallsBackToCurrentSession() {
    applyGatewayRouteUpdateToPrefs(
      GatewayRouteUpdate(
        message = "Route cleared.",
        route = GatewayRoute(defaultTarget = null, currentSession = "Main"),
        ok = true
      ),
      "",
      prefs
    )

    assertEquals("Main", prefs.codexSessionName)
  }
}
