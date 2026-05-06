package com.pkkidking.pispeak.domain.usecase

import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.RecordedAudio
import com.pkkidking.pispeak.domain.model.RemoteStatusSummary
import com.pkkidking.pispeak.domain.repo.PiSpeakRepository
import javax.inject.Inject

class LoadSettingsUseCase @Inject constructor(
    private val repository: PiSpeakRepository,
) {
    operator fun invoke(): AppSettings = repository.loadSettings()
}

class SaveSettingsUseCase @Inject constructor(
    private val repository: PiSpeakRepository,
) {
    operator fun invoke(settings: AppSettings) = repository.saveSettings(settings)
}

class GetStatusUseCase @Inject constructor(
    private val repository: PiSpeakRepository,
) {
    suspend operator fun invoke(settings: AppSettings) = repository.getStatus(settings)
}

class UpdateRouteTargetUseCase @Inject constructor(
    private val repository: PiSpeakRepository,
) {
    suspend operator fun invoke(settings: AppSettings, target: String?): Result<RemoteStatusSummary> =
        repository.updateRouteTarget(settings, target)
}

class SendTextTurnUseCase @Inject constructor(
    private val repository: PiSpeakRepository,
) {
    suspend operator fun invoke(settings: AppSettings, text: String, target: String?) =
        repository.sendTextTurn(settings, text, target)
}

class SendVoiceTurnUseCase @Inject constructor(
    private val repository: PiSpeakRepository,
) {
    suspend operator fun invoke(settings: AppSettings, audio: RecordedAudio, target: String?) =
        repository.sendVoiceTurn(settings, audio, target)
}
