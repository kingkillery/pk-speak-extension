package com.pkkidking.pispeak.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val LightColors = lightColorScheme(
    primary = Color(0xFF8B3E2F),
    onPrimary = Color(0xFFFDF7F2),
    primaryContainer = Color(0xFFF6DED1),
    onPrimaryContainer = Color(0xFF422118),
    secondary = Color(0xFF36516A),
    onSecondary = Color(0xFFF4F7FA),
    secondaryContainer = Color(0xFFDCE7F0),
    onSecondaryContainer = Color(0xFF1A3247),
    tertiary = Color(0xFF87693C),
    background = Color(0xFFF4EEE5),
    onBackground = Color(0xFF183249),
    surface = Color(0xFFFFFBF6),
    onSurface = Color(0xFF183249),
    surfaceVariant = Color(0xFFE6DED2),
    onSurfaceVariant = Color(0xFF536879),
    outline = Color(0xFF9DAAB5),
    outlineVariant = Color(0xFFD5CCBF),
    error = Color(0xFFB33E1B),
    onError = Color.White,
    errorContainer = Color(0xFFF9DDD2),
    onErrorContainer = Color(0xFF5B1E0D),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFF09B7D),
    onPrimary = Color(0xFF4E241A),
    primaryContainer = Color(0xFF6A3325),
    onPrimaryContainer = Color(0xFFFFDBCF),
    secondary = Color(0xFFB8CBDC),
    onSecondary = Color(0xFF20374A),
    secondaryContainer = Color(0xFF30495E),
    onSecondaryContainer = Color(0xFFD7E6F3),
    tertiary = Color(0xFFE0C18A),
    background = Color(0xFF101B25),
    onBackground = Color(0xFFF1EAE2),
    surface = Color(0xFF16232D),
    onSurface = Color(0xFFF1EAE2),
    surfaceVariant = Color(0xFF223441),
    onSurfaceVariant = Color(0xFFB9C7D1),
    outline = Color(0xFF7D8D99),
    outlineVariant = Color(0xFF324654),
    error = Color(0xFFFFB59A),
    onError = Color(0xFF611F0E),
    errorContainer = Color(0xFF7D2D13),
    onErrorContainer = Color(0xFFFFDBCF),
)

private val PiSpeakTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 46.sp,
        lineHeight = 48.sp,
        letterSpacing = (-1.2).sp,
    ),
    displayMedium = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 34.sp,
        lineHeight = 36.sp,
        letterSpacing = (-0.6).sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 30.sp,
        lineHeight = 34.sp,
        letterSpacing = (-0.3).sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Medium,
        fontSize = 24.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 25.sp,
        letterSpacing = (-0.1).sp,
    ),
    titleSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.1.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 18.sp,
        lineHeight = 29.sp,
        letterSpacing = 0.1.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 24.sp,
        letterSpacing = 0.15.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 16.sp,
        letterSpacing = 1.3.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.9.sp,
    ),
)

@Composable
fun PiSpeakTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = PiSpeakTypography,
        content = content,
    )
}
