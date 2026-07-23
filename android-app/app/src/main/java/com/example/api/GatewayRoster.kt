package com.example.api

import org.json.JSONObject

/**
 * Models + pure parser for the host-assisted tailnet gateway roster
 * (`GET /v1/gateways`). Phones cannot enumerate tailnet peers themselves
 * (mDNS/UDP broadcast do not traverse the WireGuard tunnel), so any paired
 * gateway doubles as the directory of every other live gateway.
 */

data class TailnetGateway(
    val hostName: String,
    val os: String? = null,
    val ip: String? = null,
    val online: Boolean = false,
    /** Display name from the gateway's discovery descriptor, e.g. "Pi Speak on mac2". */
    val name: String? = null,
    val serverId: String? = null,
    val version: String? = null,
    val authRequired: Boolean = false,
    /** Base URL that answered the probe, e.g. "http://100.109.244.1:8767". */
    val baseUrl: String = ""
)

data class GatewayRoster(
    val gateways: List<TailnetGateway> = emptyList(),
    val peersProbed: Int = 0,
    val errors: List<String> = emptyList()
)

fun parseGatewayRoster(json: JSONObject): GatewayRoster {
    val gatewaysJson = json.optJSONArray("gateways")
    val gateways = mutableListOf<TailnetGateway>()
    if (gatewaysJson != null) {
        for (i in 0 until gatewaysJson.length()) {
            val item = gatewaysJson.optJSONObject(i) ?: continue
            val peer = item.optJSONObject("peer") ?: continue
            val descriptor = item.optJSONObject("descriptor") ?: continue
            val hostName = peer.optString("hostName")
            val baseUrl = descriptor.optString("baseUrl")
            if (hostName.isBlank() || baseUrl.isBlank()) continue
            gateways.add(
                TailnetGateway(
                    hostName = hostName,
                    os = peer.optString("os").ifBlank { null },
                    ip = peer.optString("ip").ifBlank { null },
                    online = peer.optBoolean("online", false),
                    name = descriptor.optString("name").ifBlank { null },
                    serverId = descriptor.optString("serverId").ifBlank { null },
                    version = descriptor.optString("version").ifBlank { null },
                    authRequired = descriptor.optBoolean("authRequired", false),
                    baseUrl = baseUrl
                )
            )
        }
    }
    val errorsJson = json.optJSONArray("errors")
    val errors = mutableListOf<String>()
    if (errorsJson != null) {
        for (i in 0 until errorsJson.length()) {
            val value = errorsJson.optString(i)
            if (value.isNotBlank()) errors.add(value)
        }
    }
    return GatewayRoster(
        gateways = gateways,
        peersProbed = json.optInt("peersProbed", 0),
        errors = errors
    )
}
