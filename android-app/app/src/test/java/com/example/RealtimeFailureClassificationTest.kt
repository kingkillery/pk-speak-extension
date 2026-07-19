package com.example

import java.io.IOException
import java.net.ProtocolException
import java.net.SocketTimeoutException
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeFailureClassificationTest {

  @Test
  fun classifyRealtimeFailure_flagsHandshake401AsAuthFailure() {
    val throwable = ProtocolException("Expected HTTP 101 response but was '401 Unauthorized'")

    val error = classifyRealtimeFailure(throwable, handshakeResponse(401))

    assertTrue(error.isAuth)
    assertEquals(401, error.httpCode)
    assertEquals("Expected HTTP 101 response but was '401 Unauthorized'", error.message)
  }

  @Test
  fun classifyRealtimeFailure_treatsNullResponseAsTransportFailure() {
    val error = classifyRealtimeFailure(SocketTimeoutException("timeout"), null)

    assertFalse(error.isAuth)
    assertNull(error.httpCode)
    assertEquals("timeout", error.message)
  }

  @Test
  fun classifyRealtimeFailure_keepsHttpCodeForNonAuthHandshakeFailures() {
    val throwable = ProtocolException("Expected HTTP 101 response but was '500 Internal Server Error'")

    val error = classifyRealtimeFailure(throwable, handshakeResponse(500))

    assertFalse(error.isAuth)
    assertEquals(500, error.httpCode)
    assertEquals("Expected HTTP 101 response but was '500 Internal Server Error'", error.message)
  }

  @Test
  fun classifyRealtimeFailure_fallsBackToThrowableClassNameWhenMessageMissing() {
    val error = classifyRealtimeFailure(IOException(), null)

    assertFalse(error.isAuth)
    assertNull(error.httpCode)
    assertEquals("IOException", error.message)
  }

  private fun handshakeResponse(code: Int): Response {
    val request = Request.Builder().url("http://localhost:8767/v1/realtime").build()
    return Response.Builder()
      .request(request)
      .protocol(Protocol.HTTP_1_1)
      .code(code)
      .message("Handshake rejected")
      .build()
  }
}
