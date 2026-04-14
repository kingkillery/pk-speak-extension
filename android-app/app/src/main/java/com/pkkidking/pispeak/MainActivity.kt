package com.pkkidking.pispeak

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dagger.hilt.android.AndroidEntryPoint
import com.pkkidking.pispeak.presentation.main.MainRoute
import com.pkkidking.pispeak.ui.theme.PiSpeakTheme

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            PiSpeakTheme {
                MainRoute()
            }
        }
    }
}
