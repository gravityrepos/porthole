// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole

import android.os.SystemClock

/**
 * The one clock everything in the porthole is stamped against.
 *
 * Monotonic on purpose. Wall time goes backwards — a network time correction, a
 * user changing the date — and a timeline that goes backwards is not a timeline.
 * Every event, every report and every mark shares this reading, which is what
 * makes the timeline and the MCP tools able to talk about the same moment.
 *
 * Gathered behind one function rather than called for directly in thirty places,
 * for two reasons. It is the only thing standing between most of the collectors
 * and a common source set, so when the runtime splits for Multiplatform this
 * becomes an `expect` and the platforms supply an `actual`. And a clock reached
 * for statically cannot be substituted, which is why the event ring had no test.
 */
internal fun nowMs(): Long = SystemClock.uptimeMillis()
