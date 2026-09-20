// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_WIDTH,
  boxDownscale,
  captureRawScreenshot,
  captureScreenshot,
  looksLikeBlackFrame,
} from "./screenshot.js";
import { buildFakeScreencapAdb } from "./testing/fakeScreencapAdb.js";

/**
 * GRA-63: "the agent can see the screen". Covers, in order: the black-frame
 * heuristic and the downscaler as pure functions (no process involved), the
 * raw binary capture against a real, faked `adb` process (proving the pipe
 * survives byte-for-byte — see `captureRawScreenshot`'s own doc comment for
 * why this cannot go through `adb.ts`'s `runAdbAsync`), and `captureScreenshot`
 * end to end.
 */

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A solid RGBA image, `width`x`height`, one PNG-encoded pixel repeated. */
function solidPng(width: number, height: number, [r, g, b, a] = [0, 0, 0, 255]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}

/** Left half one solid colour, right half another — for proving box-average blending, not just uniform passthrough. */
function splitPng(width: number, height: number, left: [number, number, number], right: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b] = x < width / 2 ? left : right;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/**
 * Solid `bg` everywhere except a horizontal band — a stand-in for a status
 * bar, a small logo's row-span, or a line of text on an otherwise solid
 * screen: real UI content that occupies a small fraction of a real device's
 * pixels, the exact shape QA's 63-A report used to prove the old 8x8-grid
 * check refused real, non-FLAG_SECURE screens.
 */
function blackWithBandPng(
  width: number,
  height: number,
  bg: [number, number, number],
  band: { y: number; height: number; color: [number, number, number] },
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const inBand = y >= band.y && y < band.y + band.height;
    const [r, g, b] = inBand ? band.color : bg;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Every pixel an independent random RGB value — deliberately close to incompressible, for exercising the size-cap shrink loop. */
function noisePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = Math.floor(Math.random() * 256);
    png.data[i + 1] = Math.floor(Math.random() * 256);
    png.data[i + 2] = Math.floor(Math.random() * 256);
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// the fake adb — testing/fakeScreencapAdb.ts (GRA-63, shared with surface.test.ts)
// ---------------------------------------------------------------------------

const cleanupFns: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanupFns.splice(0)) fn();
});

/** Every `buildFakeScreencapAdb` call in this file routes through here so its temp directory is always cleaned up, without every test having to remember to. */
function fakeScreencapAdb(pngBytes: Buffer, options?: { exitCode?: number; stderr?: string }) {
  const adb = buildFakeScreencapAdb(pngBytes, options);
  cleanupFns.push(adb.cleanup);
  return adb;
}

// ---------------------------------------------------------------------------
// looksLikeBlackFrame
// ---------------------------------------------------------------------------

describe("looksLikeBlackFrame", () => {
  it("is true for a solid black capture — what FLAG_SECURE actually produces", () => {
    const png = PNG.sync.read(solidPng(16, 16, [0, 0, 0, 255]));
    expect(looksLikeBlackFrame({ width: png.width, height: png.height, data: png.data })).toBe(true);
  });

  it("is false for ordinary, non-black content", () => {
    const png = PNG.sync.read(solidPng(16, 16, [40, 90, 200, 255]));
    expect(looksLikeBlackFrame({ width: png.width, height: png.height, data: png.data })).toBe(false);
  });

  it("is true for a near-black AMOLED level a few points above zero — #050505, still within the threshold", () => {
    const png = PNG.sync.read(solidPng(64, 64, [5, 5, 5, 255]));
    expect(looksLikeBlackFrame({ width: png.width, height: png.height, data: png.data })).toBe(true);
  });

  it("is false for a dark-but-not-black theme colour — #121212, past the threshold", () => {
    const png = PNG.sync.read(solidPng(64, 64, [0x12, 0x12, 0x12, 255]));
    expect(looksLikeBlackFrame({ width: png.width, height: png.height, data: png.data })).toBe(false);
  });

  // GRA-230 QA (63-A/63-B): the previous version of this check sampled a
  // fixed 8x8 grid, and its own test here proved only that a bright pixel
  // AT ONE OF THOSE 64 EXACT SAMPLE COORDINATES was caught — which is
  // exactly the shape of bug QA found: at a real device's resolution
  // (1080x2400, driven through the built module) a status bar, a white
  // text band or a small centred logo sits at coordinates a coarse grid
  // never samples, and was refused as a false FLAG_SECURE. A test built on
  // the same convenient, sample-aligned coordinate the implementation uses
  // internally passes for a mutant that reintroduces sparse sampling just
  // as happily as it passes for a real full scan — it cannot tell the two
  // apart. This one places a single bright pixel at an arbitrary, non-grid
  // coordinate in a real-sized image instead, which only a genuine full
  // scan can find.
  it("catches a single bright pixel at an arbitrary coordinate in a real-sized image, not only one a coarse grid would happen to sample", () => {
    const width = 1080;
    const height = 2400;
    const png = new PNG({ width, height });
    png.data.fill(0);
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255; // alpha channel
    // An arbitrary, deliberately not-grid-aligned point.
    const x = 733;
    const y = 1847;
    const idx = (y * width + x) * 4;
    png.data[idx] = 255;
    png.data[idx + 1] = 255;
    png.data[idx + 2] = 255;
    expect(looksLikeBlackFrame({ width, height, data: png.data })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// boxDownscale
// ---------------------------------------------------------------------------

describe("boxDownscale", () => {
  it("never upscales — an image already narrower than the target is returned as-is", () => {
    const png = PNG.sync.read(solidPng(100, 50));
    const image = { width: png.width, height: png.height, data: png.data };
    expect(boxDownscale(image, 640)).toBe(image); // same object, not just equal dimensions
  });

  it("keeps a uniform colour uniform after downscaling — box-averaging a solid fill changes nothing", () => {
    const png = PNG.sync.read(solidPng(8, 8, [200, 100, 50, 255]));
    const scaled = boxDownscale({ width: png.width, height: png.height, data: png.data }, 4);
    expect(scaled.width).toBe(4);
    expect(scaled.height).toBe(4);
    for (let i = 0; i < scaled.data.length; i += 4) {
      expect([scaled.data[i], scaled.data[i + 1], scaled.data[i + 2]]).toEqual([200, 100, 50]);
    }
  });

  it("blends a solid two-colour split into two solid, distinct output columns — box-averaging is real, not nearest-neighbour", () => {
    const png = PNG.sync.read(splitPng(8, 4, [255, 0, 0], [0, 0, 255]));
    const scaled = boxDownscale({ width: png.width, height: png.height, data: png.data }, 2);
    expect(scaled.width).toBe(2);
    // Left output column: pure red (averaged entirely from the red half).
    expect([scaled.data[0], scaled.data[1], scaled.data[2]]).toEqual([255, 0, 0]);
    // Right output column: pure blue.
    const rightIdx = 1 * 4;
    expect([scaled.data[rightIdx], scaled.data[rightIdx + 1], scaled.data[rightIdx + 2]]).toEqual([0, 0, 255]);
  });
});

// ---------------------------------------------------------------------------
// captureRawScreenshot — against a real (faked) adb process
// ---------------------------------------------------------------------------

describe("captureRawScreenshot", () => {
  it("returns the PNG bytes exactly, byte for byte — the reason this cannot go through runAdbAsync's utf8 stdout", () => {
    const pngBytes = solidPng(4, 4, [10, 20, 30, 255]);
    const adb = fakeScreencapAdb(pngBytes);
    return captureRawScreenshot({ binary: adb.binaryPath, env: adb.env }).then((result) => {
      expect(result.ok).toBe(true);
      expect(result.data).toEqual(pngBytes);
    });
  });

  it("sends -s SERIAL and -d DISPLAY when given, plus exec-out screencap -p", async () => {
    const adb = fakeScreencapAdb(solidPng(2, 2));
    await captureRawScreenshot({ binary: adb.binaryPath, env: adb.env, serial: "A1", displayId: 2 });
    expect(adb.calls()).toEqual([["-s", "A1", "exec-out", "screencap", "-p", "-d", "2"]]);
  });

  it("omits -d entirely when no displayId is given, rather than sending -d 0 by convention", async () => {
    const adb = fakeScreencapAdb(solidPng(2, 2));
    await captureRawScreenshot({ binary: adb.binaryPath, env: adb.env });
    expect(adb.calls()).toEqual([["exec-out", "screencap", "-p"]]);
  });

  it("reports adb's own failure rather than an empty capture", async () => {
    const adb = fakeScreencapAdb(Buffer.alloc(0), { exitCode: 1, stderr: "error: no devices/emulators found\n" });
    const result = await captureRawScreenshot({ binary: adb.binaryPath, env: adb.env });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no devices/emulators found");
  });
});

// ---------------------------------------------------------------------------
// captureScreenshot — end to end
// ---------------------------------------------------------------------------

describe("captureScreenshot", () => {
  it("captures, scales to the default width, and re-encodes as a JPEG an agent can actually decode", async () => {
    const adb = fakeScreencapAdb(splitPng(1200, 2000, [255, 0, 0], [0, 128, 255]));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.originalWidth).toBe(1200);
    expect(result.originalHeight).toBe(2000);
    expect(result.width).toBe(DEFAULT_MAX_WIDTH);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);

    // Round-trip sanity: what comes back must actually be a valid JPEG an
    // agent's decoder (or ours, in this assertion) can read, not merely
    // "some bytes under the cap".
    const decoded = jpeg.decode(Buffer.from(result.base64, "base64"));
    expect(decoded.width).toBe(result.width);
    expect(decoded.height).toBe(result.height);
  });

  it("never upscales a screenshot already narrower than the target width", async () => {
    const adb = fakeScreencapAdb(solidPng(100, 200, [10, 200, 30, 255]));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(100);
    expect(result.height).toBe(200);
  });

  it("refuses a black capture instead of returning it — GRA-63 AC, names FLAG_SECURE", async () => {
    const adb = fakeScreencapAdb(solidPng(200, 400, [0, 0, 0, 255]));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("black-frame");
    expect(result.message).toContain("FLAG_SECURE");
  });

  it("passes displayId through to adb and back out in the result", async () => {
    const adb = fakeScreencapAdb(solidPng(20, 20));
    const result = await captureScreenshot({ displayId: 3, adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.displayId).toBe(3);
    expect(adb.calls()[0]).toContain("-d");
    expect(adb.calls()[0]).toContain("3");
  });

  it("reports capture-failed rather than crashing when adb itself fails", async () => {
    const adb = fakeScreencapAdb(Buffer.alloc(0), { exitCode: 1, stderr: "error: device offline\n" });
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("capture-failed");
    expect(result.message).toContain("device offline");
  });

  it("reports decode-failed rather than throwing when adb returns something that is not a PNG", async () => {
    const adb = fakeScreencapAdb(Buffer.from("not a png"));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("decode-failed");
  });

  it("shrinks further, and still respects the cap, on content that resists compression — GRA-63 AC (size cap enforced)", async () => {
    // Random noise is close to worst-case for JPEG: the initial 640px-wide
    // encode of this is large enough to force the shrink loop to actually
    // run, not just prove the cap holds by never being threatened.
    const adb = fakeScreencapAdb(noisePng(1280, 720));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
    expect(result.width).toBeLessThanOrEqual(DEFAULT_MAX_WIDTH);
  }, 20_000);

  it("refuses rather than exceeding an impossible cap — GRA-63 AC (a tablet screenshot does not blow past it)", async () => {
    const adb = fakeScreencapAdb(splitPng(2000, 3000, [255, 128, 0], [0, 64, 200]));
    const result = await captureScreenshot({
      adbOptions: { binary: adb.binaryPath, env: adb.env },
      maxBytes: 50, // no real JPEG (headers alone) fits in 50 bytes
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
  });

  it("a tablet's larger native resolution does not produce a larger output than a phone's — fixed-width scaling caps it structurally", async () => {
    const phone = fakeScreencapAdb(splitPng(1080, 2400, [255, 0, 0], [0, 128, 255]));
    const tablet = fakeScreencapAdb(splitPng(2560, 1600, [255, 0, 0], [0, 128, 255]));
    const phoneResult = await captureScreenshot({ adbOptions: { binary: phone.binaryPath, env: phone.env } });
    const tabletResult = await captureScreenshot({ adbOptions: { binary: tablet.binaryPath, env: tablet.env } });
    expect(phoneResult.ok && tabletResult.ok).toBe(true);
    if (!phoneResult.ok || !tabletResult.ok) return;
    expect(phoneResult.width).toBe(DEFAULT_MAX_WIDTH);
    expect(tabletResult.width).toBe(DEFAULT_MAX_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// GRA-230 QA (63-A): the exact four scenarios QA drove through the built
// module at a real device's resolution (1080x2400) — a sparse 8x8-grid
// sample refused three of these that are not FLAG_SECURE at all.
// ---------------------------------------------------------------------------

describe("captureScreenshot at a real device resolution — GRA-230 QA (63-A)", () => {
  const WIDTH = 1080;
  const HEIGHT = 2400;

  it("accepts #000 with a white text band — real content, not a black frame", async () => {
    const png = blackWithBandPng(WIDTH, HEIGHT, [0, 0, 0], { y: 1000, height: 60, color: [255, 255, 255] });
    const adb = fakeScreencapAdb(png);
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
  });

  it("accepts a status-bar-sized band near the top of an otherwise-black screen", async () => {
    const png = blackWithBandPng(WIDTH, HEIGHT, [0, 0, 0], { y: 0, height: 72, color: [230, 230, 230] });
    const adb = fakeScreencapAdb(png);
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
  });

  it("accepts a small centred logo on an otherwise-black screen", async () => {
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    png.data.fill(0);
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255; // alpha
    // A 200x200 centred square, well inside one edge of the frame, exactly
    // as QA's report describes.
    const logoSize = 200;
    const x0 = Math.floor((WIDTH - logoSize) / 2);
    const y0 = Math.floor((HEIGHT - logoSize) / 2);
    for (let y = y0; y < y0 + logoSize; y++) {
      for (let x = x0; x < x0 + logoSize; x++) {
        const idx = (y * WIDTH + x) * 4;
        png.data[idx] = 255;
        png.data[idx + 1] = 255;
        png.data[idx + 2] = 255;
      }
    }
    const adb = fakeScreencapAdb(PNG.sync.write(png));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
  });

  it("accepts a solid #121212 screen — dark theme, not black", async () => {
    const adb = fakeScreencapAdb(solidPng(WIDTH, HEIGHT, [0x12, 0x12, 0x12, 255]));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(true);
  });

  it("refuses a solid #000 screen", async () => {
    const adb = fakeScreencapAdb(solidPng(WIDTH, HEIGHT, [0, 0, 0, 255]));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("black-frame");
  });

  it("refuses a solid #050505 screen — near-black AMOLED, still within the threshold", async () => {
    const adb = fakeScreencapAdb(solidPng(WIDTH, HEIGHT, [5, 5, 5, 255]));
    const result = await captureScreenshot({ adbOptions: { binary: adb.binaryPath, env: adb.env } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("black-frame");
  });
});
