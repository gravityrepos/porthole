// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * How far up from the working directory to look for local.properties.
 *
 * The working directory is usually the build root, but an agent or a shell is
 * just as often sitting in a module inside it. Five levels covers that without
 * letting a build that has no local.properties at all walk to the top of the
 * disk looking for one.
 */
const LOCAL_PROPERTIES_LEVELS = 5;

/**
 * A .properties file, read the way java.util.Properties reads it.
 *
 * local.properties is written by Android Studio, and on Windows what it writes
 * is `sdk.dir=C\:\\Users\\james\\AppData\\Local\\Android\\Sdk`. Splitting on
 * the first `=` and keeping the rest verbatim yields a path with an escaped
 * colon and doubled separators that no filesystem call will accept, so the
 * escapes have to come off. The rules honoured here are Java's, because Java's
 * are what wrote the file and what the Gradle plugin reads it back with: `#`
 * and `!` comment out a whole line and nothing else — a `#` partway through a
 * value belongs to the value — `=`, `:` or whitespace ends the key, and a line
 * ending in an odd number of backslashes continues onto the next.
 */
export function parseProperties(text: string): Map<string, string> {
  const properties = new Map<string, string>();
  const lines = text.split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t\f]+/, "");
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;

    while (trailingBackslashes(line) % 2 === 1 && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, "");
    }

    // The key runs to the first separator that is not itself escaped.
    let end = 0;
    while (end < line.length) {
      const character = line[end];
      if (character === "\\") {
        end += 2;
        continue;
      }
      if ("=: \t\f".includes(character)) break;
      end++;
    }

    let value = line.slice(end).replace(/^[ \t\f]*/, "");
    if (value.startsWith("=") || value.startsWith(":")) {
      value = value.slice(1).replace(/^[ \t\f]*/, "");
    }
    properties.set(unescape(line.slice(0, end)), unescape(value));
  }
  return properties;
}

function trailingBackslashes(line: string): number {
  let count = 0;
  while (count < line.length && line[line.length - 1 - count] === "\\") count++;
  return count;
}

function unescape(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      out += raw[i];
      continue;
    }
    const escaped = raw[++i];
    if (escaped === undefined) break;
    if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    // Java drops the backslash before anything it does not recognise, which is
    // what turns `C\:\\Users` back into `C:\Users`.
    out += { t: "\t", n: "\n", r: "\r", f: "\f" }[escaped] ?? escaped;
  }
  return out;
}

/**
 * Where PORTHOLE_PROJECT_ROOT and PORTHOLE_SDK_DIR come from: `.mcp.json`,
 * generated at Gradle configure time by `PortholeMcpConfigTask`. That task
 * knows both values with certainty — the Gradle root project directory, and
 * `sdk.dir`/`ANDROID_HOME` resolved the same way `PortholePlugin` resolves
 * them for `adb` itself — because it is the build, not a process launched by
 * whatever an MCP client decided to use as `cwd`.
 */
const PORTHOLE_PROJECT_ROOT = "PORTHOLE_PROJECT_ROOT";
const PORTHOLE_SDK_DIR = "PORTHOLE_SDK_DIR";

export type ProjectRootSource = "PORTHOLE_PROJECT_ROOT" | "cwd";

export interface ResolvedProjectRoot {
  directory: string;
  source: ProjectRootSource;
}

/**
 * The project root anything here should treat as "the build", in order:
 * `PORTHOLE_PROJECT_ROOT` if the generated config set it, otherwise
 * `process.cwd()` on the stated assumption GRA-87 already made and this
 * ticket exists to stop relying on — that an MCP client launches its stdio
 * server from the workspace root. When a generated `.mcp.json` is what
 * started this process, that assumption is no longer needed at all.
 */
export function resolveProjectRoot(): ResolvedProjectRoot {
  const declared = process.env[PORTHOLE_PROJECT_ROOT];
  if (declared && declared.trim()) {
    return { directory: declared.trim(), source: "PORTHOLE_PROJECT_ROOT" };
  }
  return { directory: process.cwd(), source: "cwd" };
}

/**
 * True for a Windows drive-relative path — a letter, a colon, and then
 * anything other than a separator (`C:foo`, or bare `C:`): "foo, relative to
 * whatever the current directory on drive C happens to be", a real Windows
 * path concept distinct from both absolute and an ordinary relative path.
 * This is the TypeScript analogue of `isWindowsDriveRelative` in
 * PortholeTasks.kt (GRA-150), kept for the same reason: `path.join(directory,
 * "C:foo")` does not anchor it under `directory` — Node happily concatenates
 * the strings into `<directory>\C:foo`, a colon spliced into the middle of a
 * path segment that Windows refuses to open. There is no reliable way to ask
 * Node, any more than the JVM, what "the current directory on drive C" is for
 * a directory other than this process's own, so — matching the Kotlin
 * resolver's choice — this shape is deliberately left to resolve however
 * `path.resolve` on its own (no `directory` argument) already resolves it,
 * rather than inventing an anchor. Gated on `win32`: everywhere else a colon
 * is an ordinary filename character, and `C:foo` there is exactly as
 * relative as it looks.
 */
function isWindowsDriveRelative(value: string): boolean {
  return process.platform === "win32" && /^[A-Za-z]:($|[^\\/])/.test(value);
}

/**
 * True for a path `java.io.File#isAbsolute()` — and so PortholeTasks.kt's
 * `resolveSdkDir` — would call absolute. On Windows this deliberately
 * disagrees with Node's own `path.isAbsolute`: a bare POSIX-style leading
 * slash (`/opt/sdk`) is absolute to Node there (it roots the path at
 * whatever the current drive is) but not to Java, which requires a drive
 * letter or a UNC prefix. GRA-150's QA moved the Kotlin resolver to route
 * that shape through the project-root join instead of the current-drive
 * root; using Node's native check here would silently put TypeScript back on
 * the old, rejected answer for this one shape. See PortholeTasks.kt's
 * `resolveSdkDir` doc comment for the full story. Off Windows, Java's rule
 * and Node's agree (both are simply "starts with /"), so this just defers to
 * `path.isAbsolute`.
 */
function isJavaStyleAbsolute(value: string): boolean {
  if (process.platform !== "win32") return path.isAbsolute(value);
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
}

/**
 * Anchors a `sdk.dir` value read out of local.properties against `directory`
 * — [sdkDirFromLocalProperties]'s current directory in its walk, i.e. the
 * directory the file was actually found in. This is deliberately NOT
 * `resolveProjectRoot().directory`: the two differ whenever the walk climbs
 * past the project root to find the file, and a relative path written inside
 * that file means "relative to where the file lives", not "relative to
 * wherever PORTHOLE_PROJECT_ROOT happens to point". This mirrors
 * PortholeTasks.kt's `resolveSdkDir`, which anchors on `projectRoot` — its
 * exact analogue, for the exact same reason (GRA-160 AC1).
 *
 * `path.join`, not `path.resolve`, does the anchoring for the ordinary case:
 * `path.resolve` special-cases any argument it considers absolute — which,
 * on Windows, includes the POSIX-style shape `isJavaStyleAbsolute`
 * deliberately excludes — by discarding every argument before it and rooting
 * at the current drive instead. That is exactly the answer this function
 * exists to avoid. `path.join` treats every argument as a plain segment
 * regardless of what it looks like, so it always anchors under `directory`;
 * the outer `path.resolve` then only normalizes the result (drops a trailing
 * separator, collapses a redundant `.`/`..`), which is also where the
 * "GRA-160 AC4" trim below actually pays for itself — an unstripped
 * whitespace character survives straight into this join as part of the path
 * segment, and lands on a directory that does not exist.
 */
function resolveRelativeSdkDir(value: string, directory: string): string {
  if (isWindowsDriveRelative(value)) return path.resolve(value);
  if (isJavaStyleAbsolute(value)) return path.resolve(value);
  return path.resolve(path.join(directory, value));
}

/** `sdk.dir` from the nearest local.properties at or above `from`. */
function sdkDirFromLocalProperties(from: string): string | null {
  let directory = path.resolve(from);
  for (let level = 0; level <= LOCAL_PROPERTIES_LEVELS; level++) {
    const file = path.join(directory, "local.properties");
    try {
      if (existsSync(file)) {
        // A local.properties with no sdk.dir in it is not an answer, so the
        // walk continues past it rather than stopping at the first file found.
        const value = parseProperties(readFileSync(file, "utf8")).get("sdk.dir");
        // GRA-160 AC4: value.trim() here is the only thing standing between
        // a value parseProperties handed back un-trimmed and a filesystem
        // check on a directory that does not exist. Plain ASCII whitespace
        // around the value mostly never reaches this line at all —
        // parseProperties' own `[ \t\f]` stripping already ate the leading
        // run, and a value with nothing but trailing ASCII space is realistic
        // (a hand-edited file, or a stray editor auto-format) but easy to
        // write a fixture for and forget. A non-breaking space (U+00A0) is
        // the sharper case: `[ \t\f]` does not include it, so it survives
        // parseProperties untouched either way, and only JS's own
        // Unicode-aware `trim()` — not a regex character class copied from
        // Java's — removes it here. adb.test.ts covers both.
        if (value && value.trim()) return resolveRelativeSdkDir(value.trim(), directory);
      }
    } catch {
      // Unreadable is the same as absent: the environment is next, and a
      // permissions problem on someone's parent directory is not adb's fault.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break; // The root of the filesystem is its own parent.
    directory = parent;
  }
  return null;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * GRA-119, AC5: `porthole_status` (in `index.ts`) names which of these two it
 * used and where the value came from, as of GRA-152 — that ticket exists
 * because this criterion fell through the gap between GRA-119's `Owns`
 * (which excluded `index.ts`) and GRA-90's rewrite of `index.ts` afterwards.
 * `resolveSdkDir()` and `resolveProjectRoot()`'s `.source` fields
 * (`"PORTHOLE_SDK_DIR"` / `"local.properties"` / `"ANDROID_HOME"` /
 * `"ANDROID_SDK_ROOT"` / `"PATH"` for the SDK; `"PORTHOLE_PROJECT_ROOT"` /
 * `"cwd"` for the project root) are what `porthole_status` reports alongside
 * the resolved `.directory`.
 */
export type SdkDirSource = "PORTHOLE_SDK_DIR" | "local.properties" | "ANDROID_HOME" | "ANDROID_SDK_ROOT" | "PATH";

export interface ResolvedSdkDir {
  /** Null only when `source` is "PATH" — nothing named an SDK directory at all. */
  directory: string | null;
  source: SdkDirSource;
}

/**
 * The Android SDK, in the order a developer would look for it — and, ahead
 * of all of them, the order this ticket adds: an explicit `PORTHOLE_SDK_DIR`
 * from a generated `.mcp.json` wins outright and short-circuits before any
 * filesystem access, deliberately. GRA-87's walk up from the project root for
 * local.properties, and the ANDROID_HOME/ANDROID_SDK_ROOT fallback after it,
 * both stay exactly as they were for a server that was not started from a
 * generated config — see [sdkDirFromLocalProperties] and its tests.
 *
 * The walk-and-environment order below is deliberately the Gradle plugin's —
 * `sdkDirectory` in PortholePlugin.kt — and the two agreeing is the whole
 * point of it. sdk.dir is what Android Studio writes into local.properties,
 * and on a stock install it is the only one of these that is set: neither
 * environment variable exists, and platform-tools is not on PATH, least of
 * all on Windows. Reading only the environment is why `system_context` used
 * to tell the user to go fix something that `./gradlew portholeConnect`, on
 * the same machine and the same SDK, had no trouble with.
 *
 * Once local.properties names a directory, that is the answer even if adb
 * turns out not to be beneath it. The plugin stops there too, and one tool
 * quietly falling through to a different SDK than the other is the exact
 * split personality this replaced.
 */
export function resolveSdkDir(): ResolvedSdkDir {
  const declared = process.env[PORTHOLE_SDK_DIR];
  if (declared && declared.trim()) {
    return { directory: declared.trim(), source: "PORTHOLE_SDK_DIR" };
  }

  const fromProperties = sdkDirFromLocalProperties(resolveProjectRoot().directory);
  if (fromProperties) return { directory: fromProperties, source: "local.properties" };

  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"] as const) {
    const root = process.env[variable];
    if (root && isDirectory(root)) return { directory: root, source: variable };
  }
  return { directory: null, source: "PATH" };
}

/**
 * adb, from the SDK if one can be found, and otherwise left to the PATH.
 *
 * GRA-160 AC3: falling through to a bare binary name is the right answer
 * only when nothing named an SDK at all (`directory` is null, `source` is
 * "PATH") — that is an honest "I don't know", and PATH is the reasonable
 * last resort, unremarked. When `directory` IS known — Android Studio wrote
 * it, or this ticket's fix just anchored a relative one against the right
 * place — but platform-tools is not actually there, falling through to PATH
 * the same silent way is a different thing: it runs *some* adb, possibly a
 * different SDK's, without a word to whoever asked. The wave-4 integration
 * QA measured exactly this. This writes that specific case to stderr rather
 * than swallowing it — stdout is the MCP transport's JSON-RPC channel, so
 * stderr is the only channel available here that cannot corrupt it. Fully
 * surfacing it through `porthole_status`'s payload would need a change in
 * index.ts, which this ticket's Owns excludes; see the ticket report.
 */
export function findAdb(): string {
  const binary = process.platform === "win32" ? "adb.exe" : "adb";
  const { directory } = resolveSdkDir();
  if (!directory) return binary;
  const candidate = path.join(directory, "platform-tools", binary);
  if (existsSync(candidate)) return candidate;
  process.stderr.write(
    `[porthole] sdk.dir resolved to ${directory}, but ` +
      `${path.join("platform-tools", binary)} was not found there; falling back to ${binary} on PATH.\n`,
  );
  return binary;
}

export interface AdbResult {
  ok: boolean;
  output: string;
  /**
   * GRA-233 QA F15: `output` above is stdout and stderr merged (and, on a
   * timeout or a spawn failure, synthesised text that was never on either
   * real stream) — fine for an error message a human reads, wrong for code
   * that has to tell adb's own chatter apart from the command's actual
   * answer. `adb`'s one-time "daemon not running; starting now at
   * tcp:5037" notice lands on stderr and contains a digit, which a caller
   * parsing `output` for a pid can misread as one. Populated only where a
   * real child process actually ran and its stdout was captured (`runAdb`,
   * `runAdbAsync`'s `close` handler); undefined on a spawn error or a
   * timeout, where there is no real stdout to report.
   */
  stdout?: string;
}

/**
 * Spawn options for launching `binary`. Production adb is `adb.exe` on
 * Windows and a plain executable elsewhere, and needs nothing. A batch file
 * is different: since the CVE-2024-27980 hardening, Node refuses to spawn a
 * `.cmd`/`.bat` without `shell: true` and fails with `spawn EINVAL` — which
 * is exactly what the test fakes in `src/testing/fakeAdb.ts` and
 * `fakeScreencapAdb.ts` are on Windows, and why every adb-driven test went
 * red on the Windows CI leg while passing on the other two. Enabling the
 * shell only for that file shape keeps the real `adb.exe` path untouched.
 */
export function spawnOptionsFor<T extends object>(binary: string, base?: T): T & { shell?: boolean } {
  const batch = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  return { ...(base ?? ({} as T)), ...(batch ? { shell: true } : {}) };
}

/**
 * `binary` and `env` mean exactly what they mean on `RunAdbAsyncOptions`
 * below, and exist for the same reason (GRA-182). `system_context` reads the
 * device through this *synchronous* function, and until this existed a test
 * that needed that tool kept off the host's real adb had no way to say so:
 * the override only reached the async twin. With a phone plugged into the
 * machine running the suite, `surface.test.ts`'s every-tool walk turned
 * `system_context`'s four `dumpsys` reads into ~9.6s of blocked event loop
 * (found during GRA-186's device verification — the fake adb the walk
 * already injected never reached this call). Undefined, as every real
 * caller leaves them, means `findAdb()` and an inherited `process.env` —
 * unchanged.
 */
export interface RunAdbOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
}

export function runAdb(args: string[], serial?: string, options: RunAdbOptions = {}): AdbResult {
  const { binary: adbBinary = findAdb(), env } = options;
  const prefix = serial ? ["-s", serial] : [];
  // Same rule as `runAdbAsync`: `env` is only passed through when given, so
  // every real call spawns exactly as it always did.
  const result = spawnSync(
    adbBinary,
    [...prefix, ...args],
    spawnOptionsFor(adbBinary, env ? { encoding: "utf8" as const, env } : { encoding: "utf8" as const }),
  );

  if (result.error) {
    return {
      ok: false,
      output:
        `Could not run adb (${result.error.message}). ` +
        "Set ANDROID_HOME, or put adb on your PATH.",
    };
  }

  const rawStdout = result.stdout || "";
  const output = (rawStdout + (result.stderr || "")).trim();
  if (result.status !== 0) {
    return {
      ok: false,
      output:
        output.includes("more than one") && !serial
          ? `${output}\nStart the UI with --serial <id>; 'adb devices' lists them.`
          : output || `adb exited ${result.status}`,
      stdout: rawStdout,
    };
  }
  return { ok: true, output, stdout: rawStdout };
}

/**
 * How long `runAdbAsync` waits before presuming an adb child is wedged.
 *
 * 150s, not `capture_system_trace`'s own 120s maximum: a caller recording a
 * near-maximum-length trace overrides this per-call to `seconds * 1000` plus
 * a startup buffer (see `index.ts`), so this default only ever governs the
 * short calls — the pull and the on-device cleanup — where anything near a
 * minute already means adb itself, not the recording, is stuck.
 */
const DEFAULT_ADB_TIMEOUT_MS = Number(process.env.PORTHOLE_ADB_TIMEOUT_MS) || 150_000;

/** "One per few seconds", per the ticket: not so chatty it drowns stderr, not so sparse a caller watching the log wonders if the server is still alive. */
const DEFAULT_ADB_TICK_MS = 5_000;

/** Writes one line to stderr — never stdout, which on this server is the MCP transport's own JSON-RPC channel. */
function defaultAdbProgress(elapsedMs: number, args: string[]): void {
  process.stderr.write(
    `[porthole] adb ${args[0] ?? ""} still running after ${Math.round(elapsedMs / 1000)}s...\n`,
  );
}

export interface RunAdbAsyncOptions {
  serial?: string;
  /**
   * Overrides `findAdb()` — the same seam `perfetto.ts`'s `runScript` takes
   * as a plain parameter rather than resolving `trace_processor_shell`
   * itself, for the same reason: a test can hand this a real, controllable
   * process (`cmd.exe`, `/bin/sh`, or a stand-in "adb" on PATH) without a
   * real device or a real SDK on the machine running the suite.
   */
  binary?: string;
  timeoutMs?: number;
  /** Fires every `tickMs` while the child is still running. Default writes progress to stderr; a caller wanting a different message overrides it, not the ticking. */
  onProgress?: (elapsedMs: number, args: string[]) => void;
  tickMs?: number;
  /**
   * Overrides the child's environment. Undefined (the default, and what
   * every real caller leaves it as) means `spawn` does what it always does:
   * inherit `process.env` as it stood at the moment this call was made.
   *
   * This exists for one reason: a test that needs a spawned child to see a
   * *different* `NODE_OPTIONS` (or any other variable) than the rest of the
   * process would otherwise have to mutate the real `process.env` for the
   * duration of the call — a global, shared by every other test running in
   * the same worker, including ones that spawn their own child processes
   * concurrently. That is exactly the kind of cross-test interference this
   * project's own rules warn about elsewhere, and it was measured here, not
   * hypothesised: `index.test.ts`'s GRA-89 rig test used to set
   * `process.env.NODE_OPTIONS` globally for its ~3s capture window, and an
   * unrelated `cli.test.ts` case that spawns its own child process during
   * that window failed intermittently — once, across the handful of
   * full-suite runs made while building this fix, with an exit code its own
   * assertions could not explain — and it did not recur once this parameter
   * replaced the global mutation. A real instance of the leak this
   * parameter exists to make unnecessary. Scoping the override to one
   * `spawn()` call removes the shared mutable state instead of narrowing
   * the window it is exposed for.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * `runAdb`'s async twin: `spawn`, awaited, standing in for `spawnSync`.
 *
 * `capture_system_trace`'s three adb calls — the recording, the pull, and
 * the on-device cleanup — used to run through `runAdb` above, which blocks
 * Node's single thread for as long as the child takes. At the tool's own
 * 120s maximum that froze the whole MCP server for over two minutes: nothing
 * read the device socket, nothing answered another tool call, and the
 * timeline WebSocket went silent. This is the way back, and it is
 * deliberately the same shape GRA-82 already proved out for
 * `trace_processor_shell` in `perfetto.ts`'s `runScript` — `spawn` instead
 * of `spawnSync`, a `setTimeout` that kills the child and reports how long
 * it waited, one shared helper rather than a second way to run a child
 * process asynchronously.
 *
 * Progress is reported on stderr, not returned, because nothing here knows
 * whether anyone is listening for it — it exists so a long recording does
 * not look identically alive and wedged from the outside.
 */
export function runAdbAsync(args: string[], options: RunAdbAsyncOptions = {}): Promise<AdbResult> {
  const {
    serial,
    binary = findAdb(),
    timeoutMs = DEFAULT_ADB_TIMEOUT_MS,
    onProgress = defaultAdbProgress,
    tickMs = DEFAULT_ADB_TICK_MS,
    env,
  } = options;
  const prefix = serial ? ["-s", serial] : [];
  const fullArgs = [...prefix, ...args];

  return new Promise((resolvePromise) => {
    const start = Date.now();
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // `env` is only passed through when given: `spawn(binary, fullArgs)`
    // with no third argument at all is what every real, non-test call makes
    // (production behaviour is unchanged either way, since Node's own
    // default is already "inherit process.env").
    const child = spawn(binary, fullArgs, spawnOptionsFor(binary, env ? { env } : {}));

    const ticker = setInterval(() => {
      if (!settled) onProgress(Date.now() - start, fullArgs);
    }, tickMs);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const finish = (result: AdbResult) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // The binary itself did not run (ENOENT, EACCES, ...) — same wording as
    // the sync version above, so a caller cannot tell which path answered.
    child.on("error", (error) => {
      finish({
        ok: false,
        output: `Could not run adb (${error.message}). Set ANDROID_HOME, or put adb on your PATH.`,
      });
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish({
          ok: false,
          output:
            `adb did not finish within ${timeoutMs}ms running '${fullArgs.join(" ")}'; ` +
            "it may be wedged, so it was killed rather than left to hang.",
        });
        return;
      }
      const output = (stdout + stderr).trim();
      if (code !== 0) {
        finish({
          ok: false,
          output:
            output.includes("more than one") && !serial
              ? `${output}\nStart the UI with --serial <id>; 'adb devices' lists them.`
              : output || `adb exited ${code}`,
          stdout,
        });
        return;
      }
      finish({ ok: true, output, stdout });
    });
  });
}

/**
 * GRA-233: on an API 36 image, `monkey -p <pkg> -c
 * android.intent.category.LAUNCHER 1` prints debug noise to stdout and does
 * not reliably print "Events injected" even after a launch that plainly
 * worked — `finishRestart`'s old check (this function's predecessor) read
 * that absence as failure, so `porthole_connect { restart: true }` and
 * `{ launch: true }` reported failure right after a working relaunch, and
 * the timeline UI's restart button (which shares this code path) did too.
 *
 * The fix stops trusting anything the launcher printed. `am start -W -n
 * <pkg>/<activity>` against a resolved launcher activity replaces `monkey`
 * as the primary way to launch (stable `Status:`/`LaunchState:`/`TotalTime:`
 * output, not a human-input simulator's log), and success is judged solely
 * by whether `packageName`'s process is actually up afterwards — polled with
 * `pidof` for up to [LAUNCH_PID_POLL_TIMEOUT_MS] — regardless of what the
 * launcher itself said. `monkey` survives only as the fallback for when
 * `resolve-activity` cannot name a launcher activity at all.
 */
const LAUNCH_PID_POLL_TIMEOUT_MS = 2_000;
const LAUNCH_PID_POLL_INTERVAL_MS = 200;

/**
 * `adb shell cmd package resolve-activity --brief -c
 * android.intent.category.LAUNCHER <packageName>`'s last non-blank line,
 * when it names a component. `--brief` still prints preamble ahead of the
 * answer on some API levels, so this reads the last line rather than the
 * first; "No activity found" and similar human-readable failures never take
 * the `pkg/Class` shape a real component does, which is what tells the two
 * apart without matching the failure text itself (a wording that has no
 * reason to be stable across Android versions).
 */
export function parseResolvedActivity(output: string): string | null {
  const lines = output
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  // Exactly one "/", with something on both sides of it and no whitespace —
  // "pkg/.Activity" and "pkg/full.Class.Name" both match; "No activity
  // found" and "priority=... match=..." lines do not.
  return /^[^\s/]+\/[^\s/]+$/.test(last) ? last : null;
}

async function resolveLauncherActivity(packageName: string, options: RunAdbAsyncOptions): Promise<string | null> {
  const result = await runAdbAsync(
    ["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", packageName],
    options,
  );
  // A failed adb call (no such shell command on an old API level, adb itself
  // wedged, ...) is exactly as "nothing to resolve" as an empty answer:
  // either way there is no component to hand `am start -W`, and `monkey` is
  // the fallback for both.
  if (!result.ok) return null;
  return parseResolvedActivity(result.output);
}

/**
 * `am start -W -n <packageName>/<activity>`'s three stable fields —
 * confirmed against a real API 36 device, unlike anything `monkey` prints.
 * `ok` mirrors `Status: ok`, but is not this function's last word on
 * success: [launchApp] below judges that by `pidof`, not by this.
 */
export interface AmStartInfo {
  ok: boolean;
  launchState: string | null;
  totalTimeMs: number | null;
}

export function parseAmStart(output: string): AmStartInfo {
  const status = output.match(/^Status:\s*(\S+)/m)?.[1] ?? null;
  const launchState = output.match(/^LaunchState:\s*(\S+)/m)?.[1] ?? null;
  const totalTimeMatch = output.match(/^TotalTime:\s*(\d+)/m);
  return {
    ok: status === "ok",
    launchState,
    totalTimeMs: totalTimeMatch ? Number(totalTimeMatch[1]) : null,
  };
}

/**
 * `adb shell pidof <packageName>`'s pid, read from stdout only — GRA-233 QA
 * F15: `result.output` (used here up to that finding) is stdout and stderr
 * merged, and adb's own one-time "daemon not running; starting now at
 * tcp:5037" notice, which lands on stderr, contains a digit. A pidof that
 * genuinely found nothing (empty stdout, exit 0 on some toybox builds) but
 * happened to trigger that notice used to read as "up" purely off the port
 * number in adb's own chatter. `stdout` is real, captured child-process
 * output — never adb's synthesised text for a spawn error or a timeout — so
 * this only ever matches a pid pidof itself actually printed, anchored to
 * the start of a line so nothing from later on that same line can smuggle a
 * digit in ahead of it either.
 */
async function currentPidOf(packageName: string, options: RunAdbAsyncOptions): Promise<string | null> {
  const result = await runAdbAsync(["shell", "pidof", packageName], options);
  if (!result.ok) return null;
  return result.stdout?.match(/^\s*(\d+)/m)?.[1] ?? null;
}

export interface LaunchResult extends AdbResult {
  /** `am start -W`'s LaunchState, or null when that path never ran (monkey fallback, or the call failed outright). */
  launchState: string | null;
  /** `am start -W`'s TotalTime in ms, same conditions as `launchState`. */
  totalTimeMs: number | null;
}

export interface LaunchOptions extends RunAdbAsyncOptions {
  /** Overrides [LAUNCH_PID_POLL_TIMEOUT_MS] — a test-only knob so a case that proves out the "process never appears" failure does not have to spend the full production timeout doing it. */
  pidPollTimeoutMs?: number;
  /** Overrides [LAUNCH_PID_POLL_INTERVAL_MS]. */
  pidPollIntervalMs?: number;
}

interface PidOutcome {
  /** True once a pid is seen that is not `beforePid` — a genuinely new (or newly-appeared) process. */
  up: boolean;
  /** True when the poll gave up with the *same* pid it started with still answering — force-stop never actually ended it. */
  samePidSurvived: boolean;
  /** The pid last observed, whichever branch above is true — for the "force-stop did not end pid N" message. */
  lastPid: string | null;
}

/**
 * Polls `pidof` until `packageName` answers with a pid other than
 * `beforePid`, or `timeoutMs` runs out — the one honest signal a launch
 * actually worked, since GRA-233 exists precisely because the launcher's
 * own stdout is not one on every API level.
 *
 * GRA-233 QA F14: `beforePid` is what turns this from "is *a* process up"
 * into "did *this* restart actually happen". `restartAppAsync` force-stops
 * before it launches, but a force-stop that silently no-ops (adb reports
 * exit 0, nothing torn down — seen against a real device) leaves the old
 * process answering `pidof` the whole time; judging success by "some pid
 * answers" read that surviving old process as a successful restart.
 * `launchAppAsync` has no old process to distinguish from (it only ever
 * runs once `checkInstalledApp` has already confirmed nothing is running),
 * so it passes `null` and this degrades to exactly the old "any pid at all"
 * check.
 */
async function waitForPidChange(
  packageName: string,
  options: RunAdbAsyncOptions,
  beforePid: string | null,
  timeoutMs = LAUNCH_PID_POLL_TIMEOUT_MS,
  intervalMs = LAUNCH_PID_POLL_INTERVAL_MS,
): Promise<PidOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await currentPidOf(packageName, options);
    if (pid && pid !== beforePid) return { up: true, samePidSurvived: false, lastPid: pid };
    if (Date.now() >= deadline) {
      return { up: false, samePidSurvived: pid !== null && pid === beforePid, lastPid: pid };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

/**
 * The actual "make `packageName` come up" step, shared by `restartAppAsync`
 * (after its own force-stop) and `launchAppAsync` (which has none) — the one
 * place this ticket's fix lives, so the two callers, and the timeline UI's
 * restart button behind `restartAppAsync`, cannot drift apart on how success
 * is judged. `beforePid` is `restartAppAsync`'s pid-before-force-stop
 * (GRA-233 QA F14); `launchAppAsync` always passes `null`, since it has no
 * "before" process to protect against.
 */
async function launchApp(packageName: string, options: LaunchOptions, beforePid: string | null = null): Promise<LaunchResult> {
  const activity = await resolveLauncherActivity(packageName, options);

  let launchOutput: AdbResult;
  let launchState: string | null = null;
  let totalTimeMs: number | null = null;

  if (activity) {
    launchOutput = await runAdbAsync(["shell", "am", "start", "-W", "-n", activity], options);
    if (launchOutput.ok) {
      const info = parseAmStart(launchOutput.output);
      launchState = info.launchState;
      totalTimeMs = info.totalTimeMs;
    }
  } else {
    // Fallback: resolve-activity named nothing, so ask monkey to find and
    // tap a launcher intent blind — exactly what this always did before
    // GRA-233, kept only for the devices/API levels that leave it as the
    // only option.
    launchOutput = await runAdbAsync(
      ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"],
      options,
    );
  }

  // The one check that matters: is a genuinely new process up, never mind
  // what the launcher printed. A launch call that itself failed to run (adb
  // error) still gets this poll — an unrelated process already running
  // under this package name, or a slow-but-successful launch whose adb
  // invocation merely timed out, are both real "yes" answers this would
  // otherwise miss.
  const outcome = await waitForPidChange(
    packageName,
    options,
    beforePid,
    options.pidPollTimeoutMs,
    options.pidPollIntervalMs,
  );
  if (outcome.up) {
    return { ok: true, output: `${packageName} is running`, launchState, totalTimeMs };
  }
  return {
    ok: false,
    // GRA-233 QA F14: named distinctly from "never came up at all" — the
    // old process answering the whole time is a different failure (the
    // force-stop itself never worked) from a launch that genuinely never
    // landed, and the two point at different fixes.
    output: outcome.samePidSurvived
      ? `force-stop did not end pid ${outcome.lastPid}`
      : launchOutput.output || `No launcher activity found for ${packageName}.`,
    launchState,
    totalTimeMs,
  };
}

/**
 * Stop the app and start it again — the async version and the only one:
 * GRA-186 already moved this off `spawnSync` so a mid-capture restart would
 * not freeze the event loop, and GRA-233's `pidof` poll (via [launchApp])
 * would have made a synchronous version block it for up to
 * [LAUNCH_PID_POLL_TIMEOUT_MS] on top of that. The timeline UI's own restart
 * button (`timeline.ts`) now awaits this directly instead of a separate sync
 * copy, so it and `porthole_connect { restart: true }` are, by construction,
 * the same code path GRA-233 set out to fix.
 *
 * Driven from this side rather than from inside the app: a process cannot
 * reliably restart itself, and asking it to try is how you end up with a
 * half-dead process that no longer answers the socket.
 */
export async function restartAppAsync(packageName: string, options: LaunchOptions = {}): Promise<LaunchResult> {
  // GRA-233 QA F14: captured before force-stop runs at all, so [launchApp]
  // can tell "a fresh process came up" apart from "the old one never left".
  const beforePid = await currentPidOf(packageName, options);
  const stopped = await runAdbAsync(["shell", "am", "force-stop", packageName], options);
  if (!stopped.ok) return { ...stopped, launchState: null, totalTimeMs: null };
  return launchApp(packageName, options, beforePid);
}

/**
 * GRA-62: `restartAppAsync` without the force-stop half, for `porthole_connect`'s
 * "installed but not running" case — launching an app that is not running
 * needs no force-stop first, and sending one anyway is not merely redundant:
 * `am force-stop` on a process that is not there is harmless, but it also
 * means this could never be told apart from `restartAppAsync` in a test that
 * only watches which adb calls ran. Shares [launchApp] with `restartAppAsync`
 * rather than re-deriving its resolve/launch/poll sequence a second time.
 */
export async function launchAppAsync(packageName: string, options: LaunchOptions = {}): Promise<LaunchResult> {
  return launchApp(packageName, options);
}
