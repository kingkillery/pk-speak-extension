package com.example

import android.content.Context
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.example.api.GatewaySessionDashboard
import com.example.data.AppPreferences
import com.example.ui.theme.MyApplicationTheme
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel8, sdk = [36])
class GatewaySessionsHeaderTest {

  @get:Rule val composeTestRule = createComposeRule()

  private lateinit var prefs: AppPreferences

  @Before
  fun setUp() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    prefs = AppPreferences(context).apply {
      targetIpAddress = "http://100.93.214.66:8768"
      codexSessionName = "codex:85740"
      workspacePath = "C:\\Dev"
    }
  }

  @Test
  fun compactHeader_keepsSessionControlsVisible_andExpandsLaunchControlsOnDemand() {
    composeTestRule.setContent {
      MyApplicationTheme {
        GatewaySessionsHeader(
          prefs = prefs,
          state = GatewaySessionsUiState.Loaded(GatewaySessionDashboard()),
          filterText = "",
          onFilterTextChange = {},
          launchingHub = false,
          launchingColab = false,
          joiningCollab = false,
          onLaunchHub = {},
          onLaunchColab = {},
          onJoinCollab = {},
          onRefresh = {},
          showAllSessions = true,
          onToggleShowAll = {},
        )
      }
    }

    composeTestRule.onNodeWithText("All sessions").assertIsDisplayed()
    composeTestRule.onNodeWithText("Filter sessions, paths, aliases").assertIsDisplayed()
    composeTestRule.onAllNodesWithText("Launch OMPK hub").assertCountEquals(0)

    composeTestRule.onNodeWithText("Show controls").performClick()

    composeTestRule.onNodeWithText("Launch OMPK hub").assertIsDisplayed()
    composeTestRule.onNodeWithText("Launch Colab").assertIsDisplayed()
    composeTestRule.onNodeWithText("Join collab").assertIsDisplayed()
    composeTestRule.onNodeWithText("Hide controls").assertIsDisplayed()
  }
}
