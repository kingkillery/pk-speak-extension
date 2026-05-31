package com.example.ui.theme

import androidx.compose.ui.graphics.Color

// Warm "paper" palette inspired by the Claude mobile aesthetic.
val Canvas = Color(0xFFF4F1E9) // warm cream app background
val SurfacePaper = Color(0xFFFFFFFF) // cards, pills, composer
val SurfaceSubtle = Color(0xFFF0ECE2) // inset / secondary fills
val SurfaceMuted = Color(0xFFE9E3D6) // pressed / muted chips
val SelectedFill = Color(0xFFEDE7DB) // selected nav row pill

val Ink = Color(0xFF211C16) // primary text (warm near-black)
val InkMuted = Color(0xFF6E665A) // secondary text
val Line = Color(0xFFE3DCCC) // hairline borders

// Accent: terracotta / rust (matches the send button + "New chat").
val Accent = Color(0xFFC2542F)
val OnAccent = Color(0xFFFFFFFF)
val AccentSoft = Color(0xFFFBF1EC)

val Success = Color(0xFF2E7D52)
val SuccessSoft = Color(0xFFDCEEE0)
val Warn = Color(0xFFC97E1A)
val Error = Color(0xFFB3261E)

// Back-compat aliases (older references expect these names).
val Surface = Canvas
val OnSurface = Ink
val OnSurfaceVariant = InkMuted
val Primary = Accent
val OnPrimary = OnAccent
val SurfaceContainer = SurfacePaper
val Outline = Line
val PrimaryContainer = AccentSoft
val OnPrimaryContainer = Ink
val OnAccentLegacy = OnAccent
val AccentContainer = AccentSoft
val OnError = Color(0xFFFFFFFF)
val ErrorContainer = Color(0xFFF9DAD5)
