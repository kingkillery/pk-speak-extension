package com.pkkidking.pispeak.domain.repo

import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.RecordedAudio
import com.pkkidking.pispeak.domain.model.RemoteStatusSummary
import com.pkkidking.pispeak.domain.model.TurnResult

interface PiSpeakRepository {
    fun loadSettings(): AppSettings
    fun saveSettings(settings: AppSettings)
    suspend fun getStatus(settings: AppSettings): Result<RemoteStatusSummary>
    suspend fun updateRouteTarget(settings: AppSettings, target: String?): Result<RemoteStatusSummary>
    suspend fun sendTextTurn(settings: AppSettings, text: String): Result<TurnResult>
    suspend fun sendVoiceTurn(settings: AppSettings, audio: RecordedAudio): Result<TurnResult>
}
