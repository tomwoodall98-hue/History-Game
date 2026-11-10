/**
 * Validates src/data/questions.json.
 *
 *   npm run validate
 *   npm run validate -- path/to/other.json   (check another file)
 *
 * Checks:
 *   - schema and types of every field, ids are kebab-case and unique
 *   - no duplicate events (ignoring case/punctuation) or near-identical spots
 *   - lat/lng in range
 *   - each point is on land, or within 50 km of a coast, using the same
 *     Natural Earth data the game draws (detail tiles where available),
 *     unless the question is marked `atSea`; an `atSea` point shouldn't be
 *     on land
 *   - flags land events that fall in no country of the scoring outlines
 *     (they would get no same-country floor); `country` names one for islands
 *     too small for the outlines
 *   - years up to 2000, and the year appears in dateDisplay
 *   - notes are one or two sentences
 *   - an even spread of questions across the seven tiers (at least 40 each)
 *   - the puzzle schedule (src/data/schedule.json): every scheduled id still
 *     exists in the right tier, and the schedule runs well past today
 *     (`npm run schedule:extend` adds days)
 *
 * Exits with code 1 if anything fails; warnings don't fail the run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { FeatureCollection, MultiLineString, MultiPolygon } from 'geojson';
import { CELL_COLS, CELL_ROWS, cellId, cellOf, type GlobeBase } from '../src/map/globeData.ts';
import { EARTH_RADIUS_KM, haversineKm, scoringParams } from '../src/game/scoring.ts';
import { CountryIndex } from '../src/game/countries.ts';
import { addDays, daysBetween, londonDateKey, LAUNCH_DATE } from '../src/game/daily.ts';
import { scheduleEnd, type Schedule } from '../src/game/schedule.ts';
import { TIERS, type Question } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUESTIONS = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'src/data/questions.json');
const GLOBE = resolve(ROOT, 'src/data/globe.topo.json');
const COUNTRIES = resolve(ROOT, 'src/data/countries.topo.json');
const SCHEDULE = resolve(ROOT, 'src/data/schedule.json');
/** Warn when the schedule runs out within this many days; fail within SCHEDULE_FAIL_DAYS. */
const SCHEDULE_WARN_DAYS = 90;
const SCHEDULE_FAIL_DAYS = 14;
const TILE_DIR = resolve(ROOT, 'public/geo/globe');

const MIN_PER_TIER = 40;
const COAST_KM = 50;
const INLAND_KM = 5;
const MAX_YEAR = 2000;
const NEAR_DUPLICATE_KM = 1;

const errors: string[] = [];
const warnings: string[] = [];
const err = (id: string, msg: string) => errors.push(`${id}: ${msg}`);
const warn = (id: string, msg: string) => warnings.push(`${id}: ${msg}`);

// ---------------------------------------------------------------- data ---

let questions: Question[];
try {
  questions = JSON.parse(readFileSync(QUESTIONS, 'utf8'));
} catch (e) {
  console.error(`Cannot read ${QUESTIONS}: ${(e as Error).message}`);
  process.exit(1);
}
if (!Array.isArray(questions)) {
  console.error('questions.json must contain an array');
  process.exit(1);
}

// ------------------------------------------------------------- geodata ---

/** Land rings and coastlines near a point, in plain lng/lat. */
interface CellGeo {
  land: number[][][];
  coast: number[][][];
}

const base = JSON.parse(readFileSync(GLOBE, 'utf8')) as GlobeBase;
const baseGeo = decode(base, 'land', 'coast');
const cellCache = new Map<string, CellGeo>();

function decode(topo: Topology, land: string, coast: string): CellGeo {
  const geo = (name: string) => feature(topo as never, topo.objects[name] as never) as unknown as FeatureCollection;
  const out: CellGeo = { land: [], coast: [] };
  for (const f of geo(land).features) for (const poly of (f.geometry as MultiPolygon).coordinates) out.land.push(...poly);
  for (const f of geo(coast).features) out.coast.push(...(f.geometry as MultiLineString).coordinates);
  return out;
}

/** The detail tile for a cell (finer, with small islands), else the base level. */
function cell(col: number, row: number): CellGeo {
  const id = cellId(col, row);
  if (!cellCache.has(id)) {
    const path = resolve(TILE_DIR, `${id}.json`);
    cellCache.set(id, existsSync(path) ? decode(JSON.parse(readFileSync(path, 'utf8')), 'land', 'coast') : baseGeo);
  }
  return cellCache.get(id)!;
}

function insideRings(x: number, y: number, rings: number[][][]): boolean {
  let inside = false; // even-odd, as the globe fills land
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const KM_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_KM;

/** On land? And the distance in km to the nearest mapped coast (only nearby cells are searched). */
function landCheck(lng: number, lat: number): { onLand: boolean; coastKm: number } {
  const { col, row } = cellOf(lng, lat);
  const home = cell(col, row);
  const onLand = insideRings(lng, lat, home.land);
  // Distances in a local plane in km around the point: fine at coastal range.
  const kx = KM_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const wrap = (x: number) => ((((x - lng) % 360) + 540) % 360) - 180; // nearest copy across the antimeridian
  let best = Infinity;
  const seen = new Set<CellGeo>();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr;
      if (r < 0 || r >= CELL_ROWS) continue;
      const g = cell((col + dc + CELL_COLS) % CELL_COLS, r);
      if (seen.has(g)) continue;
      seen.add(g);
      for (const line of g.coast) {
        for (let i = 1; i < line.length; i++) {
          const [ax, ay] = line[i - 1];
          const [bx, by] = line[i];
          const d = segDist(0, 0, wrap(ax) * kx, (ay - lat) * KM_PER_DEG, wrap(bx) * kx, (by - lat) * KM_PER_DEG);
          if (d < best) best = d;
        }
      }
    }
  }
  return { onLand, coastKm: best };
}

// -------------------------------------------------------------- checks ---

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const normEvent = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Sentence count, not fooled by "c." / "St" / initials such as "John F. Kennedy". */
function sentences(text: string): number {
  const cleaned = text
    .replace(/\b(c|ca|St|Dr|Mt|Jr|Sr|Mr|Mrs|No|vs|i\.e|e\.g)\./g, '$1')
    .replace(/\b[A-Z]\./g, 'X');
  return (cleaned.match(/[.!?]['"’”)]*(?=\s+[A-Z'"‘“(]|\s*$)/g) ?? []).length;
}

const KEYS = ['id', 'event', 'dateDisplay', 'year', 'tier', 'lat', 'lng', 'k', 'bullseyeKm', 'atSea', 'country', 'note', 'source'];
const seenIds = new Map<string, number>();
const seenEvents = new Map<string, string>();

questions.forEach((q, index) => {
  const id = isStr(q?.id) ? q.id : `#${index}`;
  if (typeof q !== 'object' || q === null) {
    err(id, 'not an object');
    return;
  }
  for (const key of Object.keys(q)) if (!KEYS.includes(key)) warn(id, `unknown field "${key}"`);

  if (!isStr(q.id) || !ID_RE.test(q.id)) err(id, 'id must be kebab-case (a-z, 0-9, hyphens)');
  if (seenIds.has(q.id)) err(id, `duplicate id (also question #${seenIds.get(q.id)})`);
  seenIds.set(q.id, index);

  if (!isStr(q.event)) err(id, 'event is required');
  else {
    if (q.event.length > 80) warn(id, `event is long (${q.event.length} chars) and may wrap awkwardly`);
    const key = normEvent(q.event);
    if (seenEvents.has(key)) err(id, `duplicate event (same as ${seenEvents.get(key)})`);
    seenEvents.set(key, id);
  }

  if (!TIERS.includes(q.tier)) err(id, `tier must be an integer 1–7 (got ${JSON.stringify(q.tier)})`);

  if (!isNum(q.lat) || q.lat < -90 || q.lat > 90) err(id, `lat out of range: ${q.lat}`);
  if (!isNum(q.lng) || q.lng < -180 || q.lng > 180) err(id, `lng out of range: ${q.lng}`);

  if (!Number.isInteger(q.year)) err(id, 'year must be an integer (negative for BC)');
  else {
    if (q.year > MAX_YEAR) err(id, `year ${q.year} is after ${MAX_YEAR}`);
    if (q.year === 0) err(id, 'there is no year 0; use 1 BC (-1) or AD 1');
    if (isStr(q.dateDisplay)) {
      const y = String(Math.abs(q.year));
      if (!new RegExp(`(^|\\D)${y}(\\D|$)`).test(q.dateDisplay)) warn(id, `dateDisplay "${q.dateDisplay}" doesn't mention ${y}`);
      const bc = /\bBC\b/.test(q.dateDisplay);
      if (q.year < 0 && !bc) err(id, 'negative year but dateDisplay has no "BC"');
      if (q.year > 0 && bc && !/AD/.test(q.dateDisplay)) err(id, 'dateDisplay says BC but year is positive');
    }
  }
  if (!isStr(q.dateDisplay)) err(id, 'dateDisplay is required');

  for (const key of ['k', 'bullseyeKm'] as const) {
    const v = q[key];
    if (v != null && (!isNum(v) || v <= 0)) err(id, `${key} must be a positive number or null`);
  }
  if (q.atSea !== undefined && typeof q.atSea !== 'boolean') err(id, 'atSea must be true or false (or left out)');
  if (TIERS.includes(q.tier)) {
    const { k, bullseyeKm } = scoringParams(q);
    if (bullseyeKm >= k) err(id, `bullseyeKm (${bullseyeKm}) should be well below k (${k})`);
  }

  if (!isStr(q.note)) err(id, 'note is required');
  else {
    const n = sentences(q.note);
    if (n > 2) err(id, `note has ${n} sentences; keep it to one or two`);
    if (q.note.length > 320) warn(id, `note is long (${q.note.length} chars)`);
  }

  if (!isStr(q.source) || !/^https:\/\/\S+$/.test(q.source)) err(id, 'source must be an https URL');
  else if (!/wikipedia\.org\/wiki\//.test(q.source)) warn(id, 'source is not a Wikipedia article; fine, but check it gives coordinates');
});

// Near-identical locations usually mean a copy-paste slip.
for (let i = 0; i < questions.length; i++) {
  for (let j = i + 1; j < questions.length; j++) {
    const a = questions[i];
    const b = questions[j];
    if (!isNum(a.lat) || !isNum(b.lat) || !isNum(a.lng) || !isNum(b.lng)) continue;
    const d = haversineKm([a.lng, a.lat], [b.lng, b.lat]);
    if (d < NEAR_DUPLICATE_KM) warn(a.id, `within ${d.toFixed(2)} km of ${b.id}; intended?`);
  }
}

// Land / coast, and the country each land event scores against.
const countries = new CountryIndex(JSON.parse(readFileSync(COUNTRIES, 'utf8')));
let atSea = 0;
let farOut = 0;
const overridden: string[] = [];
for (const q of questions) {
  if (!isNum(q.lat) || !isNum(q.lng) || Math.abs(q.lat) > 90 || Math.abs(q.lng) > 180) continue;
  const { onLand, coastKm } = landCheck(q.lng, q.lat);
  if (q.atSea === true) {
    atSea++;
    // A naval battle can be marked on the island it is named after, but not inland.
    if (onLand && coastKm > INLAND_KM) warn(q.id, `marked atSea but ${Math.round(coastKm)} km inland; check the coordinates or drop atSea`);
    if (!onLand && coastKm > COAST_KM) farOut++;
    if (q.country != null) warn(q.id, 'country is ignored for events at sea');
  } else {
    if (!onLand && coastKm > COAST_KM) {
      err(q.id, `${Number.isFinite(coastKm) ? `${Math.round(coastKm)} km` : 'far'} from the nearest coast; check the coordinates, or set "atSea": true if it really happened at sea`);
    }
    const found = countries.countryAt([q.lng, q.lat]);
    if (q.country != null) {
      if (typeof q.country !== 'string' || !countries.byCode(q.country)) err(q.id, `country ${JSON.stringify(q.country)} is not an ADM0_A3 code in the outlines`);
      else if (found && found.code !== q.country) warn(q.id, `country is ${q.country} but the point is in ${found.code}`);
      else if (found) warn(q.id, `country ${q.country} isn't needed; the outlines find it`);
      else overridden.push(`${q.id} (${q.country})`);
    } else if (!found) {
      warn(q.id, 'no country in the scoring outlines here, so no same-country floor; set "country" to its ADM0_A3 code if it has one');
    }
  }
}

// The schedule: past puzzles are frozen, so every id in it must stay in the bank.
const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8')) as Schedule;
const byId = new Map(questions.map((q) => [q.id, q]));
if (schedule.start !== LAUNCH_DATE) err('schedule', `starts on ${schedule.start}, not launch day ${LAUNCH_DATE}`);
schedule.days.forEach((day, i) => {
  const date = addDays(schedule.start, i);
  if (!Array.isArray(day) || day.length !== TIERS.length) {
    err('schedule', `${date} should list ${TIERS.length} question ids`);
    return;
  }
  day.forEach((id, t) => {
    const q = byId.get(id);
    if (!q) err('schedule', `${date} plays ${id}, which is no longer in the bank; ids are never removed once scheduled`);
    else if (q.tier !== TIERS[t]) err('schedule', `${date} plays ${id} as Q${t + 1}, but it is now tier ${q.tier}; scheduled questions keep their tier`);
  });
});
const daysLeft = daysBetween(londonDateKey(), scheduleEnd(schedule));
if (daysLeft < SCHEDULE_FAIL_DAYS) err('schedule', `runs out on ${scheduleEnd(schedule)}; run npm run schedule:extend and commit the result`);
else if (daysLeft < SCHEDULE_WARN_DAYS) warn('schedule', `runs out on ${scheduleEnd(schedule)}, in ${daysLeft} days; run npm run schedule:extend soon`);

// Tier spread.
const perTier = new Map<number, number>(TIERS.map((t) => [t, 0]));
for (const q of questions) if (TIERS.includes(q.tier)) perTier.set(q.tier, perTier.get(q.tier)! + 1);
const counts = [...perTier.values()];
for (const [t, n] of perTier) if (n < MIN_PER_TIER) err(`tier ${t}`, `has ${n} questions; at least ${MIN_PER_TIER} needed`);
if (Math.max(...counts) > Math.ceil(Math.min(...counts) * 1.25)) {
  err('tiers', `uneven spread (${counts.join(' / ')}); keep tiers within 25% of each other`);
}

// --------------------------------------------------------------- report ---

const era = (y: number) => (y < 500 ? 'ancient' : y < 1500 ? 'medieval' : y < 1800 ? 'early modern' : y < 1900 ? '1800s' : '1900s');
const region = (q: Question) => {
  const { lat, lng } = q;
  if (lat < -60) return 'Antarctic';
  if (lng < -25) return lat > 13 ? 'N. America' : 'C./S. America';
  if (lng > 110 && lat < -10) return 'Oceania';
  if (lng > 130 || (lng > 110 && lat < 0)) return 'Pacific';
  if (lat > 35 && lng < 45) return 'Europe';
  if (lat < 33 && lng < 52 && !(lat > 12 && lng > 34)) return 'Africa';
  return 'Asia';
};
const table = (label: string, keyOf: (q: Question) => string) => {
  const cols = [...new Set(questions.map(keyOf))].sort();
  console.log(`\n${label.padEnd(14)}${TIERS.map((t) => `T${t}`.padStart(5)).join('')}  total`);
  for (const col of cols) {
    const row = TIERS.map((t) => questions.filter((q) => q.tier === t && keyOf(q) === col).length);
    console.log(`${col.padEnd(14)}${row.map((n) => String(n).padStart(5)).join('')}  ${String(row.reduce((a, b) => a + b, 0)).padStart(5)}`);
  }
};

console.log(`Chronomap question bank: ${questions.length} questions`);
table('Region', region);
table('Era', (q) => era(q.year));
console.log(`\nAt sea: ${atSea} (${farOut} more than ${COAST_KM} km from a coast); no same-country floor`);
console.log(`Schedule: ${schedule.days.length} days, ${schedule.start} to ${scheduleEnd(schedule)}`);
if (overridden.length) console.log(`Country given by hand (island too small for the outlines): ${overridden.join(', ')}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\n✓ All checks passed.');
