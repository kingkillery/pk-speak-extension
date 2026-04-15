package com.pkkidking.pispeak.data.repo

import com.pkkidking.pispeak.data.api.PiSpeakApiService
import com.pkkidking.pispeak.data.model.TargetRouteRequestDto
import com.pkkidking.pispeak.data.model.TextTurnRequestDto
import com.pkkidking.pispeak.data.model.toDomain
import com.pkkidking.pispeak.data.storage.SecureSettingsStore
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.RecordedAudio
import com.pkkidking.pispeak.domain.model.RemoteStatusSummary
import com.pkkidking.pispeak.domain.model.TurnResult
import com.pkkidking.pispeak.domain.repo.PiSpeakRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.net.URI
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PiSpeakRepositoryImpl @Inject constructor(
    private val api: PiSpeakApiService,
    private val settingsStore: SecureSettingsStore,
) : PiSpeakRepository {

    override fun loadSettings(): AppSettings = settingsStore.load()

    override fun saveSettings(settings: AppSettings) {
        settingsStore.save(settings)
    }

    override suspend fun getStatus(settings: AppSettings): Result<RemoteStatusSummary> = withContext(Dispatchers.IO) {
        runCatching {
            api.getStatus(
                url = url(settings.baseUrl, "v1/status"),
                authorization = authHeader(settings.token),
            ).toDomain()
        }
    }

    override suspend fun updateRouteTarget(settings: AppSettings, target: String?): Result<RemoteStatusSummary> = withContext(Dispatchers.IO) {
        runCatching {
            val route = api.updateRoute(
                url = url(settings.baseUrl, "v1/route"),
                authorization = authHeader(settings.token),
                body = TargetRouteRequestDto(target = target?.trim()?.takeIf { it.isNotEmpty() }),
            ).route
            RemoteStatusSummary(
                remoteEnabled = true,
                remotePort = null,
                speakEnabled = false,
                speakProvider = null,
                monoRunning = false,
                phoneEnabled = false,
                defaultTarget = route?.defaultTarget,
                currentSession = route?.currentSession,
                availableTargets = route?.availableTargets.orEmpty(),
            )
        }
    }

    override suspend fun sendTextTurn(settings: AppSettings, text: String): Result<TurnResult> = withContext(Dispatchers.IO) {
        runCatching {
            api.sendTextTurn(
                url = url(settings.baseUrl, "v1/turn/text"),
                authorization = authHeader(settings.token),
                body = TextTurnRequestDto(
                    text = text,
                    audio = settings.requestAudioReplies,
                    target = null,
                ),
            ).toDomain()
        }
    }

    override suspend fun sendVoiceTurn(settings: AppSettings, audio: RecordedAudio): Result<TurnResult> = withContext(Dispatchers.IO) {
        val audioFile = File(audio.filePath)
        try {
            runCatching {
                api.sendVoiceTurn(
                    url = url(settings.baseUrl, "v1/turn/voice?audio=${if (settings.requestAudioReplies) 1 else 0}"),
                    authorization = authHeader(settings.token),
                    body = audioFile.asRequestBody(audio.mimeType.toMediaType()),
                ).toDomain()
            }
        } finally {
            audioFile.delete()
        }
    }

    private fun authHeader(token: String): String? = token.trim().takeIf { it.isNotEmpty() }?.let { "Bearer $it" }

    private fun url(baseUrl: String, path: String): String {
        val normalized = ensureTrailingSlash(baseUrl.ifBlank { settingsStore.load().baseUrl })
        return normalized + path.removePrefix("/")
    }

    private fun ensureTrailingSlash(value: String): String = if (value.endsWith('/')) value else "$value/"

    companion object {
        fun resolveAudioUrl(baseUrl: String, audioUrl: String): String {
            val base = URI.create(baseUrl)
            val resolved = if (audioUrl.startsWith("http://") || audioUrl.startsWith("https://")) {
                URI.create(audioUrl)
            } else {
                val origin = URI("${base.scheme}://${base.authority}")
                origin.resolve(audioUrl)
            }
            return resolved.toString()
        }
    }
}
