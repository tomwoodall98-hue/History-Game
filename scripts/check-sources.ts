/**
 * Checks that every question's `source` leads to a usable Wikipedia summary,
 * the one "Read more" shows after a guess.
 *
 *   npm run check:sources              report on every question
 *   npm run check:sources -- --fix     also point plain redirects at their target
 *   npm run check:sources -- t3-waterloo t5-actium   just these questions
 *   npm run check:sources -- --fresh   ignore answers saved in the last day
 *
 * For each source it asks Wikipedia (the action API, 50 titles at a time,
 * then the REST summary the game itself fetches) and sorts what it finds:
 *
 *   Needs fixing   not a Wikipedia article URL, a missing page, a
 *                  disambiguation page, a redirect to a section of another
 *                  article (the summary would be of that whole article), or
 *                  a summary the game couldn't use (no extract).
 *   Redirects      the title redirects to another article. The summary
 *                  follows it, but check the target is the event, then
 *                  `--fix` rewrites the URL to the target.
 *   Far away       the article's own coordinates are a long way from the
 *                  answer: worth a look in case it's the wrong place or the
 *                  wrong article (often fine, e.g. a war's article sits on
 *                  its capital).
 *   No picture     no lead image, or one that isn't on Wikimedia Commons
 *                  (the game shows only Commons images, which are free).
 *
 * Wikipedia asks scripts to identify themselves; set WIKI_USER_AGENT to
 * something with your contact details if you run this a lot. This needs the
 * network, so it isn't part of `npm run check`; run it after editing sources.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineKm } from '../src/game/scoring.ts';
import type { Question } from '../src/game/types.ts';
import { articleTitle, commonsImage, parseSummary, summaryUrl, type WikiSummary } from '../src/game/wikipedia.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUESTIONS = resolve(ROOT, 'src/data/questions.json');
const USER_AGENT = process.env.WIKI_USER_AGENT || 'question-source-check/1.0 (Wikipedia summary checker)';
const FAR_KM = 400;
const GAP_MS = 400;
const CACHE = resolve(ROOT, '.cache/wikipedia-summaries.json');
/** Saved answers older than this are asked for again. */
const CACHE_HOURS = 24;

interface PageInfo {
  /** The title after normalisation and redirects. */
  title: string;
  redirectedFrom: string | null;
  fragment: string | null;
  missing: boolean;
  disambiguation: boolean;
  coords: { lat: number; lon: number } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answers from earlier runs, so a rerun after fixing a few sources is quick. */
let saved: Record<string, { status: number; body: unknown }> = {};

/** GETs JSON politely: one request at a time, backing off whenever Wikipedia asks. */
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  if (saved[url]) return saved[url];
  for (let attempt = 0; ; attempt++) {
    await sleep(GAP_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT } });
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      const wait = Number(res.headers.get('retry-after'));
      await sleep(Math.max(Number.isFinite(wait) ? wait * 1000 : 0, 2000 * (attempt + 1)));
      continue;
    }
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    if (res.status === 200 || res.status === 404) saved[url] = { status: res.status, body };
    return { status: res.status, body };
  }
}

const spaced = (title: string) => title.replace(/_/g, ' ');

/** Redirects, disambiguation flags and coordinates for up to 50 titles at once. */
async function pageInfo(titles: string[]): Promise<Map<string, PageInfo>> {
  const out = new Map<string, PageInfo>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      redirects: '1',
      prop: 'pageprops|coordinates',
      ppprop: 'disambiguation',
      colimit: 'max',
      titles: batch.map(spaced).join('|'),
    });
    const { body } = await getJson(`https://en.wikipedia.org/w/api.php?${params}`);
    const q = (body as { query?: Record<string, unknown> } | null)?.query;
    if (!q) throw new Error(`Wikipedia's API gave no answer for titles ${i + 1}–${i + batch.length}`);
    const normalized = new Map(((q.normalized as { from: string; to: string }[]) ?? []).map((n) => [n.from, n.to]));
    const redirects = new Map(
      ((q.redirects as { from: string; to: string; tofragment?: string }[]) ?? []).map((r) => [r.from, r]),
    );
    const pages = new Map(
      (
        (q.pages as {
          title: string;
          missing?: boolean;
          invalid?: boolean;
          pageprops?: { disambiguation?: string };
          coordinates?: { lat: number; lon: number }[];
        }[]) ?? []
      ).map((p) => [p.title, p]),
    );
    for (const t of batch) {
      const asked = spaced(t);
      const norm = normalized.get(asked) ?? asked;
      const redirect = redirects.get(norm);
      const final = redirect?.to ?? norm;
      const page = pages.get(final);
      out.set(t, {
        title: final,
        redirectedFrom: redirect ? norm : null,
        fragment: redirect?.tofragment ?? null,
        missing: !page || !!page.missing || !!page.invalid,
        disambiguation: page?.pageprops?.disambiguation != null,
        coords: page?.coordinates?.[0] ?? null,
      });
    }
  }
  return out;
}

/** A Wikipedia URL in the style the question bank uses (Unicode kept, apostrophes escaped). */
function articleUrl(title: string): string {
  const path = title.replace(/ /g, '_').replace(/[%'"?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `https://en.wikipedia.org/wiki/${path}`;
}

async function keep(): Promise<void> {
  await mkdir(dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify({ at: Date.now(), answers: saved }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  if (!args.includes('--fresh')) {
    try {
      const file = JSON.parse(await readFile(CACHE, 'utf8')) as { at: number; answers: typeof saved };
      if (Date.now() - file.at < CACHE_HOURS * 3_600_000) saved = file.answers;
    } catch {
      // no saved answers yet
    }
  }
  const only = new Set(args.filter((a) => !a.startsWith('--')));
  const all = JSON.parse(await readFile(QUESTIONS, 'utf8')) as Question[];
  const questions = only.size ? all.filter((q) => only.has(q.id)) : all;

  const broken: string[] = [];
  const redirects: { q: Question; from: string; to: string }[] = [];
  const far: string[] = [];
  const noPicture: string[] = [];

  const titled = questions.map((q) => ({ q, title: articleTitle(q.source) }));
  for (const { q, title } of titled) if (!title) broken.push(`${q.id}: not a Wikipedia article URL (${q.source})`);
  const valid = titled.filter((t): t is { q: Question; title: string } => t.title != null);
  console.log(`Checking ${valid.length} sources against Wikipedia…`);
  const info = await pageInfo([...new Set(valid.map((t) => t.title))]);

  const summaries: { status: number; body: unknown; summary: WikiSummary | null }[] = [];
  for (const { q } of valid) {
    const { status, body } = await getJson(summaryUrl(q.source)!);
    summaries.push({ status, body, summary: status === 200 ? parseSummary(body) : null });
    if (summaries.length % 50 === 0) {
      console.log(`  …${summaries.length}`);
      await keep();
    }
  }
  await keep();

  valid.forEach(({ q, title }, i) => {
    const page = info.get(title)!;
    const { status, body, summary } = summaries[i];
    const type = (body as { type?: string } | null)?.type;
    if (page.missing || status === 404) {
      broken.push(`${q.id}: no such article (${q.source})`);
      return;
    }
    if (page.disambiguation || type === 'disambiguation') {
      broken.push(`${q.id}: "${page.title}" is a disambiguation page`);
      return;
    }
    if (page.fragment) {
      broken.push(`${q.id}: "${spaced(title)}" redirects to a section, "${page.title}#${page.fragment}"`);
      return;
    }
    if (!summary) {
      broken.push(`${q.id}: no usable summary (HTTP ${status}${type ? `, type ${type}` : ''})`);
      return;
    }
    if (page.redirectedFrom) redirects.push({ q, from: spaced(title), to: page.title });
    const coords = (body as { coordinates?: { lat: number; lon: number } }).coordinates ?? page.coords;
    if (coords) {
      const km = haversineKm([q.lng, q.lat], [coords.lon, coords.lat]);
      if (km > FAR_KM) far.push(`${q.id}: "${page.title}" is placed ${Math.round(km).toLocaleString('en-GB')} km from the answer`);
    }
    const thumb = (body as { thumbnail?: { source?: string } }).thumbnail;
    if (!thumb) noPicture.push(`${q.id}: no lead image`);
    else if (!commonsImage(thumb)) noPicture.push(`${q.id}: lead image isn't on Commons, so it isn't shown`);
  });

  const section = (heading: string, lines: string[]) => {
    console.log(`\n${heading} (${lines.length})`);
    for (const l of lines) console.log(`  ${l}`);
  };
  section('Needs fixing', broken);
  section(
    'Redirects',
    redirects.map((r) => `${r.q.id}: "${r.from}" → "${r.to}"`),
  );
  section('Far away', far);
  section('No picture', noPicture);

  if (fix && redirects.length) {
    let text = await readFile(QUESTIONS, 'utf8');
    for (const r of redirects) {
      const from = JSON.stringify(r.q.source);
      const to = JSON.stringify(articleUrl(r.to));
      text = text.split(from).join(to);
    }
    await writeFile(QUESTIONS, text);
    console.log(`\nRewrote ${redirects.length} redirected sources.`);
  }

  console.log(broken.length ? `\n✗ ${broken.length} sources need fixing.` : '\n✓ Every source has a usable summary.');
  if (broken.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
