package com.example.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Default (platform sans) for headings — the Sage & Clay identity trades the
// old literary-paper serif for a friendlier, more spacious voice.
val Typography =
  Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 40.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 44.sp,
    ),
    headlineLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 30.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 36.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 24.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 30.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 22.sp,
        fontWeight = FontWeight.SemiBold,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 17.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 22.1.sp, // 17 * 1.3
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 17.sp,
        fontWeight = FontWeight.Normal,
        lineHeight = 26.35.sp, // 17 * 1.55
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 15.sp,
        fontWeight = FontWeight.Normal,
        lineHeight = 22.5.sp, // 15 * 1.5
    ),
    bodySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 13.sp,
        fontWeight = FontWeight.Normal,
        lineHeight = 18.85.sp, // 13 * 1.45
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 13.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 15.6.sp, // 13 * 1.2
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontSize = 11.sp,
        fontWeight = FontWeight.W600,
        lineHeight = 13.2.sp, // 11 * 1.2
    ),
  )
