// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
package live.gravitylabs.porthole.gradle

/**
 * Parses the Kotlin Compose compiler's own metrics reports — GRA-69's whole
 * premise is that the compiler already knows why a composable is not
 * skippable, and this is the part that reads what it wrote down.
 *
 * Three files come out of `composeCompiler { reportsDestination }` for one
 * module/variant (`PortholeComposeReportTask` is what points it there):
 *
 *  - `<module>_<variant>-composables.txt` — one block per composable, human
 *    readable, with per-parameter stability. No package name anywhere in it.
 *  - `<module>_<variant>-composables.csv` — one row per composable, machine
 *    readable, *with* the fully-qualified name — but no per-parameter detail
 *    at all, just the composable-level flags.
 *  - `<module>_<variant>-classes.txt` — one block per class the module
 *    declares, stable or not and why, human readable, no package name either.
 *
 * The ticket that asked for this (GRA-69) names only the two `.txt` files.
 * This also reads the `.csv` — not instead of the `.txt`, alongside it —
 * purely to recover the package name the `.txt` never carries: the join in
 * `mcp/src/composeReport.ts` matches a composable by (package, name), and
 * "never join a wrong function" (GRA-69's own open-question-3 ruling) is not
 * something a bare simple name like `Row` can promise on its own. The two
 * files come from the same compiler pass over the same declaration order
 * (verified against this module's own fixture — see
 * `composeReportFixtures/PROVENANCE.md`), so they are zipped by simple name,
 * consumed in file order per name — the ordering claim a same-named overload
 * in two files would break, which is exactly the case [zipByName] refuses
 * silently rather than mis-pairing: an unmatched `.txt` entry keeps its own
 * (unqualified) `restartable`/`skippable` reading rather than borrowing a
 * `.csv` row that might belong to a different declaration.
 *
 * Every regex here is deliberately tolerant — a line it does not recognise is
 * skipped, not fatal — because this is parsing a compiler's incidental
 * human-readable log, not a versioned wire format; `sources.ts`'s own
 * `portholeNode`-detecting regex takes the same stance for the same reason.
 * A future compose-compiler release that adds a new per-composable modifier
 * word, or reorders a column, should degrade this to "found fewer facts",
 * never to a stack trace.
 */
internal object ComposeReportParser {

    data class Parameter(
        val name: String,
        val type: String,
        val stable: Boolean,
        val unused: Boolean,
    )

    data class Composable(
        val name: String,
        /** Null when no `.csv` row could be matched to this entry — see the class KDoc. */
        val packageName: String?,
        val restartable: Boolean,
        val skippable: Boolean,
        val parameters: List<Parameter>,
    )

    data class Property(
        val name: String,
        val mutable: Boolean,
        val stable: Boolean,
        val type: String,
    )

    data class ClassEntry(
        val name: String,
        val stable: Boolean,
        /** The literal text after `<runtime stability> =`, e.g. `"Unstable"`. Null if that line was never found. */
        val runtimeStability: String?,
        val properties: List<Property>,
    )

    data class Report(val composables: List<Composable>, val classes: List<ClassEntry>)

    fun parse(composablesTxt: String, composablesCsv: String?, classesTxt: String): Report {
        val txtEntries = parseComposablesTxt(composablesTxt)
        val csvRows = composablesCsv?.let(::parseComposablesCsv) ?: emptyList()
        return Report(composables = zipByName(txtEntries, csvRows), classes = parseClassesTxt(classesTxt))
    }

    // -------------------------------------------------------------------
    // composables.txt
    // -------------------------------------------------------------------

    private data class TxtEntry(
        val name: String,
        val restartable: Boolean,
        val skippable: Boolean,
        val parameters: List<Parameter>,
    )

    /**
     * `restartable skippable scheme("[...]") fun Name(` — any subset of
     * modifier words (`restartable`, `skippable`, `inline`, `readonly`, a
     * `scheme(...)` annotation) can precede `fun`; only the two this ticket
     * cares about are read, by substring, rather than requiring them in a
     * fixed position — a scheme argument that happened to contain the word
     * "skippable" is not a real risk (it names a `UiComposable`-shaped
     * annotation list, not English prose) and would be a strange thing to
     * defend against at the cost of a brittler regex.
     */
    private val COMPOSABLE_HEADER = Regex("""^(.*?)fun\s+([A-Za-z_$][\w$.]*)\($""")

    /** `  unused unstable items: List<CartItem>` — `unused` is optional, the stability word is not. */
    private val COMPOSABLE_PARAM = Regex("""^\s+(unused\s+)?(stable|unstable|runtime|uncertain)\s+([^:]+):\s*(.+?)\s*$""")

    private fun parseComposablesTxt(text: String): List<TxtEntry> {
        val lines = text.lines()
        val out = mutableListOf<TxtEntry>()
        var i = 0
        while (i < lines.size) {
            val header = COMPOSABLE_HEADER.find(lines[i])
            if (header == null) {
                i++
                continue
            }
            val mods = header.groupValues[1]
            val name = header.groupValues[2]
            i++
            val params = mutableListOf<Parameter>()
            // A closing line is `)` alone, or `): ReturnType` for a
            // value-returning composable — either way it is the first line
            // from here that starts with `)`, since a parameter line always
            // starts with leading whitespace.
            while (i < lines.size && !lines[i].startsWith(")")) {
                COMPOSABLE_PARAM.find(lines[i])?.let { p ->
                    params += Parameter(
                        name = p.groupValues[3].trim(),
                        type = p.groupValues[4].trim(),
                        stable = p.groupValues[2] == "stable",
                        unused = p.groupValues[1].isNotBlank(),
                    )
                }
                i++
            }
            if (i < lines.size) i++ // consume the closing line
            out += TxtEntry(
                name = name,
                restartable = Regex("""\brestartable\b""").containsMatchIn(mods),
                skippable = Regex("""\bskippable\b""").containsMatchIn(mods),
                parameters = params,
            )
        }
        return out
    }

    // -------------------------------------------------------------------
    // composables.csv
    // -------------------------------------------------------------------

    private data class CsvRow(val packageName: String, val simpleName: String, val skippable: Boolean, val restartable: Boolean)

    /**
     * `package,name,composable,skippable,restartable,readonly,inline,...` —
     * every field the compose compiler writes here is an identifier or a
     * `0`/`1` flag, never developer text, so a naive comma split is safe:
     * nothing in this format is ever quoted because nothing in it ever needs
     * to be.
     */
    private fun parseComposablesCsv(text: String): List<CsvRow> {
        val lines = text.lines().filter { it.isNotBlank() }
        if (lines.isEmpty()) return emptyList()
        val header = lines.first().split(",")
        val packageIdx = header.indexOf("package")
        val nameIdx = header.indexOf("name")
        val skippableIdx = header.indexOf("skippable")
        val restartableIdx = header.indexOf("restartable")
        if (packageIdx < 0 || nameIdx < 0) return emptyList()

        return lines.drop(1).mapNotNull { line ->
            val cols = line.split(",")
            if (cols.size <= maxOf(packageIdx, nameIdx)) return@mapNotNull null
            val qualified = cols[packageIdx]
            val simple = cols[nameIdx]
            val withoutSimple = qualified.removeSuffix(".$simple")
            CsvRow(
                packageName = if (withoutSimple != qualified) withoutSimple else qualified,
                simpleName = simple,
                skippable = cols.getOrNull(skippableIdx) == "1",
                restartable = cols.getOrNull(restartableIdx) == "1",
            )
        }
    }

    /**
     * Pairs each `.txt` entry with the `.csv` row of the same simple name, in
     * file order — a queue per name rather than a single map, so two
     * same-named declarations (an overload, or two private composables that
     * happen to share a name) still pair up index-for-index instead of both
     * borrowing the first match. A `.txt` entry that runs out of same-named
     * `.csv` rows to draw from keeps `packageName: null` and its own
     * `.txt`-derived `restartable`/`skippable` — never a guess at which
     * `.csv` row it was.
     */
    private fun zipByName(txtEntries: List<TxtEntry>, csvRows: List<CsvRow>): List<Composable> {
        val queues = csvRows.groupBy { it.simpleName }.mapValues { it.value.toMutableList() }
        return txtEntries.map { txt ->
            val row = queues[txt.name]?.let { q -> if (q.isNotEmpty()) q.removeAt(0) else null }
            Composable(
                name = txt.name,
                packageName = row?.packageName,
                // The .csv's flags are the authoritative ones when a row
                // matched (a clean 0/1, not a keyword substring search); the
                // .txt's own reading is the fallback so an entry with no
                // matching row still reports something rather than nothing.
                restartable = row?.restartable ?: txt.restartable,
                skippable = row?.skippable ?: txt.skippable,
                parameters = txt.parameters,
            )
        }
    }

    // -------------------------------------------------------------------
    // classes.txt
    // -------------------------------------------------------------------

    private val CLASS_HEADER = Regex("""^(\S+)\s+class\s+([A-Za-z_$][\w$.]*)\s*\{$""")
    private val CLASS_PROPERTY = Regex("""^\s+(stable|unstable|runtime|uncertain)\s+(val|var)\s+([^:]+):\s*(.+?)\s*$""")
    private val RUNTIME_STABILITY = Regex("""^\s*<runtime stability>\s*=\s*(.+?)\s*$""")

    private fun parseClassesTxt(text: String): List<ClassEntry> {
        val lines = text.lines()
        val out = mutableListOf<ClassEntry>()
        var i = 0
        while (i < lines.size) {
            val header = CLASS_HEADER.find(lines[i])
            if (header == null) {
                i++
                continue
            }
            val stabilityWord = header.groupValues[1]
            val name = header.groupValues[2]
            i++
            val properties = mutableListOf<Property>()
            var runtimeStability: String? = null
            while (i < lines.size && lines[i].trim() != "}") {
                val rs = RUNTIME_STABILITY.find(lines[i])
                if (rs != null) {
                    runtimeStability = rs.groupValues[1]
                } else {
                    CLASS_PROPERTY.find(lines[i])?.let { p ->
                        properties += Property(
                            name = p.groupValues[3].trim(),
                            mutable = p.groupValues[2] == "var",
                            stable = p.groupValues[1] == "stable",
                            type = p.groupValues[4].trim(),
                        )
                    }
                }
                i++
            }
            if (i < lines.size) i++ // consume the closing "}"
            out += ClassEntry(
                name = name,
                stable = stabilityWord.equals("stable", ignoreCase = true),
                runtimeStability = runtimeStability,
                properties = properties,
            )
        }
        return out
    }
}
