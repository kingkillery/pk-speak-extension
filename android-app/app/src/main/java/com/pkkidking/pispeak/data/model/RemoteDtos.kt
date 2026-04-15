package com.pkkidking.pispeak.data.model

import com.pkkidking.pispeak.domain.model.RemoteStatusSummary
import com.pkkidking.pispeak.domain.model.TurnResult

data class StatusResponseDto(
    val ok: Boolean = false,
    val status: StatusDto? = null,
)

data class StatusDto(
    val speak: SpeakStatusDto? = null,
    val mono: MonoStatusDto? = null,
    val phone: PhoneStatusDto? = null,
    val remote: RemoteStatusDto? = null,
)

data class SpeakStatusDto(
    val enabled: Boolean? = null,
    val provider: String? = null,
    val configuredProvider: String? = null,
)

data class MonoStatusDto(
    val running: Boolean? = null,
)

data class PhoneStatusDto(
    val enabled: Boolean? = null,
)

data class RemoteStatusDto(
    val enabled: Boolean? = null,
    val port: Int? = null,
    val defaultTarget: String? = null,
    val currentSession: String? = null,
    val availableTargets: List<String>? = null,
)

data class TextTurnRequestDto(
    val text: String,
    val audio: Boolean,
    val target: String? = null,
)

data class TargetRouteRequestDto(
    val target: String? = null,
)

data class TargetRouteResponseDto(
    val ok: Boolean = false,
    val message: String? = null,
    val route: RouteStatusDto? = null,
)

data class RouteStatusDto(
    val defaultTarget: String? = null,
    val currentSession: String? = null,
    val availableTargets: List<String>? = null,
)

data class TurnResponseDto(
    val ok: Boolean = false,
    val replyText: String? = null,
    val transcript: String? = null,
    val audioUrl: String? = null,
    val error: String? = null,
    val message: String? = null,
)

fun StatusResponseDto.toDomain(): RemoteStatusSummary {
    val safeStatus = status
    return RemoteStatusSummary(
        remoteEnabled = safeStatus?.remote?.enabled == true,
        remotePort = safeStatus?.remote?.port,
        speakEnabled = safeStatus?.speak?.enabled == true,
        speakProvider = safeStatus?.speak?.provider ?: safeStatus?.speak?.configuredProvider,
        monoRunning = safeStatus?.mono?.running == true,
        phoneEnabled = safeStatus?.phone?.enabled == true,
        defaultTarget = safeStatus?.remote?.defaultTarget,
        currentSession = safeStatus?.remote?.currentSession,
        availableTargets = safeStatus?.remote?.availableTargets.orEmpty(),
    )
}

fun TurnResponseDto.toDomain(): TurnResult = TurnResult(
    replyText = replyText.orEmpty(),
    transcript = transcript.orEmpty(),
    audioUrl = audioUrl,
)
