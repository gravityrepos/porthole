// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Renders the raster brand assets from their vector sources.
 *
 *     node brand/render.mjs
 *
 * There are two of them and they only change when the brand does, so they are
 * committed rather than built in CI. This script exists so that "committed"
 * does not mean "unreproducible".
 *
 * It drives headless Chrome rather than a rasteriser library for one reason:
 * Chrome fetches the webfont. rsvg or resvg would render PORTHOLE in whatever
 * sans-serif the machine happened to have, and the wordmark is the one place
 * the typeface is not negotiable. The same is true on GitHub, which serves
 * README images through a proxy that will not load Google Fonts either — which
 * is exactly why the README points at the PNG and not the SVG.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome found. Set CHROME_PATH to a Chrome or Chromium binary and run again.",
  );
}

/** The SVGs carry no @font-face of their own, so wrap one in a page that does. */
function pageForSvg(svgPath, width, height) {
  const svg = readFileSync(svgPath, "utf8").replace(/<!--[\s\S]*?-->\s*/g, "");
  return `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>html,body{margin:0;padding:0}body{width:${width}px;height:${height}px;overflow:hidden}svg{display:block}</style>
${svg}`;
}

function shoot(chrome, url, out, { width, height, scale }) {
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-sandbox",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      // Chrome will screenshot before the webfont arrives unless it is told to
      // let time pass. This is the whole reason for using Chrome; do not drop it.
      "--virtual-time-budget=6000",
      `--screenshot=${out}`,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

const scratch = mkdtempSync(join(tmpdir(), "porthole-brand-"));
try {
  const chrome = findChrome();

  const bannerPage = join(scratch, "banner.html");
  writeFileSync(bannerPage, pageForSvg(join(root, "brand/banner.svg"), 1280, 320), "utf8");

  const targets = [
    {
      name: "brand/banner.png",
      url: pathToFileURL(bannerPage).href,
      out: join(root, "brand/banner.png"),
      size: { width: 1280, height: 320, scale: 2 },
    },
    {
      name: "site/og.png",
      url: pathToFileURL(join(root, "brand/og.html")).href,
      out: join(root, "site/og.png"),
      size: { width: 1200, height: 630, scale: 2 },
    },
  ];

  for (const target of targets) {
    shoot(chrome, target.url, target.out, target.size);
    const { width, height, scale } = target.size;
    console.log(`${target.name}  ${width * scale}x${height * scale}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
