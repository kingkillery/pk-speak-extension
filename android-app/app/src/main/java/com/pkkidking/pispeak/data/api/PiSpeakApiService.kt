package com.pkkidking.pispeak.data.api

import com.pkkidking.pispeak.data.model.StatusResponseDto
import com.pkkidking.pispeak.data.model.TargetRouteRequestDto
import com.pkkidking.pispeak.data.model.TargetRouteResponseDto
import com.pkkidking.pispeak.data.model.TextTurnRequestDto
import com.pkkidking.pispeak.data.model.TurnResponseDto
import okhttp3.RequestBody
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Url

interface PiSpeakApiService {
    @GET
    suspend fun getStatus(
        @Url url: String,
        @Header("Authorization") authorization: String? = null,
    ): StatusResponseDto

    @POST
    suspend fun sendTextTurn(
        @Url url: String,
        @Header("Authorization") authorization: String? = null,
        @Body body: TextTurnRequestDto,
    ): TurnResponseDto

    @POST
    suspend fun updateRoute(
        @Url url: String,
        @Header("Authorization") authorization: String? = null,
        @Body body: TargetRouteRequestDto,
    ): TargetRouteResponseDto

    @POST
    suspend fun sendVoiceTurn(
        @Url url: String,
        @Header("Authorization") authorization: String? = null,
        @Body body: RequestBody,
    ): TurnResponseDto
}
