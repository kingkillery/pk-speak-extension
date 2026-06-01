package com.example

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.example.ui.theme.MyApplicationTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36])
class HeaderConnectionStateTest {

  @get:Rule val composeTestRule = createComposeRule()

  @Test
  fun gatewayIndicatorColor_isGreenWhenConnected() {
    assertEquals(Color(0xFF22C55E), gatewayConnectionIndicatorColor(isGatewayConnected = true, isReconnecting = false))
  }

  @Test
  fun gatewayIndicatorColor_isOrangeWhenReconnecting() {
    assertEquals(Color(0xFFF59E0B), gatewayConnectionIndicatorColor(isGatewayConnected = false, isReconnecting = true))
  }

  @Test
  fun gatewayIndicatorColor_isRedWhenUnreachable() {
    assertEquals(Color(0xFFEF4444), gatewayConnectionIndicatorColor(isGatewayConnected = false, isReconnecting = false))
  }

  @Test
  fun headerShowsConnectedStatus() {
    setHeader(connectionStatusText = "Connected", isGatewayConnected = true, isReconnecting = false)

    composeTestRule.onNodeWithText("Connected | Codex: Main-Project-Alpha").assertIsDisplayed()
  }

  @Test
  fun headerShowsReconnectingStatus() {
    setHeader(connectionStatusText = "Reconnecting...", isGatewayConnected = false, isReconnecting = true)

    composeTestRule.onNodeWithText("Reconnecting... | Codex: Main-Project-Alpha").assertIsDisplayed()
  }

  @Test
  fun headerShowsUnreachableStatus() {
    setHeader(connectionStatusText = "Gateway unreachable", isGatewayConnected = false, isReconnecting = false)

    composeTestRule.onNodeWithText("Gateway unreachable | Codex: Main-Project-Alpha").assertIsDisplayed()
  }

  private fun setHeader(
    connectionStatusText: String,
    isGatewayConnected: Boolean,
    isReconnecting: Boolean
  ) {
    composeTestRule.setContent {
      MyApplicationTheme {
        HeaderSection(
          title = "Studio",
          sessionName = "Main-Project-Alpha",
          onMenuClick = {},
          isGatewayConnected = isGatewayConnected,
          isReconnecting = isReconnecting,
          connectionStatusText = connectionStatusText,
          onSettingsClick = {}
        )
      }
    }
  }
}
