// Copyright 2026 Gravity Labs
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the landing page's hero artwork — the porthole and the timeline
 * running behind its glass.
 *
 *     node brand/hero.mjs            # write brand/hero.svg, check the page
 *     node brand/hero.mjs --inject   # write it and splice it into the page
 *
 * The lanes are generated rather than hand-authored for one reason: a timeline
 * drawn by hand has a rhythm a person invented, and it reads as invented. A
 * seeded PRNG gives each lane its own cadence — db fires constantly and
 * briefly, nav almost never and for a long time, memory climbs and is
 * collected — and the same seed gives the same picture every run, so the SVG
 * in the page is reproducible rather than a one-off someone tweaked until it
 * looked right. Change a lane colour or a cadence here, re-run, and both the
 * committed vector and the page move together.
 *
 * Unlike render.mjs this needs no browser: there is no text in the drawing, so
 * there is no webfont to rasterise and nothing to rasterise it with. The SVG is
 * the asset, inline in the page, and `--inject` keeps the copy in
 * site/index.html byte-identical to brand/hero.svg.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ prng --- */

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (n) => Math.round(n * 100) / 100;

/* ----------------------------------------------------------------- lanes --- */

// Each lane's shape is its own: this is the part of the drawing that has to be
// true, because a developer reading it will recognise their own app or not.
// The colours are the nine lane colours the rest of the page uses, as literals
// so that brand/hero.svg also renders correctly on its own.
const LANES = [
  { key: "recompose", color: "#f0883e", kind: "spans", gap: [10, 46], w: [5, 24] },
  { key: "state", color: "#a371f7", kind: "ticks", gap: [26, 120], w: [3, 4] },
  { key: "nav", color: "#56c88c", kind: "spans", gap: [150, 320], w: [46, 104] },
  { key: "http", color: "#539bf5", kind: "spans", gap: [48, 190], w: [26, 78] },
  { key: "db", color: "#e3b341", kind: "spans", gap: [8, 34], w: [3, 13] },
  { key: "work", color: "#db61a2", kind: "spans", gap: [180, 360], w: [40, 90] },
  { key: "memory", color: "#6cb6ff", kind: "area" },
  { key: "device", color: "#56d4dd", kind: "ticks", gap: [90, 240], w: [3, 5] },
  { key: "frames", color: "#5ec8b0", kind: "frames" },
];

const TILE = {
  id: "hero-tile",
  tileW: 1440,
  laneH: 24,
  gap: 20,
  seed: 4471,
  frameScale: 2.4,
  wScale: 1.9,
  frameStep: 21,
  round: 3,
};

/**
 * One seamless tile of timeline. Two copies sit end to end inside the animated
 * group, so translating by exactly `tileW` loops without a seam. Nothing is
 * allowed to cross the tile's right edge.
 */
function tile({ id, tileW, laneH, gap, seed, frameScale, round, wScale, frameStep }) {
  const rnd = mulberry32(seed);
  const pick = ([lo, hi]) => (lo + rnd() * (hi - lo)) * wScale;
  const parts = [];
  let y = 0;

  for (const lane of LANES) {
    const h = lane.kind === "frames" ? laneH * frameScale : laneH;

    if (lane.kind === "spans" || lane.kind === "ticks") {
      const op = lane.kind === "ticks" ? 0.85 : 0.92;
      let x = pick(lane.gap) * rnd();
      const bits = [];
      for (;;) {
        const w = pick(lane.w);
        if (x + w > tileW) break;
        bits.push(
          `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${round}"/>`
        );
        x += w + pick(lane.gap);
      }
      parts.push(`<g fill="${lane.color}" opacity="${op}">${bits.join("")}</g>`);
    }

    if (lane.kind === "area") {
      // Allocation climbs, a collection drops it: the sawtooth every Android
      // developer recognises. The period divides tileW so the tile still loops.
      const cycles = 4;
      const period = tileW / cycles;
      const base = y + h;
      const pts = [`0,${r2(base)}`];
      for (let c = 0; c < cycles; c++) {
        const x0 = c * period;
        const peak = 0.62 + rnd() * 0.34;
        pts.push(`${r2(x0 + period * 0.86)},${r2(base - h * peak)}`);
        pts.push(`${r2(x0 + period * 0.9)},${r2(base - h * 0.06)}`);
      }
      pts.push(`${r2(tileW)},${r2(base)}`);
      parts.push(
        `<polyline points="${pts.join(" ")}" fill="none" stroke="${lane.color}" ` +
          `stroke-width="1.4" stroke-linejoin="round" opacity="0.9"/>` +
          `<polygon points="0,${r2(base)} ${pts.join(" ")} ${r2(tileW)},${r2(base)}" ` +
          `fill="${lane.color}" opacity="0.14"/>`
      );
    }

    if (lane.kind === "frames") {
      // A bar per vsync. Most are short; a few blow through the frame budget
      // and go red. That red bar is the whole reason anyone installs this.
      const base = y + h;
      const good = [];
      const bad = [];
      for (let x = 2; x + 3 <= tileW; x += frameStep) {
        const dropped = rnd() < 0.075;
        const bh = dropped ? h * (0.66 + rnd() * 0.34) : h * (0.12 + rnd() * 0.16);
        const rect = `<rect x="${r2(x)}" y="${r2(base - bh)}" width="3" height="${r2(bh)}" rx="1.2"/>`;
        (dropped ? bad : good).push(rect);
      }
      parts.push(`<g fill="${lane.color}" opacity="0.5">${good.join("")}</g>`);
      parts.push(`<g fill="#f85149" opacity="0.95">${bad.join("")}</g>`);
    }

    y += h + gap;
  }

  return { markup: `<g id="${id}">${parts.join("")}</g>`, height: y - gap, tileW };
}

/* ------------------------------------------------------------------ disc --- */

function hero() {
  const T = tile(TILE);
  const C = 510; // centre of the 1020 viewBox
  const R = 440; // the glass
  const COLLAR = R + 46; // the hull ring the bolts sit in
  const bandY = C - T.height / 2;

  // Sixteen bolts, first one at twelve o'clock. The hull the mark implies.
  const bolts = Array.from({ length: 16 }, (_, i) => {
    const a = (i * 22.5 - 90) * (Math.PI / 180);
    return (
      `<circle cx="${r2(C + Math.cos(a) * 468)}" cy="${r2(C + Math.sin(a) * 468)}" ` +
      `r="6" fill="#1e2634" stroke="#46546e" stroke-width="1.2"/>`
    );
  }).join("");

  // aria-hidden + focusable="false": the drawing carries nothing the h1 and the
  // paragraph beside it do not already say, and without focusable="false" older
  // engines put the <svg> in the tab order between the two buttons.
  return `<!-- Copyright 2026 Gravity Labs -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<svg xmlns="http://www.w3.org/2000/svg" class="disc" viewBox="0 0 1020 1020" role="presentation" aria-hidden="true" focusable="false">
<defs>
<radialGradient id="hero-tint" cx="0.38" cy="0.28" r="0.8">
<stop offset="0" stop-color="#7fdcc6" stop-opacity="0.18"/>
<stop offset="0.5" stop-color="#5ec8b0" stop-opacity="0.06"/>
<stop offset="1" stop-color="#060a0f" stop-opacity="0.66"/>
</radialGradient>
<radialGradient id="hero-vign" cx="0.5" cy="0.5" r="0.5">
<stop offset="0.58" stop-color="#0d1117" stop-opacity="0"/>
<stop offset="1" stop-color="#05080c" stop-opacity="0.9"/>
</radialGradient>
<linearGradient id="hero-collar" x1="0.12" y1="0" x2="0.85" y2="1">
<stop offset="0" stop-color="#273244" stop-opacity="0.9"/>
<stop offset="0.48" stop-color="#131a25" stop-opacity="0.35"/>
<stop offset="1" stop-color="#080c12" stop-opacity="0.8"/>
</linearGradient>
<clipPath id="hero-aperture"><circle cx="${C}" cy="${C}" r="${R}"/></clipPath>
${T.markup}
</defs>
<circle cx="${C}" cy="${C}" r="${COLLAR}" fill="#141b26" stroke="#2b3648" stroke-width="1"/>
<circle cx="${C}" cy="${C}" r="${COLLAR}" fill="url(#hero-collar)"/>
${bolts}
<circle cx="${C}" cy="${C}" r="${R}" fill="#070b11"/>
<g clip-path="url(#hero-aperture)">
<g class="flow">
<g transform="translate(-120 ${r2(bandY)})"><use href="#${TILE.id}"/></g>
<g transform="translate(${T.tileW - 120} ${r2(bandY)})"><use href="#${TILE.id}"/></g>
</g>
<rect x="70" y="70" width="880" height="880" fill="url(#hero-tint)"/>
<rect x="70" y="70" width="880" height="880" fill="url(#hero-vign)"/>
<path d="M 170 360 A 440 440 0 0 1 460 72 L 402 160 A 340 340 0 0 0 242 418 Z" fill="#eaf6f2" opacity="0.05"/>
</g>
<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="#5ec8b0" stroke-width="4.5" opacity="0.92"/>
<circle cx="${C}" cy="${C}" r="${COLLAR}" fill="none" stroke="#5ec8b0" stroke-width="1" opacity="0.14"/>
<circle cx="${C}" cy="${C}" r="10" fill="#7fdcc6"/>
<circle cx="${C}" cy="${C}" r="21" fill="none" stroke="#7fdcc6" stroke-width="1.3" opacity="0.4"/>
</svg>
`;
}

/* ----------------------------------------------------------------- write --- */

const OPEN = "      <!-- brand/hero.svg — generated by brand/hero.mjs, do not edit here -->";
const START = "<!-- Copyright 2026 Gravity Labs -->";
const END = "</svg>";

const svg = hero();
const svgPath = join(root, "brand", "hero.svg");
writeFileSync(svgPath, svg, "utf8");
console.log(`brand/hero.svg  ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB`);

// The page carries the same bytes inline. Splice them in with --inject;
// otherwise just say whether the two have drifted apart.
const pagePath = join(root, "site", "index.html");
const page = readFileSync(pagePath, "utf8");
const from = page.indexOf(OPEN);
if (from === -1) {
  console.log("site/index.html: no hero marker — nothing to check");
} else {
  const bodyStart = page.indexOf(START, from);
  const bodyEnd = page.indexOf(END, bodyStart) + END.length + 1;
  const inlined = page.slice(bodyStart, bodyEnd);
  if (inlined === svg) {
    console.log("site/index.html: inline copy matches");
  } else if (process.argv.includes("--inject")) {
    writeFileSync(pagePath, page.slice(0, bodyStart) + svg + page.slice(bodyEnd), "utf8");
    console.log("site/index.html: inline copy updated");
  } else {
    console.error("site/index.html: inline copy has drifted — re-run with --inject");
    process.exitCode = 1;
  }
}
