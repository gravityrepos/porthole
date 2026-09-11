#!/usr/bin/env node
// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DeviceClient } from "./device.js";
import { TimelineServer } from "./timeline.js";
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

  npx @gravitylabs/porthole ui [options]

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

/** adb, in the order a developer would look for it. Mirrors the Gradle plugin. */
function findAdb(): string {
  const binary = process.platform === "win32" ? "adb.exe" : "adb";
  for (const variable of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = process.env[variable];
    if (!root) continue;
    const candidate = path.join(root, "platform-tools", binary);
    if (existsSync(candidate)) return candidate;
  }
  return binary;
}

function forwardPort(options: Options): void {
  const adb = findAdb();
  const args = options.serial ? ["-s", options.serial] : [];
  args.push("forward", `tcp:${options.port}`, `tcp:${options.port}`);

  const result = spawnSync(adb, args, { encoding: "utf8" });
  if (result.error) {
    console.error(
      `Could not run adb (${result.error.message}).\n` +
        "Set ANDROID_HOME, or put adb on your PATH, or pass --no-forward if the\n" +
        "bridge is already up.",
    );
    return;
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    console.error(`adb forward failed: ${message}`);
    if (message.includes("more than one")) {
      console.error("Pass --serial <id>; 'adb devices' lists them.");
    }
    return;
  }
  console.error(`forwarded 127.0.0.1:${options.port} to the device`);
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
  if (options.forward) forwardPort(options);

  const device = new DeviceClient("127.0.0.1", options.port);
  const timeline = new TimelineServer(device, options.uiPort, options.serial);
  device.start();

  let url: string;
  try {
    url = await timeline.start();
  } catch (error) {
    console.error(
      `Could not serve the timeline on port ${options.uiPort}: ${(error as Error).message}\n` +
        "Something else is probably on it; pass --ui-port to move.",
    );
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
