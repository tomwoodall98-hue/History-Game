import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CountryIndex } from '../src/game/countries.ts';
import { scoreGuess } from '../src/game/scoring.ts';
import type { Question } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const countries = new CountryIndex(JSON.parse(readFileSync(resolve(ROOT, 'src/data/countries.topo.json'), 'utf8')));
const questions = JSON.parse(readFileSync(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
const byId = (id: string) => questions.find((q) => q.id === id)!;

test('country lookups', () => {
  assert.equal(countries.countryAt([2.3522, 48.8566])?.code, 'FRA'); // Paris
  assert.equal(countries.countryAt([13.405, 52.52])?.code, 'DEU'); // Berlin
  assert.equal(countries.countryAt([-52.33, 4.92])?.code, 'FRA'); // Cayenne, French Guiana
  assert.equal(countries.countryAt([-74.0445, 40.6892])?.code, 'USA', 'Liberty Island, in the harbour');
  assert.equal(countries.countryAt([-40, 30]), null, 'mid-Atlantic');
  const russia = countries.countryAt([37.6176, 55.7558]); // Moscow
  assert.equal(russia?.code, 'RUS');
  assert.ok(russia!.radiusKm > 1500);
  assert.ok(countries.countryAt([4.3517, 50.8503])!.radiusKm < 500); // Brussels
  assert.equal(countries.byCode('JPN')?.code, 'JPN');
  assert.equal(countries.byCode('XXX'), null);
});

test('every land event has a country to score against', () => {
  for (const q of questions) {
    if (q.atSea) continue;
    const found = q.country ? countries.byCode(q.country) : countries.countryAt([q.lng, q.lat]);
    assert.ok(found, q.id);
  }
});

test('the floor on real questions', () => {
  // Statue of Liberty, marked in Dallas (~2,200 km): the curve gives ~9, the USA floor 250.
  const liberty = scoreGuess(byId('t1-statue-of-liberty'), [-96.8, 32.78], countries);
  assert.deepEqual([liberty.score, liberty.countryFloor], [250, 250]);
  // The Bastille marked in French Guiana: France, but an ocean away.
  assert.equal(scoreGuess(byId('t1-bastille'), [-52.33, 4.92], countries).countryFloor, undefined);
  // Trafalgar happened at sea: Madrid is Spain, but there's no floor.
  assert.equal(scoreGuess(byId('t3-trafalgar'), [-3.7038, 40.4168], countries).countryFloor, undefined);
  // Iwo Jima is too small for the outlines, so the question names Japan.
  assert.equal(scoreGuess(byId('t3-iwo-jima'), [139.6917, 35.6895], countries).countryFloor, 500);
});

test('country outlines are never drawn', () => {
  // Nothing in the map code may load or import them...
  const mapDir = resolve(ROOT, 'src/map');
  for (const file of readdirSync(mapDir)) {
    const text = readFileSync(resolve(mapDir, file), 'utf8');
    assert.ok(!/countr/i.test(text), `src/map/${file} mentions countries`);
  }
  // ...and a lookup hands back a code and a size, never a shape.
  assert.deepEqual(Object.keys(countries.countryAt([2.3522, 48.8566])!).sort(), ['code', 'radiusKm']);
});
