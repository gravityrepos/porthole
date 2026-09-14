// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findAdb, parseProperties, resolveProjectRoot, resolveSdkDir } from "./adb.js";

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

    it.skipIf(process.platform !== "win32")(
      "a Windows drive-relative sdk.dir (C:foo) is not spliced onto the project root",
      () => {
        // GRA-150 QA's regression, TypeScript side: path.join(directory,
        // "C:foo") does not anchor this shape the way an ordinary relative
        // path is anchored — it splices the strings into
        // "<directory>\C:foo", a colon in the middle of a path segment that
        // Windows refuses to open. isWindowsDriveRelative routes this shape
        // to path.resolve(value) alone instead, matching PortholeTasks.kt's
        // choice to leave it exactly as Java resolves it, unanchored, rather
        // than invent an answer. There is no reliable way to independently
        // compute "the current directory on drive C" for this test to compare
        // against — see the Kotlin test's own comment on that — so this
        // checks the same invariant the Kotlin test does: no colon outside
        // the drive prefix, and not spliced onto the project root.
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
      },
    );

    it.skipIf(process.platform !== "win32")(
      "a UNC sdk.dir is used as-is, not joined under the project root",
      () => {
        const project = temporaryDirectory();
        const unc = String.raw`\\server\share\sdk`;
        writeLocalProperties(project, `sdk.dir=${javaEscaped(unc)}\n`);
        workingDirectory(project);

        const result = resolveSdkDir();
        expect(result.source).toBe("local.properties");
        expect(result.directory).toBe(unc);
      },
    );

    it.skipIf(process.platform !== "win32")(
      "a POSIX-shaped sdk.dir (no drive letter) anchors under the project root on Windows too, agreeing with PortholeTasks.kt post-GRA-150",
      () => {
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
      stderr.mockRestore();
    });

    it("says nothing on stderr when no sdk.dir was ever named at all — an honest, unremarkable PATH lookup", () => {
      workingDirectory(temporaryDirectory());
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      expect(findAdb()).toBe(BINARY);
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
