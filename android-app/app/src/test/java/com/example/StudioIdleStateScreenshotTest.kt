package com.example

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import com.example.ui.theme.MyApplicationTheme
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel8, sdk = [36])
class StudioIdleStateScreenshotTest {

  @get:Rule val composeTestRule = createComposeRule()

  @Test
  fun idleState_screenshot_and_content() {
    composeTestRule.setContent {
      MyApplicationTheme {
        StudioIdleState(
          transmissionMode = "PTT",
          targetSession = "Main-Project-Alpha",
          gatewayStatus = "Connected",
          modifier = Modifier.fillMaxSize(),
        )
      }
    }

    composeTestRule.onNodeWithText("Connected to your computer").assertIsDisplayed()
    composeTestRule.onNodeWithText("Connected").assertIsDisplayed()
    composeTestRule.onNodeWithText("Main-Project-Alpha").assertIsDisplayed()
    composeTestRule.onNodeWithText("Hold to talk").assertIsDisplayed()

    composeTestRule.onRoot().captureRoboImage(filePath = "src/test/screenshots/studio_idle_state.png")
  }

  @Test
  fun idleState_toggleMode_hint() {
    composeTestRule.setContent {
      MyApplicationTheme {
        StudioIdleState(
          transmissionMode = "TOGGLE",
          targetSession = "",
          gatewayStatus = "",
          modifier = Modifier.fillMaxSize(),
        )
      }
    }

    composeTestRule.onNodeWithText("Tap to talk").assertIsDisplayed()
    composeTestRule.onNodeWithText("Default session").assertIsDisplayed()
    composeTestRule.onNodeWithText("Checking").assertIsDisplayed()
  }
}
