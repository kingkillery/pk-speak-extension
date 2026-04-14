package com.pkkidking.pispeak.data.storage

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.pkkidking.pispeak.BuildConfig
import com.pkkidking.pispeak.domain.model.AppSettings
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
        baseUrl = prefs.getString(KEY_BASE_URL, BuildConfig.DEFAULT_BASE_URL).orEmpty(),
        token = prefs.getString(KEY_TOKEN, "").orEmpty(),
        requestAudioReplies = prefs.getBoolean(KEY_REQUEST_AUDIO, true),
        autoplayReplyAudio = prefs.getBoolean(KEY_AUTOPLAY_AUDIO, true),
    )

    fun save(settings: AppSettings) {
        prefs.edit()
            .putString(KEY_BASE_URL, settings.baseUrl)
            .putString(KEY_TOKEN, settings.token)
            .putBoolean(KEY_REQUEST_AUDIO, settings.requestAudioReplies)
            .putBoolean(KEY_AUTOPLAY_AUDIO, settings.autoplayReplyAudio)
            .apply()
    }

    private companion object {
        const val PREFS_NAME = "pi_speak_secure_settings"
        const val KEY_BASE_URL = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_REQUEST_AUDIO = "request_audio"
        const val KEY_AUTOPLAY_AUDIO = "autoplay_audio"
    }
}
