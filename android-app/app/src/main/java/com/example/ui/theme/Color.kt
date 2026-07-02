package com.example.ui.theme

import androidx.compose.ui.graphics.Color

// Minimal computer-connection palette inspired by OpenAI/Codex mobile surfaces.
val Canvas = Color(0xFFF7F7F4) // quiet off-white app background
val SurfacePaper = Color(0xFFFFFFFF) // primary cards, composer, sheets
val SurfaceSubtle = Color(0xFFF1F1EE) // secondary panels and empty states
val SurfaceMuted = Color(0xFFE6E6E1) // disabled controls and pressed chips
val SelectedFill = Color(0xFFEDEDEA) // selected nav row pill

val Ink = Color(0xFF171717) // primary text
val InkMuted = Color(0xFF6B6B66) // secondary text
val Line = Color(0xFFE1E1DC) // quiet dividers and borders

// Accent stays monochrome; live connection state carries the color.
val Accent = Color(0xFF171717)
val OnAccent = Color(0xFFFFFFFF)
val AccentSoft = Color(0xFFF1F1EE)

val Success = Color(0xFF147A4A)
val SuccessSoft = Color(0xFFE2F4EA)
val Warn = Color(0xFF9A6A16)
val Error = Color(0xFFB42318)

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
