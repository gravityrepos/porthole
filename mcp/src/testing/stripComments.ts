// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Blanks out comments in TypeScript/Kotlin-ish source without disturbing
 * line numbers, so an offender's reported line still points at the real
 * line. A block comment's content becomes spaces, one per character, with
 * its own newlines left in place — so a match that would have spanned the
 * comment's start and end markers is neither created nor hidden by the
 * blanking; a line ("//") comment is cut from its marker to the end of its
 * line.
 *
 * GRA-168 item 1: earlier versions of this function (once duplicated
 * between `surface.test.ts` and `device.test.ts` — see item 3 below) were a
 * pure text blanker with no notion of a string literal, so `/*` and `* /`
 * (written apart here only so this doc comment itself does not close early)
 * appearing inside an ordinary string opened and closed a comment span just
 * like the real thing. Two harmless-looking string literals — say
 * `const qaOpen = "/*"` and `const qaClose = "* /"` a few lines apart —
 * were enough to blank everything between them, offender included, on a
 * perfectly clean tree. Measured on `surface.test.ts`'s guard: injecting
 * exactly that shape around a genuine bare `state === "connected"` left the
 * suite 22/22 green. This version tracks whether it is inside a single- or
 * double-quoted string or a template literal and, while inside one, does not
 * treat `//`, `/*` or `* /` as comment markers at all — the same way a real
 * tokenizer would not. Escaped quotes (`\"`, `\'`, `` \` ``) do not end the
 * string early; an escaped backslash does not swallow the character after it.
 *
 * This is a string-literal-*aware* blanker, not a full tokenizer, and it is
 * worth being explicit about where that stops, because a wrong claim here is
 * exactly how GRA-168 was filed in the first place (a prior comment on this
 * function claimed a property that was never run — see the note in
 * `surface.test.ts`'s history). Three things it does **not** reach:
 *
 * 1. **Regex literals.** A regex matching a literal slash-star (written
 *    apart here, again, so this comment does not close early: slash
 *    backslash-star slash) is not recognised as a regex, so its slash and
 *    star characters are read as ordinary code-mode characters by this
 *    function. A regex literal that happens to contain the two-character
 *    sequence that opens a block or line comment is scanned exactly as if
 *    it were code, which is a narrower but real gap in the same family as
 *    the string-literal one this fix closes.
 * 2. **Template-literal interpolation.** ``` `${...}` ``` is treated as
 *    opaque string content from the opening backtick to the next
 *    unescaped backtick — this function does not parse the expression
 *    inside `${ }`, so it does not track a *nested* template literal
 *    opened inside one (`` `${`inner`}` ``). A backtick inside an
 *    interpolation is read as if it closed the outer template.
 * 3. It does not understand any other host-language construct that can
 *    hide or fabricate a `/`, `*`, or quote character — decorators,
 *    generated code, or a string built by concatenation across lines.
 *
 * None of these three are exercised by this codebase's production source
 * today (verified by running the full suite after this change — see
 * GRA-168's Linear comment for the counts), but a future file that adds a
 * regex literal containing `/*`, or a nested template literal, would not be
 * defended by this guard. A full tokenizer would close all three; it is not
 * warranted for a guard whose only job is scanning this package's own
 * TypeScript and one Kotlin file for a handful of known-bad shapes.
 *
 * Whatever this function returns is guaranteed to have exactly as many
 * lines (split on `"\n"`) as its input has after CRLF normalisation — every
 * branch below consumes and emits exactly one input character per iteration
 * (substituting comment content with a space, but never a newline), so line
 * count cannot change no matter which mode misidentifies what. That
 * invariant is what GRA-168 item 2's line-count check asserts across every
 * scanned file.
 */
export function stripComments(text: string): string {
  // GRA-166 item 6: normalise CRLF first. `.` in `/\/\/.*$/`-style patterns
  // does not match "\r" (it is a line terminator to the regex engine even
  // without the `s` flag), so a line ending in "\r\n" defeated the old
  // line-comment stripping — see surface.test.ts's dedicated CRLF test for
  // the full story. Collapsing "\r\n" to "\n" up front cannot change how
  // many lines the file has, only how each line's own terminator is spelled.
  const normalized = text.replace(/\r\n/g, "\n");

  type Mode = "code" | "line" | "block" | "dq" | "sq" | "template";
  let mode: Mode = "code";
  let out = "";

  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    const next = normalized[i + 1];

    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out += "  ";
        i++;
      } else if (c === "/" && next === "*") {
        mode = "block";
        out += "  ";
        i++;
      } else if (c === '"') {
        mode = "dq";
        out += c;
      } else if (c === "'") {
        mode = "sq";
        out += c;
      } else if (c === "`") {
        mode = "template";
        out += c;
      } else {
        out += c;
      }
      continue;
    }

    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += "\n";
      } else {
        out += " ";
      }
      continue;
    }

    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i++;
      } else {
        out += c === "\n" ? "\n" : " ";
      }
      continue;
    }

    // Both string modes and the template-literal mode share the same escape
    // handling: a backslash always consumes the next character verbatim
    // (so `\"` inside a double-quoted string, `\'` inside a single-quoted
    // one, and `` \` `` inside a template literal never end the string
    // early, and `\\` does not make the following character start a new
    // escape). Strings are copied through unchanged — this function only
    // needs to know where a string is, not to alter what it contains.
    if (mode === "dq" || mode === "sq") {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i++;
        continue;
      }
      if ((mode === "dq" && c === '"') || (mode === "sq" && c === "'")) {
        mode = "code";
      } else if (c === "\n") {
        // A real single/double-quoted string cannot legally contain a raw
        // newline; if one shows up (malformed input, or this function
        // mis-tracked an opening quote), fall back to code mode rather than
        // consuming the rest of the file as an unterminated string.
        mode = "code";
      }
      continue;
    }

    // mode === "template"
    out += c;
    if (c === "\\" && next !== undefined) {
      out += next;
      i++;
      continue;
    }
    if (c === "`") {
      mode = "code";
    }
  }

  return out;
}
