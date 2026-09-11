// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import live.gravitylabs.porthole.integration.BodyCapture
import live.gravitylabs.porthole.integration.OkHttpPorthole
import okhttp3.EventListener
import okhttp3.OkHttpClient

/**
 * Instruments an OkHttp client.
 *
 * ```kotlin
 * OkHttpClient.Builder().installPorthole().build()
 * ```
 *
 * Top level, and named the same as the Room one on purpose: they are extensions
 * on different receivers, so one import covers both and a file that builds a
 * client and a database reads the same way twice. As members of two objects
 * they collided, and needed an `as` rename to use together.
 *
 * @param existing an event listener factory of your own to keep. The porthole
 *   forwards to it rather than replacing it.
 * @param bodies request and response body capture. Off by default: phases,
 *   timings, status codes and headers come through either way.
 */
fun OkHttpClient.Builder.installPorthole(
    existing: EventListener.Factory? = null,
    bodies: BodyCapture = BodyCapture.Off,
): OkHttpClient.Builder = with(OkHttpPorthole) { installPorthole(existing, bodies) }
