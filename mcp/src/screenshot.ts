// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import * as jpeg from "jpeg-js";
import { findAdb, spawnOptionsFor } from "./adb.js";

/**
 * GRA-63: "the agent can see the screen". `adb exec-out screencap -p` is one
 * command and the MCP server already runs `adb` — this module is everything
 * between that raw PNG and an image content block a multimodal agent can
 * actually reason about: decode, a FLAG_SECURE/black-frame check, downscale,
 * re-encode as JPEG, all pure JS (no `sharp`, no native module — see the
 * ticket's own EM note: a native dependency in the `npx` path is a real cost
 * for a package whose job is to start instantly).
 *
 * A screenshot is unredactable by construction, unlike the app's own text
 * events — there is no reliable way to know what is sensitive in a bitmap.
 * It is therefore never written to the session file (`sessions.ts`); nothing
 * in this module even has a `SessionWriter` in scope to write one to. It
 * exists only in the one MCP response that captured it.
 */

// ---------------------------------------------------------------------------
// the raw capture — binary, so it cannot go through adb.ts's runAdbAsync
// ---------------------------------------------------------------------------

/**
 * `runAdbAsync` (adb.ts) sets its child's stdout encoding to "utf8" — right
 * for every other adb call this server makes, all of which are text, and
 * fatal for this one: decoding a PNG's raw bytes as UTF-8 and then handing
 * the resulting *string* back corrupts every byte that is not valid UTF-8 on
 * its own, which is most of a compressed image. This captures the child's
 * stdout as `Buffer` chunks and concatenates them, never touching a text
 * encoding at all — `exec-out`, not `shell`, is also part of that: `shell`
 * is documented to mangle binary output (historically CRLF translation) on
 * some adb/device combinations, where `exec-out` is the binary-safe form.
 */
export interface RawCaptureOptions {
  serial?: string;
  displayId?: number;
  /** Test-only override, same seam adb.ts's own functions take. */
  binary?: string;
  timeoutMs?: number;
  /**
   * Test-only, same reasoning as adb.ts's `runAdbAsync`'s own `env` option:
   * overrides the spawned child's environment instead of mutating the real,
   * shared `process.env` for the duration of a call. `undefined` (every real
   * caller) means `spawn` does what it always does — inherit `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

export interface RawCaptureResult {
  ok: boolean;
  data?: Buffer;
  error?: string;
}

const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;

export function captureRawScreenshot(options: RawCaptureOptions = {}): Promise<RawCaptureResult> {
  const {
    serial,
    displayId,
    binary = findAdb(),
    timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
    env,
  } = options;
  const prefix = serial ? ["-s", serial] : [];
  const displayArgs = displayId !== undefined ? ["-d", String(displayId)] : [];
  const args = [...prefix, "exec-out", "screencap", "-p", ...displayArgs];

  return new Promise((resolveCapture) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let stderr = "";

    // `env` only passed through when given, same as adb.ts's `runAdbAsync` —
    // `spawn(binary, args)` with no third argument already inherits
    // `process.env`, which is every real (non-test) caller's behaviour.
    const child = spawn(binary, args, spawnOptionsFor(binary, env ? { env } : {}));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolveCapture({
        ok: false,
        error: `adb did not finish within ${timeoutMs}ms running 'exec-out screencap -p'; it may be wedged.`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCapture({
        ok: false,
        error: `Could not run adb (${error.message}). Set ANDROID_HOME, or put adb on your PATH.`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolveCapture({ ok: false, error: stderr.trim() || `adb exited ${code}` });
        return;
      }
      resolveCapture({ ok: true, data: Buffer.concat(chunks) });
    });
  });
}

// ---------------------------------------------------------------------------
// the FLAG_SECURE / black-frame check
// ---------------------------------------------------------------------------

interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel — pngjs's own `PNG.data` layout. */
  data: Buffer;
}

/** Per-channel — screencap's own black-frame output for FLAG_SECURE is exactly (0,0,0); a few points of headroom absorbs codec/rounding noise without also absorbing a merely dark UI (a dark theme's background is dark, not uniformly black across every pixel). */
const BLACK_FRAME_CHANNEL_THRESHOLD = 8;

/**
 * True only when *every* pixel is at or below the threshold on every
 * channel — a single bright pixel anywhere (a status bar, a small centred
 * logo, a band of white text on an otherwise-black screen) is enough to
 * prove the capture is real content, not a security-blocked black
 * rectangle.
 *
 * GRA-230 QA (on GRA-63): this used to sample a fixed 8x8 grid — 64 points
 * — rather than scan the whole buffer, on the reasoning that a genuinely
 * solid-black FLAG_SECURE frame does not need every pixel checked to prove
 * it. That reasoning had the direction backwards: at a real device's
 * resolution (QA drove this at 1080x2400, ~2.6M pixels) 64 evenly-spaced
 * samples covers a vanishingly small fraction of the frame, so an AMOLED
 * true-black screen with a status bar, a white text band, or a small
 * centred logo was REFUSED and blamed on FLAG_SECURE — every one of those
 * features is easily missed by a grid that fine at that resolution, even
 * though the actual bitmap already has the answer sitting in memory. A
 * full scan is the correct check, not a more-expensive one worth avoiding:
 * it still exits on the very first bright pixel it finds (immediately, for
 * ordinary UI content — a black-and-white screen fails within the first
 * few rows), and only pays for the whole buffer on a capture that turns
 * out to genuinely need refusing.
 *
 * Called on the already-downscaled buffer (see `captureScreenshot`), not
 * the full-resolution decode: smaller to scan, and it is what actually
 * ships, so "is this what an agent is about to be shown" is the honest
 * question to ask, not "was the original black" — a source of both facts
 * agreeing.
 */
export function looksLikeBlackFrame(image: DecodedImage): boolean {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    if (
      data[i] > BLACK_FRAME_CHANNEL_THRESHOLD ||
      data[i + 1] > BLACK_FRAME_CHANNEL_THRESHOLD ||
      data[i + 2] > BLACK_FRAME_CHANNEL_THRESHOLD
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// downscale — pure JS, no sharp
// ---------------------------------------------------------------------------

/**
 * Box-average downscale to `targetWidth`, height scaled proportionally.
 * Never upscales — a screenshot already narrower than `targetWidth` (a small
 * emulator, a low-density device) is returned as-is.
 *
 * Every output pixel is the average of the block of source pixels it
 * covers, not a single sampled source pixel (nearest-neighbour) — box
 * averaging is what keeps a downscaled screenshot of text and thin UI lines
 * legible instead of aliased into noise, and it costs nothing asymptotically
 * more than nearest-neighbour: every source pixel is still visited exactly
 * once in total across the whole output.
 */
export function boxDownscale(image: DecodedImage, targetWidth: number): DecodedImage {
  if (targetWidth >= image.width) return image;
  const scale = image.width / targetWidth;
  const targetHeight = Math.max(1, Math.round(image.height / scale));
  const out = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let ty = 0; ty < targetHeight; ty++) {
    const sy0 = Math.floor(ty * scale);
    const sy1 = Math.min(image.height, Math.max(sy0 + 1, Math.floor((ty + 1) * scale)));
    for (let tx = 0; tx < targetWidth; tx++) {
      const sx0 = Math.floor(tx * scale);
      const sx1 = Math.min(image.width, Math.max(sx0 + 1, Math.floor((tx + 1) * scale)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let idx = (sy * image.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          r += image.data[idx];
          g += image.data[idx + 1];
          b += image.data[idx + 2];
          a += image.data[idx + 3];
          count++;
          idx += 4;
        }
      }

      const outIdx = (ty * targetWidth + tx) * 4;
      out[outIdx] = Math.round(r / count);
      out[outIdx + 1] = Math.round(g / count);
      out[outIdx + 2] = Math.round(b / count);
      out[outIdx + 3] = Math.round(a / count);
    }
  }

  return { width: targetWidth, height: targetHeight, data: out };
}

// ---------------------------------------------------------------------------
// the tool's own orchestration
// ---------------------------------------------------------------------------

export interface ScreenshotOptions {
  serial?: string;
  /** Which display to capture — `screencap -d`. Defaults to 0, the main display. */
  displayId?: number;
  adbOptions?: { binary?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv };
  /** Target width for the re-encoded JPEG. Default 640 (the EM's own spec on this ticket). */
  maxWidth?: number;
  /** JPEG quality, 0-100. Default 80 (the EM's own spec). */
  quality?: number;
  /** Hard cap on the returned JPEG's byte size. Default 1.5MB. */
  maxBytes?: number;
}

export type ScreenshotResult =
  | {
      ok: true;
      base64: string;
      mimeType: "image/jpeg";
      originalWidth: number;
      originalHeight: number;
      width: number;
      height: number;
      bytes: number;
      quality: number;
      displayId: number;
    }
  | {
      ok: false;
      reason: "capture-failed" | "decode-failed" | "black-frame" | "too-large";
      message: string;
      displayId: number;
    };

/** JPEG-encodes `image` at `quality`, cheaply enough to call in a loop while shrinking to fit under a byte cap. */
function encodeJpeg(image: DecodedImage, quality: number): { data: Buffer; width: number; height: number } {
  const encoded = jpeg.encode({ data: image.data, width: image.width, height: image.height }, quality);
  return { data: Buffer.from(encoded.data), width: image.width, height: image.height };
}

export const DEFAULT_MAX_WIDTH = 640;
export const DEFAULT_QUALITY = 80;
export const DEFAULT_MAX_BYTES = 1_500_000;
/** Never shrinks further than this while chasing a byte cap — a screenshot this narrow is no longer useful, so `too-large` is the honest answer past this point rather than a technically-compliant sliver. */
const MIN_SHRINK_WIDTH = 160;

export async function captureScreenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const displayId = options.displayId ?? 0;
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const raw = await captureRawScreenshot({
    serial: options.serial,
    displayId: options.displayId,
    ...options.adbOptions,
  });
  if (!raw.ok || !raw.data) {
    return { ok: false, reason: "capture-failed", message: raw.error ?? "adb returned nothing.", displayId };
  }
  if (raw.data.length === 0) {
    return {
      ok: false,
      reason: "capture-failed",
      message: "adb exec-out screencap returned no data — is the device screen on and unlocked?",
      displayId,
    };
  }

  let decoded: DecodedImage;
  try {
    const png = PNG.sync.read(raw.data);
    decoded = { width: png.width, height: png.height, data: png.data };
  } catch (error) {
    return {
      ok: false,
      reason: "decode-failed",
      message: `Could not decode the captured screenshot: ${error instanceof Error ? error.message : String(error)}`,
      displayId,
    };
  }

  // Fixed-width scaling is most of the size cap's own enforcement: the
  // output byte size tracks `maxWidth`, not the device's native resolution,
  // so a tablet's screenshot ends up roughly the same size as a phone's.
  // The shrink loop below is the belt-and-suspenders case — pathological,
  // noise-heavy content compresses far worse than an ordinary UI ever does.
  let width = Math.min(maxWidth, decoded.width);
  let scaled = boxDownscale(decoded, width);

  // GRA-230 QA: checked on `scaled`, not `decoded` — see looksLikeBlackFrame's
  // own doc comment for why scanning the full-resolution buffer was never
  // actually the point, and why a sparse sample of it was the real bug.
  if (looksLikeBlackFrame(scaled)) {
    return {
      ok: false,
      reason: "black-frame",
      message:
        "The captured screenshot is entirely black. That is what screencap returns for a FLAG_SECURE " +
        "window, not the app's real content, so this refuses rather than handing back a black frame " +
        "as if it were the screen.",
      displayId,
    };
  }

  let jpegResult = encodeJpeg(scaled, quality);

  while (jpegResult.data.length > maxBytes && width > MIN_SHRINK_WIDTH) {
    width = Math.max(MIN_SHRINK_WIDTH, Math.round(width * 0.75));
    scaled = boxDownscale(decoded, width);
    jpegResult = encodeJpeg(scaled, quality);
  }

  if (jpegResult.data.length > maxBytes) {
    return {
      ok: false,
      reason: "too-large",
      message:
        `The captured screenshot still exceeds the ${maxBytes}-byte cap even scaled down to ` +
        `${width}px wide (${jpegResult.data.length} bytes). Unusual for ordinary UI content — try again, ` +
        "or pass a lower `quality`.",
      displayId,
    };
  }

  return {
    ok: true,
    base64: jpegResult.data.toString("base64"),
    mimeType: "image/jpeg",
    originalWidth: decoded.width,
    originalHeight: decoded.height,
    width: scaled.width,
    height: scaled.height,
    bytes: jpegResult.data.length,
    quality,
    displayId,
  };
}
