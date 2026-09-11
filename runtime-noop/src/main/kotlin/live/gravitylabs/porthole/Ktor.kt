// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import live.gravitylabs.porthole.integration.KtorPorthole

/** Release stand-in: a plugin that installs nothing. */
fun portholeKtor() = KtorPorthole.plugin
