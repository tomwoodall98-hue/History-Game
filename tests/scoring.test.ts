import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm,
  scoreForDistance,
  scoreGuess,
  scoringParams,
  pointsFor,
  countryFloor,
  emojiFor,
  shareText,
  formatDistance,
  TIER_DEFAULTS,
  SEA_K_FACTOR,
  COUNTRY_FLOOR,
  MAX_SCORE,
} from '../src/game/scoring.ts';
import type { CountryLookup } from '../src/game/countries.ts';
import type { Question, Tier } from '../src/game/types.ts';

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

test('score follows a bell curve beyond the bullseye', () => {
  assert.equal(scoreForDistance(0, 1000, 10), 1000);
  assert.equal(scoreForDistance(10, 1000, 10), 1000, 'inside bullseye');
  assert.equal(scoreForDistance(10.5, 1000, 10), 1000, 'no cliff at the bullseye edge');
  assert.equal(scoreForDistance(510, 1000, 10), Math.round(1000 * Math.exp(-0.25)), 'half a k beyond: 779');
  assert.equal(scoreForDistance(1010, 1000, 10), 368, 'one k beyond the bullseye = 1000/e');
  assert.equal(scoreForDistance(2010, 1000, 10), 18, 'two k beyond = 1000/e⁴');
  assert.equal(scoreForDistance(20000, 1750, 10), 0);
  assert.equal(scoreForDistance(Number.NaN, 1000, 10), 0);
  assert.equal(scoreForDistance(-1, 1000, 10), 0);
  // Closer is never worse.
  let prev = 1000;
  for (let d = 0; d <= 6000; d += 50) {
    const s = scoreForDistance(d, 1375, 15);
    assert.ok(s <= prev, `${d} km`);
    prev = s;
  }
});

test('tier defaults: k grows with tier, the bullseye never widens', () => {
  for (let t = 2; t <= 7; t++) {
    const prev = TIER_DEFAULTS[(t - 1) as Tier];
    const cur = TIER_DEFAULTS[t as Tier];
    assert.ok(cur.k > prev.k, `tier ${t} k`);
    assert.ok(cur.bullseyeKm <= prev.bullseyeKm, `tier ${t} bullseye`);
  }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((t) => TIER_DEFAULTS[t as Tier].k), [1000, 1125, 1250, 1375, 1500, 1625, 1750]);
});

const question = (over: Partial<Question> = {}): Question => ({
  id: 'x', event: 'x', dateDisplay: 'x', year: 1, tier: 7, lat: 0, lng: 0, k: null, bullseyeKm: null, note: 'x', source: 'x', ...over,
});

test('per-question k and bullseye override tier defaults', () => {
  const q = question({ k: 2000, bullseyeKm: 100 });
  assert.equal(scoreGuess(q, [0.5, 0]).score, 1000); // ~56 km, inside the 100 km bullseye
  const far = scoreGuess(q, [10, 0]); // ~1,112 km
  assert.equal(far.score, Math.round(1000 * Math.exp(-(((far.distanceKm - 100) / 2000) ** 2))));
  const dflt = scoreGuess(question(), [10, 0]);
  const { k, bullseyeKm } = TIER_DEFAULTS[7];
  assert.equal(dflt.score, Math.round(1000 * Math.exp(-(((dflt.distanceKm - bullseyeKm) / k) ** 2))));
  assert.equal(scoreGuess(q, null).score, 0);
});

test('events at sea default to a longer k', () => {
  assert.deepEqual(scoringParams(question({ tier: 4, atSea: true })), { k: 1375 * SEA_K_FACTOR, bullseyeKm: 15 });
  assert.deepEqual(scoringParams(question({ tier: 4, atSea: true, k: 3000 })), { k: 3000, bullseyeKm: 15 }, 'own k wins');
  const land = scoreGuess(question({ tier: 4 }), [12, 0]).score;
  const sea = scoreGuess(question({ tier: 4, atSea: true }), [12, 0]).score;
  assert.ok(sea > land, `${sea} > ${land}`);
});

test('country floor shrinks for the largest countries', () => {
  assert.equal(countryFloor(99), 500); // Belgium
  assert.equal(countryFloor(500), 500);
  assert.equal(countryFloor(1002), 340); // India
  assert.equal(countryFloor(1500), 250);
  assert.equal(countryFloor(2318), 250); // Russia
  for (let r = 100; r < 3000; r += 50) assert.ok(countryFloor(r + 50) <= countryFloor(r), `${r} km`);
});

/** Two made-up countries either side of 20°E: small to the west, huge to the east. */
const fakeCountries: CountryLookup = {
  countryAt: ([lng, lat]) => (Math.abs(lat) > 60 ? null : lng < 20 ? { code: 'AAA', radiusKm: 300 } : { code: 'BBB', radiusKm: 2000 }),
  byCode: (code) => (code === 'AAA' ? { code, radiusKm: 300 } : code === 'BBB' ? { code, radiusKm: 2000 } : null),
};

test('same-country floor', () => {
  const q = question({ tier: 1 }); // answer at 0°, 0° in country AAA
  // ~1,670 km away, still in AAA: the curve gives ~68, the floor 500.
  const far = scoreGuess(q, [15, 0], fakeCountries);
  assert.ok(scoreGuess(q, [15, 0]).score < 100, 'curve alone');
  assert.deepEqual([far.score, far.countryFloor], [500, 500]);
  // The floor never lowers a better score.
  const near = scoreGuess(q, [3, 0], fakeCountries);
  assert.equal(near.countryFloor, undefined);
  assert.equal(near.score, scoreGuess(q, [3, 0]).score);
  // Another country: distance alone.
  assert.equal(scoreGuess(q, [21, 0], fakeCountries).countryFloor, undefined);
  // Same country but more than 2,500 km away (an overseas territory, say): no floor.
  const overseas = scoreGuess(q, [0, -25], fakeCountries);
  assert.ok(overseas.distanceKm > COUNTRY_FLOOR.maxDistanceKm);
  assert.deepEqual([overseas.score, overseas.countryFloor], [scoreGuess(q, [0, -25]).score, undefined]);
  // A huge country gets the smaller floor.
  assert.equal(scoreGuess(question({ tier: 1, lng: 30 }), [45, 0], fakeCountries).score, 250);
  // At sea: never.
  assert.equal(scoreGuess(question({ tier: 1, atSea: true }), [15, 0], fakeCountries).countryFloor, undefined);
  // An answer the outlines miss can name its country.
  assert.equal(scoreGuess(question({ tier: 1, lat: 70, country: 'AAA' }), [15, 55], fakeCountries).countryFloor, 500);
  assert.equal(scoreGuess(question({ tier: 1, lat: 70 }), [15, 55], fakeCountries).countryFloor, undefined);
  // pointsFor is the same rule without the lookup.
  assert.deepEqual(pointsFor(q, far.distanceKm, 300), { score: 500, countryFloor: 500 });
  assert.deepEqual(pointsFor(q, far.distanceKm, null), { score: scoreGuess(q, [15, 0]).score });
});

test('emoji thresholds', () => {
  assert.equal(emojiFor(1000), '🟩');
  assert.equal(emojiFor(900), '🟩');
  assert.equal(emojiFor(899), '🟨');
  assert.equal(emojiFor(600), '🟨');
  assert.equal(emojiFor(599), '🟧');
  assert.equal(emojiFor(300), '🟧');
  assert.equal(emojiFor(299), '🟥');
  assert.equal(emojiFor(0), '🟥');
});

test('share text format', () => {
  const text = shareText(42, [1000, 900, 650, 820, 300, 520, 40]);
  assert.equal(text, 'Chronomap #42 — 4,230/7,000 🟩🟩🟨🟨🟧🟧🟥');
  assert.equal(MAX_SCORE, 7000);
  assert.equal(shareText(3, [1000, 0, 0, 0, 0, 0, 0], undefined, true), 'Chronomap #3 · Archive — 1,000/7,000 🟩🟥🟥🟥🟥🟥🟥');
  assert.equal(shareText(1, [0, 0, 0, 0, 0, 0, 0], 'https://example.org/'), 'Chronomap #1 — 0/7,000 🟥🟥🟥🟥🟥🟥🟥\nhttps://example.org/');
});

test('distance formatting', () => {
  assert.equal(formatDistance(1234.4, 'km'), '1,234 km');
  assert.equal(formatDistance(1.609344, 'mi'), '1 mile');
  assert.equal(formatDistance(3.25, 'km'), '3.3 km');
  assert.equal(formatDistance(16093.44, 'mi'), '10,000 miles');
});
