package com.example.ui.theme

import androidx.compose.ui.graphics.Color

// Sage & Clay: a warm, spacious agent-hub palette. Sage carries "live"/primary
// UI state (tabs, connected status, nav selection); clay is the action accent
// (record/send, avatars). Both are colored deliberately — this build no longer
// keeps the accent monochrome.
val Canvas = Color(0xFFF7F6F0) // warm sage-tinted off-white app background
val SurfacePaper = Color(0xFFFEFDF9) // primary cards, composer, sheets
val SurfaceSubtle = Color(0xFFEDEDE1) // secondary panels and empty states
val SurfaceMuted = Color(0xFFE3E3D3) // disabled controls and pressed chips
val SelectedFill = Color(0xFFE3E8DA) // selected nav row / tab pill (sage wash)

val Ink = Color(0xFF2B2E24) // primary text (olive-tinted near-black)
val InkMuted = Color(0xFF767A64) // secondary text
val Line = Color(0xFFDEDECD) // quiet dividers and borders

// Accent is warm clay/terracotta; live connection state carries sage.
val Accent = Color(0xFFC1653E)
val OnAccent = Color(0xFFFFFFFF)
val AccentSoft = Color(0xFFF7EBE6)

val Success = Color(0xFF5F7548) // sage — also the "live"/primary UI color
val SuccessSoft = Color(0xFFEAEDE0)
val Warn = Color(0xFF9C6B1E)
val Error = Color(0xFFB23B23)

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
val ErrorContainer = Color(0xFFF5E6E2)
