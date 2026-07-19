package com.example.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ConnectionReasonTest {

  @Test
  fun classifyPairing_reportsUnreachableWheneverHealthCheckFails() {
    assertEquals(
      ConnectionReason.Unreachable,
      classifyPairing(healthOk = false, requiresPairing = false, authRequired = false, token = "", authenticated = false)
    )
    // Pairing/auth/token state is irrelevant while the gateway is not answering.
    assertEquals(
      ConnectionReason.Unreachable,
      classifyPairing(healthOk = false, requiresPairing = true, authRequired = true, token = "stale", authenticated = false)
    )
  }

  @Test
  fun classifyPairing_requiresPairingWheneverAuthGatewayHasNoToken() {
    // Pairing-required gateway with no token.
    assertEquals(
      ConnectionReason.PairingRequired,
      classifyPairing(healthOk = true, requiresPairing = true, authRequired = true, token = "", authenticated = true)
    )
    // Auth-required gateway with no token is also a pairing problem, even when
    // the descriptor does not flag pairing explicitly.
    assertEquals(
      ConnectionReason.PairingRequired,
      classifyPairing(healthOk = true, requiresPairing = false, authRequired = true, token = "", authenticated = true)
    )
    // A saved-but-unverified token is a token question, not a pairing one.
    assertEquals(
      ConnectionReason.TokenRejected,
      classifyPairing(healthOk = true, requiresPairing = true, authRequired = true, token = "stale", authenticated = false)
    )
  }

  @Test
  fun classifyPairing_rejectsUnauthenticatedTokenOnAuthGateway() {
    assertEquals(
      ConnectionReason.TokenRejected,
      classifyPairing(healthOk = true, requiresPairing = false, authRequired = true, token = "stale", authenticated = false)
    )
  }

  @Test
  fun classifyPairing_reportsOkForOpenPairedAndAuthenticatedGateways() {
    // Open gateway: no pairing, no auth, no token needed.
    assertEquals(
      ConnectionReason.Ok,
      classifyPairing(healthOk = true, requiresPairing = false, authRequired = false, token = "", authenticated = false)
    )
    // Paired gateway accepting the saved token.
    assertEquals(
      ConnectionReason.Ok,
      classifyPairing(healthOk = true, requiresPairing = false, authRequired = true, token = "secret", authenticated = true)
    )
    // Previously paired gateway still accepting the saved token.
    assertEquals(
      ConnectionReason.Ok,
      classifyPairing(healthOk = true, requiresPairing = true, authRequired = true, token = "secret", authenticated = true)
    )
  }

  @Test
  fun classifyPairing_neverReportsDiscoveryFailed() {
    // DiscoveryFailed is emitted only by tryAutoConnect's discovery catch branch,
    // never by the pure health/pairing mapping.
    for (healthOk in listOf(false, true)) {
      for (requiresPairing in listOf(false, true)) {
        for (authRequired in listOf(false, true)) {
          for (token in listOf("", "secret")) {
            for (authenticated in listOf(false, true)) {
              assertNotEquals(
                ConnectionReason.DiscoveryFailed,
                classifyPairing(healthOk, requiresPairing, authRequired, token, authenticated)
              )
            }
          }
        }
      }
    }
  }
}
