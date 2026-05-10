package com.pkkidking.pispeak

import android.content.Intent
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
        val params = extractBootstrapParams(intent)
        setContent {
            PiSpeakApp(
                bootstrapBaseUrl = params.baseUrl,
                bootstrapToken = params.token,
                bootstrapMachineId = params.machineId,
                bootstrapProfileName = params.profileName,
                bootstrapConnectionMode = params.connectionMode,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // With singleTask launchMode, a new deep-link intent arrives here when the app
        // is already running. Recreate so onCreate processes the fresh intent.
        if (intent.data?.scheme == "pi-speak" || intent.hasExtra("base_url")) {
            recreate()
        }
    }

    private fun extractBootstrapParams(intent: Intent): BootstrapParams {
        val setupUri = intent.data
        return BootstrapParams(
            baseUrl = intent.getStringExtra("base_url")
                ?: setupUri?.getQueryParameter("base_url")
                ?: setupUri?.getQueryParameter("base"),
            token = intent.getStringExtra("token")
                ?: setupUri?.getQueryParameter("token"),
            machineId = intent.getStringExtra("machine_id")
                ?: setupUri?.getQueryParameter("machine_id"),
            profileName = intent.getStringExtra("profile_name")
                ?: setupUri?.getQueryParameter("profile_name"),
            connectionMode = intent.getStringExtra("connection_mode")
                ?: intent.getStringExtra("connection")
                ?: setupUri?.getQueryParameter("connection_mode")
                ?: setupUri?.getQueryParameter("connection"),
        )
    }

    private data class BootstrapParams(
        val baseUrl: String? = null,
        val token: String? = null,
        val machineId: String? = null,
        val profileName: String? = null,
        val connectionMode: String? = null,
    )
}
