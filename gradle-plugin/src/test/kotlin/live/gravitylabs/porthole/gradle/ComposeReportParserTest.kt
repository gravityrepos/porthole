// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins [ComposeReportParser] against the real compose-compiler output
 * captured from this repo's own sample app — see
 * `composeReportFixtures/PROVENANCE.md` for exactly how, and why
 * `enableStrongSkippingMode` had to be off to capture a genuine
 * "not skippable" example at all.
 */
class ComposeReportParserTest {

    private fun resource(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/composeReportFixtures/$name")) {
            "missing test resource $name"
        }.bufferedReader().readText()

    private val composablesTxt = resource("sample_roomDebug-composables.txt")
    private val classesTxt = resource("sample_roomDebug-classes.txt")

    @Test
    fun `parses every composable in the fixture, not a subset`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        // Mutation: change 9 to 8 — a truncated parse still "passes" any
        // fewer-than check, only an exact count catches it. QaNoArgs
        // (zero-parameter, D3), QaDefaultInt and QaDefaultClass (default
        // parameter values, D2) were added to this fixture's own capture
        // specifically to pin those two QA fixes against real output — see
        // PROVENANCE.md.
        assertEquals(9, report.composables.size)
        assertEquals(
            listOf(
                "QaNoArgs",
                "QaDefaultInt",
                "QaDefaultClass",
                "HomeScreen",
                "CartScreen",
                "Controls",
                "LeakyRow",
                "ScopedRow",
                "RowBody",
            ),
            report.composables.map { it.name },
        )
    }

    @Test
    fun `D3 (QA) - a zero-parameter composable emitted on one line is parsed, not dropped`() {
        // The exact regression: `restartable skippable fun QaNoArgs()` has
        // no separate parameter block and no separate closing line at all
        // — before this fix, the header regex required a line ending in a
        // bare `(`, which this line never has, so the whole entry (name,
        // restartable, skippable) was silently skipped. Real measured
        // effect before the fix: 21 composables in this fixture's own
        // `.txt`, 20 parsed by `parseComposablesTxt` — now 9 and 9 (the
        // enlarged fixture's own real total, not the original 6-composable
        // capture's).
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val noArgs = report.composables.single { it.name == "QaNoArgs" }
        assertTrue(noArgs.restartable)
        assertTrue(noArgs.skippable)
        assertEquals(emptyList<Any>(), noArgs.parameters)
    }

    @Test
    fun `D2 (QA) - a default parameter value never leaks into the captured type`() {
        // Real measured bug: `count: Int = @static 1` parsed as type
        // "Int = @static 1" before this fix — never a real class name, and
        // useless to `findClass`'s lookup on the MCP side. `modifier:
        // Modifier = Modifier` (rendered `Modifier? = @static Companion` by
        // the compiler's own static-value printer) is this shape on nearly
        // every real composable, which is why QaDefaultInt's own second
        // parameter is exactly that.
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val defaultInt = report.composables.single { it.name == "QaDefaultInt" }
        assertEquals(
            listOf("count" to "Int", "modifier" to "Modifier?"),
            defaultInt.parameters.map { it.name to it.type },
        )
    }

    @Test
    fun `D2 (QA) - a class-typed default value strips just as cleanly`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val defaultClass = report.composables.single { it.name == "QaDefaultClass" }
        val holder = defaultClass.parameters.single { it.name == "holder" }
        assertEquals("QaDefaultHolder?", holder.type)
        assertFalse(holder.stable)
    }

    @Test
    fun `reads restartable and skippable off the real header line`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val home = report.composables.single { it.name == "HomeScreen" }
        assertTrue(home.restartable)
        assertTrue(home.skippable)
    }

    @Test
    fun `GRA-69 fixture - LeakyRow is restartable but not skippable`() {
        // The whole ticket in one assertion: this line goes false the moment
        // someone re-captures the fixture against a report where strong
        // skipping was left on (see PROVENANCE.md) — the exact regression
        // this ticket exists to make detectable in the first place.
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val leakyRow = report.composables.single { it.name == "LeakyRow" }
        assertTrue(leakyRow.restartable)
        assertFalse(leakyRow.skippable)
    }

    @Test
    fun `names the unstable parameter and every other parameter's own stability`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val leakyRow = report.composables.single { it.name == "LeakyRow" }
        assertEquals(
            listOf("item" to true, "tick" to true, "onBump" to true, "highlight" to false),
            leakyRow.parameters.map { it.name to it.stable },
        )
        assertEquals("RowHighlight", leakyRow.parameters.single { it.name == "highlight" }.type)
    }

    @Test
    fun `packageName is null with no csv, since the txt alone never carries one`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        assertNull(report.composables.single { it.name == "LeakyRow" }.packageName)
    }

    @Test
    fun `a csv row supplies the package name and the authoritative flags`() {
        val csv =
            "package,name,composable,skippable,restartable,readonly,inline,isLambda,hasDefaults,defaultsGroup,groups,calls,\n" +
                "com.example.shop.ui.HomeScreen,HomeScreen,1,1,1,0,0,0,0,0,1,2,\n" +
                "com.example.shop.ui.CartScreen,CartScreen,1,0,1,0,0,0,0,0,1,2,\n" +
                "com.example.shop.ui.Controls,Controls,1,0,1,0,0,0,0,0,1,2,\n" +
                "com.example.shop.ui.LeakyRow,LeakyRow,1,0,1,0,0,0,0,0,1,1,\n" +
                "com.example.shop.ui.ScopedRow,ScopedRow,1,1,1,0,0,0,0,0,1,1,\n" +
                "com.example.shop.ui.RowBody,RowBody,1,1,1,0,0,0,0,0,1,3,\n"
        val report = ComposeReportParser.parse(composablesTxt, csv, classesTxt)
        val leakyRow = report.composables.single { it.name == "LeakyRow" }
        assertEquals("com.example.shop.ui", leakyRow.packageName)
        assertFalse(leakyRow.skippable)
        // The txt's own per-parameter detail is still carried even when a
        // csv row matched — the csv has no parameter breakdown at all.
        assertEquals(4, leakyRow.parameters.size)
    }

    @Test
    fun `an unmatched txt entry keeps its own reading rather than borrowing a wrong csv row`() {
        // Mutation: a csv with a row for a DIFFERENT composable only — the
        // parser must not pair it with LeakyRow just because something is
        // available in the queue.
        val csv = "package,name,composable,skippable,restartable,readonly,inline,isLambda,hasDefaults,defaultsGroup,groups,calls,\n" +
            "com.example.shop.ui.HomeScreen,HomeScreen,1,1,1,0,0,0,0,0,1,2,\n"
        val report = ComposeReportParser.parse(composablesTxt, csv, classesTxt)
        val leakyRow = report.composables.single { it.name == "LeakyRow" }
        assertNull(leakyRow.packageName)
        // Falls back to the .txt's own restartable/skippable reading.
        assertFalse(leakyRow.skippable)
        assertTrue(leakyRow.restartable)
    }

    @Test
    fun `parses every class in the fixture`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        // 10 from the original capture, plus QaDefaultHolder (D2/D3 fixture
        // enlargement).
        assertEquals(11, report.classes.size)
    }

    @Test
    fun `RowHighlight is unstable because of its var property, not an unstable field type`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val rowHighlight = report.classes.single { it.name == "RowHighlight" }
        assertFalse(rowHighlight.stable)
        assertEquals("Unstable", rowHighlight.runtimeStability)
        val prop = rowHighlight.properties.single()
        assertEquals("tappedAt", prop.name)
        assertTrue(prop.mutable)
        // The field's own TYPE is stable (Long) — the class is unstable
        // solely because the property is a `var`, which is exactly the
        // distinction ComposeReportParserTest and mcp/composeReport.ts's
        // stability-reason prose both key off.
        assertTrue(prop.stable)
        assertEquals("stable", prop.stability)
    }

    @Test
    fun `CartApi is unstable because of unstable-typed fields, not a var`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val cartApi = report.classes.single { it.name == "CartApi" }
        assertFalse(cartApi.stable)
        assertTrue(cartApi.properties.all { !it.mutable })
        assertTrue(cartApi.properties.any { !it.stable })
        // B2 (QA): `stable` alone cannot tell "proven unstable" apart from
        // "runtime/uncertain" — `stability` is what mcp/composeReport.ts's
        // fixed `stabilityReason` actually keys off to prefer this over
        // CartViewModel's own merely-"runtime" `dao: CartStore`.
        assertTrue(cartApi.properties.any { it.stability == "unstable" })
    }

    @Test
    fun `B2 (QA) - CartViewModel's own dao field is runtime, not unstable — the distinction the old code collapsed`() {
        // `runtime val dao: CartStore` — an interface, whose real stability
        // depends on which implementation shows up at runtime — is a
        // genuinely different, weaker claim than `unstable val api: CartApi`
        // right below it in the same real class. Both used to read
        // `stable: false` and be indistinguishable; `stability` is what
        // fixed that.
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val cartViewModel = report.classes.single { it.name == "CartViewModel" }
        val dao = cartViewModel.properties.single { it.name == "dao" }
        val api = cartViewModel.properties.single { it.name == "api" }
        assertEquals("runtime", dao.stability)
        assertFalse(dao.stable)
        assertEquals("unstable", api.stability)
        assertFalse(api.stable)
    }

    @Test
    fun `B2 (QA) - CartViewModel's delegate-backed vars all read stable, never the false instability cause`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val cartViewModel = report.classes.single { it.name == "CartViewModel" }
        val delegates = cartViewModel.properties.filter { it.name.endsWith("\$delegate") }
        assertEquals(5, delegates.size)
        assertTrue(delegates.all { it.mutable })
        assertTrue(delegates.all { it.stable })
        assertTrue(delegates.all { it.stability == "stable" })
    }

    @Test
    fun `CartItem is a stable data class, all-val, all-stable fields`() {
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val cartItem = report.classes.single { it.name == "CartItem" }
        assertTrue(cartItem.stable)
        assertEquals("Stable", cartItem.runtimeStability)
        assertEquals(6, cartItem.properties.size)
        assertTrue(cartItem.properties.all { it.stable && !it.mutable })
    }

    @Test
    fun `a class with no properties still parses`() {
        // MainActivity and CartDatabase in the fixture are exactly this
        // shape — `stable class X { <runtime stability> = Stable }` with no
        // member lines at all between the header and the close.
        val report = ComposeReportParser.parse(composablesTxt, composablesCsv = null, classesTxt)
        val mainActivity = report.classes.single { it.name == "MainActivity" }
        assertTrue(mainActivity.stable)
        assertEquals(emptyList<Any>(), mainActivity.properties)
    }

    @Test
    fun `an unrecognised line is skipped rather than fatal`() {
        val report = ComposeReportParser.parse(
            composablesTxt = "not a report at all\nnonsense\n",
            composablesCsv = null,
            classesTxt = "also nonsense\n",
        )
        assertEquals(emptyList<Any>(), report.composables)
        assertEquals(emptyList<Any>(), report.classes)
    }

    @Test
    fun `a value-returning composable has neither restartable nor skippable`() {
        val txt = "fun ProbeReturnsValue(\n  stable x: Int\n): Int\n"
        val report = ComposeReportParser.parse(txt, composablesCsv = null, classesTxt = "")
        val entry = report.composables.single()
        assertFalse(entry.restartable)
        assertFalse(entry.skippable)
        assertEquals("x", entry.parameters.single().name)
    }

    @Test
    fun `an unused parameter is still captured, marked unused`() {
        val txt = "restartable skippable fun Probe(\n  unused unstable items: List<String>\n)\n"
        val report = ComposeReportParser.parse(txt, composablesCsv = null, classesTxt = "")
        val param = report.composables.single().parameters.single()
        assertTrue(param.unused)
        assertFalse(param.stable)
    }
}
