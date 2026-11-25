/**
 * The glyph specimen page (/glyphs.html): every decoration glyph, enlarged
 * and at the size it is drawn on the globe, on the globe's own land and sea
 * colours. Built alongside the game but never linked from it.
 */
import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/im-fell-english/latin-400-italic.css';
import '@fontsource/im-fell-english-sc/latin-400.css';
import './styles/specimen.css';
import { applyPaperTexture } from './map/texture';
import { PALETTE } from './map/GlobeView';
import { ATLAS_PAD, GLYPHS, buildGlyphAtlas, drawGlyph, glyphId, type GlyphAtlas, type GlyphKind, type GlyphSpec } from './map/glyphs';
import { mulberry32 } from './game/schedule';

const FAMILIES: { kinds: GlyphKind[]; title: string; note: string; medium: 'land' | 'sea' }[] = [
  { kinds: ['mountain'], title: 'Mountains', medium: 'land', note: 'Profile peaks lit from the upper left, the shadow flank hatched. Placed along Natural Earth mountain ranges.' },
  { kinds: ['desert'], title: 'Deserts', medium: 'land', note: 'Stipple and dune arcs, with an optional ochre wash. Placed in Natural Earth desert regions.' },
  { kinds: ['conifer'], title: 'Northern forests', medium: 'land', note: 'Conifers for the boreal forests of Canada, Scandinavia and Siberia.' },
  { kinds: ['broadleaf'], title: 'Broadleaf forests', medium: 'land', note: 'Rounded crowns for the temperate and tropical rainforests: Amazon, Congo, South-East Asia.' },
  { kinds: ['palm'], title: 'Palms', medium: 'land', note: 'For the tropical fringes, used sparingly among the broadleaf stands.' },
  { kinds: ['ripple'], title: 'Sea ripples', medium: 'sea', note: 'Short strokes scattered over the open ocean, well clear of the existing water-lining at the coasts.' },
  { kinds: ['ship'], title: 'Ships', medium: 'sea', note: 'Occasional, on the old sea routes and never within about 200 km of a coast.' },
  { kinds: ['serpent', 'whale'], title: 'Here be monsters', medium: 'sea', note: 'One or two only, in the remotest ocean, as an easter egg.' },
];

const ENLARGE = 6;
const dpr = Math.min(3, window.devicePixelRatio || 1);

function canvasOf(cssW: number, cssH: number, cls?: string): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(cssW * dpr);
  canvas.height = Math.ceil(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  if (cls) canvas.className = cls;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return { canvas, ctx };
}

function h(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** Draws an atlas cell with the glyph's anchor at (x, y), CSS px. */
function stamp(ctx: CanvasRenderingContext2D, atlas: GlyphAtlas, g: GlyphSpec, x: number, y: number, k = 1, wash = false): void {
  const cell = (wash && atlas.cells.get(`${glyphId(g)}+wash`)) || atlas.cells.get(glyphId(g));
  if (!cell) return;
  const s = k / atlas.scale;
  ctx.drawImage(atlas.canvas, cell.sx, cell.sy, cell.sw, cell.sh, x - (g.ax + ATLAS_PAD) * k, y - (g.ay + ATLAS_PAD) * k, cell.sw * s, cell.sh * s);
}

function card(g: GlyphSpec, atlas: GlyphAtlas, medium: 'land' | 'sea'): HTMLElement {
  const fig = h('figure', 'card');
  const big = canvasOf(g.w * ENLARGE, g.h * ENLARGE, 'enlarged');
  big.ctx.scale(dpr, dpr);
  drawGlyph(big.ctx, g, ENLARGE);
  fig.append(big.canvas);

  // At globe size, on the globe's paper colour, from the atlas.
  const strip = h('div', 'actual');
  const sw = Math.max(64, g.w * 2 + 24);
  const swatch = (wash: boolean, scale: number) => {
    const c = canvasOf(sw, g.h + 14, `swatch ${medium}`);
    c.ctx.scale(dpr, dpr);
    c.ctx.fillStyle = medium === 'land' ? PALETTE.land : PALETTE.sea;
    c.ctx.fillRect(0, 0, sw, g.h + 14);
    stamp(c.ctx, atlas, g, sw / 2 - (g.w * (1 - scale)) / 2 + (g.ax - g.w / 2) * scale, 7 + g.ay * scale + (g.h * (1 - scale)) / 2, scale, wash);
    return c.canvas;
  };
  strip.append(swatch(false, 1));
  if (g.wash) strip.append(swatch(true, 1));
  strip.append(swatch(false, 0.7));
  fig.append(strip);
  const cap = h('figcaption');
  cap.append(h('span', 'id', `${g.kind} ${g.variant + 1}`), h('span', 'dims', `${g.w}×${g.h} px${g.wash ? ' · with wash' : ''} · 70%`));
  fig.append(cap);
  return fig;
}

/** A patch of "globe": a blob of land in the sea with glyphs scattered as they might be placed. */
function vignette(atlas: GlyphAtlas, wash: boolean): HTMLCanvasElement {
  const W = 520;
  const H = 300;
  const { canvas, ctx } = canvasOf(W, H, 'vignette');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = PALETTE.sea;
  ctx.fillRect(0, 0, W, H);
  const rnd = mulberry32(42);
  // An irregular continent.
  const land: [number, number][] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const r = 1 + 0.16 * Math.sin(a * 3 + 1) + 0.08 * Math.sin(a * 7) + (rnd() - 0.5) * 0.06;
    land.push([300 + Math.cos(a) * 165 * r, 150 + Math.sin(a) * 112 * r]);
  }
  const coast = (grow: number) => {
    ctx.beginPath();
    land.forEach(([x, y], i) => {
      const px = 300 + (x - 300) * (1 + grow / 165);
      const py = 150 + (y - 150) * (1 + grow / 112);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
  };
  // Water-lining, roughly as the globe draws it.
  ctx.lineWidth = 0.6;
  for (const [d, al] of [[12.3, 0.18], [8.5, 0.32], [5.2, 0.48], [2.4, 0.62]]) {
    coast(d);
    ctx.strokeStyle = `rgba(51,34,15,${al})`;
    ctx.stroke();
  }
  coast(0);
  ctx.fillStyle = PALETTE.land;
  ctx.fill();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const by = (kind: GlyphKind) => GLYPHS.filter((g) => g.kind === kind);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const put = (kind: GlyphKind, x: number, y: number, k = 1) => stamp(ctx, atlas, pick(by(kind)), x, y, k, wash);
  // Mountains along a diagonal range, conifers to the north, desert south-east, tropics south-west.
  [[220, 120], [248, 108], [276, 116], [304, 98], [332, 108], [360, 94], [390, 104]].forEach(([x, y]) => put('mountain', x, y, 0.95));
  [[200, 70], [232, 62], [270, 58], [310, 54], [350, 58], [388, 66], [252, 80], [330, 76]].forEach(([x, y]) => put('conifer', x, y));
  [[350, 190], [392, 172], [420, 205], [380, 222], [430, 160]].forEach(([x, y]) => put('desert', x, y));
  [[180, 170], [214, 196], [250, 172], [196, 224], [244, 222], [282, 196]].forEach(([x, y]) => put(rnd() < 0.25 ? 'palm' : 'broadleaf', x, y));
  [[30, 40], [80, 70], [40, 130], [95, 150], [30, 210], [90, 240], [60, 280], [140, 278], [500, 30], [490, 270], [20, 270], [120, 20]].forEach(([x, y]) => put('ripple', x, y));
  put('ship', 70, 108);
  put('ship', 488, 120);
  stamp(ctx, atlas, by('whale')[0], 60, 196);
  return canvas;
}

function build(): void {
  applyPaperTexture(document.documentElement);
  const root = document.getElementById('specimen');
  if (!root) return;
  // The same atlas the globe will use: baked once, at up to 3× for sharp phones and some magnification.
  const atlas = buildGlyphAtlas(Math.min(4, dpr * 1.5));

  const intro = h('section', 'plate');
  intro.append(
    h('h2', undefined, 'On the globe'),
    h('p', 'note', 'A patch of map with glyphs placed as the globe will place them, at their natural size. Water-lining and coast as drawn by the globe today.'),
  );
  const pair = h('div', 'vignettes');
  const plain = h('figure');
  plain.append(vignette(atlas, false), h('figcaption', undefined, 'Ink only'));
  const washed = h('figure');
  washed.append(vignette(atlas, true), h('figcaption', undefined, 'With watercolour washes on forests and deserts'));
  pair.append(plain, washed);
  intro.append(pair);
  root.append(intro);

  for (const fam of FAMILIES) {
    const sec = h('section', 'plate');
    sec.append(h('h2', undefined, fam.title), h('p', 'note', fam.note));
    const grid = h('div', 'grid');
    for (const g of GLYPHS.filter((x) => fam.kinds.includes(x.kind))) grid.append(card(g, atlas, fam.medium));
    sec.append(grid);
    root.append(sec);
  }

  const sheet = h('section', 'plate');
  sheet.append(
    h('h2', undefined, 'Sprite atlas'),
    h('p', 'note', `Every glyph baked once into a single ${atlas.canvas.width}×${atlas.canvas.height} canvas at ${atlas.scale.toFixed(1)}× (washed copies included). The globe draws each decoration as one copy from this sheet.`),
  );
  const shown = atlas.canvas;
  shown.className = 'atlas';
  shown.style.width = `${atlas.canvas.width / dpr}px`;
  sheet.append(shown);
  root.append(sheet);
}

void document.fonts.ready.then(build);
