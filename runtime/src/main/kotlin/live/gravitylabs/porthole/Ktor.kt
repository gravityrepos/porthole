// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import live.gravitylabs.porthole.integration.KtorPorthole

/**
 * The Ktor client plugin, for clients not on the OkHttp engine.
 *
 * ```kotlin
 * HttpClient(CIO) { install(portholeKtor()) }
 * ```
 *
 * A client on Ktor's OkHttp engine should use [installPorthole] on that engine
 * instead: the interceptor sees DNS, connect and TLS as separate phases, which
 * a plugin sitting above the engine cannot.
 */
fun portholeKtor() = KtorPorthole.plugin
