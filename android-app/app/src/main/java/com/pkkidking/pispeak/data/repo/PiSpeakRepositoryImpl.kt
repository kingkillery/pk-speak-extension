package com.pkkidking.pispeak.data.repo

import com.pkkidking.pispeak.data.api.PiSpeakApiService
import com.pkkidking.pispeak.data.model.TargetRouteRequestDto
import com.pkkidking.pispeak.data.model.TextTurnRequestDto
import com.pkkidking.pispeak.data.model.toDomain
import com.pkkidking.pispeak.data.storage.SecureSettingsStore
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.DiagnosticEvent
import com.pkkidking.pispeak.domain.model.RecordedAudio
import com.pkkidking.pispeak.domain.model.RemoteStatusSummary
import com.pkkidking.pispeak.domain.model.TurnHistoryItem
import com.pkkidking.pispeak.domain.model.TurnResult
import com.pkkidking.pispeak.domain.repo.PiSpeakRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import javax.inject.Inject
import javax.inject.Singleton
import retrofit2.HttpException

@Singleton
class PiSpeakRepositoryImpl @Inject constructor(
    private val api: PiSpeakApiService,
    private val settingsStore: SecureSettingsStore,
) : PiSpeakRepository {

    override fun loadSettings(): AppSettings = settingsStore.load()

    override fun saveSettings(settings: AppSettings) {
        settingsStore.save(settings)
    }

    override fun loadTurnHistory(): List<TurnHistoryItem> = settingsStore.loadTurnHistory()

    override fun saveTurnHistory(items: List<TurnHistoryItem>) {
        settingsStore.saveTurnHistory(items)
    }

    override fun appendTurnHistory(item: TurnHistoryItem): List<TurnHistoryItem> =
        settingsStore.appendTurnHistory(item)

    override fun clearTurnHistory() {
        settingsStore.clearTurnHistory()
    }

    override fun loadDiagnostics(): List<DiagnosticEvent> = settingsStore.loadDiagnostics()

    override fun appendDiagnostic(event: DiagnosticEvent): List<DiagnosticEvent> =
        settingsStore.appendDiagnostic(event)

    override suspend fun getStatus(settings: AppSettings): Result<RemoteStatusSummary> = withContext(Dispatchers.IO) {
        remoteResult {
            val response = api.getStatus(
                url = url(settings.baseUrl, "v1/status"),
                authorization = authHeader(settings.token),
            )
            requireOk(response.ok, "Status request failed")
            response.toDomain()
        }
    }

    override suspend fun updateRouteTarget(settings: AppSettings, target: String?): Result<RemoteStatusSummary> = withContext(Dispatchers.IO) {
        remoteResult {
            val response = api.updateRoute(
                url = url(settings.baseUrl, "v1/route"),
                authorization = authHeader(settings.token),
                body = TargetRouteRequestDto(target = target?.trim()?.takeIf { it.isNotEmpty() }),
            )
            requireOk(response.ok, response.message ?: "Failed to update route target")
            val route = response.route
            RemoteStatusSummary(
                remoteEnabled = true,
                remotePort = null,
                agentProvider = null,
                agentModel = null,
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

    override suspend fun sendTextTurn(settings: AppSettings, text: String, target: String?): Result<TurnResult> = withContext(Dispatchers.IO) {
        remoteResult {
            val response = api.sendTextTurn(
                url = url(settings.baseUrl, "v1/turn/text"),
                authorization = authHeader(settings.token),
                body = TextTurnRequestDto(
                    text = text,
                    audio = settings.requestAudioReplies,
                    target = normalizedTarget(target),
                    cwd = normalizedWorkspace(settings.workspacePath),
                ),
            )
            requireOk(response.ok, response.error ?: response.message ?: "Text turn failed")
            response.toDomain()
        }
    }

    override suspend fun sendVoiceTurn(settings: AppSettings, audio: RecordedAudio, target: String?): Result<TurnResult> = withContext(Dispatchers.IO) {
        val audioFile = File(audio.filePath)
        try {
            remoteResult {
                val response = api.sendVoiceTurn(
                    url = url(settings.baseUrl, voiceTurnPath(settings, target)),
                    authorization = authHeader(settings.token),
                    body = audioFile.asRequestBody(audio.mimeType.toMediaType()),
                )
                requireOk(response.ok, response.error ?: response.message ?: "Voice turn failed")
                response.toDomain()
            }
        } finally {
            audioFile.delete()
        }
    }

    private fun authHeader(token: String): String? = token.trim().takeIf { it.isNotEmpty() }?.let { "Bearer $it" }

    private fun normalizedTarget(target: String?): String? = target?.trim()?.takeIf { it.isNotEmpty() }

    private fun normalizedWorkspace(workspacePath: String): String? = workspacePath.trim().takeIf { it.isNotEmpty() }

    private fun voiceTurnPath(settings: AppSettings, target: String?): String {
        val params = mutableListOf("audio=${if (settings.requestAudioReplies) 1 else 0}")
        normalizedTarget(target)?.let {
            params += "target=${URLEncoder.encode(it, StandardCharsets.UTF_8.name())}"
        }
        normalizedWorkspace(settings.workspacePath)?.let {
            params += "cwd=${URLEncoder.encode(it, StandardCharsets.UTF_8.name())}"
        }
        return "v1/turn/voice?${params.joinToString("&")}"
    }

    private fun url(baseUrl: String, path: String): String {
        val normalized = ensureTrailingSlash(baseUrl.ifBlank { settingsStore.load().baseUrl })
        return normalized + path.removePrefix("/")
    }

    private fun ensureTrailingSlash(value: String): String = if (value.endsWith('/')) value else "$value/"

    private inline fun <T> remoteResult(block: () -> T): Result<T> =
        runCatching(block).fold(
            onSuccess = { Result.success(it) },
            onFailure = { Result.failure(IllegalStateException(it.toRemoteMessage())) },
        )

    private fun requireOk(ok: Boolean, message: String) {
        if (!ok) error(message)
    }

    private fun Throwable.toRemoteMessage(): String = when (this) {
        is HttpException -> when (code()) {
            401, 403 -> "Unauthorized. Check the remote token from /remote setup."
            404 -> "Pi Speak endpoint was not found. Check the base URL."
            413 -> "The request was too large for the Pi Speak server."
            415 -> "This audio format is not accepted by the Pi Speak server."
            429 -> "Pi is busy or rate limited. Wait a moment and retry."
            504 -> "Pi did not answer before the request timed out."
            else -> "Pi Speak request failed with HTTP ${code()}."
        }
        is IOException -> "Pi is offline or unreachable. Check the HTTPS, Tailscale, or Bluetooth local-link URL and network."
        else -> message ?: "Pi Speak request failed."
    }
}
