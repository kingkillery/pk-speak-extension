package com.pkkidking.pispeak.data.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.AppSettings
import com.pkkidking.pispeak.domain.model.ConnectionProfileId
import com.pkkidking.pispeak.domain.model.ConnectionSettings
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

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

    fun load(): AppSettings = AppSettings(
        activeProfileId = prefs.getString(KEY_ACTIVE_PROFILE, ConnectionProfileId.WINDOWS.key).orEmpty(),
        windowsConnection = ConnectionSettings(
            baseUrl = prefs.getString(KEY_WINDOWS_BASE_URL, BuildConfig.DEFAULT_BASE_URL).orEmpty(),
            token = prefs.getString(KEY_WINDOWS_TOKEN, "").orEmpty(),
        ),
        macConnection = ConnectionSettings(
            baseUrl = prefs.getString(KEY_MAC_BASE_URL, BuildConfig.DEFAULT_BASE_URL).orEmpty(),
            token = prefs.getString(KEY_MAC_TOKEN, "").orEmpty(),
        ),
        requestAudioReplies = prefs.getBoolean(KEY_REQUEST_AUDIO, true),
        autoplayReplyAudio = prefs.getBoolean(KEY_AUTOPLAY_AUDIO, true),
    )

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_ACTIVE_PROFILE, settings.activeProfileId)
            .putString(KEY_WINDOWS_BASE_URL, settings.windowsConnection.baseUrl)
            .putString(KEY_WINDOWS_TOKEN, settings.windowsConnection.token)
            .putString(KEY_MAC_BASE_URL, settings.macConnection.baseUrl)
            .putString(KEY_MAC_TOKEN, settings.macConnection.token)
            .putBoolean(KEY_REQUEST_AUDIO, settings.requestAudioReplies)
            .putBoolean(KEY_AUTOPLAY_AUDIO, settings.autoplayReplyAudio)
            .apply()
    }

    private companion object {
        const val PREFS_NAME = "pi_speak_secure_settings"
        const val KEY_ACTIVE_PROFILE = "active_profile"
        const val KEY_WINDOWS_BASE_URL = "windows_base_url"
        const val KEY_WINDOWS_TOKEN = "windows_token"
        const val KEY_MAC_BASE_URL = "mac_base_url"
        const val KEY_MAC_TOKEN = "mac_token"
        const val KEY_REQUEST_AUDIO = "request_audio"
        const val KEY_AUTOPLAY_AUDIO = "autoplay_audio"
    }
}
