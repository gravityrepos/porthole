// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * GRA-200: [EventKinds] and [DeviceEventKinds] replaced a string literal
 * repeated at every collector's own call site with one named constant each.
 * "No behaviour change" is the whole point of that move, so this pins the
 * wire value of every constant against a hand-written expectation — a typo
 * introduced while converting a literal to `EventKinds.SOMETHING` changes
 * what actually goes out on the socket exactly as silently as the literal it
 * replaced would have, and nothing else in this suite would catch that
 * (`mcp/src/eventKinds.test.ts` catches the *set* of [EventKinds] drifting
 * from the TypeScript side, not any individual value being wrong on both
 * sides at once, which is a gap this file closes).
 */
class EventKindsTest {

    @Test
    fun `EventKinds carries exactly the wire values timeline's kinds filter has always accepted`() {
        assertEquals(
            mapOf(
                "RECOMPOSE" to "recompose",
                "STATE_WRITE" to "state_write",
                "FRAME" to "frame",
                "NAV" to "nav",
                "HTTP_START" to "http_start",
                "HTTP_END" to "http_end",
                "DB_START" to "db_start",
                "DB_END" to "db_end",
                "LOG" to "log",
                "LOG_APPEND" to "log_append",
                "MARK" to "mark",
                "DEVICE" to "device",
                "EXIT" to "exit",
                "WORK_START" to "work_start",
                "WORK_END" to "work_end",
                "BLOCKED" to "blocked",
                "GC" to "gc",
                "MEMORY" to "memory",
            ),
            mapOf(
                "RECOMPOSE" to EventKinds.RECOMPOSE,
                "STATE_WRITE" to EventKinds.STATE_WRITE,
                "FRAME" to EventKinds.FRAME,
                "NAV" to EventKinds.NAV,
                "HTTP_START" to EventKinds.HTTP_START,
                "HTTP_END" to EventKinds.HTTP_END,
                "DB_START" to EventKinds.DB_START,
                "DB_END" to EventKinds.DB_END,
                "LOG" to EventKinds.LOG,
                "LOG_APPEND" to EventKinds.LOG_APPEND,
                "MARK" to EventKinds.MARK,
                "DEVICE" to EventKinds.DEVICE,
                "EXIT" to EventKinds.EXIT,
                "WORK_START" to EventKinds.WORK_START,
                "WORK_END" to EventKinds.WORK_END,
                "BLOCKED" to EventKinds.BLOCKED,
                "GC" to EventKinds.GC,
                "MEMORY" to EventKinds.MEMORY,
            ),
        )
    }

    @Test
    fun `DeviceEventKinds carries exactly the sub-kinds DeviceCollector's own emit(kind, fields) has always sent`() {
        assertEquals(
            mapOf(
                "PROFILE" to "profile",
                "CLOCKS" to "clocks",
                "FOREGROUND" to "foreground",
                "BACKGROUND" to "background",
                "ROTATION" to "rotation",
                "THEME" to "theme",
                "FONT_SCALE" to "fontScale",
                "TRIM_MEMORY" to "trimMemory",
                "LOW_MEMORY" to "lowMemory",
                "POWER" to "power",
                "NETWORK" to "network",
            ),
            mapOf(
                "PROFILE" to DeviceEventKinds.PROFILE,
                "CLOCKS" to DeviceEventKinds.CLOCKS,
                "FOREGROUND" to DeviceEventKinds.FOREGROUND,
                "BACKGROUND" to DeviceEventKinds.BACKGROUND,
                "ROTATION" to DeviceEventKinds.ROTATION,
                "THEME" to DeviceEventKinds.THEME,
                "FONT_SCALE" to DeviceEventKinds.FONT_SCALE,
                "TRIM_MEMORY" to DeviceEventKinds.TRIM_MEMORY,
                "LOW_MEMORY" to DeviceEventKinds.LOW_MEMORY,
                "POWER" to DeviceEventKinds.POWER,
                "NETWORK" to DeviceEventKinds.NETWORK,
            ),
        )
    }

    @Test
    fun `no two EventKinds constants share a wire value`() {
        // A silent collision here would mean two different real-world
        // occurrences ("a query started" vs "a job started") become the
        // same string on the wire and the receiving side can no longer tell
        // them apart -- a defect a plain "does the set match" comparison
        // against the TypeScript side would not catch if both sides happened
        // to collide the same way.
        val values = listOf(
            EventKinds.RECOMPOSE, EventKinds.STATE_WRITE, EventKinds.FRAME, EventKinds.NAV,
            EventKinds.HTTP_START, EventKinds.HTTP_END, EventKinds.DB_START, EventKinds.DB_END,
            EventKinds.LOG, EventKinds.LOG_APPEND, EventKinds.MARK, EventKinds.DEVICE,
            EventKinds.EXIT, EventKinds.WORK_START, EventKinds.WORK_END, EventKinds.BLOCKED,
            EventKinds.GC, EventKinds.MEMORY,
        )
        assertEquals(values.size, values.toSet().size)
    }
}
