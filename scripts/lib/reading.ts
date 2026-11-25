/**
 * The parts of the "Further reading" pipeline that need no network: matching
 * an Open Library search result to a book we recommend, and building the
 * game's reading list (src/data/reading.json) from the recommendations and
 * the record of what Open Library said about each.
 *
 * Shared by scripts/verify-reading.ts and tests/reading.test.ts, which
 * rebuilds the list to prove the shipped file holds only verified books.
 */
import type { Book, ReadingData } from '../../src/game/reading.ts';
import type { Question } from '../../src/game/types.ts';
import { booksFor } from '../../src/game/reading.ts';

/** A recommended book, as written in data/reading/*.json (not yet checked). */
export interface Candidate {
  title: string;
  /** "Barbara W. Tuchman", or "Will Durant and Ariel Durant"; the first named is matched. */
  author: string;
  /** Year of first publication. */
  year: number;
  /** One line on why it's worth reading. */
  why: string;
}

export interface Topic {
  id: string;
  name: string;
  books: Candidate[];
}

/** What Open Library said about a candidate, kept in data/reading/openlibrary.json. */
export interface Check {
  /**
   * verified:   a work with this title by this author
   * not-found:  nothing with this title by this author
   * ambiguous:  the title exists, but only by other authors
   */
  status: 'verified' | 'not-found' | 'ambiguous';
  /** YYYY-MM-DD */
  checked: string;
  work?: string;
  cover?: number;
  olTitle?: string;
  olAuthors?: string[];
  olYear?: number;
  editions?: number;
  note?: string;
}

/** The fields asked of Open Library's search API. */
export const SEARCH_FIELDS = 'key,title,subtitle,author_name,first_publish_year,cover_i,edition_count';

/** One result from https://openlibrary.org/search.json. */
export interface SearchDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  edition_count?: number;
}

/** How far Open Library's first-publication year may be from ours before it's flagged. */
export const YEAR_TOLERANCE = 2;

export const candidateKey = (c: Pick<Candidate, 'title' | 'author'>) => `${c.title} | ${c.author}`;

/** Lower case, no accents or punctuation, "&" as "and", no leading article. */
export function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/** The title before any subtitle. */
export const mainTitle = (s: string) => s.split(/:|;|\s[–—/=]\s|(?<=[!?])\s+(?=[A-Z])/)[0].trim();

/** The title to search by: the main title without a trailing date range ("…, ca. 3000–323 BC"). */
export function searchTitle(s: string): string {
  const main = mainTitle(s);
  return main.replace(/,?\s*(c\.|ca\.)?\s*\d.*$/, '').trim() || main;
}

/** A normalised main title with any trailing dates dropped ("hitler" for "Hitler, 1889–1936"). */
export function coreTitle(s: string): string {
  const words = norm(mainTitle(s)).split(' ');
  while (words.length > 1 && /^(\d+|bc|ad|bce|ce|ca|c|b|to)$/.test(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** The first author's surname, normalised ("Tuchman" for "Barbara W. Tuchman"). */
export function surname(author: string): string {
  const first = author.split(/\s+(?:and|&)\s+|,\s*/)[0];
  const words = norm(first)
    .split(' ')
    .filter((w) => w && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w));
  return words[words.length - 1] ?? '';
}

/**
 * How well a result's title matches ours: 4 the full title (with subtitle),
 * 3 the main title, 2 the main title without dates, 1 ours begins theirs
 * (Open Library sometimes adds "Part 1 of 3"; only for titles of three words
 * or more), 0 not at all.
 */
export function titleScore(c: Pick<Candidate, 'title'>, doc: SearchDoc): number {
  if (!doc.title) return 0;
  const docFull = doc.subtitle ? `${doc.title}: ${doc.subtitle}` : doc.title;
  if (norm(c.title) === norm(docFull) || norm(c.title) === norm(doc.title)) return 4;
  if (norm(mainTitle(c.title)) === norm(mainTitle(doc.title))) return 3;
  const want = coreTitle(c.title);
  const got = coreTitle(doc.title);
  if (want && want === got) return 2;
  if (want.split(' ').length >= 3 && got.startsWith(`${want} `)) return 1;
  return 0;
}

export const titleMatches = (c: Pick<Candidate, 'title'>, doc: SearchDoc) => titleScore(c, doc) > 0;

export function authorMatches(c: Pick<Candidate, 'author'>, doc: SearchDoc): boolean {
  const s = surname(c.author);
  if (!s) return false;
  return (doc.author_name ?? []).some((name) => {
    const words = norm(name).split(' ');
    // "Mac Donald" for MacDonald, "De Witte" for de Witte.
    return words.some((w, i) => w === s || (i > 0 && words[i - 1] + w === s));
  });
}

/** Decides what a set of search results says about a candidate. */
export function judge(c: Candidate, docs: SearchDoc[], today: string): Check {
  const titled = docs.filter((d) => titleMatches(c, d) && /^\/works\/OL\d+W$/.test(d.key ?? ''));
  const matched = titled.filter((d) => authorMatches(c, d));
  if (!matched.length) {
    if (titled.length) {
      const others = [...new Set(titled.flatMap((d) => d.author_name ?? []))].slice(0, 3);
      return { status: 'ambiguous', checked: today, note: `title found, but by ${others.join(', ') || 'unknown authors'}` };
    }
    return { status: 'not-found', checked: today, note: docs.length ? `${docs.length} result(s), none with this title` : 'no results' };
  }
  // The closest title wins (a full or main title counts the same); then a
  // work first published when ours was, which tells apart an author's two
  // books of one title (Cornwell's Waterloo history from his Sharpe novel);
  // then, as Open Library often has duplicate works for one book, the
  // best-catalogued.
  const tier = (d: SearchDoc) => Math.min(3, titleScore(c, d));
  const near = (d: SearchDoc) => (d.first_publish_year != null && Math.abs(d.first_publish_year - c.year) <= YEAR_TOLERANCE ? 1 : 0);
  matched.sort((a, b) => tier(b) - tier(a) || near(b) - near(a) || (b.edition_count ?? 0) - (a.edition_count ?? 0));
  const best = matched[0];
  // A cover may come from a duplicate of the same book, never from a namesake.
  const twins = matched.filter((d) => tier(d) === tier(best) && (near(d) === near(best) || d.first_publish_year == null));
  const cover = best.cover_i ?? twins.find((d) => d.cover_i)?.cover_i;
  return {
    status: 'verified',
    checked: today,
    work: best.key!.replace('/works/', ''),
    ...(cover && cover > 0 ? { cover } : {}),
    olTitle: best.subtitle ? `${best.title}: ${best.subtitle}` : best.title,
    olAuthors: best.author_name ?? [],
    ...(Number.isInteger(best.first_publish_year) ? { olYear: best.first_publish_year } : {}),
    editions: best.edition_count ?? 0,
  };
}

/** A candidate whose year is more than YEAR_TOLERANCE from Open Library's earliest. */
export const yearMismatch = (c: Candidate, check: Check) => check.olYear != null && Math.abs(check.olYear - c.year) > YEAR_TOLERANCE;

export interface BuildResult {
  data: ReadingData;
  stats: {
    candidates: number;
    distinct: number;
    checked: number;
    verified: number;
    removed: { book: Candidate; where: string; check: Check }[];
    pending: { book: Candidate; where: string }[];
    yearFlags: { book: Candidate; where: string; check: Check }[];
    thinTopics: { id: string; verified: number }[];
    coverage: Record<number, number>;
    uncovered: string[];
    /** Every lookup ever recorded, including books since dropped or replaced. */
    history: { lookups: number; verified: number; failed: { key: string; check: Check; current: boolean }[] };
  };
}

const toBook = (c: Candidate, check: Check): Book => ({
  title: c.title,
  author: c.author,
  year: c.year,
  why: c.why,
  work: check.work!,
  ...(check.cover ? { cover: check.cover } : {}),
});

/**
 * The game's reading list: every recommended book Open Library confirmed,
 * and nothing else. Unchecked and unconfirmed books are left out.
 */
export function buildReading(
  topics: Topic[],
  events: Record<string, Candidate[]>,
  checks: Record<string, Check>,
  questions: Pick<Question, 'id' | 'topics'>[],
): BuildResult {
  const stats: BuildResult['stats'] = {
    candidates: 0,
    distinct: 0,
    checked: 0,
    verified: 0,
    removed: [],
    pending: [],
    yearFlags: [],
    thinTopics: [],
    coverage: {},
    uncovered: [],
    history: { lookups: 0, verified: 0, failed: [] },
  };
  const keep = (list: Candidate[], where: string): Book[] =>
    list.flatMap((c) => {
      stats.candidates++;
      const check = checks[candidateKey(c)];
      if (!check) {
        stats.pending.push({ book: c, where });
        return [];
      }
      stats.checked++;
      if (check.status !== 'verified' || !check.work) {
        stats.removed.push({ book: c, where, check });
        return [];
      }
      stats.verified++;
      if (yearMismatch(c, check)) stats.yearFlags.push({ book: c, where, check });
      return [toBook(c, check)];
    });

  const data: ReadingData = { topics: {}, events: {} };
  for (const t of topics) {
    const books = keep(t.books, t.id);
    data.topics[t.id] = { name: t.name, books };
    if (books.length < 3) stats.thinTopics.push({ id: t.id, verified: books.length });
  }
  for (const id of Object.keys(events).sort()) {
    const books = keep(events[id], id);
    if (books.length) data.events[id] = books;
  }
  const current = new Set([...topics.flatMap((t) => t.books), ...Object.values(events).flat()].map(candidateKey));
  stats.distinct = current.size;
  for (const key of Object.keys(checks).sort()) {
    stats.history.lookups++;
    if (checks[key].status === 'verified') stats.history.verified++;
    else stats.history.failed.push({ key, check: checks[key], current: current.has(key) });
  }
  for (const q of questions) {
    const n = booksFor(data, q).length;
    stats.coverage[n] = (stats.coverage[n] ?? 0) + 1;
    if (n < 2) stats.uncovered.push(q.id);
  }
  return { data, stats };
}

/** The report written to data/reading/REPORT.md. */
export function reportMarkdown(r: BuildResult, today: string): string {
  const s = r.stats;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
  const line = (x: { book: Candidate; where: string }) => `| ${x.where} | *${x.book.title}* | ${x.book.author} | ${x.book.year} |`;
  const out = [
    '# Further reading: verification report',
    '',
    `Written by \`npm run reading:verify\` on ${today}. Every book shown in the game`,
    'was found on Open Library by title and author; anything not found, or found',
    'only under another author, is left out of `src/data/reading.json`.',
    '',
    `- Recommended: **${s.candidates}** times, **${s.distinct}** different books (some serve several events)`,
    `- Checked against Open Library: **${s.checked}**`,
    `- Verified and shown: **${s.verified}** (pass rate ${pct(s.verified, s.checked)})`,
    `- Removed: **${s.removed.length}** (${pct(s.removed.length, s.checked)})`,
    `- Not yet checked: **${s.pending.length}**`,
    '',
    `Over every lookup so far, including books that failed and were replaced by`,
    `another recommendation: ${s.history.lookups} books looked up, ${s.history.verified} found`,
    `(${pct(s.history.verified, s.history.lookups)}), ${s.history.failed.length} not (${pct(s.history.failed.length, s.history.lookups)}).`,
    '',
    '## Books per question',
    '',
    '| Books shown | Questions |',
    '| --- | --- |',
    ...Object.entries(s.coverage)
      .sort(([a], [b]) => Number(b) - Number(a))
      .map(([n, count]) => `| ${n} | ${count} |`),
    '',
  ];
  if (s.uncovered.length) out.push(`Questions with fewer than two books: ${s.uncovered.join(', ')}`, '');
  out.push('## Removed books', '');
  if (s.removed.length) {
    out.push('| Topic or question | Title | Author | Year | Why removed |', '| --- | --- | --- | --- | --- |');
    for (const x of s.removed) out.push(`${line(x)} ${x.check.status}: ${x.check.note ?? ''} |`);
  } else out.push('None.');
  out.push('');
  const replaced = s.history.failed.filter((f) => !f.current);
  if (replaced.length) {
    out.push(
      '## Failed earlier and replaced',
      '',
      'Recommendations that Open Library could not confirm, since swapped for other books.',
      '',
      '| Book — author | Why removed |',
      '| --- | --- |',
      ...replaced.map((f) => `| ${f.key.replace(' | ', ' — ')} | ${f.check.status}: ${f.check.note ?? ''} |`),
      '',
    );
  }
  if (s.yearFlags.length) {
    out.push(
      '## Years that differ from Open Library',
      '',
      `Open Library's earliest edition is more than ${YEAR_TOLERANCE} years from ours. Often its data is`,
      'off (a misdated reprint, or the original of a translation); worth a look.',
      '',
      '| Topic or question | Title | Author | Our year | Open Library |',
      '| --- | --- | --- | --- | --- |',
      ...s.yearFlags.map((x) => `${line(x)} ${x.check.olYear} |`),
      '',
    );
  }
  if (s.thinTopics.length) {
    out.push('## Topics with fewer than three verified books', '', ...s.thinTopics.map((t) => `- ${t.id}: ${t.verified}`), '');
  }
  if (s.pending.length) {
    out.push('## Not yet checked', '', ...s.pending.map((x) => `- ${x.where}: *${x.book.title}* (${x.book.author})`), '');
  }
  return out.join('\n');
}
