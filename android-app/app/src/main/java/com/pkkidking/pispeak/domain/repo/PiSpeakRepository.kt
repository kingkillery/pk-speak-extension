package com.pkkidking.pispeak.domain.repo

import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.DiagnosticEvent
import com.pkkidking.pispeak.domain.model.RecordedAudio
import com.pkkidking.pispeak.domain.model.RemoteStatusSummary
import com.pkkidking.pispeak.domain.model.TurnHistoryItem
import com.pkkidking.pispeak.domain.model.TurnResult

interface PiSpeakRepository {
    fun loadSettings(): AppSettings
    fun saveSettings(settings: AppSettings)
    fun loadTurnHistory(): List<TurnHistoryItem>
    fun saveTurnHistory(items: List<TurnHistoryItem>)
    fun appendTurnHistory(item: TurnHistoryItem): List<TurnHistoryItem>
    fun clearTurnHistory()
    fun loadDiagnostics(): List<DiagnosticEvent>
    fun appendDiagnostic(event: DiagnosticEvent): List<DiagnosticEvent>
    suspend fun getStatus(settings: AppSettings): Result<RemoteStatusSummary>
    suspend fun updateRouteTarget(settings: AppSettings, target: String?): Result<RemoteStatusSummary>
    suspend fun sendTextTurn(settings: AppSettings, text: String, target: String?): Result<TurnResult>
    suspend fun sendVoiceTurn(settings: AppSettings, audio: RecordedAudio, target: String?): Result<TurnResult>
}
