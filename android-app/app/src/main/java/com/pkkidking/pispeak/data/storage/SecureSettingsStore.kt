package com.pkkidking.pispeak.data.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.ConnectionMode
import com.pkkidking.pispeak.domain.model.DefaultMachineProfiles
import com.pkkidking.pispeak.domain.model.MachineProfile
import com.pkkidking.pispeak.domain.model.normalizedBaseUrl
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.LinkedHashMap
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import org.json.JSONArray
import org.json.JSONObject

@Singleton
class SecureSettingsStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun load(): AppSettings {
        val machineProfiles = loadMachineProfiles()
        val selectedMachineId = prefs.getString(KEY_SELECTED_MACHINE_ID, null)
        val selectedMachine = machineProfiles.firstOrNull { it.id == selectedMachineId }

        val legacyBaseUrl = prefs.getString(KEY_BASE_URL, BuildConfig.DEFAULT_BASE_URL).orEmpty()
        val legacyToken = prefs.getString(KEY_TOKEN, "").orEmpty()
        val legacyWorkspacePath = prefs.getString(KEY_WORKSPACE_PATH, "").orEmpty()

        return AppSettings(
            baseUrl = selectedMachine?.baseUrl ?: legacyBaseUrl.ifBlank { machineProfiles.first().baseUrl },
            token = selectedMachine?.token ?: legacyToken,
            requestAudioReplies = prefs.getBoolean(KEY_REQUEST_AUDIO, true),
            autoplayReplyAudio = prefs.getBoolean(KEY_AUTOPLAY_AUDIO, true),
            connectionMode = selectedMachine?.connectionMode
                ?: ConnectionMode.fromStorage(prefs.getString(KEY_CONNECTION_MODE, null)),
            selectedMachineId = selectedMachine?.id,
            machineProfiles = machineProfiles,
            machineProfileName = "",
            workspacePath = selectedMachine?.workspacePath ?: legacyWorkspacePath,
        )
    }

    fun save(settings: AppSettings) {
        val edit = prefs.edit()
            .putString(KEY_BASE_URL, settings.baseUrl)
            .putString(KEY_TOKEN, settings.token)
            .putString(KEY_WORKSPACE_PATH, settings.workspacePath)
            .putBoolean(KEY_REQUEST_AUDIO, settings.requestAudioReplies)
            .putBoolean(KEY_AUTOPLAY_AUDIO, settings.autoplayReplyAudio)
            .putString(KEY_CONNECTION_MODE, settings.connectionMode.storageKey)
            .putString(KEY_SELECTED_MACHINE_ID, settings.selectedMachineId)
            .putString(KEY_MACHINE_PROFILES, encodeMachineProfiles(settings.machineProfiles))

        edit.apply()
    }

    private fun loadMachineProfiles(): List<MachineProfile> {
        val raw = prefs.getString(KEY_MACHINE_PROFILES, "[]").orEmpty()
        if (raw.isBlank()) return DefaultMachineProfiles
        val parsed = runCatching { JSONArray(raw) }.getOrElse { return DefaultMachineProfiles }
        val profiles = mutableListOf<MachineProfile>()
        for (index in 0 until parsed.length()) {
            val item = parsed.optJSONObject(index) ?: continue
            val baseUrl = item.optString("baseUrl").trim()
            if (baseUrl.isBlank()) continue
            val id = item.optString("id").ifBlank { UUID.randomUUID().toString() }
            profiles.add(
                MachineProfile(
                    id = id,
                    name = item.optString("name").ifBlank { "Machine ${index + 1}" },
                    baseUrl = item.optString("baseUrl").trim(),
                    token = item.optString("token").trim(),
                    connectionMode = ConnectionMode.fromStorage(
                        item.optString("connectionMode"),
                        inferConnectionMode(id),
                    ),
                    workspacePath = item.optString("workspacePath").trim(),
                ),
            )
        }
        return ensureUniqueMachineProfiles(DefaultMachineProfiles + profiles)
    }

    private fun encodeMachineProfiles(machineProfiles: List<MachineProfile>): String {
        val array = JSONArray()
        for (profile in ensureUniqueMachineProfiles(machineProfiles)) {
            array.put(
                JSONObject().apply {
                    put("id", profile.id.ifBlank { UUID.randomUUID().toString() })
                    put("name", profile.name.ifBlank { "Machine ${array.length() + 1}" })
                    put("baseUrl", profile.normalizedBaseUrl())
                    put("token", profile.token.trim())
                    put("connectionMode", profile.connectionMode.storageKey)
                    put("workspacePath", profile.workspacePath.trim())
                },
            )
        }
        return array.toString()
    }

    private fun ensureUniqueMachineProfiles(machineProfiles: List<MachineProfile>): List<MachineProfile> {
        val ordered = LinkedHashMap<String, MachineProfile>()
        for (profile in machineProfiles) {
            val normalizedBaseUrl = profile.normalizedBaseUrl()
            if (normalizedBaseUrl.isBlank()) continue

            val canonical = profile.copy(
                id = profile.id.ifBlank { UUID.randomUUID().toString() },
                name = profile.name.ifBlank { "Machine" },
                baseUrl = normalizedBaseUrl,
                token = profile.token.trim(),
                connectionMode = profile.connectionMode,
                workspacePath = profile.workspacePath.trim(),
            )
            val key = if (canonical.id.startsWith("tailscale-") || canonical.id.startsWith("bluetooth-")) {
                canonical.id
            } else {
                "${canonical.baseUrl}|${canonical.token}"
            }
            ordered[key] = canonical
        }
        return ordered.values.toList()
    }

    private fun inferConnectionMode(id: String): ConnectionMode = when {
        id.startsWith("tailscale-") -> ConnectionMode.TAILSCALE
        id.startsWith("bluetooth-") -> ConnectionMode.BLUETOOTH
        else -> ConnectionMode.MANUAL
    }

    private companion object {
        const val PREFS_NAME = "pi_speak_secure_settings"
        const val KEY_BASE_URL = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_WORKSPACE_PATH = "workspace_path"
        const val KEY_CONNECTION_MODE = "connection_mode"
        const val KEY_REQUEST_AUDIO = "request_audio"
        const val KEY_AUTOPLAY_AUDIO = "autoplay_audio"
        const val KEY_SELECTED_MACHINE_ID = "selected_machine_id"
        const val KEY_MACHINE_PROFILES = "machine_profiles"
    }
}
