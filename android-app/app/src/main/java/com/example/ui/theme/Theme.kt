package com.example.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

// Single warm "Sage & Clay" scheme. Pi Speak always renders in this light,
// spacious aesthetic, independent of the system dark-mode setting, to keep
// its identity.
private val SageClayColorScheme =
  lightColorScheme(
    primary = Accent,
    onPrimary = OnAccent,
    primaryContainer = AccentSoft,
    onPrimaryContainer = Ink,
    secondary = InkMuted,
    onSecondary = SurfacePaper,
    tertiary = Accent,
    onTertiary = OnAccent,
    tertiaryContainer = AccentSoft,
    error = Error,
    onError = OnError,
    errorContainer = ErrorContainer,
    background = Canvas,
    onBackground = Ink,
    surface = SurfacePaper,
    onSurface = Ink,
    surfaceVariant = SurfaceSubtle,
    onSurfaceVariant = InkMuted,
    surfaceContainer = SurfacePaper,
    outline = Line,
    outlineVariant = Line,
  )

@Composable
fun MyApplicationTheme(
  // Retained for API compatibility; Pi Speak ignores the system setting.
  darkTheme: Boolean = false,
  dynamicColor: Boolean = false,
  content: @Composable () -> Unit,
) {
  MaterialTheme(colorScheme = SageClayColorScheme, typography = Typography, content = content)
}
