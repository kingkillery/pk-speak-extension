package com.example

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import com.example.api.ConnectionReason
import com.example.api.VoiceAgentClient
import com.example.data.AppPreferences
import com.example.ui.theme.Canvas
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
class PairingRequiredGateScreenshotTest {

  @get:Rule val composeTestRule = createComposeRule()

  @Test
  fun tokenRejectedGate_screenshot_and_recoveryActions() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    context.getSharedPreferences("pi_speak_prefs", Context.MODE_PRIVATE).edit().clear().commit()
    val prefs = AppPreferences(context)
    val client = VoiceAgentClient(context, prefs)

    composeTestRule.setContent {
      MyApplicationTheme {
        androidx.compose.foundation.layout.Box(
          modifier = Modifier
            .fillMaxSize()
            .background(Canvas)
        ) {
          PairingRequiredGate(
            connectionReason = ConnectionReason.TokenRejected,
            detail = "Gateway found, but the saved token was rejected. Scan or paste a fresh setup link.",
            prefs = prefs,
            client = client,
            onPairingApplied = {},
            modifier = Modifier.fillMaxSize()
          )
        }
      }
    }

    composeTestRule.onNodeWithText("Token rejected").assertIsDisplayed()
    composeTestRule.onNodeWithText("Scan setup QR").assertIsDisplayed()
    composeTestRule.onNodeWithText("Paste setup link").assertIsDisplayed()
    composeTestRule.onNodeWithText("Run connection test").assertIsDisplayed()

    composeTestRule.onRoot().captureRoboImage(
      filePath = "src/test/screenshots/pairing_required_gate.png"
    )
  }
}
