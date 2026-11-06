import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm,
  scoreForDistance,
  scoreGuess,
  emojiFor,
  shareText,
  formatDistance,
  TIER_DEFAULTS,
  MAX_SCORE,
} from '../src/game/scoring.ts';
import type { Question } from '../src/game/types.ts';

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('haversine: known distances', () => {
  // London (Charing Cross) to Paris (Notre-Dame): ~343 km.
  near(haversineKm([-0.1246, 51.5074], [2.3499, 48.8530]), 343, 3);
  // New York to Los Angeles: ~3,936 km.
  near(haversineKm([-74.006, 40.7128], [-118.2437, 34.0522]), 3936, 10);
  // Quarter of the equator.
  near(haversineKm([0, 0], [90, 0]), (Math.PI / 2) * 6371.0088, 0.01);
  assert.equal(haversineKm([10, 20], [10, 20]), 0);
});

test('haversine: shortest way across the antimeridian', () => {
  // 179°E to 179°W on the equator is 2° apart, not 358°.
  near(haversineKm([179, 0], [-179, 0]), 222.4, 0.5);
});

test('haversine: antipodes', () => {
  near(haversineKm([0, 0], [180, 0]), Math.PI * 6371.0088, 0.01);
});

test('score decays exponentially with distance', () => {
  assert.equal(scoreForDistance(0, 500, 10), 1000);
  assert.equal(scoreForDistance(10, 500, 10), 1000, 'inside bullseye');
  assert.equal(scoreForDistance(10.01, 500, 10), Math.round(1000 * Math.exp(-10.01 / 500)));
  assert.equal(scoreForDistance(500, 500, 10), 368, 'one k away = 1000/e');
  assert.equal(scoreForDistance(1000, 500, 10), 135);
  assert.equal(scoreForDistance(20000, 300, 10), 0);
  assert.equal(scoreForDistance(Number.NaN, 300, 10), 0);
});

test('tier defaults get stricter with each tier', () => {
  for (let t = 2; t <= 7; t++) {
    const prev = TIER_DEFAULTS[(t - 1) as 1];
    const cur = TIER_DEFAULTS[t as 1];
    assert.ok(cur.k < prev.k, `tier ${t} k`);
    assert.ok(cur.bullseyeKm <= prev.bullseyeKm, `tier ${t} bullseye`);
  }
});

test('per-question k and bullseye override tier defaults', () => {
  const q: Question = {
    id: 'x', event: 'x', dateDisplay: 'x', year: 1, tier: 7, lat: 0, lng: 0,
    k: 2000, bullseyeKm: 100, note: 'x', source: 'x',
  };
  assert.equal(scoreGuess(q, [0.5, 0]).score, 1000); // ~56 km, inside 100 km bullseye
  const far = scoreGuess(q, [10, 0]); // ~1,112 km
  assert.equal(far.score, Math.round(1000 * Math.exp(-far.distanceKm / 2000)));
  const dflt = scoreGuess({ ...q, k: null, bullseyeKm: undefined }, [10, 0]);
  assert.equal(dflt.score, Math.round(1000 * Math.exp(-dflt.distanceKm / TIER_DEFAULTS[7].k)));
  assert.equal(scoreGuess(q, null).score, 0);
});

test('emoji thresholds', () => {
  assert.equal(emojiFor(1000), '🟩');
  assert.equal(emojiFor(800), '🟩');
  assert.equal(emojiFor(799), '🟨');
  assert.equal(emojiFor(500), '🟨');
  assert.equal(emojiFor(499), '🟧');
  assert.equal(emojiFor(200), '🟧');
  assert.equal(emojiFor(199), '🟥');
  assert.equal(emojiFor(0), '🟥');
});

test('share text format', () => {
  const text = shareText(42, [1000, 900, 650, 820, 300, 520, 40]);
  assert.equal(text, 'Chronomap #42 — 4,230/7,000 🟩🟩🟨🟩🟧🟨🟥');
  assert.equal(MAX_SCORE, 7000);
  assert.equal(shareText(1, [0, 0, 0, 0, 0, 0, 0], 'https://example.org/'), 'Chronomap #1 — 0/7,000 🟥🟥🟥🟥🟥🟥🟥\nhttps://example.org/');
});

test('distance formatting', () => {
  assert.equal(formatDistance(1234.4, 'km'), '1,234 km');
  assert.equal(formatDistance(1.609344, 'mi'), '1 mile');
  assert.equal(formatDistance(3.25, 'km'), '3.3 km');
  assert.equal(formatDistance(16093.44, 'mi'), '10,000 miles');
});
