// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./testing/stripComments.js";
import { EVENT_KINDS } from "./eventKinds.js";

/**
 * GRA-200: `EVENT_KINDS` is this side's copy of the runtime's own
 * `EventKinds` object (`Protocol.kt`) — the list `timeline`'s `kinds`
 * description is generated from. Nothing on either side of the wire boundary
 * enforces the two staying equal by construction (a JVM build has no idea a
 * TypeScript constant exists, and vice versa — the same gap
 * `device.test.ts`'s `PROTOCOL_VERSION` check closes for that one field),
 * so this reads Protocol.kt as text and compares its `EventKinds` object's
 * values against this file's own list. Same technique, same file, same
 * `stripComments` helper — not reinvented here.
 */

const PROTOCOL_KT_PATH = new URL(
  "../../runtime/src/main/kotlin/live/gravitylabs/porthole/protocol/Protocol.kt",
  import.meta.url,
);

/**
 * Pulls the `object EventKinds { ... }` block out of Protocol.kt's source
 * and returns the string literal from each `const val NAME = "value"` line
 * inside it, comments already stripped.
 *
 * Deliberately scoped to that one object rather than scanning the whole
 * file: `DeviceEventKinds` sits right below it with its own, disjoint set of
 * literals (`profile`, `trimMemory`, …) that are real kinds but never appear
 * as `EventFrame.event` itself — see both objects' own doc comments in
 * Protocol.kt for why a filter value and a `data.kind` value must not be
 * compared as if they were the same list. A regex that did not stop at the
 * object's closing brace would pull those in too and this test would
 * compare the wrong sets on both mismatch *and* match, which is worse than
 * simply failing to find anything.
 */
function readEventKindsFromProtocolKt(source: string): string[] {
  const clean = stripComments(source);
  const objectMatch = clean.match(/object EventKinds\s*\{([\s\S]*?)\n\}/);
  if (!objectMatch) {
    throw new Error(
      "Could not find 'object EventKinds { ... }' in Protocol.kt (missing-input case: this parser " +
        "refuses to guess rather than silently comparing against nothing).",
    );
  }
  const body = objectMatch[1];
  const values = [...body.matchAll(/const val \w+\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  if (values.length === 0) {
    throw new Error("'object EventKinds' was found but contained no 'const val NAME = \"value\"' lines.");
  }
  return values;
}

describe("EVENT_KINDS agrees with Protocol.kt's EventKinds object", () => {
  it("is exactly the same set, on both sides of the wire", () => {
    const kotlin = readFileSync(PROTOCOL_KT_PATH, "utf8");
    const fromKotlin = readEventKindsFromProtocolKt(kotlin);

    // Set equality, not array equality: order differs on purpose (this
    // file's is the description's reading order; Protocol.kt's is grouped
    // by what the collector is), and mandating one order across a language
    // boundary would be a second, unrelated thing for this test to enforce.
    expect(new Set(fromKotlin)).toEqual(new Set(EVENT_KINDS));

    // Set equality alone would pass for two lists of different length that
    // happen to collapse to the same set through a duplicate — this catches
    // a kind repeated on either side, which set comparison above cannot.
    expect(fromKotlin).toHaveLength(new Set(fromKotlin).size);
    expect(EVENT_KINDS.length).toBe(new Set(EVENT_KINDS).size);
  });

  it("(missing-input case) refuses to guess when the object cannot be found at all", () => {
    expect(() => readEventKindsFromProtocolKt("// no such object here\n")).toThrow(
      /Could not find 'object EventKinds/,
    );
  });

  it("(malformed-input case) refuses to guess when the object is found but empty", () => {
    expect(() => readEventKindsFromProtocolKt("internal object EventKinds {\n}\n")).toThrow(
      /contained no 'const val/,
    );
  });

  it("a doc comment quoting a kind does not count as a declaration", () => {
    // Mirrors device.test.ts's own PROTOCOL_VERSION regression: a comment
    // giving an example ("today NAV = \"nav\"") sitting ahead of the real
    // block must not be read as part of it, and must not smuggle an extra
    // value into the parsed set via the comment-stripping pass alone.
    const source = [
      "/** For example, EventKinds.NAV = \"not-a-real-value\" today. */",
      "internal object EventKinds {",
      '    const val NAV = "nav"',
      "}",
    ].join("\n");
    expect(readEventKindsFromProtocolKt(source)).toEqual(["nav"]);
  });
});
