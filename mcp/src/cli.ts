#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { DeviceClient } from "./device.js";
import { TimelineServer, type PortInUse } from "./timeline.js";
import { capture, compare, parseCapture, report } from "./capture.js";
import { runAdb } from "./adb.js";
import { bootPortholeServer } from "./index.js";
import { parsePort, requiredValue } from "./args.js";

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
}

const USAGE = `
porthole — a window into a running Android app

  porthole ui                          open the live timeline
  porthole capture --scenario <name> -- <command>   record a run to a trace
  porthole report <trace.json>         what the run is worth looking at
  porthole compare <base> <trace>      regressions against a baseline
  porthole mcp                         the MCP server (stdio)

porthole ui — open the live timeline for a running debug build

  npx @gravitylabsllc/porthole ui [options]

  --port <n>       device port the porthole is listening on (default 8677)
  --ui-port <n>    port to serve the timeline on (default 8678)
  --serial <id>    adb device serial, when more than one is attached
  --no-forward     skip 'adb forward'; use it if you set the bridge up yourself
  --no-open        do not launch a browser, just print the URL

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
    } else if (arg === "--no-forward") options.forward = false;
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
    const forwarded = runAdb(
      ["forward", `tcp:${options.port}`, `tcp:${options.port}`],
      options.serial,
    );
    if (forwarded.ok) {
      console.error(`forwarded 127.0.0.1:${options.port} to the device`);
    } else {
      console.error(forwarded.output);
      console.error("Pass --no-forward if the bridge is already up.");
    }
  }

  const device = new DeviceClient("127.0.0.1", options.port);
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

  device.on("state", (state: string) => {
    if (state === "handshaking") {
      // GRA-157: this fires exactly when the socket comes up, which is the
      // real event the 2-second setTimeout below used to guess at. Printing
      // here instead means the CLI says something true immediately on a
      // slow device and does not need a fixed wait on a fast one — the
      // opposite of what a timer can do.
      console.error("connected, waiting on the app's first check-in...");
    } else if (state === "connected") {
      // hello is guaranteed non-null here — DeviceClient does not enter
      // "connected" until it is (see device.ts's setState()) — so this no
      // longer hedges with a ternary the way it had to before that was true.
      const hello = device.hello as NonNullable<typeof device.hello>;
      console.error(`connected to ${hello.packageName} on ${hello.device}`);
    } else if (state === "disconnected") {
      // Expected constantly during development: the app gets reinstalled and
      // relaunched, and the client reconnects on its own.
      console.error("waiting for the app...");
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
    const forwarded = runAdb(
      ["forward", `tcp:${options.port}`, `tcp:${options.port}`],
      options.serial,
    );
    if (!forwarded.ok) console.error(forwarded.output);
  }
  process.exit(await capture(options));
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
