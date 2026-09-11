// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.integration

import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import okhttp3.EventListener
import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response

/**
 * Release stand-ins for the OkHttp and Room integrations.
 *
 * Both return the builder untouched, so `installPorthole()` can stay in the code
 * that builds your client and your database without a build-type fork. No
 * interceptor is added and no open helper is wrapped, so no body is ever read
 * and no bind argument is ever recorded in a release build.
 */
object OkHttpPorthole {

    fun OkHttpClient.Builder.installPorthole(
        existing: EventListener.Factory? = null,
        bodies: BodyCapture = BodyCapture.Off,
    ): OkHttpClient.Builder = if (existing != null) eventListenerFactory(existing) else this

    fun eventListenerFactory(delegate: EventListener.Factory? = null): EventListener.Factory =
        delegate ?: EventListener.Factory { EventListener.NONE }

    fun bodyInterceptor(bodies: BodyCapture = BodyCapture.Text): Interceptor = PassThroughInterceptor
}

private object PassThroughInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response = chain.proceed(chain.request())
}

/** @see live.gravitylabs.porthole.integration.BodyCapture in the debug runtime. */
class BodyCapture(
    val request: Boolean = true,
    val response: Boolean = true,
    val maxBytes: Long = 4 * 1024,
    val redactHeaders: Set<String> = DEFAULT_REDACTED_HEADERS,
    val textContentTypes: List<String> = DEFAULT_TEXT_TYPES,
    val streamingContentTypes: List<String> = DEFAULT_STREAMING_TYPES,
) {
    val enabled: Boolean get() = false

    internal fun isText(contentType: String?): Boolean = false

    internal fun headers(headers: Headers): Map<String, String> = emptyMap()

    companion object {
        // Order matters: these are read as default arguments by the two
        // instances below, and companion properties initialise top to bottom.
        val DEFAULT_REDACTED_HEADERS: Set<String> = setOf(
            "authorization",
            "proxy-authorization",
            "cookie",
            "set-cookie",
            "x-api-key",
            "x-auth-token",
        )

        val DEFAULT_TEXT_TYPES: List<String> = listOf(
            "application/json",
            "application/xml",
            "application/x-www-form-urlencoded",
            "application/graphql",
            "text/",
        )

        val DEFAULT_STREAMING_TYPES: List<String> = listOf(
            "text/event-stream",
            "application/grpc",
            "application/x-ndjson",
        )

        val Off = BodyCapture(request = false, response = false)
        val Text = BodyCapture()
    }
}

object RoomPorthole {

    fun <T : RoomDatabase> RoomDatabase.Builder<T>.installPorthole(
        delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
        captureBindArgs: Boolean = true,
        maxArgChars: Int = 64,
    ): RoomDatabase.Builder<T> = this
}

/**
 * Release stand-in for the SQLite porthole.
 *
 * Hands back the delegate itself rather than a wrapper, so a release build
 * opens its database through exactly the factory it would have used without
 * this library present.
 */
object SqlitePorthole {

    @JvmOverloads
    fun factory(
        delegate: SupportSQLiteOpenHelper.Factory = FrameworkSQLiteOpenHelperFactory(),
        captureBindArgs: Boolean = true,
        maxArgChars: Int = 64,
    ): SupportSQLiteOpenHelper.Factory = delegate
}

/**
 * Release stand-in for the Ktor client plugin.
 *
 * A plugin that installs nothing: no phase is timed, no header is read, and no
 * body is inspected in a release build.
 */
object KtorPorthole {
    val plugin = io.ktor.client.plugins.api.createClientPlugin("Porthole") { }
}
