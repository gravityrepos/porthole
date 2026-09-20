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
 * @param existing an event listener factory of your own, if you have one to
 *   keep — the porthole chains onto it rather than replacing it. Usually
 *   unneeded: left `null`, this reads whatever the builder already has
 *   configured (your own `eventListener()`/`eventListenerFactory()` call
 *   before this one, or OkHttp's own default when there was none) and
 *   chains onto that automatically — see [OkHttpPorthole.installPorthole]'s
 *   own doc comment for why that is possible without asking the builder for
 *   it back.
 * @param bodies request and response body capture. Off by default: phases,
 *   timings, connection reuse, protocol, byte counts, status codes and
 *   headers come through either way (GRA-66).
 */
fun OkHttpClient.Builder.installPorthole(
    existing: EventListener.Factory? = null,
    bodies: BodyCapture = BodyCapture.Off,
): OkHttpClient.Builder = with(OkHttpPorthole) { installPorthole(existing, bodies) }
