package com.pkkidking.pispeak.domain.usecase

import java.net.URI
import javax.inject.Inject

class ResolveAudioUrlUseCase @Inject constructor() {
    operator fun invoke(baseUrl: String, audioUrl: String): String {
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
