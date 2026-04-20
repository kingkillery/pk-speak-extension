package com.pkkidking.pispeak.presentation.app

import androidx.lifecycle.ViewModel
import com.pkkidking.pispeak.data.storage.ThemeMode
import com.pkkidking.pispeak.data.storage.ThemePreferences
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.StateFlow

@HiltViewModel
class AppViewModel @Inject constructor(
    private val themePreferences: ThemePreferences,
) : ViewModel() {
    val themeMode: StateFlow<ThemeMode> = themePreferences.themeMode

    fun setThemeMode(mode: ThemeMode) {
        themePreferences.setThemeMode(mode)
    }
}
