/**
 * Scoring simulator: what would different players score on the real bank?
 *
 *   npm run simulate:scoring                      per-question and per-game tables
 *   npm run simulate:scoring -- --summary         per-game tables only
 *   npm run simulate:scoring -- --samples 2000    more Monte Carlo samples (default 800)
 *   npm run simulate:scoring -- --model patchy    the other player model (see `ModelName`)
 *   npm run simulate:scoring -- --report out.md   also write every table as Markdown
 *
 * Players are modelled as guess-distance distributions per tier. Each guess
 * is one of five kinds, with chances that shift with tier (see `BASE`):
 *
 *   pinpoint  knows the place; a small log-normal miss
 *   area      knows the area ("northern France"), not the spot
 *   country   knows only the country; a random spot on its landmass
 *   region    knows the part of the world; a miss of a thousand km or more
 *   lost      no idea; a random point on land
 *
 * Each simulated guess is a real point on the globe. For events on land the
 * player re-aims until the mark is on land, as a real player would, so
 * country rules see real borders and coastlines.
 *
 * The only thing we know about real players is that the best one averages
 * ~4,500 under the current formula, so the "good" player is fitted to that.
 * There are two ways to fit it (`ModelName`): stretch every miss distance
 * ("spread", the default) or keep misses short and lower how many events
 * they know ("patchy"). "Average" and "poor" share the fit but know fewer
 * places and miss by more. "Wild" clicks a random point on land every time
 * and should score near zero under any sane formula. The run prints the
 * resulting miss distances per tier, so the model can be judged directly.
 *
 * Guesses are drawn once and every formula scores the same guesses, so the
 * comparison is like-for-like. Country polygons (Natural Earth admin-0) are
 * read from .cache/ and used only for scoring, never drawn.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { geoArea } from 'd3-geo';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { haversineKm, scoringParams, scoreForDistance, EARTH_RADIUS_KM, TIER_DEFAULTS } from '../src/game/scoring.ts';
import { TIERS, type LngLat, type Question } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COUNTRIES_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson';
const COUNTRIES_PATH = resolve(ROOT, '.cache/natural-earth/ne_50m_admin_0_countries.geojson');

// ------------------------------------------------------------------ RNG ---

/** mulberry32, so runs are repeatable. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// -------------------------------------------------------------- geodesy ---

const RAD = Math.PI / 180;

/** Point at `km` from `from` on initial bearing `deg` (great circle). */
export function destination([lng, lat]: LngLat, km: number, deg: number): LngLat {
  const δ = km / EARTH_RADIUS_KM;
  const θ = deg * RAD;
  const φ1 = lat * RAD;
  const λ1 = lng * RAD;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [((((λ2 / RAD + 540) % 360) + 360) % 360) - 180, φ2 / RAD];
}

// ------------------------------------------------------------ countries ---

interface Part {
  country: string;
  index: number;
  rings: Float64Array[];
  bbox: [number, number, number, number];
}
export interface CountryHit {
  /** ADM0_A3 code. */
  country: string;
  /** Which polygon of the country (its landmass). */
  part: number;
  /** Equivalent radius √(area/π) of the whole country, km. */
  radiusKm: number;
}

/** Natural Earth admin-0 polygons, indexed for point lookups. */
export class CountryIndex {
  private grid = new Map<number, Part[]>();
  private byKey = new Map<string, Part>();
  private radius = new Map<string, number>();

  constructor(fc: FeatureCollection) {
    for (const f of fc.features as Feature<Polygon | MultiPolygon>[]) {
      const code = String(f.properties?.ADM0_A3 ?? f.properties?.ISO_A3 ?? '');
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      let area = 0;
      polys.forEach((poly, index) => {
        let a = geoArea({ type: 'Polygon', coordinates: poly });
        if (a > 2 * Math.PI) a = 4 * Math.PI - a; // ring wound the other way
        area += a;
        let x0 = 180;
        let y0 = 90;
        let x1 = -180;
        let y1 = -90;
        for (const [x, y] of poly[0]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
        const part: Part = { country: code, index, rings: poly.map((ring) => Float64Array.from(ring.flat())), bbox: [x0, y0, x1, y1] };
        this.byKey.set(`${code}/${index}`, part);
        for (let gy = Math.floor(y0); gy <= Math.floor(y1); gy++) {
          for (let gx = Math.floor(x0); gx <= Math.floor(x1); gx++) {
            const key = (gy + 90) * 400 + (gx + 180);
            (this.grid.get(key) ?? this.grid.set(key, []).get(key)!).push(part);
          }
        }
      });
      this.radius.set(code, Math.sqrt((area * EARTH_RADIUS_KM ** 2) / Math.PI));
    }
  }

  private inside(part: Part, x: number, y: number): boolean {
    const [x0, y0, x1, y1] = part.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    let inside = false;
    for (const r of part.rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i];
        const yi = r[i + 1];
        const xj = r[j];
        const yj = r[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  /** Equivalent radius √(area/π) of a country, km. */
  radiusOf(code: string): number | undefined {
    return this.radius.get(code);
  }

  /** A uniformly random point on the given landmass. */
  randomPointIn(hit: CountryHit, rand: () => number): LngLat {
    const part = this.byKey.get(`${hit.country}/${hit.part}`)!;
    const [x0, y0, x1, y1] = part.bbox;
    for (let i = 0; i < 5000; i++) {
      const lat = Math.asin(Math.sin(y0 * RAD) + rand() * (Math.sin(y1 * RAD) - Math.sin(y0 * RAD))) / RAD;
      const lng = x0 + rand() * (x1 - x0);
      if (this.inside(part, lng, lat)) return [lng, lat];
    }
    return [x0 + (x1 - x0) / 2, y0 + (y1 - y0) / 2];
  }

  private exact(lng: number, lat: number): Part | null {
    const key = (Math.floor(lat) + 90) * 400 + (Math.floor(lng) + 180);
    for (const part of this.grid.get(key) ?? []) if (this.inside(part, lng, lat)) return part;
    return null;
  }

  /**
   * Country and landmass under a point, with ~`tolKm` of slack so a mark
   * on a beach isn't "at sea" just because coastlines are generalised.
   */
  lookup([lng, lat]: LngLat, tolKm = 10): CountryHit | null {
    let part = this.exact(lng, lat);
    if (!part && tolKm > 0) {
      const dLat = tolKm / 111.2;
      const dLng = dLat / Math.max(0.2, Math.cos(lat * RAD));
      const probes: [number, number][] = [
        [lng + dLng, lat],
        [lng - dLng, lat],
        [lng, lat + dLat],
        [lng, lat - dLat],
        [lng + dLng * 0.7, lat + dLat * 0.7],
        [lng - dLng * 0.7, lat - dLat * 0.7],
        [lng + dLng * 0.7, lat - dLat * 0.7],
        [lng - dLng * 0.7, lat + dLat * 0.7],
      ];
      for (const [x, y] of probes) if ((part = this.exact(x, y))) break;
    }
    return part ? { country: part.country, part: part.index, radiusKm: this.radius.get(part.country)! } : null;
  }
}

export async function loadCountries(): Promise<CountryIndex> {
  try {
    await access(COUNTRIES_PATH);
  } catch {
    console.log(`Downloading ${COUNTRIES_URL} …`);
    const res = await fetch(COUNTRIES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await mkdir(dirname(COUNTRIES_PATH), { recursive: true });
    await writeFile(COUNTRIES_PATH, Buffer.from(await res.arrayBuffer()));
  }
  return new CountryIndex(JSON.parse(await readFile(COUNTRIES_PATH, 'utf8')));
}

// -------------------------------------------------------------- players ---

/** A player: the chance per tier (T1…T7) of each kind of answer, and how far each kind misses. */
export interface Profile {
  name: string;
  pin: number[];
  area: number[];
  country: number[];
  region: number[];
  /** Median miss of a pinpoint answer per tier, km. */
  pinKm: number[];
  /** Median miss of an "area" answer, km. */
  areaKm: number;
  /** Median miss of a "region" answer, km. */
  regionKm: number;
}

const BASE: Omit<Profile, 'name'>[] = [
  {
    // good: knows most famous places exactly and the area of most others
    pin: [0.85, 0.72, 0.58, 0.46, 0.36, 0.28, 0.22],
    area: [0.12, 0.21, 0.29, 0.35, 0.39, 0.41, 0.42],
    country: [0.02, 0.04, 0.07, 0.09, 0.11, 0.13, 0.14],
    region: [0.01, 0.03, 0.05, 0.07, 0.09, 0.11, 0.13],
    pinKm: [10, 12, 14, 16, 18, 20, 22],
    areaKm: 100,
    regionKm: 600,
  },
  {
    // average: knows the famous ones; past tier 3 often only the country or region
    pin: [0.6, 0.42, 0.28, 0.18, 0.11, 0.07, 0.05],
    area: [0.22, 0.28, 0.3, 0.29, 0.27, 0.24, 0.21],
    country: [0.1, 0.14, 0.17, 0.19, 0.2, 0.2, 0.19],
    region: [0.06, 0.12, 0.17, 0.21, 0.24, 0.26, 0.28],
    pinKm: [15, 18, 21, 24, 27, 30, 33],
    areaKm: 130,
    regionKm: 800,
  },
  {
    // poor: some famous places; mostly guessing from tier 3 on
    pin: [0.35, 0.2, 0.1, 0.05, 0.03, 0.02, 0.01],
    area: [0.25, 0.24, 0.21, 0.17, 0.13, 0.1, 0.08],
    country: [0.16, 0.18, 0.19, 0.19, 0.17, 0.15, 0.13],
    region: [0.17, 0.24, 0.29, 0.31, 0.32, 0.32, 0.31],
    pinKm: [20, 24, 28, 32, 36, 40, 44],
    areaKm: 160,
    regionKm: 1000,
  },
];

/**
 * `scale` stretches every miss distance. `know` (≤ 1) scales the chance of a
 * pinpoint or area answer; what it takes away goes to country, region and lost
 * answers in the ratio 3:4:3.
 */
export function profiles(scale: number, know = 1): Profile[] {
  return BASE.map((b, i) => {
    const moved = b.pin.map((x, t) => (x + b.area[t]) * (1 - know));
    return {
      ...b,
      name: ['good', 'average', 'poor'][i],
      pin: b.pin.map((x) => x * know),
      area: b.area.map((x) => x * know),
      country: b.country.map((x, t) => x + 0.3 * moved[t]),
      region: b.region.map((x, t) => x + 0.4 * moved[t]),
      pinKm: b.pinKm.map((x) => x * scale),
      areaKm: b.areaKm * scale,
      regionKm: b.regionKm * scale,
    };
  });
}

/**
 * Two ways to be a 4,500 player today:
 *  - spread: knows roughly where most events were, but often misses by a few
 *    hundred km (`know` = 1; miss distances fitted)
 *  - patchy: close when they know, but knows fewer events (miss distances
 *    ×1.5; `know` fitted)
 */
export type ModelName = 'spread' | 'patchy';

const lostShare = (p: Profile, t: number) => Math.max(0, 1 - p.pin[t] - p.area[t] - p.country[t] - p.region[t]);

// -------------------------------------------------------------- samples ---

/** One player's simulated guesses at one question. */
export interface GuessSet {
  /** Great-circle miss, km. */
  km: Float32Array;
  /** 1 if the mark is in the same modern country as the answer. */
  sameCountry: Uint8Array;
}

/** What a formula may know about a question. */
export interface QuestionInfo {
  q: Question;
  /** Country the answer is in (null: at sea, or an island too small for the data). */
  answer: CountryHit | null;
}

/** A scoring rule under test. */
export interface Formula {
  name: string;
  /** Points for a mark `km` from the answer; `sameCountry` if it lies in the answer's country. */
  score: (info: QuestionInfo, km: number, sameCountry: boolean) => number;
  /** Share square: 0 🟩, 1 🟨, 2 🟧, 3 🟥. */
  colour: (score: number) => 0 | 1 | 2 | 3;
}

function randomLand(countries: CountryIndex, rand: () => number): LngLat {
  for (;;) {
    const lat = Math.asin(rand() * (Math.sin(80 * RAD) + Math.sin(75 * RAD)) - Math.sin(75 * RAD)) / RAD;
    const g: LngLat = [rand() * 360 - 180, lat];
    if (countries.lookup(g, 0)) return g;
  }
}

function drawGuesses(info: QuestionInfo, who: Profile | 'wild', countries: CountryIndex, n: number, rand: () => number): GuessSet {
  const { q, answer } = info;
  const ans: LngLat = [q.lng, q.lat];
  // Players aim for land unless the event happened at sea (or on a speck of an island).
  const onLand = answer != null && !PROPOSAL_OVERRIDES[q.id]?.atSea;
  const km = new Float32Array(n);
  const sameCountry = new Uint8Array(n);
  const near = (median: number, sigma: number) => {
    const shot = () => destination(ans, median * Math.exp(sigma * normal(rand)), rand() * 360);
    let g = shot();
    // Someone who thinks an event happened on land clicks on land.
    for (let i = 0; onLand && i < 12 && !countries.lookup(g, 0); i++) g = shot();
    return g;
  };
  for (let i = 0; i < n; i++) {
    let g: LngLat;
    if (who === 'wild') g = randomLand(countries, rand);
    else {
      const t = q.tier - 1;
      const r = rand();
      let c = who.pin[t];
      if (r < c) g = near(who.pinKm[t], 0.7);
      else if (r < (c += who.area[t])) g = near(who.areaKm, 0.6);
      else if (r < (c += who.country[t])) {
        // Knows the country, nothing more. At sea: knows the sea, roughly.
        g = onLand ? countries.randomPointIn(answer!, rand) : near(who.areaKm * 2.5, 0.6);
      } else if (r < (c += who.region[t])) g = near(who.regionKm, 0.6);
      else g = randomLand(countries, rand);
    }
    km[i] = haversineKm(ans, g);
    const hit = answer ? countries.lookup(g, 10) : null;
    sameCountry[i] = hit && answer && hit.country === answer.country ? 1 : 0;
  }
  return { km, sameCountry };
}

// ------------------------------------------------------------- formulas ---

const colourAt =
  (green: number, yellow: number, orange: number) =>
  (s: number): 0 | 1 | 2 | 3 =>
    s >= green ? 0 : s >= yellow ? 1 : s >= orange ? 2 : 3;

/** The formula the game uses today. */
export const CURRENT: Formula = {
  name: 'current',
  score: ({ q }, km) => {
    const { k, bullseyeKm } = scoringParams(q);
    return scoreForDistance(km, k, bullseyeKm);
  },
  colour: colourAt(800, 500, 200),
};

/**
 * The proposal:
 *
 *   d′ = max(0, d − bullseyeKm)
 *   score = 1000 · e^(−(d′/k)²)
 *
 * The squared exponent keeps near misses close to 1,000 and still sends wild
 * guesses to zero. k now grows with tier instead of shrinking: everyone who
 * knows a famous event puts it within a few km, so a 1,000 km miss on tier 1
 * is a real mistake, while even experts can only place a deep cut within a
 * few hundred km. Later tiers stay harder because they are obscure.
 *
 * For events on land, a mark in the answer's modern country (and within
 * `floor.maxDistanceKm` of it, which leaves out overseas territories) scores
 * at least the country floor, which shrinks for the very largest countries.
 * Events at sea get no country floor and a longer k.
 */
export interface ProposalParams {
  /** Decay distance per tier, km beyond the bullseye where the score falls to ~368. */
  k: number[];
  /** Exponent on d′/k: 1 is today's shape, 2 is bell-shaped. */
  power: number;
  /** k multiplier for events at sea that have no k of their own. */
  seaK: number;
  floor: {
    /** Floor for countries up to `fullUpToKm` equivalent radius. */
    max: number;
    /** Floor for countries from `minFromKm` equivalent radius up. */
    min: number;
    fullUpToKm: number;
    minFromKm: number;
    /** No floor beyond this distance, even in the same country. */
    maxDistanceKm: number;
  };
  /** Share squares: 🟩 at or above [0], 🟨 [1], 🟧 [2], else 🟥. */
  colours: [number, number, number];
}

export const PROPOSAL: ProposalParams = {
  k: [1000, 1125, 1250, 1375, 1500, 1625, 1750],
  power: 2,
  seaK: 1.25,
  floor: { max: 500, min: 250, fullUpToKm: 500, minFromKm: 1500, maxDistanceKm: 2500 },
  colours: [900, 600, 300],
};

/**
 * Per-question changes in the proposal. `atSea` events skip the country
 * floor and use a longer k; spread-out or disputed events get a wider
 * bullseye (`bullseyeKm`) and, where the area is large, a longer k (`kx`, a
 * multiple of the tier's k). Anything not listed keeps its current bullseye.
 */
export const PROPOSAL_OVERRIDES: Record<string, { atSea?: boolean; k?: number; kx?: number; bullseyeKm?: number; why: string }> = {
  // Open ocean, hundreds of km from any landmark: 1.5 × the tier's k.
  't1-titanic': { atSea: true, kx: 1.5, why: 'open Atlantic, 600 km off Newfoundland' },
  't3-midway': { atSea: true, kx: 1.5, why: 'carrier battle hundreds of km from the atoll' },
  't5-bounty-mutiny': { atSea: true, kx: 1.5, why: 'open Pacific near Tofua' },
  't7-endurance': { atSea: true, kx: 1.5, bullseyeKm: 100, why: 'Weddell Sea; the ship drifted in the ice for ten months' },
  // Naval battles and wrecks off a coast: the tier's k × seaK.
  't3-trafalgar': { atSea: true, why: 'off Cape Trafalgar' },
  't3-lusitania': { atSea: true, why: 'off the Old Head of Kinsale' },
  't4-actium': { atSea: true, why: 'off the Ambracian Gulf' },
  't4-salamis': { atSea: true, why: 'strait off Salamis' },
  't4-lepanto': { atSea: true, why: 'off the Gulf of Patras' },
  't5-tsushima': { atSea: true, bullseyeKm: 50, why: 'two-day running battle across the strait' },
  't6-hansan': { atSea: true, why: 'off Hansan Island' },
  't6-takashima': { atSea: true, why: 'Imari Bay' },
  't6-nile-aboukir': { atSea: true, why: 'Aboukir Bay' },
  't7-dan-no-ura': { atSea: true, why: 'Kanmon Strait' },
  't7-antikythera': { atSea: true, why: 'wreck off the island' },
  // Spread out or disputed on land: a bullseye of about half the area's extent.
  't2-somme': { bullseyeKm: 25, why: 'a front about 30 km long' },
  't2-hijra': { bullseyeKm: 50, why: 'a migration; the answer is its end, Medina' },
  't3-columbus-landfall': { bullseyeKm: 60, why: 'landfall island disputed (San Salvador, Samana Cay)' },
  't3-bay-of-pigs': { bullseyeKm: 25, why: 'landings ~35 km apart' },
  't3-verdun': { bullseyeKm: 20, why: 'a ring of forts ~30 km across' },
  't3-el-alamein': { bullseyeKm: 40, why: 'a 60 km front' },
  't4-tours': { bullseyeKm: 40, why: 'site disputed between Tours and Poitiers' },
  't4-nazca': { bullseyeKm: 30, why: 'lines spread over ~50 km' },
  't5-gaugamela': { bullseyeKm: 30, why: 'site probable, not certain' },
  't5-teutoburg': { bullseyeKm: 20, why: 'a running ambush over several days' },
  't5-tunguska': { bullseyeKm: 30, why: '2,150 km² of forest flattened' },
  't5-zama': { bullseyeKm: 40, why: 'battlefield never located' },
  't6-mukden': { bullseyeKm: 60, why: 'a front ~150 km long' },
  't6-imphal': { bullseyeKm: 30, why: 'fighting all round the Imphal plain' },
  't7-khalkhin-gol': { bullseyeKm: 50, why: 'fighting along ~70 km of the river' },
  't7-changping': { bullseyeKm: 30, why: 'a long stand-off across a wide valley' },
  // Campaigns, conquests and expeditions: wider bullseye and k × 1.25.
  't4-guadalcanal': { bullseyeKm: 40, kx: 1.25, why: 'a six-month campaign across the island' },
  't5-long-march-end': { bullseyeKm: 40, kx: 1.25, why: 'end of a 10,000 km march, in the Shaanxi base area' },
  't6-kalinga': { bullseyeKm: 60, kx: 1.25, why: 'conquest of a whole coastal region' },
  't6-burke-wills': { bullseyeKm: 50, kx: 1.25, why: 'vague end point of a continental crossing' },
};

/** The floor, in points, for a country of equivalent radius `radiusKm`. */
export function countryFloor(p: ProposalParams, radiusKm: number): number {
  const { max, min, fullUpToKm, minFromKm } = p.floor;
  const t = Math.min(1, Math.max(0, Math.log(radiusKm / fullUpToKm) / Math.log(minFromKm / fullUpToKm)));
  return Math.round((max - (max - min) * t) / 10) * 10;
}

/** k and bullseye the proposal uses for a question. */
export function proposalParams(p: ProposalParams, q: Question): { k: number; bullseyeKm: number; atSea: boolean } {
  const o = PROPOSAL_OVERRIDES[q.id];
  const atSea = o?.atSea ?? false;
  const tierK = p.k[q.tier - 1];
  const k = o?.k ?? tierK * (o?.kx ?? (atSea ? p.seaK : 1));
  return { k, bullseyeKm: o?.bullseyeKm ?? q.bullseyeKm ?? TIER_DEFAULTS[q.tier].bullseyeKm, atSea };
}

export function makeProposal(p: ProposalParams, name = 'proposed'): Formula {
  return {
    name,
    score: (info, km, sameCountry) => {
      const { k, bullseyeKm, atSea } = proposalParams(p, info.q);
      let s = 1000 * Math.exp(-((Math.max(0, km - bullseyeKm) / k) ** p.power));
      if (!atSea && sameCountry && info.answer && km <= p.floor.maxDistanceKm) s = Math.max(s, countryFloor(p, info.answer.radiusKm));
      return Math.round(s);
    },
    colour: colourAt(...p.colours),
  };
}

export const PROPOSED = makeProposal(PROPOSAL);

// ------------------------------------------------------------ simulation ---

export interface Simulation {
  infos: QuestionInfo[];
  who: string[];
  /** guesses[questionIndex][player] */
  guesses: Record<string, GuessSet>[];
  scale: number;
  know: number;
  model: ModelName;
  players: Profile[];
  countries: CountryIndex;
}

export async function simulate(samples = 800, seed = 1, model: ModelName = 'spread'): Promise<Simulation> {
  const questions = JSON.parse(await readFile(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
  const countries = await loadCountries();
  const infos: QuestionInfo[] = questions.map((q) => ({ q, answer: countries.lookup([q.lng, q.lat], 10) }));

  // Fit the model so the good player averages ~4,500 under today's formula.
  const calib = infos.filter((_, i) => i % 3 === 0);
  const goodToday = (good: Profile) => {
    const rand = rng(7);
    return TIERS.reduce((sum, t) => {
      const qs = calib.filter((x) => x.q.tier === t);
      return sum + qs.reduce((s, x) => s + meanScore(CURRENT, x, drawGuesses(x, good, countries, 150, rand)), 0) / qs.length;
    }, 0);
  };
  let lo = model === 'spread' ? 0.2 : 0.05;
  let hi = model === 'spread' ? 8 : 1;
  for (let it = 0; it < 16; it++) {
    const mid = (lo + hi) / 2;
    const total = goodToday(model === 'spread' ? profiles(mid)[0] : profiles(1.5, mid)[0]);
    // A larger scale lowers the score; a larger `know` raises it.
    if (total > 4500 === (model === 'spread')) lo = mid;
    else hi = mid;
  }
  const fitted = (lo + hi) / 2;
  const [scale, know] = model === 'spread' ? [fitted, 1] : [1.5, fitted];
  const players = profiles(scale, know);
  const guesses = infos.map((info, i) => {
    const rand = rng(seed * 100003 + i);
    const out: Record<string, GuessSet> = {};
    for (const p of players) out[p.name] = drawGuesses(info, p, countries, samples, rand);
    out.wild = drawGuesses(info, 'wild', countries, samples, rand);
    return out;
  });
  return { infos, who: [...players.map((p) => p.name), 'wild'], guesses, scale, know, model, players, countries };
}

export function meanScore(f: Formula, info: QuestionInfo, g: GuessSet): number {
  let s = 0;
  for (let i = 0; i < g.km.length; i++) s += f.score(info, g.km[i], g.sameCountry[i] === 1);
  return s / g.km.length;
}

export interface Summary {
  /** mean score per player per tier */
  tiers: Record<string, number[]>;
  /** expected share squares per game per player [🟩, 🟨, 🟧, 🟥] */
  colours: Record<string, number[]>;
  /** game-total percentiles per player [p10, p50, p90] */
  spread: Record<string, number[]>;
}

const byTier = (sim: Simulation) => TIERS.map((t) => sim.infos.map((info, i) => ({ info, i })).filter((x) => x.info.q.tier === t));

export function summarise(sim: Simulation, f: Formula, days = 20000): Summary {
  const tiers: Record<string, number[]> = {};
  const colours: Record<string, number[]> = {};
  const spread: Record<string, number[]> = {};
  const groups = byTier(sim);
  for (const w of sim.who) {
    tiers[w] = groups.map((xs) => xs.reduce((s, x) => s + meanScore(f, x.info, sim.guesses[x.i][w]), 0) / xs.length);
    colours[w] = [0, 0, 0, 0];
    for (const xs of groups) {
      for (const x of xs) {
        const g = sim.guesses[x.i][w];
        for (let j = 0; j < g.km.length; j++) colours[w][f.colour(f.score(x.info, g.km[j], g.sameCountry[j] === 1))] += 1 / g.km.length / xs.length;
      }
    }
    // A "day" is one random question per tier, one random guess at each.
    const rand = rng(99);
    const totals: number[] = [];
    for (let d = 0; d < days; d++) {
      let total = 0;
      for (const xs of groups) {
        const x = xs[Math.floor(rand() * xs.length)];
        const g = sim.guesses[x.i][w];
        const j = Math.floor(rand() * g.km.length);
        total += f.score(x.info, g.km[j], g.sameCountry[j] === 1);
      }
      totals.push(total);
    }
    totals.sort((a, b) => a - b);
    spread[w] = [0.1, 0.5, 0.9].map((p) => totals[Math.floor(p * (totals.length - 1))]);
  }
  return { tiers, colours, spread };
}

/** Miss-distance percentiles [p25, p50, p75] per player per tier, pooled over the tier's questions. */
export function missDistances(sim: Simulation): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  for (const w of sim.who) {
    out[w] = byTier(sim).map((xs) => {
      const all = Float32Array.from(xs.flatMap((x) => Array.from(sim.guesses[x.i][w].km))).sort();
      return [0.25, 0.5, 0.75].map((p) => all[Math.floor(p * (all.length - 1))]);
    });
  }
  return out;
}

/** How much the country floor matters for each player: [share of guesses it decides, points it adds per game]. */
export function floorEffect(sim: Simulation, p: ProposalParams): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  const noFloor = makeProposal({ ...p, floor: { ...p.floor, max: 0, min: 0 } });
  const withFloor = makeProposal(p);
  for (const w of sim.who) {
    let decided = 0;
    let n = 0;
    let added = 0;
    for (const xs of byTier(sim)) {
      let tierAdded = 0;
      for (const x of xs) {
        const g = sim.guesses[x.i][w];
        for (let j = 0; j < g.km.length; j++) {
          const a = noFloor.score(x.info, g.km[j], false);
          const b = withFloor.score(x.info, g.km[j], g.sameCountry[j] === 1);
          if (b > a) decided++;
          tierAdded += (b - a) / g.km.length / xs.length;
          n++;
        }
      }
      added += tierAdded;
    }
    out[w] = [decided / n, added];
  }
  return out;
}

// --------------------------------------------------------------- output ---

const fmt = (n: number) => Math.round(n).toLocaleString('en-GB');
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function summaryLines(sim: Simulation, f: Formula, s: Summary): string[] {
  const lines = [`${'player'.padEnd(8)}${TIERS.map((t) => `T${t}`.padStart(7)).join('')}    game      p10–p90     🟩   🟨   🟧   🟥`];
  for (const w of sim.who) {
    lines.push(
      `${w.padEnd(8)}${s.tiers[w].map((m) => fmt(m).padStart(7)).join('')} ${fmt(total(s.tiers[w])).padStart(7)}  ${`${fmt(s.spread[w][0])}–${fmt(s.spread[w][2])}`.padStart(12)}  ${s.colours[w].map((c) => c.toFixed(1).padStart(4)).join(' ')}`,
    );
  }
  return [`${f.name}`, ...lines];
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  const model = (arg('--model') ?? 'spread') as ModelName;
  if (model !== 'spread' && model !== 'patchy') throw new Error('--model is spread or patchy');
  const sim = await simulate(Number(arg('--samples') ?? 800), Number(arg('--seed') ?? 1), model);
  const formulas = [CURRENT, PROPOSED];
  const out: string[] = [];
  const say = (...lines: string[]) => {
    for (const l of lines) console.log(l);
    out.push(...lines);
  };

  // The model.
  const miss = missDistances(sim);
  const pct = (xs: number[]) => xs.map((x) => `${Math.round(x * 100)}`.padStart(5)).join('');
  const fit = model === 'spread' ? `miss distances ×${sim.scale.toFixed(2)}` : `knowledge ×${sim.know.toFixed(2)}, miss distances ×${sim.scale}`;
  say('', `PLAYER MODEL "${model}" (${fit}, fitted so "good" scores ~4,500 today)`, '');
  say(`${''.padEnd(18)}${TIERS.map((t) => `T${t}`.padStart(5)).join('')}   (% of answers)`);
  for (const p of sim.players) {
    say(`${p.name.padEnd(8)}pinpoint  ${pct(p.pin)}   ~${fmt(p.pinKm[0])}–${fmt(p.pinKm[6])} km off`);
    say(`${''.padEnd(8)}area      ${pct(p.area)}   ~${fmt(p.areaKm)} km off`);
    say(`${''.padEnd(8)}country   ${pct(p.country)}   anywhere in the right country`);
    say(`${''.padEnd(8)}region    ${pct(p.region)}   ~${fmt(p.regionKm)} km off`);
    say(`${''.padEnd(8)}lost      ${pct(TIERS.map((_, t) => lostShare(p, t)))}   anywhere on land`);
  }
  say('wild    a random point on land, every time', '');
  say('Resulting miss distance, km (25th / 50th / 75th percentile):', '');
  say(`${'player'.padEnd(8)}${TIERS.map((t) => `T${t}`.padStart(21)).join('')}`);
  for (const w of sim.who) say(`${w.padEnd(8)}${miss[w].map(([p25, p50, p75]) => `${fmt(p25)} / ${fmt(p50)} / ${fmt(p75)}`.padStart(21)).join('')}`);

  // The two curves.
  const DISTANCES = [25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];
  const curveQ = (tier: number) => ({ tier, k: null, bullseyeKm: null }) as unknown as Question;
  say('', 'SCORE BY DISTANCE for a pinpoint event (current → proposed)', '');
  say(`${'km'.padEnd(6)}${TIERS.map((t) => `T${t}`.padStart(15)).join('')}`);
  for (const d of DISTANCES) {
    say(
      `${fmt(d).padEnd(6)}${TIERS.map((t) => {
        const info = { q: curveQ(t), answer: null };
        return `${CURRENT.score(info, d, false)} → ${PROPOSED.score(info, d, false)}`.padStart(15);
      }).join('')}`,
    );
  }
  say(`${'k'.padEnd(6)}${TIERS.map((t) => `${fmt(TIER_DEFAULTS[t].k)} → ${fmt(PROPOSAL.k[t - 1])}`.padStart(15)).join('')}`);

  // The country floor.
  const { floor } = PROPOSAL;
  say('', `COUNTRY FLOOR (land events; mark in the answer's country and within ${fmt(floor.maxDistanceKm)} km)`, '');
  const examples = ['BEL', 'GBR', 'DEU', 'FRA', 'ESP', 'TUR', 'ZAF', 'MEX', 'IRN', 'ARG', 'IND', 'AUS', 'BRA', 'USA', 'CHN', 'CAN', 'RUS'];
  const rows = examples.map((c) => ({ c, r: sim.countries.radiusOf(c) ?? 0 }));
  say(rows.map(({ c, r }) => `${c} ${fmt(r)} km → ${countryFloor(PROPOSAL, r)}`).join('   '));
  say(`(equivalent radius √(area/π); floor ${floor.max} up to ${fmt(floor.fullUpToKm)} km, ${floor.min} from ${fmt(floor.minFromKm)} km, log-linear between)`);

  // Per-question parameters that change.
  say('', 'QUESTIONS WHOSE PARAMETERS CHANGE (beyond the new tier k)', '');
  say(`${'question'.padEnd(26)}${'bullseye'.padStart(12)}${'k'.padStart(16)}   why`);
  for (const [id, o] of Object.entries(PROPOSAL_OVERRIDES)) {
    const info = sim.infos.find((x) => x.q.id === id);
    if (!info) continue;
    const cur = scoringParams(info.q);
    const next = proposalParams(PROPOSAL, info.q);
    say(
      `${`T${info.q.tier} ${id}`.padEnd(26)}${`${cur.bullseyeKm} → ${next.bullseyeKm}`.padStart(12)}${`${fmt(cur.k)} → ${fmt(next.k)}`.padStart(16)}   ${o.atSea ? 'at sea: ' : ''}${o.why}`,
    );
  }

  // Per question.
  if (!a.includes('--summary')) {
    say('', 'EXPECTED SCORE PER QUESTION (current → proposed)', '');
    say(`${'question'.padEnd(30)}${sim.who.map((w) => w.padStart(14)).join('')}`);
    for (const xs of byTier(sim)) {
      for (const { info, i } of xs) {
        const o = PROPOSAL_OVERRIDES[info.q.id];
        const tag = o ? (o.atSea ? '  (sea)' : '  (area)') : '';
        say(
          `${`T${info.q.tier} ${info.q.id}`.padEnd(30)}${sim.who.map((w) => `${fmt(meanScore(CURRENT, info, sim.guesses[i][w]))} → ${fmt(meanScore(PROPOSED, info, sim.guesses[i][w]))}`.padStart(14)).join('')}${tag}`,
        );
      }
    }
  }

  // Per game.
  say('', 'EXPECTED SCORE PER TIER AND PER GAME', '');
  for (const f of formulas) say(...summaryLines(sim, f, summarise(sim, f)), '');
  const fe = floorEffect(sim, PROPOSAL);
  say(`Country floor in the proposal: ${sim.who.map((w) => `${w} +${fmt(fe[w][1])}/game (decides ${(fe[w][0] * 100).toFixed(1)}% of marks)`).join(', ')}`);

  const report = arg('--report');
  if (report) {
    await writeFile(resolve(report), ['```', ...out, '```', ''].join('\n'));
    console.log(`Written to ${report}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

