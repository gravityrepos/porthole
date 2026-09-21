// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findAdb,
  launchAppAsync,
  parseAmStart,
  parseProperties,
  parseResolvedActivity,
  resolveProjectRoot,
  resolveSdkDir,
  restartAppAsync,
  runAdb,
  runAdbAsync,
} from "./adb.js";
import { buildFakeAdb, fakeAdbArgsKey, type FakeAdb } from "./testing/fakeAdb.js";

// Wraps the real readFileSync in a spy rather than replacing it: every
// existing GRA-87 test still gets real file contents back, but GRA-119's
// AC2 test can assert the call never happened at all — not just that the
// right value came back, which a backwards precedence that read the file
// anyway and then discarded it would also produce.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

/**
 * Finding adb is not interesting until it fails, and the way it failed was
 * this: the MCP server read only ANDROID_HOME and ANDROID_SDK_ROOT, neither of
 * which a stock Android Studio install sets, while the Gradle plugin read
 * sdk.dir out of local.properties and found the SDK every time. The same
 * machine, the same SDK, and two Porthole commands disagreeing about whether
 * it existed.
 *
 * So these tests are mostly about order and about the file format, and they
 * use real directories in a real temporary tree rather than a mocked fs —
 * existsSync against a path that was never created is the bug, not the
 * assertion, and a fake filesystem would have happily agreed with either.
 */

const BINARY = process.platform === "win32" ? "adb.exe" : "adb";

let roots: string[] = [];
let savedEnvironment: Record<string, string | undefined> = {};

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "porthole-adb-"));
  roots.push(directory);
  return directory;
}

/** An SDK as far as findAdb is concerned: platform-tools with adb in it. */
function fakeSdk(): string {
  const sdk = temporaryDirectory();
  mkdirSync(path.join(sdk, "platform-tools"));
  writeFileSync(path.join(sdk, "platform-tools", BINARY), "");
  return sdk;
}

/**
 * An SDK at a specific, known place under `parent` rather than at its own
 * fresh temporary root — what GRA-160's relative-path tests need, since the
 * whole point is to prove the SDK is found (or not) relative to a particular
 * directory. `parent` must already exist; the returned path is not
 * separately tracked in `roots` because it lives under a directory that
 * already is.
 */
function fakeSdkIn(parent: string, name: string): string {
  const sdk = path.join(parent, name);
  mkdirSync(path.join(sdk, "platform-tools"), { recursive: true });
  writeFileSync(path.join(sdk, "platform-tools", BINARY), "");
  return sdk;
}

/** A path as Android Studio would write it into local.properties. */
function javaEscaped(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function writeLocalProperties(directory: string, contents: string): void {
  writeFileSync(path.join(directory, "local.properties"), contents);
}

function workingDirectory(directory: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(directory);
}

beforeEach(() => {
  savedEnvironment = {
    ANDROID_HOME: process.env.ANDROID_HOME,
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
    PORTHOLE_SDK_DIR: process.env.PORTHOLE_SDK_DIR,
    PORTHOLE_PROJECT_ROOT: process.env.PORTHOLE_PROJECT_ROOT,
  };
  // This machine has neither set, which is the case worth defaulting to; a
  // machine that does must not change what these tests mean.
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  delete process.env.PORTHOLE_SDK_DIR;
  delete process.env.PORTHOLE_PROJECT_ROOT;
  vi.mocked(readFileSync).mockClear();
});

afterEach(() => {
  // Not restoreAllMocks(): the readFileSync mock above is a vi.fn() wrapping
  // the real implementation, not a vi.spyOn, and mockRestore on one of those
  // degrades it to a bare mock with no implementation at all — which would
  // silently break every later test's local.properties reads. clearAllMocks
  // resets call history (what every test here actually depends on) without
  // touching implementations, which is all any test needs: every findAdb
  // test rearms process.cwd's mock return value itself via workingDirectory.
  vi.clearAllMocks();
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("parseProperties", () => {
  it("unescapes the Windows path Android Studio writes", () => {
    const properties = parseProperties(
      String.raw`sdk.dir=C\:\\Users\\james\\AppData\\Local\\Android\\Sdk`,
    );
    expect(properties.get("sdk.dir")).toBe("C:\\Users\\james\\AppData\\Local\\Android\\Sdk");
  });

  it("reads a file with CRLF line endings and comments around the value", () => {
    const text = [
      "## This file is automatically generated by Android Studio.",
      "# Location of the SDK. This is only used by Gradle.",
      String.raw`sdk.dir=C\:\\Users\\james\\AppData\\Local\\Android\\Sdk`,
      "! and a trailing comment, which is not part of anything",
      "",
    ].join("\r\n");
    expect(parseProperties(text).get("sdk.dir")).toBe(
      "C:\\Users\\james\\AppData\\Local\\Android\\Sdk",
    );
  });

  it("takes a colon or bare whitespace as the separator, as Java does", () => {
    expect(parseProperties("sdk.dir:/opt/sdk").get("sdk.dir")).toBe("/opt/sdk");
    expect(parseProperties("sdk.dir /opt/sdk").get("sdk.dir")).toBe("/opt/sdk");
    expect(parseProperties("  sdk.dir = /opt/sdk  ").get("sdk.dir")).toBe("/opt/sdk  ");
  });

  it("joins a value continued over two lines", () => {
    expect(parseProperties("sdk.dir=/opt/\\\n  android-sdk").get("sdk.dir")).toBe(
      "/opt/android-sdk",
    );
  });

  it("keeps a # inside a value, which Java does not treat as a comment", () => {
    expect(parseProperties("sdk.dir=/opt/sdk#1").get("sdk.dir")).toBe("/opt/sdk#1");
  });

  it("finds nothing in a file that declares nothing", () => {
    expect(parseProperties("# just a comment\n\nflutter.sdk=/opt/flutter\n").has("sdk.dir")).toBe(
      false,
    );
  });
});

describe("findAdb", () => {
  it("finds adb through sdk.dir with no environment variables set", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    workingDirectory(project);

    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  it("prefers local.properties over the environment, as the Gradle plugin does", () => {
    const declared = fakeSdk();
    const environment = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(declared)}\n`);
    workingDirectory(project);
    process.env.ANDROID_HOME = environment;
    process.env.ANDROID_SDK_ROOT = environment;

    // Swapping the order in sdkRoot() fails here, which is the point: the
    // plugin reads local.properties first and the two must not diverge again.
    expect(findAdb()).toBe(path.join(declared, "platform-tools", BINARY));
    expect(findAdb()).not.toBe(path.join(environment, "platform-tools", BINARY));
  });

  it("falls back to the environment when no local.properties declares sdk.dir", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, "# an SDK is not mentioned here\nflutter.sdk=/opt/flutter\n");
    workingDirectory(project);
    process.env.ANDROID_HOME = sdk;

    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  it("skips an environment variable pointing nowhere and tries the next", () => {
    const sdk = fakeSdk();
    workingDirectory(temporaryDirectory());
    process.env.ANDROID_HOME = path.join(sdk, "does-not-exist");
    process.env.ANDROID_SDK_ROOT = sdk;

    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  it("leaves adb to the PATH when sdk.dir has no platform-tools under it", () => {
    // The plugin stops at sdk.dir too: a declared SDK is the answer even when
    // adb is not in it. Quietly reaching for a different SDK is how the two
    // sides came to disagree in the first place.
    const empty = temporaryDirectory();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(empty)}\n`);
    workingDirectory(project);
    process.env.ANDROID_HOME = fakeSdk();

    expect(findAdb()).toBe(BINARY);
  });

  it("leaves adb to the PATH when there is nothing to find", () => {
    workingDirectory(temporaryDirectory());
    expect(findAdb()).toBe(BINARY);
  });

  it("walks up to the build root from a module inside it", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    const deep = path.join(project, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    workingDirectory(deep);

    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  it("gives up rather than climbing the whole disk", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    const deeper = path.join(project, "a", "b", "c", "d", "e", "f");
    mkdirSync(deeper, { recursive: true });
    workingDirectory(deeper);

    expect(findAdb()).toBe(BINARY);
  });

  it("passes a local.properties that says nothing on its way up", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    const appModule = path.join(project, "app");
    mkdirSync(appModule);
    writeLocalProperties(appModule, "# nothing about an SDK here\n");
    workingDirectory(appModule);

    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  it("terminates at the root of the filesystem", () => {
    workingDirectory(path.parse(path.resolve(tmpdir())).root);
    // The walk stops because a root is its own parent; without that it spins
    // on "/" or "C:\" forever, which is a hang rather than a wrong answer.
    expect(typeof findAdb()).toBe("string");
  });
});

/**
 * GRA-119: `.mcp.json`, generated by `PortholeMcpConfigTask`, now carries
 * `PORTHOLE_PROJECT_ROOT` and `PORTHOLE_SDK_DIR` — values the plugin knows
 * with certainty at configure time, rather than the `process.cwd()`
 * inference GRA-87's fix rested on. These tests pin the precedence stated in
 * resolveSdkDir's doc comment (PORTHOLE_SDK_DIR, then GRA-87's walk, then the
 * environment, then PATH) and prove the interesting half of it: that an
 * explicit PORTHOLE_SDK_DIR short-circuits before local.properties is ever
 * read, not merely that it wins in the end.
 */
describe("resolveSdkDir", () => {
  it("prefers PORTHOLE_SDK_DIR over local.properties, without reading local.properties at all", () => {
    const declaredViaEnv = fakeSdk();
    // Sitting exactly where the walk would look, and pointing somewhere
    // else: if precedence were backwards, or if the code read this file
    // before checking the environment and only discarded it afterwards,
    // either mistake shows up here.
    const poisoned = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(poisoned)}\n`);
    workingDirectory(project);
    process.env.PORTHOLE_SDK_DIR = declaredViaEnv;

    expect(resolveSdkDir()).toEqual({ directory: declaredViaEnv, source: "PORTHOLE_SDK_DIR" });
    expect(findAdb()).toBe(path.join(declaredViaEnv, "platform-tools", BINARY));
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("prefers PORTHOLE_SDK_DIR over the environment too", () => {
    const declaredViaEnv = fakeSdk();
    const fromAndroidHome = fakeSdk();
    workingDirectory(temporaryDirectory());
    process.env.PORTHOLE_SDK_DIR = declaredViaEnv;
    process.env.ANDROID_HOME = fromAndroidHome;

    expect(resolveSdkDir()).toEqual({ directory: declaredViaEnv, source: "PORTHOLE_SDK_DIR" });
  });

  it("falls back to GRA-87's walk when PORTHOLE_SDK_DIR is unset — AC3", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    workingDirectory(project);

    expect(resolveSdkDir()).toEqual({ directory: sdk, source: "local.properties" });
    expect(readFileSync).toHaveBeenCalled();
  });

  it("falls back to ANDROID_HOME, then ANDROID_SDK_ROOT, in that order", () => {
    workingDirectory(temporaryDirectory());
    const fromHome = fakeSdk();
    process.env.ANDROID_HOME = fromHome;
    process.env.ANDROID_SDK_ROOT = fakeSdk();
    expect(resolveSdkDir()).toEqual({ directory: fromHome, source: "ANDROID_HOME" });

    delete process.env.ANDROID_HOME;
    const fromRoot = fakeSdk();
    process.env.ANDROID_SDK_ROOT = fromRoot;
    expect(resolveSdkDir()).toEqual({ directory: fromRoot, source: "ANDROID_SDK_ROOT" });
  });

  it("reports PATH with a null directory when nothing resolves — the seam porthole_status reports through", () => {
    workingDirectory(temporaryDirectory());
    expect(resolveSdkDir()).toEqual({ directory: null, source: "PATH" });
  });

  it("empty PORTHOLE_SDK_DIR is treated as unset, not as an empty-string SDK", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    workingDirectory(project);
    process.env.PORTHOLE_SDK_DIR = "   ";

    expect(resolveSdkDir()).toEqual({ directory: sdk, source: "local.properties" });
  });

  it("finds adb via PORTHOLE_SDK_DIR from a directory that is not the project root at all — AC4", () => {
    // The scenario the whole ticket is about: the server was not launched
    // from the workspace root GRA-87's walk assumed. Without
    // PORTHOLE_SDK_DIR this would land findAdb on bare "adb.exe"/"adb",
    // because nothing above an unrelated cwd names an SDK.
    const sdk = fakeSdk();
    const elsewhere = temporaryDirectory();
    workingDirectory(elsewhere);
    process.env.PORTHOLE_SDK_DIR = sdk;

    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });
});

describe("resolveProjectRoot", () => {
  it("uses PORTHOLE_PROJECT_ROOT when the generated config set it", () => {
    const root = temporaryDirectory();
    workingDirectory(temporaryDirectory()); // a different directory than root
    process.env.PORTHOLE_PROJECT_ROOT = root;

    expect(resolveProjectRoot()).toEqual({ directory: root, source: "PORTHOLE_PROJECT_ROOT" });
  });

  it("falls back to process.cwd() when unset, which is what GRA-87 already assumed", () => {
    const cwd = temporaryDirectory();
    workingDirectory(cwd);

    expect(resolveProjectRoot()).toEqual({ directory: cwd, source: "cwd" });
  });

  it("resolveSdkDir's local.properties walk starts from PORTHOLE_PROJECT_ROOT, not cwd — AC4 again, end to end", () => {
    const sdk = fakeSdk();
    const project = temporaryDirectory();
    writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
    // The server's actual cwd is somewhere with no local.properties at all —
    // the case that used to leave GRA-87's walk with nothing to find.
    workingDirectory(temporaryDirectory());
    process.env.PORTHOLE_PROJECT_ROOT = project;

    expect(resolveSdkDir()).toEqual({ directory: sdk, source: "local.properties" });
    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });
});

/**
 * GRA-160: a relative `sdk.dir` was returned from `sdkDirFromLocalProperties`
 * completely unresolved, and `findAdb()`'s `path.join(directory,
 * "platform-tools", binary)` stayed relative, so `existsSync` quietly
 * resolved it against `process.cwd()` — the MCP server process's own working
 * directory — rather than the project. Every test below proves the fix by
 * calling `findAdb()`, not just by inspecting `resolveSdkDir().directory`'s
 * string: a wrong anchor and a right one can produce strings that look
 * equally plausible, but only the wrong one fails to find the real adb this
 * ticket places on disk.
 */
describe("a relative sdk.dir (GRA-160)", () => {
  it("anchors on the directory local.properties was found in, not on PORTHOLE_PROJECT_ROOT — AC1", () => {
    // The walk starts at PORTHOLE_PROJECT_ROOT (a subdirectory with no
    // local.properties of its own) and has to climb past it to find the
    // file — the exact case where resolveProjectRoot().directory and the
    // walk's own current directory diverge, which is what AC1 is about.
    const root = temporaryDirectory();
    const sdk = fakeSdkIn(root, "sdk-relative");
    writeLocalProperties(root, "sdk.dir=sdk-relative\n");
    const projectRoot = path.join(root, "module");
    mkdirSync(projectRoot, { recursive: true });
    workingDirectory(temporaryDirectory()); // cwd is unrelated to either
    process.env.PORTHOLE_PROJECT_ROOT = projectRoot;

    expect(resolveSdkDir()).toEqual({ directory: sdk, source: "local.properties" });
    // The wrong anchor (resolveProjectRoot().directory === projectRoot) has
    // no "sdk-relative" under it at all, so this is the assertion that would
    // have caught it: findAdb() falls back to bare PATH unless the anchor is
    // `root`, where the file actually lives.
    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  it("finds a real adb when PORTHOLE_PROJECT_ROOT is set and the server's cwd is elsewhere — the wave-4 integration QA's exact scenario", () => {
    const project = temporaryDirectory();
    const sdk = fakeSdkIn(project, "android-sdk");
    writeLocalProperties(project, "sdk.dir=android-sdk\n");
    workingDirectory(temporaryDirectory()); // the server's own cwd, unrelated
    process.env.PORTHOLE_PROJECT_ROOT = project;

    // Before this fix: the raw "android-sdk" string came back from
    // sdkDirFromLocalProperties unresolved, findAdb() joined it onto
    // "platform-tools/adb[.exe]" without ever making it absolute, and
    // existsSync() resolved that relative candidate against process.cwd()
    // — the unrelated directory above, not `project` — so it silently fell
    // back to a bare PATH lookup even though this real adb existed.
    expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
  });

  describe("path shapes — AC2, the table PortholeTasks.kt's resolveSdkDir tests enumerate", () => {
    it("a plain relative sdk.dir resolves under the project root", () => {
      const project = temporaryDirectory();
      const sdk = fakeSdkIn(project, "sdk-relative");
      writeLocalProperties(project, "sdk.dir=sdk-relative\n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("a dot-relative ./foo sdk.dir resolves under the project root", () => {
      const project = temporaryDirectory();
      const sdk = fakeSdkIn(project, "sdk-dot-relative");
      writeLocalProperties(project, "sdk.dir=./sdk-dot-relative\n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("a parent-relative ../foo sdk.dir resolves against the project root's parent", () => {
      const parent = temporaryDirectory();
      const project = path.join(parent, "project");
      mkdirSync(project, { recursive: true });
      const sdk = fakeSdkIn(parent, "sdk-parent-relative");
      writeLocalProperties(project, "sdk.dir=../sdk-parent-relative\n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("a drive-letter absolute sdk.dir is used as-is, not anchored on the project root", () => {
      const sdk = fakeSdk(); // already an absolute, drive-letter path on this host
      const project = temporaryDirectory();
      writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("a trailing separator on a relative sdk.dir does not change the resolved path or break the lookup", () => {
      const project = temporaryDirectory();
      const sdk = fakeSdkIn(project, "sdk-relative-trailing");
      writeLocalProperties(project, "sdk.dir=sdk-relative-trailing/\n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("a relative sdk.dir with spaces resolves under the project root and finds adb", () => {
      const project = temporaryDirectory();
      const sdk = fakeSdkIn(project, "sdk relative with spaces");
      writeLocalProperties(project, "sdk.dir=sdk relative with spaces\n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("a Windows drive-relative sdk.dir (C:foo): drive-relative and unanchored on Windows, an ordinary relative segment everywhere else", () => {
      // Re-QA (QA round 1): this was previously gated on the host
      // (`it.skipIf(process.platform !== "win32")`), which meant a POSIX CI
      // leg never exercised a drive-letter-shaped value at all — so if
      // isWindowsDriveRelative's own `process.platform === "win32"` guard
      // were ever dropped, POSIX would start silently unanchoring "C:foo"
      // too, exactly the shape this test exists to pin, and nothing running
      // there would notice. It is now a branched expectation instead: it
      // runs on every host, and asserts the two platforms' genuinely
      // different, both-correct answers.
      if (process.platform === "win32") {
        // GRA-150 QA's regression, TypeScript side: path.join(directory,
        // "C:foo") does not anchor this shape the way an ordinary relative
        // path is anchored — it splices the strings into
        // "<directory>\C:foo", a colon in the middle of a path segment that
        // Windows refuses to open. isWindowsDriveRelative routes this shape
        // to path.resolve(value) alone instead, matching PortholeTasks.kt's
        // choice to leave it exactly as Java resolves it, unanchored, rather
        // than invent an answer. There is no reliable way to independently
        // compute "the current directory on drive C" for this test to
        // compare against — see the Kotlin test's own comment on that — so
        // this checks the same invariant the Kotlin test does: no colon
        // outside the drive prefix, and not spliced onto the project root.
        //
        // project (where local.properties lives, via PORTHOLE_PROJECT_ROOT)
        // and process.cwd() are deliberately different directories here:
        // path.resolve(value) alone resolves a drive-relative string against
        // process.cwd(), and if the test let that coincide with `project` —
        // by mocking cwd to `project` itself, the way most other tests in
        // this file do — a spliced, wrong answer would land under `project`
        // by coincidence and this assertion would pass for the wrong reason.
        const project = temporaryDirectory();
        writeLocalProperties(project, "sdk.dir=C:sdk-drive-relative\n");
        process.env.PORTHOLE_PROJECT_ROOT = project;
        workingDirectory(temporaryDirectory());

        const produced = resolveSdkDir().directory as string;
        expect(produced.slice(2)).not.toContain(":");
        expect(produced.startsWith(project)).toBe(false);
      } else {
        // A colon is an ordinary filename character on POSIX — "C:foo" has
        // no special "drive-relative" meaning there at all, so the only
        // correct answer is the same as any other plain relative value:
        // anchored under the directory local.properties was found in.
        //
        // Re-QA (round 2): this branch previously mocked cwd to `project`
        // itself, the same directory used as the walk anchor — exactly the
        // mistake the win32 branch's own comment above warns about. With
        // cwd === anchor, "unanchored" (path.resolve(value) alone, which
        // falls back to process.cwd() if isWindowsDriveRelative's platform
        // gate were ever dropped) and "anchored under directory" produce the
        // identical string, so the assertion below could not tell a
        // gate-dropped mutant from real code — it passed either way. project
        // (the walk anchor, via PORTHOLE_PROJECT_ROOT) and process.cwd() are
        // now deliberately different, mirroring the win32 branch, which is
        // what actually makes this the assertion that fails if the platform
        // gate is ever lost.
        const project = temporaryDirectory();
        const sdk = fakeSdkIn(project, "C:sdk-drive-relative");
        writeLocalProperties(project, "sdk.dir=C:sdk-drive-relative\n");
        process.env.PORTHOLE_PROJECT_ROOT = project;
        workingDirectory(temporaryDirectory());

        expect(resolveSdkDir().directory).toBe(sdk);
        expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
      }
    });

    it("a UNC sdk.dir: absolute and used as-is on Windows, an ordinary relative segment everywhere else", () => {
      // Re-QA (QA round 1): same host-vs-shape gap as the drive-relative
      // test above, fixed the same way — a branched expectation instead of
      // a host skip, so a POSIX leg actually exercises this string shape
      // rather than never seeing it.
      const unc = String.raw`\\server\share\sdk`;

      if (process.platform === "win32") {
        const project = temporaryDirectory();
        writeLocalProperties(project, `sdk.dir=${javaEscaped(unc)}\n`);
        workingDirectory(project);

        const result = resolveSdkDir();
        expect(result.source).toBe("local.properties");
        expect(result.directory).toBe(unc);
      } else {
        // A backslash has no separator meaning on POSIX, so this string is
        // not recognized as absolute at all (isJavaStyleAbsolute's non-win32
        // branch is a plain path.isAbsolute, which agrees with Java here) —
        // it is just an oddly-named relative path segment, anchored under
        // the directory local.properties was found in, like any other
        // relative value.
        //
        // Re-QA (round 2): this branch previously mocked cwd to `project`
        // itself — the same mistake the drive-relative test's original
        // POSIX branch made, and wrong for the same reason: if
        // isJavaStyleAbsolute's win32 gate were ever dropped, this string
        // (it starts with two backslashes, matching the win32-only UNC
        // regex) would be misclassified as absolute and resolved via
        // path.resolve(value) alone — which falls back to process.cwd() —
        // and if cwd === project that produces the identical string to the
        // correct, anchored answer, so the assertion could not tell a
        // gate-dropped mutant from real code. project (the walk anchor, via
        // PORTHOLE_PROJECT_ROOT) and process.cwd() are now deliberately
        // different, and this goes through findAdb() against a real
        // fixture rather than only comparing the resolved string.
        const project = temporaryDirectory();
        const sdk = fakeSdkIn(project, unc);
        writeLocalProperties(project, `sdk.dir=${javaEscaped(unc)}\n`);
        process.env.PORTHOLE_PROJECT_ROOT = project;
        workingDirectory(temporaryDirectory());

        expect(resolveSdkDir().directory).toBe(sdk);
        expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
      }
    });

    it.skipIf(process.platform !== "win32")(
      "a POSIX-shaped sdk.dir (no drive letter) anchors under the project root on Windows too, agreeing with PortholeTasks.kt post-GRA-150",
      () => {
        // Re-QA (QA round 1) asked whether this one could become a branched
        // expectation like the two above it. It genuinely cannot, and this
        // is that "say so plainly" case rather than an evasion: the thing
        // this test exists to pin is a *disagreement*, on Windows only,
        // between Node's path.isAbsolute (true — a bare leading slash roots
        // at the current drive there) and Java's File#isAbsolute (false — it
        // requires a drive letter), which isJavaStyleAbsolute's win32 branch
        // resolves in Java's favour. Off Windows there is no such
        // disagreement to pin: POSIX Node and POSIX Java both already agree
        // that a leading "/" is absolute, isJavaStyleAbsolute's non-win32
        // branch is nothing but a bare `path.isAbsolute(value)` call with no
        // special-casing of its own to regress, and "/opt/android-sdk" would
        // just be the ordinary absolute-path case the "drive-letter
        // absolute" test above already covers — asserting it again here
        // would only be a second copy of that test wearing this one's name,
        // not a check of anything Windows-specific. isJavaStyleAbsolute's
        // win32 gate itself — "does this fall through to plain
        // path.isAbsolute on every other platform" — is exercised by the
        // UNC test above, which does use a Windows-shaped string on a POSIX
        // host and asserts the POSIX (relative, joined) answer.
        //
        // Node's own path.isAbsolute considers a bare leading slash absolute
        // on Windows (it roots at the current drive) — but Java's
        // File#isAbsolute() does not, and GRA-150's QA moved the Kotlin
        // resolver to anchor this shape under the project root instead of
        // the current drive's root. isJavaStyleAbsolute deliberately
        // disagrees with path.isAbsolute here so the two resolvers keep
        // agreeing: without it, this would silently regress to the
        // pre-GRA-150 answer Kotlin's own test pins against.
        const project = temporaryDirectory();
        const sdk = fakeSdkIn(project, path.join("opt", "android-sdk"));
        writeLocalProperties(project, "sdk.dir=/opt/android-sdk\n");
        workingDirectory(project);

        expect(resolveSdkDir().directory).toBe(sdk);
        expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
        // Not the current-drive-root answer Node's native path.isAbsolute
        // would have produced.
        expect(resolveSdkDir().directory).not.toBe(path.resolve("/opt/android-sdk"));
      },
    );
  });

  describe("nothing fails silently when platform-tools isn't where sdk.dir says — AC3", () => {
    it("writes a diagnostic to stderr when a resolved sdk.dir has no platform-tools under it, before falling back to PATH", () => {
      const empty = temporaryDirectory();
      const project = temporaryDirectory();
      writeLocalProperties(project, `sdk.dir=${javaEscaped(empty)}\n`);
      workingDirectory(project);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(findAdb()).toBe(BINARY);
      expect(stderr).toHaveBeenCalledTimes(1);
      const message = stderr.mock.calls[0][0] as string;
      expect(message).toContain(empty);
      expect(message).toContain("platform-tools");
      // Re-QA (QA round 1): the ticket's own mechanism section says the
      // property missing from today's failure mode is that nothing names
      // sdk.dir specifically — asserting only "platform-tools" and the
      // directory would still pass a mutant that renamed this message to
      // something that never says which property was at fault.
      expect(message).toContain("sdk.dir");
      stderr.mockRestore();
    });

    it("says nothing on stderr when no sdk.dir was ever named at all — an honest, unremarkable PATH lookup", () => {
      workingDirectory(temporaryDirectory());
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(findAdb()).toBe(BINARY);
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
    });

    it("says nothing on stderr on the ordinary, successful path — a resolved sdk.dir with adb actually under it", () => {
      // Re-QA (QA round 1): the pair above covered "fires when platform-tools
      // is missing" and "silent when nothing named an SDK", but not the
      // third and most common state — a directory resolved AND adb found
      // there. Without this, a mutant that moved the stderr.write above the
      // success return (so it fired on every successful lookup too) would
      // have left the whole suite green: the healthy path is exercised by
      // nearly every other test in this file, but none of them assert
      // silence on it. A warning that also fires on the healthy path is the
      // exact failure mode AC3 exists to prevent — it trains whoever reads
      // stderr to ignore the line, and then the real one gets ignored too.
      const sdk = fakeSdk();
      const project = temporaryDirectory();
      writeLocalProperties(project, `sdk.dir=${javaEscaped(sdk)}\n`);
      workingDirectory(project);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
      expect(stderr).not.toHaveBeenCalled();
      stderr.mockRestore();
    });
  });

  describe("trimming a value read from local.properties — AC4", () => {
    it("trims trailing ASCII whitespace so the lookup still finds the real SDK", () => {
      // The realistic case: a hand-edited file, or an editor's trailing-
      // whitespace habit. parseProperties itself only strips *leading*
      // whitespace off the value ([ \t\f] anchored at ^), so this trailing
      // run survives all the way to adb.ts's own value.trim() — this is a
      // fixture a mutant deleting that trim() actually fails, unlike a
      // leading-space fixture, which parseProperties would have already
      // cleaned up before .trim() ever ran.
      const project = temporaryDirectory();
      const sdk = fakeSdkIn(project, "sdk-relative");
      writeLocalProperties(project, "sdk.dir=sdk-relative   \n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });

    it("trims a non-breaking space (U+00A0) that parseProperties' own whitespace stripping never touches", () => {
      // GRA-152's fix pass hit this trap: parseProperties' leading-
      // whitespace regex is [ \t\f], which does not include U+00A0, so a
      // non-breaking space survives parseProperties completely untouched
      // either side of the value and arrives at adb.ts's value.trim() call
      // intact. Only JS's own Unicode-aware String.prototype.trim() (not a
      // regex copied from Java's whitespace class) strips it. This is the
      // one shape that proves adb.ts's own trim() is doing real work,
      // independent of anything parseProperties already does.
      const project = temporaryDirectory();
      const sdk = fakeSdkIn(project, "sdk-relative");
      writeLocalProperties(project, "sdk.dir= sdk-relative \n");
      workingDirectory(project);

      expect(resolveSdkDir().directory).toBe(sdk);
      expect(findAdb()).toBe(path.join(sdk, "platform-tools", BINARY));
    });
  });
});

/**
 * `runAdbAsync` itself, against a real spawned process rather than a fake —
 * the same technique perfetto.test.ts's "runScript, against a real process"
 * describe block uses, and for the same reason: proving the timeout kills a
 * real child and that the event loop stays free while it waits needs an OS
 * process on the other end, and `cmd.exe` / `/bin/sh` are real,
 * always-present executables that can be told to succeed, fail or hang on
 * demand. `binary` is the seam that makes this possible without a real adb
 * or a real device — see `runAdbAsync`'s own doc comment.
 */
describe("runAdb — the synchronous twin takes the same binary/env overrides (GRA-182)", () => {
  // Why this matters: `system_context` reads the device through this
  // function, and until GRA-182 the rig's fake adb never reached it — with a
  // phone attached to the machine running the suite, the every-tool walk in
  // surface.test.ts did four real `dumpsys` reads instead. These prove the
  // seam exists and that both halves of it — the binary and its environment,
  // which is how the fake adb carries its response table — arrive at the
  // child, with `-s SERIAL` still prefixed the way every real call has it.
  let fakeAdb: FakeAdb;
  beforeEach(() => {
    fakeAdb = buildFakeAdb({
      [fakeAdbArgsKey(["shell", "dumpsys", "thermalservice"])]: { stdout: "Thermal status: 0\n" },
    });
  });
  afterEach(() => fakeAdb.cleanup());

  it("says exactly what runAdbAsync says when the adb binary itself cannot be run", () => {
    const missing = path.join(tmpdir(), `definitely-not-a-real-adb-binary-${Date.now()}`);
    const result = runAdb(["devices"], undefined, { binary: missing });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^Could not run adb \(.+\)\. Set ANDROID_HOME, or put adb on your PATH\.$/);
  });

  it("spawns the given binary with the given env, serial prefix intact — the fake adb's configured answer comes back", () => {
    const result = runAdb(["shell", "dumpsys", "thermalservice"], "A1", {
      binary: fakeAdb.binaryPath,
      env: fakeAdb.env,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("Thermal status: 0");
    expect(fakeAdb.calls()).toEqual([["-s", "A1", "shell", "dumpsys", "thermalservice"]]);
  });
});

describe("runAdbAsync — an async, awaited spawn standing in for spawnSync (GRA-89)", () => {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = (command: string) => (isWindows ? ["/d", "/s", "/c", command] : ["-c", command]);
  // Same trap perfetto.test.ts's own comment documents: cmd.exe running an
  // infinite loop itself, rather than handing it to a child ping.exe that
  // would go on holding the output pipe open after cmd.exe is killed.
  const hang = isWindows ? "for /l %i in () do @rem" : "exec sleep 30";
  const short = isWindows ? "ping -n 2 127.0.0.1 >nul" : "exec sleep 1";

  it("says exactly this when the adb binary itself cannot be run", async () => {
    const missing = path.join(tmpdir(), `definitely-not-a-real-adb-binary-${Date.now()}`);
    const result = await runAdbAsync(["devices"], { binary: missing });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^Could not run adb \(.+\)\. Set ANDROID_HOME, or put adb on your PATH\.$/);
  });

  it("reports a nonzero exit as 'adb exited N' when adb said nothing on either stream", async () => {
    const result = await runAdbAsync(shellArgs("exit 7"), { binary: shell });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("adb exited 7");
  });

  it("kills a wedged adb and says exactly how long it waited and what it ran", async () => {
    const timeoutMs = 200;
    const args = shellArgs(hang);
    const started = Date.now();
    const result = await runAdbAsync(args, { binary: shell, timeoutMs });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(result.output).toBe(
      `adb did not finish within ${timeoutMs}ms running '${args.join(" ")}'; ` +
        "it may be wedged, so it was killed rather than left to hang.",
    );
    // The real proof this was killed rather than left running the real 30s.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("keeps the event loop free while the child runs — GRA-89's whole point", async () => {
    const order: string[] = [];
    const running = runAdbAsync(shellArgs(short), { binary: shell }).then(() => order.push("adb"));
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 30)).then(() => order.push("timer"));
    await Promise.all([running, timer]);
    // `short` runs for roughly a second; a 30ms timer firing first is only
    // possible if the child is not blocking the thread it runs on.
    expect(order[0]).toBe("timer");
  }, 15_000);

  it("reports progress on stderr while a slow call is still running, on a tick a caller controls", async () => {
    const ticks: number[] = [];
    const stillRunning = isWindows ? "ping -n 4 127.0.0.1 >nul" : "exec sleep 2";
    const result = await runAdbAsync(shellArgs(stillRunning), {
      binary: shell,
      tickMs: 50,
      onProgress: (elapsedMs) => ticks.push(elapsedMs),
    });
    expect(result.ok).toBe(true);
    // A ~2s command ticking every 50ms should fire on the order of dozens of
    // times. >0 alone would also pass a broken implementation that calls
    // onProgress exactly once, immediately, instead of on an interval — >5
    // does not: it fails a single-shot call, and a real periodic ticker over
    // this duration clears it many times over.
    expect(ticks.length).toBeGreaterThan(5);
    // And it should actually be periodic, not one big element followed by
    // silence: consecutive ticks should be roughly tickMs apart, not the
    // whole elapsed duration apart.
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    expect(Math.max(...gaps)).toBeLessThan(500);
  }, 15_000);
});

describe("parseResolvedActivity", () => {
  it("reads the resolved component off the last line, past resolve-activity's own preamble", () => {
    const output = [
      "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true",
      "com.example.shop/.MainActivity",
    ].join("\n");
    expect(parseResolvedActivity(output)).toBe("com.example.shop/.MainActivity");
  });

  it("is null for 'No activity found' — nothing shaped like a component to hand am start", () => {
    expect(parseResolvedActivity("No activity found\n")).toBeNull();
  });

  it("is null for blank or whitespace-only output", () => {
    expect(parseResolvedActivity("   \n\n  \n")).toBeNull();
  });

  it("the mutation-obvious case: takes the LAST line, not the first, when both look component-shaped", () => {
    // A mutant reading lines[0] instead of lines[lines.length - 1] passes
    // every test above (a single-line or preamble-then-answer input cannot
    // tell the two apart) but fails this one, where the first line is
    // itself component-shaped and wrong.
    const output = ["com.example.shop/.DecoyActivity", "com.example.shop/.MainActivity"].join("\n");
    expect(parseResolvedActivity(output)).toBe("com.example.shop/.MainActivity");
  });

  it("rejects a line with embedded whitespace either side of the slash, not just any line containing one", () => {
    expect(parseResolvedActivity("no activity found for /this/path\n")).toBeNull();
  });
});

describe("parseAmStart", () => {
  it("reads Status/LaunchState/TotalTime off a real am start -W transcript", () => {
    const output = [
      "Starting: Intent { cmp=com.example.shop/.MainActivity }",
      "Status: ok",
      "LaunchState: COLD",
      "Activity: com.example.shop/.MainActivity",
      "TotalTime: 342",
      "WaitTime: 358",
      "Complete",
    ].join("\n");
    expect(parseAmStart(output)).toEqual({ ok: true, launchState: "COLD", totalTimeMs: 342 });
  });

  it("ok is false, but launchState/totalTimeMs are still read, when Status is not ok", () => {
    // The mutation-obvious case for `status === "ok"`: a mutant that
    // dropped the equality (any truthy Status counts) passes a plain
    // "Status: ok" fixture too, but fails this one.
    const output = ["Status: error", "LaunchState: WARM", "TotalTime: 12"].join("\n");
    expect(parseAmStart(output)).toEqual({ ok: false, launchState: "WARM", totalTimeMs: 12 });
  });

  it("nulls every field it cannot find, rather than throwing, on unrecognised output", () => {
    expect(parseAmStart("garbage\nno such fields here\n")).toEqual({ ok: false, launchState: null, totalTimeMs: null });
  });
});

/**
 * GRA-233: `restartAppAsync`/`launchAppAsync` against a real (faked) adb
 * process — the same technique `devices.test.ts` uses for `checkInstalledApp`
 * — rather than only unit-testing the parsers above. These are the
 * behavioural ACs: a launcher that prints nothing recognisable no longer
 * fails a launch that actually worked, `am start -W`'s own fields are read
 * and reported, and a launch that never actually landed is still reported
 * as a failure — quoting whatever the launcher said, however successful
 * that looked.
 */
describe("GRA-233: restartAppAsync/launchAppAsync judge success by the process coming up, not by what the launcher printed", () => {
  let cleanups: FakeAdb[] = [];
  afterEach(() => {
    for (const adb of cleanups) adb.cleanup();
    cleanups = [];
  });
  function fakeAdb(responses: Parameters<typeof buildFakeAdb>[0]): FakeAdb {
    const built = buildFakeAdb(responses);
    cleanups.push(built);
    return built;
  }

  const PKG = "com.example.shop";
  const SERIAL = "A1";
  const resolveActivityArgs = [
    "-s",
    SERIAL,
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-c",
    "android.intent.category.LAUNCHER",
    PKG,
  ];
  const monkeyArgs = ["-s", SERIAL, "shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"];
  const pidofArgs = ["-s", SERIAL, "shell", "pidof", PKG];
  const forceStopArgs = ["-s", SERIAL, "shell", "am", "force-stop", PKG];
  const amStartArgs = ["-s", SERIAL, "shell", "am", "start", "-W", "-n", `${PKG}/.MainActivity`];

  it("noisy monkey output with no 'Events injected' line, plus the process actually up afterwards, is success — the API 36 bug this ticket fixes", async () => {
    const adb = fakeAdb({
      // resolve-activity runs, but names nothing — the fallback path.
      [fakeAdbArgsKey(resolveActivityArgs)]: { stdout: "No activity found\n" },
      [fakeAdbArgsKey(monkeyArgs)]: {
        // A real API 36 transcript: touch-event debug noise, never the
        // "Events injected" line the old check depended on.
        stdout:
          ":Sending Touch (ACTION_DOWN): 0:(540.0,1176.0)\n:Sending Touch (ACTION_UP): 0:(540.0,1176.0)\n",
      },
      // Sequenced: not up on the first poll, up on the second — proves this
      // genuinely polls rather than checking once and giving up.
      [fakeAdbArgsKey(pidofArgs)]: [{ exitCode: 1 }, { stdout: "9321\n" }],
    });

    const result = await launchAppAsync(PKG, {
      serial: SERIAL,
      binary: adb.binaryPath,
      env: adb.env,
      pidPollIntervalMs: 5,
    });

    expect(result.ok).toBe(true);
    expect(adb.calls().filter((c) => c.includes("pidof")).length).toBeGreaterThanOrEqual(2);
  });

  it("GRA-233 QA F15: a digit in adb's own stderr chatter (the daemon-starting notice) is never read as a pid — only stdout counts", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(resolveActivityArgs)]: { stdout: "No activity found\n" },
      [fakeAdbArgsKey(monkeyArgs)]: { stdout: "Events injected: 1\n" },
      // pidof genuinely found nothing (empty stdout), but the process still
      // exits 0 — and adb's own one-time daemon-starting notice, which
      // contains a digit, landed on stderr. A bare /\d/ over the merged
      // output would misread "tcp:5037" as a pid.
      [fakeAdbArgsKey(pidofArgs)]: {
        stdout: "",
        stderr: "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n",
        exitCode: 0,
      },
    });

    const result = await launchAppAsync(PKG, {
      serial: SERIAL,
      binary: adb.binaryPath,
      env: adb.env,
      pidPollTimeoutMs: 50,
      pidPollIntervalMs: 10,
    });

    expect(result.ok).toBe(false);
  });

  it("resolves the launcher activity and reads Status/LaunchState/TotalTime from am start -W, never touching monkey at all", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(resolveActivityArgs)]: { stdout: "priority=0\ncom.example.shop/.MainActivity\n" },
      [fakeAdbArgsKey(amStartArgs)]: {
        stdout:
          "Starting: Intent { cmp=com.example.shop/.MainActivity }\nStatus: ok\nLaunchState: COLD\n" +
          "Activity: com.example.shop/.MainActivity\nTotalTime: 342\nComplete\n",
      },
      [fakeAdbArgsKey(pidofArgs)]: { stdout: "9321\n" },
    });

    const result = await launchAppAsync(PKG, { serial: SERIAL, binary: adb.binaryPath, env: adb.env });

    expect(result).toMatchObject({ ok: true, launchState: "COLD", totalTimeMs: 342 });
    expect(adb.calls().some((c) => c.includes("monkey"))).toBe(false);
  });

  it("process never appears → failure, quoting the launcher's own output even though it looked like success", async () => {
    const adb = fakeAdb({
      // A genuine adb failure resolving the activity, not just an empty
      // answer — the other branch that sends this to the monkey fallback.
      [fakeAdbArgsKey(resolveActivityArgs)]: { stderr: "no such shell command\n", exitCode: 1 },
      [fakeAdbArgsKey(monkeyArgs)]: { stdout: "Events injected: 1\n" },
      // Never comes up, however many times this is asked.
      [fakeAdbArgsKey(pidofArgs)]: { exitCode: 1 },
    });

    const result = await launchAppAsync(PKG, {
      serial: SERIAL,
      binary: adb.binaryPath,
      env: adb.env,
      pidPollTimeoutMs: 50,
      pidPollIntervalMs: 10,
    });

    expect(result.ok).toBe(false);
    // The launcher's own output is quoted verbatim — even monkey's own
    // "looked successful" line — rather than a generic "failed" sentence
    // that throws away what actually happened.
    expect(result.output).toContain("Events injected: 1");
  });

  it("restartAppAsync force-stops strictly before it launches, and shares launchAppAsync's exact success judgement", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(forceStopArgs)]: {},
      [fakeAdbArgsKey(resolveActivityArgs)]: { stdout: "No activity found\n" },
      [fakeAdbArgsKey(monkeyArgs)]: { stdout: "some noise, no confirmation line at all\n" },
      // GRA-233 QA F14: sequenced — the pid-before-force-stop read, then a
      // genuinely DIFFERENT pid once the relaunch has landed. A single
      // fixed pid here would read as the old process surviving force-stop,
      // not as a successful restart.
      [fakeAdbArgsKey(pidofArgs)]: [{ stdout: "9321\n" }, { stdout: "9455\n" }],
    });

    const result = await restartAppAsync(PKG, { serial: SERIAL, binary: adb.binaryPath, env: adb.env });

    expect(result.ok).toBe(true);
    const tags = adb.calls().map((c) => c.join(" "));
    const stopIndex = tags.findIndex((c) => c.includes("force-stop"));
    const monkeyIndex = tags.findIndex((c) => c.includes("monkey"));
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(monkeyIndex).toBeGreaterThan(stopIndex);
  });

  it("GRA-233 QA F14: a force-stop that silently no-ops, followed by a launch that never actually lands, fails naming the surviving pid — not ok:true off the old process still answering pidof", async () => {
    const adb = fakeAdb({
      // Force-stop itself reports success (exit 0, no output) even though
      // nothing was actually torn down — the exact silent-no-op this
      // finding is about.
      [fakeAdbArgsKey(forceStopArgs)]: {},
      [fakeAdbArgsKey(resolveActivityArgs)]: { stdout: "No activity found\n" },
      [fakeAdbArgsKey(monkeyArgs)]: { exitCode: 1, stderr: "No activities found to run, monkey aborted.\n" },
      // The SAME pid, every single call — the old process never left.
      [fakeAdbArgsKey(pidofArgs)]: { stdout: "9321\n" },
    });

    const result = await restartAppAsync(PKG, {
      serial: SERIAL,
      binary: adb.binaryPath,
      env: adb.env,
      pidPollTimeoutMs: 50,
      pidPollIntervalMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("force-stop did not end pid 9321");
    // Not the launcher's own output this time — the pid-survival reason is
    // the more specific and more actionable of the two.
    expect(result.output).not.toContain("No activities found to run");
  });

  it("a force-stop that itself fails short-circuits before ever trying resolve-activity or monkey", async () => {
    const adb = fakeAdb({
      [fakeAdbArgsKey(forceStopArgs)]: { exitCode: 1, stderr: "no such package\n" },
    });

    const result = await restartAppAsync(PKG, { serial: SERIAL, binary: adb.binaryPath, env: adb.env });

    expect(result.ok).toBe(false);
    expect(adb.calls().some((c) => c.includes("monkey") || c.includes("resolve-activity"))).toBe(false);
  });
});
