import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geoDistance, geoOrthographic } from 'd3-geo';
import {
  PressTracker,
  TAP_SLOP,
  centreOf,
  decay,
  dragRotation,
  isFacing,
  rotationFor,
  screenToLngLat,
  viewForPoints,
  zoomRotation,
  type LngLat,
  type Rotation,
} from '../src/map/globeMath.ts';
import { fastView, prepare, preparePolygons, projectInto, traceLines, tracePolygons } from '../src/map/fastOrtho.ts';

const near = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} not within ${tol} of ${b}`);

const globe = (rotation: Rotation = [-10, -20], scale = 200, centre: [number, number] = [300, 260]) =>
  geoOrthographic().clipAngle(90).precision(0).rotate(rotation).scale(scale).translate(centre);

// ------------------------------------------------------- screen → globe ---

test('screen point to longitude/latitude', () => {
  const p = globe();
  assert.deepEqual(screenToLngLat(p, [300, 260])?.map((v) => +v.toFixed(9)), [10, 20], 'the centre of the view');
  // Every point on the globe round-trips.
  for (let i = 0; i < 200; i++) {
    const a = (i * 137.5 * Math.PI) / 180;
    const r = 199.5 * Math.sqrt(((i * 7919) % 1000) / 1000);
    const xy: [number, number] = [300 + Math.cos(a) * r, 260 + Math.sin(a) * r];
    const ll = screenToLngLat(p, xy)!;
    assert.ok(ll, `point ${i} on the globe`);
    const back = p(ll)!;
    near(back[0], xy[0], 1e-6);
    near(back[1], xy[1], 1e-6);
  }
});

test('points off the globe return nothing', () => {
  const p = globe();
  assert.equal(screenToLngLat(p, [300 + 200.5, 260]), null, 'just past the rim');
  assert.notEqual(screenToLngLat(p, [300 + 199.5, 260]), null, 'just inside it');
  assert.equal(screenToLngLat(p, [0, 0]), null, 'a corner of the view');
  assert.equal(screenToLngLat(p, [300, 260 + 1000]), null);
  assert.equal(screenToLngLat(p, [Number.NaN, 5]), null);
});

test('longitudes come back wrapped, latitudes clamped', () => {
  const p = globe([-179, 0]);
  const ll = screenToLngLat(p, [300 + 50, 260])!;
  assert.ok(ll[0] >= -180 && ll[0] < 180, String(ll[0]));
  assert.ok(Math.abs(screenToLngLat(globe([0, -90]), [300, 260])![1] - 90) < 1e-9, 'north pole');
});

// ------------------------------------------------------------ tap vs drag ---

test('a press that barely moves is a tap; one that travels is a drag', () => {
  for (const kind of ['mouse', 'pen', 'touch'] as const) {
    const slop = TAP_SLOP[kind];
    const t = new PressTracker();
    t.down(100, 100, kind);
    assert.equal(t.move(100 + slop - 1, 100), false);
    assert.equal(t.up(100 + slop - 1, 100), true, `${kind}: within ${slop}px`);
    t.down(100, 100, kind);
    assert.equal(t.move(100 + slop + 1, 100), true, `${kind}: past the slop it becomes a drag`);
    assert.equal(t.up(100, 100), false, 'returning to the start is still a drag');
  }
  assert.ok(TAP_SLOP.touch > TAP_SLOP.mouse, 'fingers wobble more than mice');
});

test('a wiggle that ends where it started is still a drag', () => {
  const t = new PressTracker();
  t.down(50, 50, 'touch');
  t.move(80, 50);
  t.move(50, 50);
  assert.equal(t.up(50, 50), false);
});

test('pinches, spin-stopping presses and cancelled presses never tap', () => {
  const t = new PressTracker();
  t.down(10, 10, 'touch');
  t.down(60, 10, 'touch'); // second finger
  assert.equal(t.up(60, 10), false);
  assert.equal(t.up(10, 10), false, 'lifting the last finger of a pinch');
  t.down(10, 10, 'touch', true);
  assert.equal(t.up(10, 10), false, 'stopping a spinning globe');
  t.down(10, 10, 'mouse');
  t.cancel();
  assert.equal(t.up(10, 10), false);
  t.down(10, 10, 'mouse');
  assert.equal(t.up(11, 10), true, 'and the next ordinary press taps again');
});

test('an unknown pointer type gets the mouse slop', () => {
  const t = new PressTracker();
  t.down(0, 0, 'eye-tracker');
  t.move(TAP_SLOP.mouse + 1, 0);
  assert.equal(t.up(TAP_SLOP.mouse + 1, 0), false);
});

// ---------------------------------------------------------------- motion ---

test('dragging: the point under the finger follows it', () => {
  const r0: Rotation = [-10, -20];
  const p = globe(r0);
  const grabbed = screenToLngLat(p, [300, 260])!;
  const r1 = dragRotation(r0, 40, -25, 200);
  const [x, y] = globe(r1)(grabbed)!;
  near(x, 340, 1.5, 'x');
  near(y, 235, 1.5, 'y');
  // Dragging a long way up brings the South Pole round, and no further.
  assert.equal(dragRotation([0, 85], 0, -10_000, 200)[1], 90, 'the poles stop the globe tipping over');
  assert.equal(dragRotation([0, -85], 0, 10_000, 200)[1], -90);
});

test('zooming keeps the point under the cursor in place', () => {
  const r0: Rotation = [-10, -20];
  const at: [number, number] = [300 + 30, 260 - 20];
  const under = screenToLngLat(globe(r0, 2000), at)!;
  const r1 = zoomRotation(r0, 30, -20, 2000, 3000);
  const [x, y] = globe(r1, 3000)(under)!;
  near(x, at[0], 0.5, 'x');
  near(y, at[1], 0.5, 'y');
});

test('inertia fades away', () => {
  assert.equal(decay(1, 0), 1);
  assert.ok(decay(1, 100) < 1 && decay(1, 100) > decay(1, 200));
  assert.ok(decay(1, 3000) < 1e-3);
});

test('rotations and the view centre', () => {
  assert.deepEqual(centreOf([-10, -20]), [10, 20]);
  assert.deepEqual(rotationFor([10, 20]), [-10, -20]);
  assert.equal(isFacing([-10, -20], [12, 22]), true);
  assert.equal(isFacing([-10, -20], [-170, -20]), false, 'the antipode');
});

// ------------------------------------------------------------------ views ---

test('the reveal view faces both points and fits them in', () => {
  const guess: LngLat = [-0.1276, 51.5072]; // London
  const answer: LngLat = [32.2841, 31.2565]; // Port Said
  const v = viewForPoints([guess, answer], 180, 150, 5000);
  const p = globe(v.rotation, v.scale, [0, 0]);
  for (const pt of [guess, answer]) {
    assert.ok(isFacing(v.rotation, pt), 'on the near side');
    const [x, y] = p(pt)!;
    assert.ok(Math.hypot(x, y) <= 180, `inside the circle (${Math.hypot(x, y).toFixed(1)})`);
  }
  near(geoDistance(centreOf(v.rotation), guess), geoDistance(centreOf(v.rotation), answer), 1e-9, 'centred between them');
  // One point (a perfect guess): close in, but with some surroundings in view.
  near(viewForPoints([guess], 180, 150, 5000).scale, 180 / Math.sin(0.12), 1e-6);
  assert.equal(viewForPoints([guess], 180, 150, 1000).scale, 1000, 'never past the zoom limit');
  assert.equal(viewForPoints([[0, 0], [180, 0]], 135, 150, 5000).scale, 150, 'opposite sides: the whole globe');
});

// ------------------------------------------------------- fast projection ---

test('the fast projector matches d3, and knows which side faces us', () => {
  const rot: Rotation = [-37, 52];
  const p = globe(rot, 321, [150, 120]);
  const v = fastView(rot, 321, 150, 120);
  const out = new Float64Array(3);
  for (let i = 0; i < 300; i++) {
    const ll: LngLat = [((i * 47) % 360) - 180, ((i * 29) % 178) - 89];
    const [a] = prepare({ type: 'LineString', coordinates: [ll] });
    projectInto(v, a, 0, out);
    assert.equal(out[2] > 0, isFacing(rot, ll), `side of ${ll}`);
    if (out[2] > 0.01) {
      const [x, y] = p(ll)!;
      near(out[0], x, 1e-6);
      near(out[1], y, 1e-6);
    }
  }
});

/** Records path commands. */
class Recorder {
  ops: [string, ...number[]][] = [];
  moveTo(x: number, y: number) {
    this.ops.push(['M', x, y]);
  }
  lineTo(x: number, y: number) {
    this.ops.push(['L', x, y]);
  }
  closePath() {
    this.ops.push(['Z']);
  }
  arc(x: number, y: number, r: number) {
    this.ops.push(['A', x, y, r]);
  }
}

test('lines stop exactly at the rim', () => {
  const v = fastView([0, 0], 100, 0, 0);
  const meridian = prepare({ type: 'LineString', coordinates: [[0, 0], [60, 0], [120, 0]] });
  const rec = new Recorder();
  traceLines(rec, meridian, v);
  const last = rec.ops[rec.ops.length - 1];
  assert.equal(last[0], 'L');
  near(Math.hypot(last[1]!, last[2]!), 100, 1e-9, 'ends on the rim');
  assert.equal(rec.ops.filter((o) => o[0] === 'M').length, 1);
});

test('a polygon wrapped round the far side gets a cancelling rim circle', () => {
  const v = fastView([0, 0], 100, 0, 0); // looking at 0°, 0°; the antipode is 180°, 0°
  // A band round the antipode that just peeps over the rim near 80°E.
  const wrap = preparePolygons({
    type: 'Polygon',
    coordinates: [[[80, -30], [80, 30], [180, 30], [-80, 30], [-100, -30], [180, -30], [80, -30]]],
  });
  const rec = new Recorder();
  tracePolygons(rec, wrap, v, [180, 0]);
  assert.ok(rec.ops.some((o) => o[0] === 'A'), 'reversed circle added');
  const small = preparePolygons({ type: 'Polygon', coordinates: [[[-10, -10], [-10, 10], [10, 10], [10, -10], [-10, -10]]] });
  const rec2 = new Recorder();
  tracePolygons(rec2, small, v, [180, 0]);
  assert.ok(!rec2.ops.some((o) => o[0] === 'A'), 'an ordinary polygon round the view centre is drawn as it is');
  const hidden = preparePolygons({ type: 'Polygon', coordinates: [[[170, -5], [170, 5], [-170, 5], [-170, -5], [170, -5]]] });
  const rec3 = new Recorder();
  tracePolygons(rec3, hidden, v, [180, 0]);
  assert.equal(rec3.ops.length, 0, 'wholly on the far side: skipped');
});
