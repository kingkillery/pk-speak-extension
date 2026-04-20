package com.pkkidking.pispeak

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dagger.hilt.android.AndroidEntryPoint
import com.pkkidking.pispeak.presentation.app.PiSpeakApp

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val bootstrapBaseUrl = intent.getStringExtra("base_url")
        val bootstrapToken = intent.getStringExtra("token")
        setContent {
            PiSpeakApp(
                bootstrapBaseUrl = bootstrapBaseUrl,
                bootstrapToken = bootstrapToken,
            )
        }
    }
}
