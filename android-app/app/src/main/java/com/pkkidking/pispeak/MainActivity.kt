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
        val setupUri = intent?.data
        val bootstrapBaseUrl = intent.getStringExtra("base_url")
            ?: setupUri?.getQueryParameter("base_url")
            ?: setupUri?.getQueryParameter("base")
        val bootstrapToken = intent.getStringExtra("token")
            ?: setupUri?.getQueryParameter("token")
        val bootstrapMachineId = intent.getStringExtra("machine_id")
            ?: setupUri?.getQueryParameter("machine_id")
        val bootstrapProfileName = intent.getStringExtra("profile_name")
            ?: setupUri?.getQueryParameter("profile_name")
        val bootstrapConnectionMode = intent.getStringExtra("connection_mode")
            ?: intent.getStringExtra("connection")
            ?: setupUri?.getQueryParameter("connection_mode")
            ?: setupUri?.getQueryParameter("connection")
        setContent {
            PiSpeakApp(
                bootstrapBaseUrl = bootstrapBaseUrl,
                bootstrapToken = bootstrapToken,
                bootstrapMachineId = bootstrapMachineId,
                bootstrapProfileName = bootstrapProfileName,
                bootstrapConnectionMode = bootstrapConnectionMode,
            )
        }
    }
}
