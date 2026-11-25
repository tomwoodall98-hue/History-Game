import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS_PAD, GLYPHS, drawGlyph, glyphId, type GlyphKind } from '../src/map/glyphs.ts';

const count = (kind: GlyphKind) => GLYPHS.filter((g) => g.kind === kind).length;

test('the glyph set has the variants the design calls for', () => {
  assert.ok(count('mountain') >= 3 && count('mountain') <= 5, 'mountains: 3–5 variants');
  assert.ok(count('ship') >= 2 && count('ship') <= 3, 'ships: 2–3 variants');
  for (const kind of ['desert', 'conifer', 'broadleaf', 'palm', 'ripple', 'serpent', 'whale'] as const) assert.ok(count(kind) >= 1, kind);
  const ids = GLYPHS.map(glyphId);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('anchors sit inside their glyph, and only land cover takes a wash', () => {
  for (const g of GLYPHS) {
    assert.ok(g.ax >= 0 && g.ax <= g.w && g.ay >= 0 && g.ay <= g.h, `${glyphId(g)} anchor`);
    const washable = ['desert', 'conifer', 'broadleaf', 'palm'].includes(g.kind);
    assert.equal(Boolean(g.wash), washable, `${glyphId(g)} wash`);
  }
});

/**
 * A stand-in 2D context that records every point drawn outside a clip.
 * (Hatching is clipped to its shape, so its raw lines may overrun.)
 */
function recorder() {
  const pts: [number, number][] = [];
  let clipDepth = 0;
  const saves: number[] = [];
  const note = (x: number, y: number) => {
    if (clipDepth === 0) pts.push([x, y]);
  };
  const ctx = {
    save: () => saves.push(clipDepth),
    restore: () => {
      clipDepth = saves.pop() ?? 0;
    },
    clip: () => {
      clipDepth++;
    },
    scale: () => {},
    beginPath: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => {},
    moveTo: note,
    lineTo: note,
    ellipse: (x: number, y: number, rx: number, ry: number) => {
      note(x - rx, y - ry);
      note(x + rx, y + ry);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pts };
}

test('every glyph is drawn inside its padded atlas cell, the same way each time', () => {
  for (const g of GLYPHS) {
    const a = recorder();
    drawGlyph(a.ctx, g, 1);
    assert.ok(a.pts.length > 10, `${glyphId(g)} draws something`);
    // Strokes have width, so allow half a line beyond the points themselves.
    const slack = ATLAS_PAD - 0.5;
    for (const [x, y] of a.pts) {
      assert.ok(x >= -slack && x <= g.w + slack && y >= -slack && y <= g.h + slack, `${glyphId(g)} spills out at ${x.toFixed(2)},${y.toFixed(2)}`);
    }
    const b = recorder();
    drawGlyph(b.ctx, g, 1);
    assert.deepEqual(b.pts, a.pts, `${glyphId(g)} is deterministic`);
  }
});
