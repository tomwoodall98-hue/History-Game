/**
 * Procedurally drawn engraving-style ornaments: compass rose, cartouche,
 * map pins. Everything is plain SVG markup so it ships inside the JS bundle
 * with no image requests.
 */

const INK = '#2e1f12';
const PAPER = '#f4ead2';
const RED = '#8a2a1b';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Polar → cartesian with 0° pointing north (up), clockwise. */
function polar(deg: number, r: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [r2(r * Math.cos(a)), r2(r * Math.sin(a))];
}

const pt = (p: [number, number]) => `${p[0]},${p[1]}`;

/** A fleur-de-lis pointing up, base at (0,0), roughly 26 wide × 34 tall. */
export function fleurDeLis(fill = INK): string {
  return `
  <g fill="${fill}">
    <path d="M0,-34 C5,-27 7.5,-19 5.2,-12 C4.2,-9 3,-7.5 2.6,-6 L-2.6,-6 C-3,-7.5 -4.2,-9 -5.2,-12 C-7.5,-19 -5,-27 0,-34 Z"/>
    <path d="M3.2,-6 C4.5,-12 9,-19 14.5,-18.5 C19.5,-18 20.5,-11.5 17,-9 C14.6,-7.4 11.6,-8.6 12,-11.2 C12.3,-13.2 14.8,-13.4 15.4,-12.2 C15.4,-15 12,-15.6 9.6,-13.2 C7.4,-11 6.2,-8.2 5.8,-6 Z"/>
    <path d="M-3.2,-6 C-4.5,-12 -9,-19 -14.5,-18.5 C-19.5,-18 -20.5,-11.5 -17,-9 C-14.6,-7.4 -11.6,-8.6 -12,-11.2 C-12.3,-13.2 -14.8,-13.4 -15.4,-12.2 C-15.4,-15 -12,-15.6 -9.6,-13.2 C-7.4,-11 -6.2,-8.2 -5.8,-6 Z"/>
    <rect x="-7.5" y="-6.2" width="15" height="3.4" rx="1"/>
    <path d="M-2.2,-2.8 L2.2,-2.8 C2.6,0 4.6,2.2 7.2,2 C5.4,4.2 2.4,3.8 1.2,1.8 L0,5 L-1.2,1.8 C-2.4,3.8 -5.4,4.2 -7.2,2 C-4.6,2.2 -2.6,0 -2.2,-2.8 Z"/>
  </g>`;
}

/**
 * A 32-point engraved compass rose. Returns a complete <svg> element string.
 * North is marked with a fleur-de-lis rather than a letter: the map carries
 * no text.
 */
export function compassRoseSVG(): string {
  const R = 100;
  const parts: string[] = [];

  // Outer rings with degree ticks.
  parts.push(
    `<circle r="${R}" fill="${PAPER}" fill-opacity="0.55" stroke="${INK}" stroke-width="1.6"/>`,
    `<circle r="${R - 5}" fill="none" stroke="${INK}" stroke-width="0.7"/>`,
    `<circle r="${R - 14}" fill="none" stroke="${INK}" stroke-width="0.7"/>`,
  );
  const ticks: string[] = [];
  for (let d = 0; d < 360; d += 2.8125) {
    const major = Math.abs(d % 11.25) < 1e-6;
    const a = polar(d, R - 5);
    const b = polar(d, major ? R - 14 : R - 9);
    ticks.push(`M${pt(a)}L${pt(b)}`);
  }
  parts.push(`<path d="${ticks.join('')}" stroke="${INK}" stroke-width="0.5" fill="none"/>`);

  // Alternating band between the inner rings (32 segments).
  const band: string[] = [];
  for (let i = 0; i < 32; i += 2) {
    const a0 = i * 11.25;
    const a1 = a0 + 11.25;
    const p0 = polar(a0, R - 14);
    const p1 = polar(a1, R - 14);
    const p2 = polar(a1, R - 18.5);
    const p3 = polar(a0, R - 18.5);
    band.push(
      `M${pt(p0)}A${R - 14},${R - 14} 0 0 1 ${pt(p1)}L${pt(p2)}A${R - 18.5},${R - 18.5} 0 0 0 ${pt(p3)}Z`,
    );
  }
  parts.push(
    `<circle r="${R - 18.5}" fill="none" stroke="${INK}" stroke-width="0.6"/>`,
    `<path d="${band.join('')}" fill="${INK}" fill-opacity="0.85"/>`,
  );

  // Rose points, smallest first so larger ones overlap them.
  const levels = [
    { step: 11.25, offset: 11.25, len: 0.4, base: 0.07, spread: 5.625, dark: INK, light: PAPER },
    { step: 45, offset: 22.5, len: 0.6, base: 0.11, spread: 11.25, dark: RED, light: PAPER },
    { step: 90, offset: 45, len: 0.74, base: 0.15, spread: 22.5, dark: INK, light: PAPER },
    { step: 90, offset: 0, len: 0.97, base: 0.17, spread: 45, dark: INK, light: PAPER },
  ];
  for (const lv of levels) {
    for (let a = lv.offset; a < 360; a += lv.step) {
      if (lv.step === 11.25 && Math.abs(a % 22.5) < 1e-6) continue; // only odd quarter-winds
      const tip = polar(a, R * lv.len);
      const left = polar(a - lv.spread, R * lv.base);
      const right = polar(a + lv.spread, R * lv.base);
      parts.push(
        `<path d="M0,0L${pt(tip)}L${pt(left)}Z" fill="${lv.light}" stroke="${INK}" stroke-width="0.6" stroke-linejoin="round"/>`,
        `<path d="M0,0L${pt(tip)}L${pt(right)}Z" fill="${lv.dark}" stroke="${INK}" stroke-width="0.6" stroke-linejoin="round"/>`,
      );
    }
  }

  // Hub.
  parts.push(
    `<circle r="7" fill="${PAPER}" stroke="${INK}" stroke-width="1"/>`,
    `<circle r="3" fill="${INK}"/>`,
  );

  // Fleur-de-lis beyond the ring at north.
  parts.push(`<g transform="translate(0,${-R - 2}) scale(0.95)">${fleurDeLis(INK)}</g>`);

  return `<svg viewBox="-112 -142 224 254" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}

/** Logarithmic spiral volute as a path, curling inwards from `start` radius. */
function volute(cx: number, cy: number, r: number, turns: number, startDeg: number, dir: 1 | -1): string {
  const pts: string[] = [];
  const steps = Math.round(turns * 40);
  const b = Math.log(0.16) / (turns * 2 * Math.PI); // shrink to 16% over the curl
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns * 2 * Math.PI;
    const rr = r * Math.exp(b * t);
    const a = (startDeg * Math.PI) / 180 + dir * t;
    pts.push(`${r2(cx + rr * Math.cos(a))},${r2(cy + rr * Math.sin(a))}`);
  }
  return `M${pts.join('L')}`;
}

/**
 * Scrolled cartouche holding the title. Coordinates are in a 420×150 box;
 * the outer element scales it.
 */
export function cartoucheSVG(opts: { title: string; subtitle?: string; idPrefix?: string }): string {
  const id = opts.idPrefix ?? 'ct';
  const W = 420;
  const H = 150;
  // Panel with concave corners.
  const x0 = 58;
  const x1 = W - 58;
  const y0 = 26;
  const y1 = H - 26;
  const c = 12;
  const panel =
    `M${x0 + c},${y0} L${x1 - c},${y0} A${c},${c} 0 0 0 ${x1},${y0 + c} ` +
    `L${x1},${y1 - c} A${c},${c} 0 0 0 ${x1 - c},${y1} L${x0 + c},${y1} ` +
    `A${c},${c} 0 0 0 ${x0},${y1 - c} L${x0},${y0 + c} A${c},${c} 0 0 0 ${x0 + c},${y0} Z`;
  const inset = 6;
  const inner =
    `M${x0 + c + inset},${y0 + inset} L${x1 - c - inset},${y0 + inset} A${c},${c} 0 0 0 ${x1 - inset},${y0 + c + inset} ` +
    `L${x1 - inset},${y1 - c - inset} A${c},${c} 0 0 0 ${x1 - c - inset},${y1 - inset} L${x0 + c + inset},${y1 - inset} ` +
    `A${c},${c} 0 0 0 ${x0 + inset},${y1 - c - inset} L${x0 + inset},${y0 + c + inset} A${c},${c} 0 0 0 ${x0 + c + inset},${y0 + inset} Z`;

  // Scroll ends: the sheet rolls back on itself at each side.
  const rollL =
    `M${x0},${y0 + 8} C${x0 - 26},${y0 + 2} ${x0 - 40},${y0 + 22} ${x0 - 34},${H / 2} ` +
    `C${x0 - 40},${y1 - 22} ${x0 - 26},${y1 - 2} ${x0},${y1 - 8} Z`;
  const rollR =
    `M${x1},${y0 + 8} C${x1 + 26},${y0 + 2} ${x1 + 40},${y0 + 22} ${x1 + 34},${H / 2} ` +
    `C${x1 + 40},${y1 - 22} ${x1 + 26},${y1 - 2} ${x1},${y1 - 8} Z`;

  const curls = [
    volute(x0 - 22, y0 + 8, 16, 1.6, 270, -1),
    volute(x0 - 22, y1 - 8, 16, 1.6, 90, 1),
    volute(x1 + 22, y0 + 8, 16, 1.6, 270, 1),
    volute(x1 + 22, y1 - 8, 16, 1.6, 90, -1),
  ];

  // Small acanthus-like flourishes top and bottom centre.
  const flourish = (y: number, s: 1 | -1) =>
    `M${W / 2 - 46},${y} C${W / 2 - 30},${y - 9 * s} ${W / 2 - 14},${y - 9 * s} ${W / 2 - 6},${y - 2 * s} ` +
    `C${W / 2 - 2},${y - 8 * s} ${W / 2 + 2},${y - 8 * s} ${W / 2 + 6},${y - 2 * s} ` +
    `C${W / 2 + 14},${y - 9 * s} ${W / 2 + 30},${y - 9 * s} ${W / 2 + 46},${y}`;

  const titleY = opts.subtitle ? 80 : 88;
  return `
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${opts.title}">
    <defs>
      <linearGradient id="${id}-roll" x1="0" x2="1">
        <stop offset="0" stop-color="#cdb487"/>
        <stop offset="0.45" stop-color="#f2e5c6"/>
        <stop offset="1" stop-color="#b99a66"/>
      </linearGradient>
      <radialGradient id="${id}-panel" cx="0.5" cy="0.45" r="0.75">
        <stop offset="0" stop-color="#f8f0da"/>
        <stop offset="1" stop-color="#eadbb5"/>
      </radialGradient>
    </defs>
    <g stroke="${INK}" stroke-linejoin="round" stroke-linecap="round">
      <path d="${rollL}" fill="url(#${id}-roll)" stroke-width="1.4"/>
      <path d="${rollR}" fill="url(#${id}-roll)" stroke-width="1.4"/>
      <path d="${curls.join(' ')}" fill="none" stroke-width="1.5"/>
      <path d="${panel}" fill="url(#${id}-panel)" stroke-width="1.8"/>
      <path d="${inner}" fill="none" stroke-width="0.7"/>
      <path d="${flourish(y0 - 1, 1)}" fill="none" stroke-width="1.1"/>
      <path d="${flourish(y1 + 1, -1)}" fill="none" stroke-width="1.1"/>
      <circle cx="${W / 2}" cy="${y0 - 6}" r="2.2" fill="${INK}" stroke="none"/>
      <circle cx="${W / 2}" cy="${y1 + 6}" r="2.2" fill="${INK}" stroke="none"/>
    </g>
    <text x="${W / 2}" y="${titleY}" text-anchor="middle" class="cartouche-title" fill="${INK}">${opts.title}</text>
    ${
      opts.subtitle
        ? `<g stroke="${INK}" stroke-width="0.8"><path d="M${W / 2 - 112},92 H${W / 2 - 18} M${W / 2 + 18},92 H${W / 2 + 112}"/><path d="M${W / 2},88 l4,4 l-4,4 l-4,-4 Z" fill="${INK}"/></g>
    <text x="${W / 2}" y="111" text-anchor="middle" class="cartouche-subtitle" fill="${INK}">${opts.subtitle}</text>`
        : ''
    }
  </svg>`;
}

/** The player's guess: an inked cross. Centred on (0,0). */
export function guessMarkerMarkup(): string {
  return `
    <g class="guess-marker">
      <circle r="13" fill="${PAPER}" fill-opacity="0.001"/>
      <path d="M-7.5,-7.8 C-3,-3.2 2.8,2.6 7.6,7.4 M7.4,-7.6 C2.8,-2.8 -2.6,2.4 -7.4,7.8"
        stroke="#f6edd6" stroke-width="5.2" stroke-linecap="round" fill="none" opacity="0.85"/>
      <path d="M-7.5,-7.8 C-3,-3.2 2.8,2.6 7.6,7.4 M7.4,-7.6 C2.8,-2.8 -2.6,2.4 -7.4,7.8"
        stroke="${INK}" stroke-width="2.6" stroke-linecap="round" fill="none"/>
    </g>`;
}

/** The answer: a red wax seal with an embossed star. Centred on (0,0). */
export function sealMarkerMarkup(id = 'seal'): string {
  // Irregular blob outline for the poured wax.
  const blob: string[] = [];
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = 11.5 + (i % 3 === 0 ? 1.4 : i % 2 === 0 ? -0.6 : 0.5);
    blob.push(`${r2(rr * Math.cos(a))},${r2(rr * Math.sin(a))}`);
  }
  const star: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? 5.4 : 2.3;
    star.push(`${r2(rr * Math.cos(a))},${r2(rr * Math.sin(a))}`);
  }
  return `
    <g class="seal-marker">
      <defs>
        <radialGradient id="${id}-wax" cx="0.38" cy="0.32" r="0.8">
          <stop offset="0" stop-color="#d0473a"/>
          <stop offset="0.55" stop-color="#9c1f18"/>
          <stop offset="1" stop-color="#5e0f0b"/>
        </radialGradient>
      </defs>
      <ellipse cx="1.2" cy="2.4" rx="12.5" ry="11.5" fill="#2a1408" opacity="0.28"/>
      <polygon points="${blob.join(' ')}" fill="url(#${id}-wax)" stroke="#4a0c08" stroke-width="0.8" stroke-linejoin="round"/>
      <circle r="8" fill="none" stroke="#5a0f0a" stroke-width="1.1" opacity="0.8"/>
      <circle r="8.6" fill="none" stroke="#e46a5a" stroke-width="0.5" opacity="0.5"/>
      <polygon points="${star.join(' ')}" fill="#6e130e" stroke="#c94a3c" stroke-width="0.35" opacity="0.95"/>
    </g>`;
}
