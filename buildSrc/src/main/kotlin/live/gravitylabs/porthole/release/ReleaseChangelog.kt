package live.gravitylabs.porthole.release

// The CHANGELOG.md parser `release` and `releaseDryRun` share. Moved out of
// build.gradle.kts (GRA-100 fix pass) so it can be unit tested: a Kotlin
// script body cannot be imported by a test, a Kotlin source set can.
//
// Anchored to the start of a line on purpose, everywhere below: this file's
// own intro prose mentions `` `## [Unreleased]` `` inline as documentation,
// and a plain substring search matched that mention instead of the actual
// heading — found by running `release` for real in a scratch clone, where it
// silently mistook the whole Unreleased section for empty. Only `##`/`###`
// at column zero is a heading; nothing that appears mid-line counts.

/**
 * A line that opens or closes a fenced code block: three or more backticks
 * or tildes, ignoring leading indentation. CommonMark allows either fence
 * character and does not require the count beyond "at least three" — which
 * is all this parser needs, since it never renders the file, only decides
 * which lines are prose.
 */
private fun isFenceDelimiter(line: String): Boolean {
    val trimmed = line.trimStart()
    return trimmed.startsWith("```") || trimmed.startsWith("~~~")
}

/**
 * `true` at index `i` when `lines[i]` is real Markdown structure: not a
 * fence delimiter itself, and not a line the fence one opened swallows. A
 * `## [` heading or `- ` bullet only counts where this is `true`.
 *
 * GRA-100 QA found the previous, regex-only parser read a `## [` heading
 * inside a fenced example as a real section boundary, and a `- ` bullet
 * inside a fence as a real entry — both directions are covered by
 * [ReleaseChangelogTest].
 */
internal fun unfencedLineMask(lines: List<String>): BooleanArray {
    val mask = BooleanArray(lines.size)
    var inFence = false
    for (i in lines.indices) {
        val fenceLine = isFenceDelimiter(lines[i])
        mask[i] = !inFence && !fenceLine
        if (fenceLine) inFence = !inFence
    }
    return mask
}

/** Character offset each line starts at. `changelog` is assumed `\n`-only, which is how this repo's files are written. */
private fun lineStartOffsets(lines: List<String>): IntArray {
    val offsets = IntArray(lines.size)
    var offset = 0
    for (i in lines.indices) {
        offsets[i] = offset
        offset += lines[i].length + 1
    }
    return offsets
}

/** The `[bodyStart, bodyEnd)` offsets between `## [Unreleased]` and the next real `## [` heading (or EOF). */
fun changelogUnreleasedBounds(changelog: String): Pair<Int, Int> {
    val lines = changelog.split("\n")
    val unfenced = unfencedLineMask(lines)
    val starts = lineStartOffsets(lines)

    val unreleasedIdx = lines.indices.firstOrNull { i -> unfenced[i] && lines[i].startsWith("## [Unreleased]") }
    requireNotNull(unreleasedIdx) { "CHANGELOG.md has no '## [Unreleased]' heading at the start of a line" }

    val bodyStart = minOf(starts[unreleasedIdx] + lines[unreleasedIdx].length + 1, changelog.length)
    val nextIdx = (unreleasedIdx + 1 until lines.size).firstOrNull { i -> unfenced[i] && lines[i].startsWith("## [") }
    val bodyEnd = nextIdx?.let { starts[it] } ?: changelog.length
    return bodyStart to bodyEnd
}

fun changelogUnreleasedBody(changelog: String): String {
    val (bodyStart, bodyEnd) = changelogUnreleasedBounds(changelog)
    return changelog.substring(bodyStart, bodyEnd)
}

/** A `### Heading` with no `- ` entries under it is not a change, just a label. A fenced `- ` line is not an entry. */
fun hasReleasableChanges(unreleasedBody: String): Boolean {
    val lines = unreleasedBody.split("\n")
    val unfenced = unfencedLineMask(lines)
    return lines.indices.any { i -> unfenced[i] && lines[i].trimStart().startsWith("- ") }
}

/**
 * Moves the Unreleased body into a new dated section and leaves a fresh,
 * empty Unreleased behind for whatever lands next. Subsections that carried
 * no entries are dropped rather than carried forward empty. Both the
 * subsection split (`### `) and the entries test (`- `) go through
 * [unfencedLineMask], so an example fence spanning a subsection never gets
 * mistaken for a real boundary, and a fenced `- ` line never keeps an
 * otherwise-empty subsection alive.
 */
fun cutChangelog(changelog: String, newVersion: String, date: String): String {
    val (bodyStart, bodyEnd) = changelogUnreleasedBounds(changelog)
    val body = changelog.substring(bodyStart, bodyEnd)
    val bodyLines = body.split("\n")
    val unfenced = unfencedLineMask(bodyLines)

    val headingLineIdx = bodyLines.indices.filter { i -> unfenced[i] && bodyLines[i].startsWith("### ") }
    val boundaries = (listOf(0) + headingLineIdx + listOf(bodyLines.size)).distinct().sorted()
    val sections = boundaries.zipWithNext { s, e -> s until e }

    val carried = sections
        .filter { range -> range.any { i -> unfenced[i] && bodyLines[i].trimStart().startsWith("- ") } }
        .map { range -> range.joinToString("\n") { bodyLines[it] } }
        .joinToString("") { it.trimEnd('\n') + "\n\n" }
        .trimEnd('\n')

    val freshUnreleased = "\n### Added\n\n### Changed\n\n### Fixed\n\n"
    val datedSection = "## [$newVersion] - $date\n\n$carried\n\n"

    return (changelog.substring(0, bodyStart) + freshUnreleased + datedSection + changelog.substring(bodyEnd))
        .replace(Regex("""\n{3,}"""), "\n\n")
}
