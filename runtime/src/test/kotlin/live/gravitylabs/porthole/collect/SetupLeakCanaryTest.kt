// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.collect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Two of GRA-64's three `setup` states — present-and-hooked and
 * present-but-signature-mismatch — driven straight through
 * [Setup.recordLeakCanary], the same way [StrictModeTest] drives
 * [Setup.recordStrictMode] directly rather than through a real StrictMode
 * violation.
 *
 * The third state, absent, is not asserted anywhere as "`Setup.report()`
 * currently has no `leakcanary` entry": [Setup] is a plain object singleton,
 * shared by every test that loads it in the same test JVM, and this suite
 * has no per-class isolation for that state the way a Robolectric sandbox
 * would give it (this file itself opts out of Robolectric, see below). A
 * test asserting absence would really be asserting "no earlier test in this
 * JVM happened to call `recordLeakCanary` first" — true today, but a
 * property of test execution order, not of this ticket's own code. The
 * *codebase's* own precedent agrees: [StrictModeTest] and `HttpPhasesTest`
 * have the identical special-entry shape (`strictmode`, `okhttp-listener`)
 * and neither ever asserts one of them is absent, only that it is present
 * once something has genuinely caused it. "Absent" here is instead exactly
 * what reading [Setup.leakCanaryEntry]'s own `?: return null` proves by
 * construction: nothing this ticket added can produce an entry without
 * [Setup.recordLeakCanary] being called first, and the two tests below are
 * what exercises every call that ever reaches it.
 *
 * What a real, present-but-mismatched LeakCanary looks like end to end is
 * [live.gravitylabs.porthole.integration.LeakCanaryTest]'s job (it needs a
 * real `leakcanary.LeakCanary` and Robolectric to get there); this file is
 * about the state shape `Setup.report()` promises, in isolation, and does
 * not need Robolectric at all — like [RedactionTest], it never touches an
 * Android class.
 */
class SetupLeakCanaryTest {

    // -- present and hooked ---------------------------------------------------

    @Test
    fun `present and hooked - onClasspath and instrumented both true, no hint`() {
        Setup.recordLeakCanary(present = true, hooked = true, hint = null)

        val entry = Setup.report().single { it.name == "leakcanary" }
        assertTrue(entry.onClasspath)
        assertTrue(entry.instrumented)
        assertNull(entry.hint)
    }

    // -- present but the API this module compiled against did not match ------

    @Test
    fun `present but signature mismatch - onClasspath true, instrumented false, hint says so`() {
        Setup.recordLeakCanary(
            present = true,
            hooked = false,
            hint = "leakcanary-android is on the classpath but its LeakCanary.config/" +
                "OnHeapAnalyzedListener API did not match what Porthole compiled against " +
                "(floor: leakcanary-android 2.14) — NoSuchMethodError: leakcanary.LeakCanary\$Config.getOnHeapAnalyzedListener()",
        )

        val entry = Setup.report().single { it.name == "leakcanary" }
        assertTrue(entry.onClasspath)
        assertFalse(
            "present-but-mismatched must never read as wired — the EM's whole point was to " +
                "stop this case from being reported as plain 'not hooked'",
            entry.instrumented,
        )
        assertTrue(entry.hint.orEmpty().contains("did not match what Porthole compiled against"))
        assertEquals(1, Setup.report().count { it.name == "leakcanary" })
    }

    // -- a later call replaces the state, it does not accumulate a second row -

    @Test
    fun `a second recordLeakCanary call replaces the entry, not appends`() {
        Setup.recordLeakCanary(present = true, hooked = false, hint = "mismatch")
        Setup.recordLeakCanary(present = true, hooked = true, hint = null)

        val entries = Setup.report().filter { it.name == "leakcanary" }
        assertEquals(1, entries.size)
        assertTrue(entries.single().instrumented)
    }
}
