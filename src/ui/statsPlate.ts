/**
 * The day's scores as an engraved statistical plate: hatched ink bars on a
 * ruled ground, a graduated base line with period figures, and the player's
 * own score marked in red. Hand-rolled SVG; the geometry lives in
 * game/stats.ts so it can be tested.
 */
import { BAND, BANDS, bandOf, histogramBars, scoreX, type DayStats, type Rect } from '../game/stats';
import { MAX_SCORE, formatNumber } from '../game/scoring';

const W = 330;
const H = 204;
/** The plotting area inside the plate. */
const PLOT: Rect = { x: 22, y: 34, w: W - 44, h: 118 };
const INK = '#33220f';
const FAINT = '#8a7253';
const RED = '#8a2a1b';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** A short description for screen readers. */
export function plateLabel(stats: DayStats, score: number | null): string {
  const n = stats.histogram.reduce((a, b) => a + b, 0);
  const parts = [`Histogram of ${formatNumber(n)} ${n === 1 ? 'score' : 'scores'} in bands of ${BAND} points.`];
  const peak = stats.histogram.indexOf(Math.max(...stats.histogram));
  if (n) parts.push(`Most players scored ${formatNumber(peak * BAND)} to ${formatNumber(Math.min(MAX_SCORE, (peak + 1) * BAND - 1))}.`);
  if (score != null) {
    const b = bandOf(score);
    parts.push(`Your ${formatNumber(score)} is in the ${formatNumber(b * BAND)} to ${formatNumber(b === BANDS - 1 ? MAX_SCORE : (b + 1) * BAND - 1)} band.`);
  }
  return parts.join(' ');
}

export function statsPlateSVG(stats: DayStats, score: number | null, id = 'plate'): string {
  const bars = histogramBars(stats.histogram, PLOT, 3);
  const mine = score == null ? -1 : bandOf(score);
  const base = PLOT.y + PLOT.h;
  const out: string[] = [];

  out.push(
    `<defs>`,
    // Single hatching for the bars, cross-hatching in red for the player's band.
    `<pattern id="${id}-hatch" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`,
    `<line x1="0" y1="0" x2="0" y2="3.2" stroke="${INK}" stroke-width="1"/></pattern>`,
    `<pattern id="${id}-cross" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`,
    `<line x1="0" y1="0" x2="0" y2="3.2" stroke="${RED}" stroke-width="1.1"/><line x1="0" y1="0" x2="3.2" y2="0" stroke="${RED}" stroke-width="0.8"/></pattern>`,
    `</defs>`,
    // The plate: a double ruled border.
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="${INK}" stroke-width="1.4"/>`,
    `<rect x="4.5" y="4.5" width="${W - 9}" height="${H - 9}" fill="none" stroke="${INK}" stroke-width="0.5"/>`,
  );

  // Ruled ground: faint dotted lines at quarters of the tallest band.
  for (let i = 1; i <= 4; i++) {
    const y = (base - (PLOT.h * i) / 4).toFixed(1);
    out.push(`<line x1="${PLOT.x}" y1="${y}" x2="${PLOT.x + PLOT.w}" y2="${y}" stroke="${FAINT}" stroke-width="0.5" stroke-dasharray="1 2.5"/>`);
  }

  for (const b of bars) {
    if (!b.count) continue;
    const own = b.band === mine;
    out.push(
      `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" ` +
        `fill="url(#${id}-${own ? 'cross' : 'hatch'})" stroke="${own ? RED : INK}" stroke-width="${own ? 1.4 : 1}"/>`,
    );
  }

  // Graduated base line: a short tick every band, a long one and a figure every 1,000.
  out.push(`<line x1="${PLOT.x - 2}" y1="${base}" x2="${PLOT.x + PLOT.w + 2}" y2="${base}" stroke="${INK}" stroke-width="1.5"/>`);
  for (let v = 0; v <= MAX_SCORE; v += BAND) {
    const x = scoreX(v, PLOT).toFixed(1);
    const major = v % 1000 === 0;
    out.push(`<line x1="${x}" y1="${base}" x2="${x}" y2="${base + (major ? 6 : 3)}" stroke="${INK}" stroke-width="${major ? 1.1 : 0.7}"/>`);
    if (major) out.push(`<text x="${x}" y="${base + 19}" text-anchor="middle" class="plate-figure">${formatNumber(v)}</text>`);
  }
  out.push(`<text x="${W / 2}" y="${H - 12}" text-anchor="middle" class="plate-caption">Points scored, in bands of ${BAND}</text>`);

  // The player's mark: a red needle down to the base line, labelled above.
  if (score != null) {
    const x = scoreX(score, PLOT);
    const lx = Math.max(PLOT.x + 34, Math.min(PLOT.x + PLOT.w - 34, x));
    out.push(
      `<line x1="${x.toFixed(1)}" y1="${PLOT.y - 4}" x2="${x.toFixed(1)}" y2="${base}" stroke="${RED}" stroke-width="1.3" stroke-dasharray="3 2"/>`,
      `<path d="M${(x - 4).toFixed(1)},${PLOT.y - 9} L${(x + 4).toFixed(1)},${PLOT.y - 9} L${x.toFixed(1)},${PLOT.y - 2} Z" fill="${RED}"/>`,
      `<text x="${lx.toFixed(1)}" y="${PLOT.y - 13}" text-anchor="middle" class="plate-you">Yours: ${formatNumber(score)}</text>`,
    );
  }

  return (
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(plateLabel(stats, score))}" xmlns="http://www.w3.org/2000/svg">` +
    out.join('') +
    `</svg>`
  );
}
