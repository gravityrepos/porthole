#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { DeviceClient } from "./device.js";
import { TimelineServer, type PortInUse } from "./timeline.js";
import { capture, compare, parseCapture, report } from "./capture.js";
import { runAdb } from "./adb.js";

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

function parse(argv: string[]): Options {
  const options: Options = {
    port: 8677,
    uiPort: 8678,
    forward: true,
    open: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--ui-port") options.uiPort = Number(argv[++i]);
    else if (arg === "--serial") options.serial = argv[++i];
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
    if (state === "connected") {
      const hello = device.hello;
      console.error(hello ? `connected to ${hello.packageName} on ${hello.device}` : "connected");
    } else if (state === "disconnected") {
      // Expected constantly during development: the app gets reinstalled and
      // relaunched, and the client reconnects on its own.
      console.error("waiting for the app...");
    }
  });

  // The first connect usually lands in well under a second. Printing a
  // troubleshooting wall immediately and then "connected" a moment later reads
  // like something went wrong when nothing did.
  setTimeout(() => {
    if (device.state !== "connected") console.error(device.notConnectedMessage());
  }, 2000);

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
  await import("./index.js");
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
