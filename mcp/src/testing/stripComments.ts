// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Blanks out comments without disturbing line numbers, so an offender's
 * reported line still points at the real line. A block comment's content
 * becomes spaces, one per character, with its own newlines left in place —
 * so a match that would have spanned the comment's start and end markers is
 * neither created nor hidden by the blanking; a line ("//") comment is cut
 * from its marker to the end of its line. This does not understand string
 * literals — a comment marker inside a quoted string would be mistaken for
 * a real comment — which is a known, accepted gap; see GRA-168.
 *
 * GRA-168 item 3: lifted here from two independent, drifting copies —
 * `surface.test.ts`'s (which had the CRLF normalisation below, added for
 * GRA-166 item 6) and `device.test.ts`'s (which did not, since its own scan
 * only ever reads a checked-out Kotlin file, which `.gitattributes` already
 * pins to LF). They existed separately only because GRA-166 item 7 needed
 * the same technique while the two files sat in different nodes' `Owns`,
 * and two nodes must never own one file. That constraint is gone as of this
 * ticket, so both scans now import this one copy — which also means
 * GRA-168 item 1's fix protects the `PROTOCOL_VERSION` drift scan in
 * `device.test.ts` by construction, not by remembering to patch a second
 * file.
 *
 * Normalises CRLF to LF first (GRA-166 item 6). Without this, a line ending
 * in "\r\n" defeats the "//" stripping below: `.` in `/\/\/.*$/` does not
 * match "\r" (it is a line terminator to the regex engine even without the
 * `s` flag), and `$` without the `m` flag demands the true end of the
 * string — so on a line carrying a trailing "\r" the pattern never reaches
 * it and the replace silently no-ops, leaving the raw comment text in
 * place. That is exactly how a prose comment like `// ... state ===
 * "connected" ...` in production source starts matching the
 * `ConnectionState` offender pattern on a CRLF-ending file even though the
 * only line-ending byte changed and no comparison was added: a false
 * positive on a clean tree, which is worse than a missed real one (see
 * `surface.test.ts`'s "ConnectionState reads" describe block for why).
 * `.gitattributes` pins `* text=auto eol=lf` (an `eol` directive overrides
 * `core.autocrlf` unconditionally), so a plain `git clone` cannot actually
 * produce this — the real routes are an editor saving CRLF, a patch or
 * archive applied outside git, or an edit to `.gitattributes` itself.
 * Narrower than it looks, but still a route, and still a false positive
 * rather than a missed real one when it happens. Collapsing "\r\n" to "\n"
 * up front costs nothing (it cannot change how many lines the file has,
 * only how each line's own terminator is spelled) and makes every consumer
 * of this function see the same normalised text regardless of which line
 * ending the checkout happened to produce.
 */
export function stripComments(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const noBlockComments = normalized.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
  return noBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}
