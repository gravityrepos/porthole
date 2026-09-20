#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { DeviceClient, type ConnectionState } from "./device.js";
import { TimelineServer, type PortInUse } from "./timeline.js";
import { capture, compare, parseCapture, report } from "./capture.js";
import { resolveProjectRoot, runAdb } from "./adb.js";
import { forwardTarget } from "./devices.js";
import { bootPortholeServer } from "./index.js";
import { parseDuration, parseMillis, parsePort, requiredValue } from "./args.js";
import { sessionsRoot } from "./sessions.js";
import { listSessionsText, saveFromSessions, type SaveFromSessionsOptions } from "./save.js";
import { parseWatch, runWatch } from "./watch.js";

/**
 * The human entry point.
 *
 * The MCP server exists for an agent and talks stdio; this exists for a person
 * and talks to a browser. Opening the timeline should not require asking an
 * agent to call a tool on your behalf.
 */

interface Options {
  port: number;
  uiPort: number;
  serial?: string;
  forward: boolean;
  open: boolean;
  /** GRA-199: see `devices.ts`'s `forwardTarget`. Defaults to `PORTHOLE_APPLICATION_ID`. */
  applicationId?: string;
  /** GRA-199: see `devices.ts`'s `forwardTarget`. Defaults to `PORTHOLE_LEGACY_TCP_PORT` being set. */
  legacyTcpPort: boolean;
}

const USAGE = `
porthole — a window into a running Android app

  porthole ui                          open the live timeline
  porthole capture --scenario <name> -- <command>   record a run to a trace
  porthole watch [--until-first] [--json]   block until something breaks
  porthole save (--since <dur> | --from <ms> --to <ms>)   save what already happened
  porthole sessions                    list what is recorded on disk
  porthole report <trace.json>         what the run is worth looking at
  porthole compare <base> <trace>      regressions against a baseline
  porthole mcp                         the MCP server (stdio)

porthole ui — open the live timeline for a running debug build

  npx @gravitylabsllc/porthole ui [options]

  --port <n>            device port the porthole is listening on (default 8677)
  --ui-port <n>          port to serve the timeline on (default 8678)
  --serial <id>          adb device serial, when more than one is attached
  --application-id <id>  the app the abstract socket is named for (default PORTHOLE_APPLICATION_ID)
  --legacy-tcp-port      forward to the old shared TCP port instead (default PORTHOLE_LEGACY_TCP_PORT)
  --no-forward           skip 'adb forward'; use it if you set the bridge up yourself
  --no-open              do not launch a browser, just print the URL

Needs a device or emulator with the debug build running: the porthole lives inside
the app process, and adb forward is what makes its socket reachable from here.
`;

/**
 * Exported so a test can drive the argv loop itself, not just the pure
 * validators it calls. A test that only calls `parsePort` directly cannot
 * tell the difference between this loop checking its result and ignoring it —
 * deleting the `process.exit(2)` branches below left every prior test green.
 */
export function parse(argv: string[]): Options {
  const options: Options = {
    port: 8677,
    uiPort: 8678,
    forward: true,
    open: true,
    applicationId: process.env.PORTHOLE_APPLICATION_ID || undefined,
    legacyTcpPort: Boolean(process.env.PORTHOLE_LEGACY_TCP_PORT),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = parsePort(argv[++i], "--port");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.port = value;
    } else if (arg === "--ui-port") {
      const value = parsePort(argv[++i], "--ui-port");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.uiPort = value;
    } else if (arg === "--serial") {
      // Previously `argv[++i]` raw: a missing value was consumed silently, and
      // `--serial --port 8677` swallowed "--port" as the serial and left
      // "8677" to be rejected next as a nonsense option — blaming the wrong
      // token for the actual mistake. requiredValue names --serial instead.
      const value = requiredValue(argv[++i], "--serial");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.serial = value;
    } else if (arg === "--application-id") {
      const value = requiredValue(argv[++i], "--application-id");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.applicationId = value;
    } else if (arg === "--legacy-tcp-port") options.legacyTcpPort = true;
    else if (arg === "--no-forward") options.forward = false;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`unknown option: ${arg}\n${USAGE}`);
      process.exit(2);
    }
  }
  return options;
}

export const SAVE_USAGE = `
porthole save — turn a window of what already happened into a trace file

  porthole save (--since <duration> | --from <ms> --to <ms>) [options]

  --since <duration>   how far back to look: 10m, 90s, 2h, or a millisecond count
  --from <ms>          absolute start, device uptime clock (quote a finding's window)
  --to <ms>            absolute end, same clock
  --scenario <name>    what to call it. Defaults to moment-<from>-<to>
  --out <file>         where to write the trace. Defaults to .porthole/traces/<scenario>.json

Resolves against whichever session on disk was most recently written to —
there is no running MCP server here to ask "what counts as now" of.

  porthole sessions    list every session recorded on disk
`;

export interface SaveCliOptions {
  scenario?: string;
  sinceMs?: number;
  from?: number;
  to?: number;
  out?: string;
}

/**
 * GRA-54. Same discipline as `parseCapture`/`parse()` above: every value
 * goes through a validator that names the option and refuses rather than
 * silently accepting `NaN` or swallowing the next flag as its own value.
 * Exported, like `parse()`, so a test can drive the argv loop itself and not
 * just the pure validators it calls (deleting the `process.exit(2)`
 * branches below would otherwise leave every prior test green).
 */
export function parseSave(argv: string[]): SaveCliOptions {
  const options: SaveCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenario") {
      const value = requiredValue(argv[++i], "--scenario");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.scenario = value;
    } else if (arg === "--since") {
      const value = parseDuration(argv[++i], "--since");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.sinceMs = value;
    } else if (arg === "--from") {
      const value = parseMillis(argv[++i], "--from");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.from = value;
    } else if (arg === "--to") {
      const value = parseMillis(argv[++i], "--to");
      if (typeof value !== "number") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.to = value;
    } else if (arg === "--out") {
      const value = requiredValue(argv[++i], "--out");
      if (typeof value !== "string") {
        process.stderr.write(`${value.message}\n`);
        process.exit(2);
      }
      options.out = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(SAVE_USAGE);
      process.exit(0);
    } else {
      process.stderr.write(`unknown option: ${arg}\n${SAVE_USAGE}`);
      process.exit(2);
    }
  }

  const hasSince = options.sinceMs !== undefined;
  const hasFrom = options.from !== undefined;
  const hasTo = options.to !== undefined;
  if (hasSince && (hasFrom || hasTo)) {
    process.stderr.write(`--since cannot be combined with --from/--to\n${SAVE_USAGE}`);
    process.exit(2);
  }
  if (hasFrom !== hasTo) {
    process.stderr.write(`--from and --to must be given together\n${SAVE_USAGE}`);
    process.exit(2);
  }
  if (!hasSince && !hasFrom) {
    process.stderr.write(`give either --since <duration> or both --from and --to\n${SAVE_USAGE}`);
    process.exit(2);
  }
  return options;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Printing the URL is the fallback, and it is already printed.
  }
}

async function ui(argv: string[]): Promise<void> {
  const options = parse(argv);
  if (options.forward) {
    // Same call `porthole capture` makes, through the same runAdb: this used to
    // be a second copy of adb discovery and a second copy of the advice to pass
    // --serial, and the copy here was the one that could not find the SDK.
    // GRA-199: forwardTarget decides tcp:PORT vs the abstract socket; a
    // missing applicationId is reported the same way an adb failure is,
    // rather than silently forwarding to a socket name nothing binds.
    const target = forwardTarget(options.port, options.applicationId, options.legacyTcpPort);
    if (!target.ok) {
      console.error(target.error);
      console.error("Pass --no-forward if the bridge is already up.");
    } else {
      const forwarded = runAdb(["forward", `tcp:${options.port}`, target.target], options.serial);
      if (forwarded.ok) {
        console.error(`forwarded 127.0.0.1:${options.port} to ${target.target}`);
      } else {
        console.error(forwarded.output);
        console.error("Pass --no-forward if the bridge is already up.");
      }
    }
  }

  // GRA-53: the same sessions root `createPortholeServer` uses (index.ts),
  // so a session started here — `porthole ui` is a real entry point someone
  // launches directly, not only through an agent's MCP server — persists to
  // disk the same as any other. Without this, `porthole ui` silently wrote
  // to nothing: `DeviceClient`'s sessions root defaults to disabled when
  // omitted, and nobody watching a browser tab would notice a feature that
  // fails silent.
  const device = new DeviceClient("127.0.0.1", options.port, sessionsRoot(resolveProjectRoot().directory));
  const timeline = new TimelineServer(device, options.uiPort, options.serial);
  device.start();

  let url: string;
  try {
    url = await timeline.start();
  } catch (error) {
    const problem = error as PortInUse;
    console.error(problem.message);
    // An instance already serving this device is not a failure — it is the
    // thing that was asked for. Point at it and stop.
    if (problem.portholeAlreadyRunning) {
      if (options.open) openBrowser(problem.url);
      process.exit(0);
    }
    console.error(`Pass --ui-port to use a port other than ${options.uiPort}.`);
    process.exit(1);
  }

  console.error(`timeline at ${url}`);
  if (options.open) openBrowser(url);

  device.on("state", (state: ConnectionState) => {
    // GRA-162: was an if/else-if chain with no final else, so "connecting"
    // printed nothing — silently correct, but silently, and a fifth state
    // would have joined it there without tsc ever noticing. A switch with
    // an explicit (still silent) "connecting" case and a never-guarded
    // default gives that same behaviour a name and makes the next state
    // addition fail here instead of joining "connecting" by accident. Same
    // precedent as pendingMessage() in device.ts.
    switch (state) {
      case "handshaking":
        // GRA-157: this fires exactly when the socket comes up, which is the
        // real event the 2-second setTimeout below used to guess at. Printing
        // here instead means the CLI says something true immediately on a
        // slow device and does not need a fixed wait on a fast one — the
        // opposite of what a timer can do.
        console.error("connected, waiting on the app's first check-in...");
        break;
      case "connected": {
        // hello is guaranteed non-null here — DeviceClient does not enter
        // "connected" until it is (see device.ts's setState()) — so this no
        // longer hedges with a ternary the way it had to before that was true.
        const hello = device.hello as NonNullable<typeof device.hello>;
        console.error(`connected to ${hello.packageName} on ${hello.device}`);
        break;
      }
      case "disconnected":
        // Expected constantly during development: the app gets reinstalled and
        // relaunched, and the client reconnects on its own.
        console.error("waiting for the app...");
        break;
      case "connecting":
        // No behaviour change (GRA-162 AC3): the original chain had no
        // branch for "connecting" either, so this stays deliberately silent.
        break;
      default: {
        const exhaustive: never = state;
        throw new Error(`porthole ui: unhandled ConnectionState '${exhaustive as string}'`);
      }
    }
  });

  const shutdown = () => {
    device.stop();
    timeline.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const [command, ...rest] = process.argv.slice(2);

if (command === "ui") {
  await ui(rest);
} else if (command === "mcp") {
  // Calls the same boot function `node dist/index.js` uses under its own
  // `isMainModule()` guard, rather than `import("./index.js")`ing for the
  // side effect. That side-effect import used to be how this worked, but it
  // silently stopped booting anything once the boot moved behind the guard:
  // `argv[1]` here is `cli.js`, so the guard (correctly) never fires for us.
  // One boot path, two callers.
  await bootPortholeServer();
} else if (command === "capture") {
  const options = parseCapture(rest);
  if (options.forward) {
    // GRA-199: same forwardTarget() `porthole ui` uses above.
    const target = forwardTarget(options.port, options.applicationId, options.legacyTcpPort);
    if (!target.ok) {
      console.error(target.error);
    } else {
      const forwarded = runAdb(["forward", `tcp:${options.port}`, target.target], options.serial);
      if (!forwarded.ok) console.error(forwarded.output);
    }
  }
  process.exit(await capture(options));
} else if (command === "watch") {
  const options = parseWatch(rest);
  if (options.forward) {
    const forwarded = runAdb(
      ["forward", `tcp:${options.port}`, `tcp:${options.port}`],
      options.serial,
    );
    if (!forwarded.ok) console.error(forwarded.output);
  }
  // AbortController, not a direct `device.stop()` in a SIGINT handler here:
  // runWatch() owns its own DeviceClient and every timer that could still be
  // armed (the tick interval, --timeout), and it is the one place that knows
  // how to unwind all of it without leaving a handle open behind it. Wiring
  // SIGINT/SIGTERM to abort() is the same shape `ui()`'s own shutdown uses.
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.exit(await runWatch(options, controller.signal));
} else if (command === "save") {
  const options = parseSave(rest);
  const projectRoot = resolveProjectRoot().directory;
  const saveOptions: SaveFromSessionsOptions = { root: sessionsRoot(projectRoot), projectRoot, ...options };
  const result = await saveFromSessions(saveOptions);
  process.stderr.write(`${result.message}\n`);
  process.exit(result.code);
} else if (command === "sessions") {
  const result = await listSessionsText(sessionsRoot(resolveProjectRoot().directory));
  process.stdout.write(`${result.message}\n`);
  process.exit(result.code);
} else if (command === "report") {
  if (!rest[0]) {
    process.stderr.write("porthole report <trace.json>\n");
    process.exit(2);
  }
  process.exit(await report(rest[0]));
} else if (command === "compare") {
  if (!rest[0] || !rest[1]) {
    process.stderr.write("porthole compare <baseline.json> <trace.json>\n");
    process.exit(2);
  }
  process.exit(await compare(rest[0], rest[1]));
} else {
  process.stdout.write(USAGE);
  process.exit(command === undefined || command === "--help" || command === "-h" ? 0 : 2);
}
