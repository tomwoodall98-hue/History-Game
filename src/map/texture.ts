/**
 * Paper texture built from SVG turbulence filters, encoded as data URIs and
 * applied as CSS backgrounds. Browsers rasterise these images once and cache
 * them, so the texture costs nothing while the map is panned or zoomed.
 */

function svgUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}")`;
}

/** Fine fibre grain, tiled. */
const grain = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">
  <filter id="f" x="0" y="0">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/>
    <feColorMatrix values="0 0 0 0 0.32  0 0 0 0 0.22  0 0 0 0 0.11  0.55 0 0 0 -0.2"/>
  </filter>
  <rect width="100%" height="100%" filter="url(#f)"/>
</svg>`);

/** Long fibres: stretched turbulence gives a laid-paper feel. */
const fibres = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420">
  <filter id="f" x="0" y="0">
    <feTurbulence type="fractalNoise" baseFrequency="0.012 0.32" numOctaves="2" seed="3" stitchTiles="stitch"/>
    <feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.25  0 0 0 0 0.12  0.36 0 0 0 -0.19"/>
  </filter>
  <rect width="100%" height="100%" filter="url(#f)"/>
</svg>`);

/** Large soft mottling and occasional foxing spots. */
const mottle = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900">
  <filter id="m" x="0" y="0">
    <feTurbulence type="fractalNoise" baseFrequency="0.0045" numOctaves="4" seed="11" stitchTiles="stitch"/>
    <feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.3  0 0 0 0 0.12  0.9 0 0 0 -0.42"/>
  </filter>
  <filter id="s" x="0" y="0">
    <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="1" seed="29" stitchTiles="stitch"/>
    <feColorMatrix values="0 0 0 0 0.42  0 0 0 0 0.24  0 0 0 0 0.08  2.6 0 0 0 -1.62"/>
  </filter>
  <rect width="100%" height="100%" filter="url(#m)"/>
  <rect width="100%" height="100%" filter="url(#s)" opacity="0.35"/>
</svg>`);

/** Tide-mark stains and burnt edges for the whole sheet (not tiled). */
const stains = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" preserveAspectRatio="none">
  <filter id="d" x="-20%" y="-20%" width="140%" height="140%">
    <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="5"/>
    <feDisplacementMap in="SourceGraphic" scale="70"/>
    <feGaussianBlur stdDeviation="3"/>
  </filter>
  <radialGradient id="e" cx="0.5" cy="0.5" r="0.72">
    <stop offset="0.62" stop-color="#7a4f1f" stop-opacity="0"/>
    <stop offset="0.9" stop-color="#7a4f1f" stop-opacity="0.18"/>
    <stop offset="1" stop-color="#5c3814" stop-opacity="0.42"/>
  </radialGradient>
  <g filter="url(#d)" fill="none" stroke="#8a5a26">
    <ellipse cx="880" cy="130" rx="95" ry="80" stroke-width="5" stroke-opacity="0.16"/>
    <ellipse cx="880" cy="130" rx="88" ry="73" fill="#a0733a" fill-opacity="0.05" stroke-width="2" stroke-opacity="0.08"/>
    <ellipse cx="130" cy="590" rx="150" ry="110" stroke-width="6" stroke-opacity="0.12"/>
    <ellipse cx="560" cy="660" rx="60" ry="40" fill="#a0733a" fill-opacity="0.06" stroke-width="3" stroke-opacity="0.1"/>
  </g>
  <rect width="1000" height="700" fill="url(#e)"/>
</svg>`);

export function applyPaperTexture(root: HTMLElement): void {
  root.style.setProperty('--paper-grain', grain);
  root.style.setProperty('--paper-fibres', fibres);
  root.style.setProperty('--paper-mottle', mottle);
  root.style.setProperty('--paper-stains', stains);
}
