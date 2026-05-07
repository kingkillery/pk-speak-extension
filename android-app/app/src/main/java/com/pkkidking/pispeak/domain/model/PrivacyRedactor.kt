package com.pkkidking.pispeak.domain.model

object PrivacyRedactor {
    fun redact(value: String): String =
        value
            .replace(Regex("Bearer\\s+\\S+", RegexOption.IGNORE_CASE), "Bearer [redacted]")
            .replace(Regex("([?&]token=)([^\\s&]+)", RegexOption.IGNORE_CASE), "${'$'}1[redacted]")
            .replace(Regex("(token=)([^\\s&]+)", RegexOption.IGNORE_CASE), "${'$'}1[redacted]")
            .replace(Regex("(remote token[:=]\\s*)(\\S+)", RegexOption.IGNORE_CASE), "${'$'}1[redacted]")
}
