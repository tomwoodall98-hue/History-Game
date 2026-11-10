/**
 * Scoring simulator: what do different players score on the real bank?
 *
 *   npm run simulate:scoring                      per-question and per-game tables
 *   npm run simulate:scoring -- --summary         per-game tables only
 *   npm run simulate:scoring -- --samples 2000    more Monte Carlo samples (default 800)
 *   npm run simulate:scoring -- --model patchy    the other player model (see `ModelName`)
 *   npm run simulate:scoring -- --report out.md   also write everything to a Markdown file
 *
 * It compares the game's scoring (src/game/scoring.ts, run as is) with the
 * formula it replaced (`PREVIOUS`: exponential decay, k shrinking from
 * 1,200 km on tier 1 to 300 km on tier 7, no country floor). To weigh up
 * another idea, add it to `CANDIDATES`.
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
 * player re-aims until the mark is on land, as a real player would, and the
 * same-country floor is decided by the game's own outlines and lookup
 * (src/game/countries.ts), so a simulated mark earns it exactly when a real
 * one would.
 *
 * The only thing we know about real players is that the best one averaged
 * ~4,500 under the previous formula, so the "good" player is fitted to that.
 * There are two ways to fit it (`ModelName`): stretch every miss distance
 * ("spread", the default) or keep misses short and lower how many events
 * they know ("patchy"). "Average" and "poor" share the fit but know fewer
 * places and miss by more. "Wild" clicks a random point on land every time
 * and should score near zero under any sane formula. The run prints the
 * resulting miss distances per tier, so the model can be judged directly.
 *
 * Guesses are drawn once and every formula scores the same guesses, so the
 * comparison is like-for-like.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import {
  haversineKm,
  scoringParams,
  pointsFor,
  countryFloor,
  gradeFor,
  EARTH_RADIUS_KM,
  COUNTRY_FLOOR,
  TIER_DEFAULTS,
} from '../src/game/scoring.ts';
import { CountryIndex, type Country } from '../src/game/countries.ts';
import { TIERS, type LngLat, type Question, type Tier } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---------------------------------------------------------------- land ---

interface Part {
  rings: Float64Array[];
  bbox: [number, number, number, number];
}

/**
 * The same country outlines, kept whole so simulated players can aim at land
 * and pick spots inside a country. (The game's lookup deliberately hides
 * shapes; this is only for placing simulated marks.)
 */
export class LandSampler {
  private grid = new Map<number, Part[]>();

  constructor(topo: Topology) {
    const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Polygon | MultiPolygon>;
    for (const f of fc.features) {
      if (!f.geometry) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) {
        let [x0, y0, x1, y1] = [180, 90, -180, -90];
        for (const [x, y] of poly[0]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
        const part: Part = { rings: poly.map((ring) => Float64Array.from(ring.flat())), bbox: [x0, y0, x1, y1] };
        for (let gy = Math.floor(y0); gy <= Math.floor(y1); gy++) {
          for (let gx = Math.floor(x0); gx <= Math.floor(x1); gx++) {
            const key = (gy + 90) * 400 + (gx + 180);
            (this.grid.get(key) ?? this.grid.set(key, []).get(key)!).push(part);
          }
        }
      }
    }
  }

  private static inside(part: Part, x: number, y: number): boolean {
    const [x0, y0, x1, y1] = part.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    let inside = false;
    for (const r of part.rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        if (r[i + 1] > y !== r[j + 1] > y && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
      }
    }
    return inside;
  }

  /** The landmass under a point, if any (no slack). */
  partAt([lng, lat]: LngLat): Part | null {
    for (const part of this.grid.get((Math.floor(lat) + 90) * 400 + (Math.floor(lng) + 180)) ?? []) {
      if (LandSampler.inside(part, lng, lat)) return part;
    }
    return null;
  }

  /** A uniformly random point on a landmass. */
  randomPointIn(part: Part, rand: () => number): LngLat {
    const [x0, y0, x1, y1] = part.bbox;
    for (let i = 0; i < 5000; i++) {
      const lat = Math.asin(Math.sin(y0 * RAD) + rand() * (Math.sin(y1 * RAD) - Math.sin(y0 * RAD))) / RAD;
      const lng = x0 + rand() * (x1 - x0);
      if (LandSampler.inside(part, lng, lat)) return [lng, lat];
    }
    return [x0 + (x1 - x0) / 2, y0 + (y1 - y0) / 2];
  }

  /** A uniformly random point on land, anywhere on the globe. */
  randomLand(rand: () => number): LngLat {
    for (;;) {
      const lat = Math.asin(rand() * 2 - 1) / RAD;
      const g: LngLat = [rand() * 360 - 180, lat];
      if (this.partAt(g)) return g;
    }
  }
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
 * Two ways to be a 4,500 player under the previous formula:
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
  /** 1 if the game would count the mark as in the answer's country. */
  sameCountry: Uint8Array;
}

/** What a formula may know about a question. */
export interface QuestionInfo {
  q: Question;
  /** The answer's country as the game sees it (null at sea, or if the outlines have none). */
  answer: Country | null;
  /** The answer's landmass, for "knows only the country" guesses. */
  part: Part | null;
}

/** A scoring rule. */
export interface Formula {
  name: string;
  /** Points for a mark `km` from the answer; `sameCountry` if the game counts it as in the answer's country. */
  score: (info: QuestionInfo, km: number, sameCountry: boolean) => number;
  /** Share square: 0 🟩, 1 🟨, 2 🟧, 3 🟥. */
  colour: (score: number) => 0 | 1 | 2 | 3;
}

function drawGuesses(info: QuestionInfo, who: Profile | 'wild', land: LandSampler, countries: CountryIndex, n: number, rand: () => number): GuessSet {
  const { q, answer, part } = info;
  const ans: LngLat = [q.lng, q.lat];
  // Players aim for land unless the event happened at sea (or on a speck of an island).
  const onLand = part != null && !q.atSea;
  const km = new Float32Array(n);
  const sameCountry = new Uint8Array(n);
  const near = (median: number, sigma: number) => {
    const shot = () => destination(ans, median * Math.exp(sigma * normal(rand)), rand() * 360);
    let g = shot();
    for (let i = 0; onLand && i < 12 && !land.partAt(g); i++) g = shot();
    return g;
  };
  for (let i = 0; i < n; i++) {
    let g: LngLat;
    if (who === 'wild') g = land.randomLand(rand);
    else {
      const t = q.tier - 1;
      const r = rand();
      let c = who.pin[t];
      if (r < c) g = near(who.pinKm[t], 0.7);
      else if (r < (c += who.area[t])) g = near(who.areaKm, 0.6);
      else if (r < (c += who.country[t])) {
        // Knows the country, nothing more. At sea: knows the sea, roughly.
        g = onLand ? land.randomPointIn(part!, rand) : near(who.areaKm * 2.5, 0.6);
      } else if (r < (c += who.region[t])) g = near(who.regionKm, 0.6);
      else g = land.randomLand(rand);
    }
    km[i] = haversineKm(ans, g);
    sameCountry[i] = answer && countries.countryAt(g)?.code === answer.code ? 1 : 0;
  }
  return { km, sameCountry };
}

// ------------------------------------------------------------- formulas ---

const squares = (green: number, yellow: number, orange: number) => (s: number): 0 | 1 | 2 | 3 =>
  s >= green ? 0 : s >= yellow ? 1 : s >= orange ? 2 : 3;

/** The game's scoring, exactly as src/game/scoring.ts does it. */
export const GAME: Formula = {
  name: 'current',
  score: ({ q, answer }, km, sameCountry) => pointsFor(q, km, sameCountry && answer ? answer.radiusKm : null).score,
  colour: (s) => (({ great: 0, good: 1, fair: 2, poor: 3 }) as const)[gradeFor(s)],
};

/** Tier defaults of the previous formula: k shrank with tier. */
const PREVIOUS_TIERS: Record<Tier, { k: number; bullseyeKm: number }> = {
  1: { k: 1200, bullseyeKm: 30 },
  2: { k: 1000, bullseyeKm: 25 },
  3: { k: 800, bullseyeKm: 20 },
  4: { k: 650, bullseyeKm: 15 },
  5: { k: 500, bullseyeKm: 15 },
  6: { k: 400, bullseyeKm: 10 },
  7: { k: 300, bullseyeKm: 10 },
};

/** [k, bullseyeKm] of the questions whose own settings changed with the new scoring. */
const PREVIOUS_SETTINGS: Record<string, [number | null, number | null]> = {
  't2-somme': [null, 15],
  't2-hijra': [null, 20],
  't3-columbus-landfall': [null, 20],
  't3-bay-of-pigs': [null, 15],
  't3-verdun': [null, 12],
  't3-el-alamein': [null, 20],
  't3-midway': [1000, 150],
  't4-tours': [null, 25],
  't4-nazca': [null, 20],
  't4-guadalcanal': [null, 15],
  't5-gaugamela': [null, 15],
  't5-teutoburg': [null, 10],
  't5-zama': [null, 30],
  't5-tsushima': [null, 30],
  't5-bounty-mutiny': [600, 60],
  't5-long-march-end': [null, 15],
  't5-tunguska': [null, 20],
  't6-burke-wills': [null, 25],
  't6-mukden': [null, 25],
  't6-imphal': [null, 20],
  't6-kalinga': [null, 15],
  't7-changping': [null, 20],
  't7-khalkhin-gol': [null, 25],
  't7-endurance': [500, 50],
};

export function previousParams(q: Question): { k: number; bullseyeKm: number } {
  const [k, b] = PREVIOUS_SETTINGS[q.id] ?? [q.k ?? null, q.bullseyeKm ?? null];
  const d = PREVIOUS_TIERS[q.tier];
  return { k: k ?? d.k, bullseyeKm: b ?? d.bullseyeKm };
}

/** The formula before: round(1000 · e^(−d/k)), 1,000 inside the bullseye, no country floor. */
export const PREVIOUS: Formula = {
  name: 'previous',
  score: ({ q }, km) => {
    const { k, bullseyeKm } = previousParams(q);
    return km <= bullseyeKm ? 1000 : Math.round(1000 * Math.exp(-km / k));
  },
  colour: squares(800, 500, 200),
};

/** Ideas to weigh up against the game's formula; printed after it. */
export const CANDIDATES: Formula[] = [];

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
  const topo = JSON.parse(await readFile(resolve(ROOT, 'src/data/countries.topo.json'), 'utf8')) as Topology;
  const countries = new CountryIndex(topo);
  const land = new LandSampler(topo);
  const infos: QuestionInfo[] = questions.map((q) => ({
    q,
    answer: q.atSea ? null : q.country ? countries.byCode(q.country) : countries.countryAt([q.lng, q.lat]),
    part: land.partAt([q.lng, q.lat]) ?? nearbyPart(land, [q.lng, q.lat]),
  }));

  // Fit the model so the good player averages ~4,500 under the previous formula.
  const calib = infos.filter((_, i) => i % 3 === 0);
  const goodBefore = (good: Profile) => {
    const rand = rng(7);
    return TIERS.reduce((sum, t) => {
      const qs = calib.filter((x) => x.q.tier === t);
      return sum + qs.reduce((s, x) => s + meanScore(PREVIOUS, x, drawGuesses(x, good, land, countries, 150, rand)), 0) / qs.length;
    }, 0);
  };
  let lo = model === 'spread' ? 0.2 : 0.05;
  let hi = model === 'spread' ? 8 : 1;
  for (let it = 0; it < 16; it++) {
    const mid = (lo + hi) / 2;
    const total = goodBefore(model === 'spread' ? profiles(mid)[0] : profiles(1.5, mid)[0]);
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
    for (const p of players) out[p.name] = drawGuesses(info, p, land, countries, samples, rand);
    out.wild = drawGuesses(info, 'wild', land, countries, samples, rand);
    return out;
  });
  return { infos, who: [...players.map((p) => p.name), 'wild'], guesses, scale, know, model, players, countries };
}

/** The landmass within ~10 km of a point (answers in harbours, rivers and bays). */
function nearbyPart(land: LandSampler, [lng, lat]: LngLat): Part | null {
  const dLat = 10 / 111.2;
  const dLng = dLat / Math.max(0.2, Math.cos(lat * RAD));
  for (const [sx, sy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]]) {
    const part = land.partAt([lng + sx * dLng, lat + sy * dLat]);
    if (part) return part;
  }
  return null;
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

/** How much the country floor matters for each player: [share of marks it decides, points it adds per game]. */
export function floorEffect(sim: Simulation): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const w of sim.who) {
    let decided = 0;
    let n = 0;
    let added = 0;
    for (const xs of byTier(sim)) {
      for (const x of xs) {
        const g = sim.guesses[x.i][w];
        for (let j = 0; j < g.km.length; j++) {
          const a = GAME.score(x.info, g.km[j], false);
          const b = GAME.score(x.info, g.km[j], g.sameCountry[j] === 1);
          if (b > a) decided++;
          added += (b - a) / g.km.length / xs.length;
          n++;
        }
      }
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
  return [f.name, ...lines];
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  const model = (arg('--model') ?? 'spread') as ModelName;
  if (model !== 'spread' && model !== 'patchy') throw new Error('--model is spread or patchy');
  const sim = await simulate(Number(arg('--samples') ?? 800), Number(arg('--seed') ?? 1), model);
  const formulas = [PREVIOUS, GAME, ...CANDIDATES];
  const out: string[] = [];
  const say = (...lines: string[]) => {
    for (const l of lines) console.log(l);
    out.push(...lines);
  };

  // The model.
  const miss = missDistances(sim);
  const pct = (xs: number[]) => xs.map((x) => `${Math.round(x * 100)}`.padStart(5)).join('');
  const fit = model === 'spread' ? `miss distances ×${sim.scale.toFixed(2)}` : `knowledge ×${sim.know.toFixed(2)}, miss distances ×${sim.scale}`;
  say('', `PLAYER MODEL "${model}" (${fit}, fitted so "good" scored ~4,500 under the previous formula)`, '');
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
  const pinpoint = (tier: Tier): QuestionInfo => ({ q: { tier, k: null, bullseyeKm: null } as Question, answer: null, part: null });
  say('', 'SCORE BY DISTANCE for a pinpoint event (previous → current)', '');
  say(`${'km'.padEnd(6)}${TIERS.map((t) => `T${t}`.padStart(15)).join('')}`);
  for (const d of DISTANCES) {
    say(`${fmt(d).padEnd(6)}${TIERS.map((t) => `${PREVIOUS.score(pinpoint(t), d, false)} → ${GAME.score(pinpoint(t), d, false)}`.padStart(15)).join('')}`);
  }
  say(`${'k'.padEnd(6)}${TIERS.map((t) => `${fmt(PREVIOUS_TIERS[t].k)} → ${fmt(TIER_DEFAULTS[t].k)}`.padStart(15)).join('')}`);

  // The country floor.
  say('', `COUNTRY FLOOR (land events; a mark in the answer's country and within ${fmt(COUNTRY_FLOOR.maxDistanceKm)} km)`, '');
  const examples = ['BEL', 'GBR', 'DEU', 'FRA', 'ESP', 'TUR', 'ZAF', 'MEX', 'IRN', 'ARG', 'IND', 'AUS', 'BRA', 'USA', 'CHN', 'CAN', 'RUS'];
  say(examples.map((c) => sim.countries.byCode(c)).filter((c) => c != null).map((c) => `${c.code} ${fmt(c.radiusKm)} km → ${countryFloor(c.radiusKm)}`).join('   '));
  say(`(equivalent radius √(area/π); ${COUNTRY_FLOOR.max} up to ${fmt(COUNTRY_FLOOR.fullUpToKm)} km, ${COUNTRY_FLOOR.min} from ${fmt(COUNTRY_FLOOR.minFromKm)} km, log-linear between)`);

  // Questions with their own settings.
  say('', 'QUESTIONS WITH THEIR OWN SETTINGS (previous → current)', '');
  say(`${'question'.padEnd(26)}${'bullseye'.padStart(12)}${'k'.padStart(16)}`);
  for (const { q } of sim.infos) {
    const before = previousParams(q);
    const now = scoringParams(q);
    if (!q.atSea && !q.country && before.bullseyeKm === now.bullseyeKm && q.k == null && !(q.id in PREVIOUS_SETTINGS)) continue;
    const flags = [q.atSea ? 'at sea' : '', q.country ? `country ${q.country}` : ''].filter(Boolean).join(', ');
    say(`${`T${q.tier} ${q.id}`.padEnd(26)}${`${before.bullseyeKm} → ${now.bullseyeKm}`.padStart(12)}${`${fmt(before.k)} → ${fmt(now.k)}`.padStart(16)}   ${flags}`);
  }

  // Per question.
  if (!a.includes('--summary')) {
    say('', 'EXPECTED SCORE PER QUESTION (previous → current)', '');
    say(`${'question'.padEnd(30)}${sim.who.map((w) => w.padStart(14)).join('')}`);
    for (const xs of byTier(sim)) {
      for (const { info, i } of xs) {
        say(
          `${`T${info.q.tier} ${info.q.id}`.padEnd(30)}${sim.who.map((w) => `${fmt(meanScore(PREVIOUS, info, sim.guesses[i][w]))} → ${fmt(meanScore(GAME, info, sim.guesses[i][w]))}`.padStart(14)).join('')}${info.q.atSea ? '  (sea)' : ''}`,
        );
      }
    }
  }

  // Per game.
  say('', 'EXPECTED SCORE PER TIER AND PER GAME', '');
  for (const f of formulas) say(...summaryLines(sim, f, summarise(sim, f)), '');
  const fe = floorEffect(sim);
  say(`Country floor: ${sim.who.map((w) => `${w} +${fmt(fe[w][1])}/game (decides ${(fe[w][0] * 100).toFixed(1)}% of marks)`).join(', ')}`);

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
