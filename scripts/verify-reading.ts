/**
 * Checks every "Further reading" book against Open Library, then builds the
 * game's reading list from the ones it confirms.
 *
 *   npm run reading:verify                  check books not checked yet, then build
 *   npm run reading:verify -- --tier 1      only books used by tier-1 questions (repeatable: --tier 1 --tier 2)
 *   npm run reading:verify -- --topic vikings   only one topic's books
 *   npm run reading:verify -- --recheck     ask again about books already checked
 *   npm run reading:verify -- --failed      ask again about books that weren't found
 *   npm run reading:verify -- --offline     no lookups: rebuild from earlier answers
 *
 * Inputs (edited by hand):
 *   src/data/questions.json      each question's `topics` (one or two)
 *   data/reading/topics.json     each topic's books: title, author, year, why
 *   data/reading/events.json     books on single events, by question id
 *
 * Outputs (written by this script; don't edit):
 *   data/reading/openlibrary.json   what Open Library said about each book, by "title | author"
 *   data/reading/REPORT.md          pass rate, removed books, coverage
 *   src/data/reading.json           the verified books the game shows
 *
 * A book is verified when Open Library's search API has a work with the
 * same title (ignoring case, punctuation and any subtitle) whose authors
 * include the surname of the first author we name. The work id and a cover
 * id are recorded. Anything else is left out of the game and listed in the
 * report. Batches can be run one after another: answers are saved as they
 * come, and the reading list is rebuilt from everything checked so far, so
 * a partial run is usable.
 *
 * Open Library asks scripts to identify themselves and keep to about one
 * request a second; set OPENLIBRARY_USER_AGENT to include your contact
 * details if you run this a lot. Also runs as the "Verify further reading"
 * GitHub Actions workflow, which commits the results.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Question } from '../src/game/types.ts';
import {
  SEARCH_FIELDS,
  buildReading,
  candidateKey,
  judge,
  reportMarkdown,
  searchTitle,
  surname,
  type Candidate,
  type Check,
  type SearchDoc,
  type Topic,
} from './lib/reading.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  questions: resolve(ROOT, 'src/data/questions.json'),
  topics: resolve(ROOT, 'data/reading/topics.json'),
  events: resolve(ROOT, 'data/reading/events.json'),
  checks: resolve(ROOT, 'data/reading/openlibrary.json'),
  report: resolve(ROOT, 'data/reading/REPORT.md'),
  output: resolve(ROOT, 'src/data/reading.json'),
};
const USER_AGENT = process.env.OPENLIBRARY_USER_AGENT || 'chronomap-further-reading-check/1.0';
const GAP_MS = 1100;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const writeJson = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

/** Sorted by key, so the file diffs cleanly. */
const sortKeys = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

async function search(params: Record<string, string>): Promise<SearchDoc[]> {
  const url = `https://openlibrary.org/search.json?${new URLSearchParams({ ...params, fields: SEARCH_FIELDS, limit: '20' })}`;
  for (let attempt = 0; ; attempt++) {
    await sleep(GAP_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Open Library: HTTP ${res.status} for ${url}`);
    const body = (await res.json()) as { docs?: SearchDoc[] };
    return body.docs ?? [];
  }
}

/** Asks by title and author; failing that, by keywords, which forgives a differently spelt name. */
async function lookUp(c: Candidate): Promise<Check> {
  const title = searchTitle(c.title);
  const author = c.author.split(/\s+(?:and|&)\s+|,\s*/)[0];
  let check = judge(c, await search({ title, author }), today());
  const tries: Record<string, string>[] = [
    { q: `${title} ${surname(c.author)}` },
    // Open Library sometimes drops a leading article ("History of the Vikings").
    { title: title.replace(/^(the|a|an)\s+/i, ''), author: surname(c.author) },
    // …or spells the author differently ("Mac Donald"); the author is still checked.
    { title },
  ];
  for (const params of tries) {
    if (check.status === 'verified') break;
    const next = judge(c, await search(params), today());
    if (next.status === 'verified' || check.status === 'not-found') check = next;
  }
  return check;
}

function parseArgs(argv: string[]) {
  const tiers = new Set<number>();
  const topics = new Set<string>();
  let recheck = false;
  let failed = false;
  let offline = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tier') for (const t of (argv[++i] ?? '').split(',')) tiers.add(Number(t));
    else if (a === '--topic') for (const t of (argv[++i] ?? '').split(',')) topics.add(t);
    else if (a === '--recheck') recheck = true;
    else if (a === '--failed') failed = true;
    else if (a === '--offline') offline = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  return { tiers, topics, recheck, failed, offline };
}

export function build(write = true) {
  const questions = readJson<Question[]>(PATHS.questions);
  const topics = readJson<Topic[]>(PATHS.topics);
  const events = readJson<Record<string, Candidate[]>>(PATHS.events);
  const checks = readJson<Record<string, Check>>(PATHS.checks);
  const result = buildReading(topics, events, checks, questions);
  if (write) {
    writeJson(PATHS.output, result.data);
    writeFileSync(PATHS.report, reportMarkdown(result, today()));
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const questions = readJson<Question[]>(PATHS.questions);
  const topics = readJson<Topic[]>(PATHS.topics);
  const events = readJson<Record<string, Candidate[]>>(PATHS.events);
  let checks: Record<string, Check> = {};
  try {
    checks = readJson(PATHS.checks);
  } catch {
    // first run
  }

  // Which books this run is about.
  const inTiers = (q: Question) => !args.tiers.size || args.tiers.has(q.tier);
  const wantedTopics = new Set(
    args.topics.size ? args.topics : questions.filter(inTiers).flatMap((q) => q.topics ?? []),
  );
  const batch: Candidate[] = [
    ...topics.filter((t) => wantedTopics.has(t.id)).flatMap((t) => t.books),
    ...(args.topics.size ? [] : questions.filter(inTiers).flatMap((q) => events[q.id] ?? [])),
  ];
  const todo = [...new Map(batch.map((c) => [candidateKey(c), c])).values()].filter(
    (c) => args.recheck || !checks[candidateKey(c)] || (args.failed && checks[candidateKey(c)].status !== 'verified'),
  );

  if (!args.offline && todo.length) {
    console.log(`Checking ${todo.length} book(s) against Open Library…`);
    let done = 0;
    for (const c of todo) {
      const check = await lookUp(c);
      checks[candidateKey(c)] = check;
      done++;
      const mark = check.status === 'verified' ? '✓' : '✗';
      console.log(`${mark} [${done}/${todo.length}] ${c.title} — ${c.author}${check.status === 'verified' ? '' : `  (${check.status}: ${check.note})`}`);
      // Save as we go, so an interrupted run keeps its answers.
      if (done % 10 === 0 || done === todo.length) writeJson(PATHS.checks, sortKeys(checks));
    }
  } else if (!args.offline) {
    console.log('Nothing new to check in this batch.');
  }
  writeJson(PATHS.checks, sortKeys(checks));

  const { stats } = build();
  const pct = stats.checked ? ((100 * stats.verified) / stats.checked).toFixed(1) : 'n/a';
  console.log(
    `\n${stats.verified}/${stats.checked} checked books verified (${pct}%), ${stats.removed.length} removed, ${stats.pending.length} not yet checked.`,
  );
  if (stats.yearFlags.length) console.log(`${stats.yearFlags.length} year(s) differ from Open Library's (see the report).`);
  if (stats.uncovered.length) console.log(`${stats.uncovered.length} question(s) have fewer than two books.`);
  console.log(`Wrote ${PATHS.output} and ${PATHS.report}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
