/**
 * Sanity-checks question coordinates against open gazetteers.
 *
 *   npm run check:places                  every question
 *   npm run check:places -- t3-waterloo   one question (or several ids)
 *   npm run check:places -- --tier 7      one tier
 *
 * For each question it prints the nearest towns (GeoNames, via the
 * lutangar/cities.json export, CC BY 4.0) and, for events before AD 700,
 * the nearest ancient places (Pleiades, CC BY 3.0). A swapped sign or a
 * slipped digit shows up at once: "The Battle of Waterloo" should sit a
 * few km from Waterloo and Braine-l'Alleud, not in the Atlantic.
 *
 * The gazetteers (~35 MB) are downloaded on first run into .cache/ and are
 * never bundled with the game. This is a reading aid for whoever edits the
 * bank; `npm run validate` is the automated gate.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineKm } from '../src/game/scoring.ts';
import type { Question } from '../src/game/types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = resolve(ROOT, '.cache/gazetteer');
const SOURCES = {
  cities: 'https://raw.githubusercontent.com/lutangar/cities.json/master/cities.json',
  pleiades: 'https://raw.githubusercontent.com/isawnyu/pleiades.datasets/main/data/gis/places.csv',
};

interface Place {
  name: string;
  detail: string;
  lat: number;
  lng: number;
}

async function cached(name: string, url: string): Promise<string> {
  const path = resolve(CACHE, name);
  try {
    await access(path);
  } catch {
    console.log(`Downloading ${url} …`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  return readFile(path, 'utf8');
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, newlines in quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Bucket places on a 1° grid so nearest-neighbour lookups stay fast. */
class Grid {
  private cells = new Map<string, Place[]>();
  add(p: Place) {
    const key = `${Math.floor(p.lat)},${Math.floor(p.lng)}`;
    (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(p);
  }
  nearest(lat: number, lng: number, n: number): { place: Place; km: number }[] {
    const found: { place: Place; km: number }[] = [];
    for (let r = 1; r <= 12 && found.length < n; r += r < 3 ? 1 : 3) {
      found.length = 0;
      for (let a = Math.floor(lat) - r; a <= Math.floor(lat) + r; a++) {
        for (let b = Math.floor(lng) - r; b <= Math.floor(lng) + r; b++) {
          const wrapped = ((((b + 180) % 360) + 360) % 360) - 180;
          for (const place of this.cells.get(`${a},${wrapped}`) ?? []) {
            found.push({ place, km: haversineKm([lng, lat], [place.lng, place.lat]) });
          }
        }
      }
    }
    return found.sort((x, y) => x.km - y.km).slice(0, n);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const tierIdx = args.indexOf('--tier');
  const tier = tierIdx >= 0 ? Number(args[tierIdx + 1]) : null;
  const ids = args.filter((a, i) => !a.startsWith('--') && (tierIdx < 0 || i !== tierIdx + 1));

  const questions = JSON.parse(await readFile(resolve(ROOT, 'src/data/questions.json'), 'utf8')) as Question[];
  const selected = questions.filter((q) => (!ids.length || ids.includes(q.id)) && (tier == null || q.tier === tier));
  if (!selected.length) {
    console.error('No matching questions.');
    process.exit(1);
  }

  const towns = new Grid();
  for (const c of JSON.parse(await cached('cities.json', SOURCES.cities)) as { name: string; country: string; lat: string; lng: string }[]) {
    towns.add({ name: c.name, detail: c.country, lat: Number(c.lat), lng: Number(c.lng) });
  }
  const ancient = new Grid();
  const rows = parseCsv(await cached('pleiades-places.csv', SOURCES.pleiades));
  const head = rows[0];
  const col = (n: string) => head.indexOf(n);
  const [ti, la, lo, pr] = ['title', 'representative_latitude', 'representative_longitude', 'location_precision'].map(col);
  for (const r of rows.slice(1)) {
    if (r[pr] !== 'precise' || !r[la]) continue;
    ancient.add({ name: r[ti], detail: 'Pleiades', lat: Number(r[la]), lng: Number(r[lo]) });
  }

  const fmt = (xs: { place: Place; km: number }[]) =>
    xs.map(({ place, km }) => `${place.name} (${place.detail}) ${km < 10 ? km.toFixed(1) : Math.round(km)} km`).join(' · ');
  for (const q of selected) {
    const near = towns.nearest(q.lat, q.lng, 3);
    const far = !near.length || near[0].km > 150;
    console.log(`\n${q.id}  [T${q.tier}]  ${q.event} (${q.dateDisplay})  ${q.lat}, ${q.lng}${far ? '  ← remote or at sea?' : ''}`);
    console.log(`  towns:   ${near.length ? fmt(near) : 'none within ~1,300 km'}`);
    if (q.year < 700) {
      const old = ancient.nearest(q.lat, q.lng, 3);
      if (old.length) console.log(`  ancient: ${fmt(old)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
