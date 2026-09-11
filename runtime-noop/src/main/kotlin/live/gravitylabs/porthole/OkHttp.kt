// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import live.gravitylabs.porthole.integration.BodyCapture
import okhttp3.EventListener
import okhttp3.OkHttpClient

/** Release stand-in: the builder comes back with no interceptor added. */
fun OkHttpClient.Builder.installPorthole(
    existing: EventListener.Factory? = null,
    bodies: BodyCapture = BodyCapture.Off,
): OkHttpClient.Builder = if (existing != null) eventListenerFactory(existing) else this
