package com.pkkidking.pispeak.data.repo

import com.pkkidking.pispeak.data.api.PiSpeakApiService
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

    override suspend fun sendTextTurn(settings: AppSettings, text: String): Result<TurnResult> = withContext(Dispatchers.IO) {
        runCatching {
            api.sendTextTurn(
                url = url(settings.baseUrl, "v1/turn/text"),
                authorization = authHeader(settings.token),
                body = TextTurnRequestDto(text = text, audio = settings.requestAudioReplies),
            ).toDomain()
        }
    }

    override suspend fun sendVoiceTurn(settings: AppSettings, audio: RecordedAudio): Result<TurnResult> = withContext(Dispatchers.IO) {
        runCatching {
            api.sendVoiceTurn(
                url = url(settings.baseUrl, "v1/turn/voice?audio=${if (settings.requestAudioReplies) 1 else 0}"),
                authorization = authHeader(settings.token),
                body = File(audio.filePath).asRequestBody(audio.mimeType.toMediaType()),
            ).toDomain()
        }
    }

    private fun authHeader(token: String): String? = token.trim().takeIf { it.isNotEmpty() }?.let { "Bearer $it" }

    private fun url(baseUrl: String, path: String): String {
        val normalized = ensureTrailingSlash(baseUrl.ifBlank { settingsStore.load().baseUrl })
        return normalized + path.removePrefix("/")
    }

    private fun ensureTrailingSlash(value: String): String = if (value.endsWith('/')) value else "$value/"

    companion object {
        fun resolveAudioUrl(baseUrl: String, token: String, audioUrl: String): String {
            val base = URI.create(baseUrl)
            val resolved = if (audioUrl.startsWith("http://") || audioUrl.startsWith("https://")) {
                URI.create(audioUrl)
            } else {
                val origin = URI("${base.scheme}://${base.authority}")
                origin.resolve(audioUrl)
            }
            val separator = if (resolved.query.isNullOrBlank()) "?" else "&"
            val tokenQuery = token.takeIf { it.isNotBlank() }?.let { "$separator token=$it".replace(" ", "") }.orEmpty()
            return resolved.toString() + tokenQuery
        }
    }
}
