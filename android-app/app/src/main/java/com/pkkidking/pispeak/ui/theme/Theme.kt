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
    primary = Color(0xFF183249),
    onPrimary = Color(0xFFF7FAFC),
    primaryContainer = Color(0xFFDCEAF3),
    onPrimaryContainer = Color(0xFF102332),
    secondary = Color(0xFF17765D),
    onSecondary = Color(0xFFF4FFFA),
    secondaryContainer = Color(0xFFD8F0E7),
    onSecondaryContainer = Color(0xFF09291F),
    tertiary = Color(0xFFC95532),
    onTertiary = Color(0xFFFFF8F2),
    tertiaryContainer = Color(0xFFF6D8CB),
    onTertiaryContainer = Color(0xFF461406),
    background = Color(0xFFF7F8F5),
    onBackground = Color(0xFF17211C),
    surface = Color(0xFFFBFCF8),
    onSurface = Color(0xFF17211C),
    surfaceVariant = Color(0xFFE7ECE5),
    onSurfaceVariant = Color(0xFF2B3630),
    outline = Color(0xFF8B978F),
    outlineVariant = Color(0xFFCCD4CD),
    error = Color(0xFFB33E1B),
    onError = Color.White,
    errorContainer = Color(0xFFF9DAD5),
    onErrorContainer = Color(0xFF5B1E0D),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFB7D4E7),
    onPrimary = Color(0xFF0B2536),
    primaryContainer = Color(0xFF25465E),
    onPrimaryContainer = Color(0xFFDCEAF3),
    secondary = Color(0xFF93D7C0),
    onSecondary = Color(0xFF073326),
    secondaryContainer = Color(0xFF164F3F),
    onSecondaryContainer = Color(0xFFD8F0E7),
    tertiary = Color(0xFFFFB59A),
    onTertiary = Color(0xFF5B1B0A),
    tertiaryContainer = Color(0xFF83381F),
    onTertiaryContainer = Color(0xFFFFDED3),
    background = Color(0xFF101A22),
    onBackground = Color(0xFFEEF3EE),
    surface = Color(0xFF101A22),
    onSurface = Color(0xFFEEF3EE),
    surfaceVariant = Color(0xFF172533),
    onSurfaceVariant = Color(0xFFD7DDD7),
    outline = Color(0xFF8B978F),
    outlineVariant = Color(0xFF405047),
    error = Color(0xFFFFB59A),
    onError = Color(0xFF611F0E),
    errorContainer = Color(0xFF7D2D13),
    onErrorContainer = Color(0xFFFFDBCF),
)

private val PiSpeakTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 40.sp,
        lineHeight = 43.sp,
        letterSpacing = 0.sp,
    ),
    displayMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 30.sp,
        lineHeight = 35.sp,
        letterSpacing = 0.sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 24.sp,
        lineHeight = 29.sp,
        letterSpacing = 0.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        lineHeight = 25.sp,
        letterSpacing = 0.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.sp,
    ),
    titleSmall = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 17.sp,
        lineHeight = 26.sp,
        letterSpacing = 0.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 23.sp,
        letterSpacing = 0.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 13.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.sp,
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
