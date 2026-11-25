/**
 * "Further reading": the shipped book list holds only books Open Library
 * confirmed, every question gets two or three, and the panel shows them.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Question } from '../src/game/types.ts';
import { booksFor, coverUrl, parseReading, ReadingList, workUrl, type Book, type ReadingData } from '../src/game/reading.ts';
import {
  authorMatches,
  buildReading,
  candidateKey,
  coreTitle,
  judge,
  searchTitle,
  surname,
  titleScore,
  type Candidate,
  type Check,
  type Topic,
} from '../scripts/lib/reading.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = <T>(path: string) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as T;
const questions = json<Question[]>('src/data/questions.json');
const topics = json<Topic[]>('data/reading/topics.json');
const events = json<Record<string, Candidate[]>>('data/reading/events.json');
const checks = json<Record<string, Check>>('data/reading/openlibrary.json');
const shipped = json<ReadingData>('src/data/reading.json');

// ----------------------------------------------------------- the data ---

test('src/data/reading.json is exactly what the verified books build (no hand edits, nothing unchecked)', () => {
  const { data } = buildReading(topics, events, checks, questions);
  assert.deepEqual(shipped, data, 'rebuild it with `npm run reading:build`');
});

test('every book shown was verified on Open Library, under the same title and author', () => {
  const all = [...Object.values(shipped.topics).flatMap((t) => t.books), ...Object.values(shipped.events).flat()];
  assert.ok(all.length > 0);
  for (const b of all) {
    const check = checks[candidateKey(b)];
    assert.equal(check?.status, 'verified', `${b.title} (${b.author}) is not verified`);
    assert.equal(b.work, check.work);
    assert.match(b.work, /^OL\d+W$/);
  }
});

test('every question has one or two known topics, and every topic is used', () => {
  const ids = new Set(topics.map((t) => t.id));
  assert.equal(ids.size, topics.length, 'duplicate topic id');
  const used = new Set<string>();
  for (const q of questions) {
    assert.ok(q.topics && q.topics.length >= 1 && q.topics.length <= 2, `${q.id} needs one or two topics`);
    for (const t of q.topics!) {
      assert.ok(ids.has(t), `${q.id}: unknown topic "${t}"`);
      used.add(t);
    }
  }
  assert.deepEqual([...ids].filter((t) => !used.has(t)), [], 'topics no question uses');
  assert.ok(topics.length >= 100 && topics.length <= 200, `${topics.length} topics; keep the list tight`);
});

test('every topic recommends three books, each with a title, author, year and reason', () => {
  for (const t of topics) {
    assert.ok(t.name.trim(), `${t.id} has no name`);
    assert.equal(t.books.length, 3, `${t.id} should recommend three books`);
    for (const b of [...t.books, ...(events[t.id] ?? [])]) {
      assert.ok(b.title.trim() && b.author.trim() && b.why.trim(), `${t.id}: incomplete book`);
      assert.ok(Number.isInteger(b.year) && b.year > 1500 && b.year <= new Date().getFullYear(), `${t.id}: ${b.title} year ${b.year}`);
    }
  }
  const qids = new Set(questions.map((q) => q.id));
  for (const id of Object.keys(events)) assert.ok(qids.has(id), `events.json: unknown question ${id}`);
});

test('every question shows at least two books', () => {
  const short = questions.filter((q) => booksFor(shipped, q).length < 2).map((q) => q.id);
  assert.deepEqual(short, []);
});

// ------------------------------------------------------- the matching ---

const doc = (title: string, author: string[], extra: Record<string, unknown> = {}) => ({
  key: '/works/OL1W',
  title,
  author_name: author,
  edition_count: 5,
  ...extra,
});

test('titles match ignoring case, punctuation, subtitles and trailing dates', () => {
  const c = { title: 'A History of the Ancient Near East, ca. 3000–323 BC' };
  assert.equal(searchTitle(c.title), 'A History of the Ancient Near East');
  assert.equal(coreTitle('Hitler, 1889–1936: Hubris'), 'hitler');
  assert.ok(titleScore(c, doc('A history of the ancient Near East, ca. 3000-323 B.C', [])) > 0);
  assert.ok(titleScore({ title: 'Battle Cry of Freedom' }, doc('Battle Cry of Freedom Part 1 of 3', [])) > 0);
  assert.equal(titleScore({ title: 'The Maya' }, doc('Maya Cities', [])), 0, 'short titles must match exactly');
  assert.equal(titleScore({ title: 'Stalingrad' }, doc('Berlin', [])), 0);
  // The right volume beats a sibling with the same core title.
  const hubris = doc('Hitler, 1889-1936', ['Ian Kershaw'], { key: '/works/OL2W', edition_count: 3 });
  const nemesis = doc('Hitler, 1936-1945', ['Ian Kershaw'], { key: '/works/OL3W', edition_count: 30 });
  const pick = judge({ title: 'Hitler, 1889–1936: Hubris', author: 'Ian Kershaw', year: 1998, why: '' }, [nemesis, hubris], '2026-01-01');
  assert.equal(pick.work, 'OL2W');
});

test('an author’s two books of one title are told apart by year', () => {
  const novel = doc('Waterloo', ['Bernard Cornwell'], { key: '/works/OL4W', edition_count: 10, first_publish_year: 1990 });
  const history = doc('Waterloo', ['Bernard Cornwell'], { key: '/works/OL5W', edition_count: 4, first_publish_year: 2014 });
  const c: Candidate = { title: 'Waterloo: The History of Four Days, Three Armies and Three Battles', author: 'Bernard Cornwell', year: 2014, why: '' };
  assert.equal(judge(c, [novel, history], 'd').work, 'OL5W');
  // A full-title match on a minor duplicate doesn't beat the main work.
  const audio = doc('The Cold War', ['John Lewis Gaddis'], { key: '/works/OL6W', subtitle: 'A New History', edition_count: 1, first_publish_year: 2005 });
  const main = doc('The Cold War', ['John Lewis Gaddis'], { key: '/works/OL7W', edition_count: 40, first_publish_year: 2005 });
  assert.equal(judge({ title: 'The Cold War: A New History', author: 'John Lewis Gaddis', year: 2005, why: '' }, [audio, main], 'd').work, 'OL7W');
});

test('authors match by the first author’s surname', () => {
  assert.ok(authorMatches({ author: 'Laura M. MacDonald' }, doc('x', ['Laura M. Mac Donald'])));
  assert.ok(!authorMatches({ author: 'Laura M. MacDonald' }, doc('x', ['Laura Donald'])));
  assert.equal(surname('Barbara W. Tuchman'), 'tuchman');
  assert.equal(surname('Louis A. Pérez Jr.'), 'perez');
  assert.equal(surname('Will Durant and Ariel Durant'), 'durant');
  const c: Candidate = { title: 'The Guns of August', author: 'Barbara W. Tuchman', year: 1962, why: '' };
  assert.equal(judge(c, [doc('The Guns of August', ['Barbara Tuchman'], { cover_i: 42 })], 'd').status, 'verified');
  assert.equal(judge(c, [doc('The Guns of August', ['Someone Else'])], 'd').status, 'ambiguous');
  assert.equal(judge(c, [doc('The Proud Tower', ['Barbara Tuchman'])], 'd').status, 'not-found');
  assert.equal(judge(c, [], 'd').status, 'not-found');
});

test('a verified book keeps the best-catalogued work and a cover', () => {
  const c: Candidate = { title: 'The Guns of August', author: 'Barbara W. Tuchman', year: 1962, why: '' };
  const check = judge(
    c,
    [
      doc('the guns of august', ['Barbara Tuchman'], { key: '/works/OL9W', edition_count: 2, cover_i: 7 }),
      doc('The Guns of August', ['Barbara Tuchman'], { key: '/works/OL8W', edition_count: 52, first_publish_year: 1962 }),
    ],
    'd',
  );
  assert.equal(check.work, 'OL8W');
  assert.equal(check.cover, 7, 'a cover from a duplicate of the same book');
  assert.equal(check.olYear, 1962);
});

test('unchecked and unconfirmed books are left out of the build', () => {
  const book = (title: string): Candidate => ({ title, author: 'A. Writer', year: 2000, why: 'Good.' });
  const t: Topic[] = [{ id: 'x', name: 'X', books: [book('Found'), book('Missing'), book('Unchecked')] }];
  const c: Record<string, Check> = {
    [candidateKey(book('Found'))]: { status: 'verified', checked: 'd', work: 'OL5W', cover: 3 },
    [candidateKey(book('Missing'))]: { status: 'not-found', checked: 'd', note: 'no results' },
  };
  const r = buildReading(t, {}, c, [{ id: 'q', topics: ['x'] }]);
  assert.deepEqual(
    r.data.topics.x.books.map((b) => b.title),
    ['Found'],
  );
  assert.equal(r.stats.removed.length, 1);
  assert.equal(r.stats.pending.length, 1);
  assert.deepEqual(r.stats.uncovered, ['q']);
});

// --------------------------------------------------------- in the game ---

const B = (n: number, extra: Partial<Book> = {}): Book => ({ title: `Book ${n}`, author: 'A', year: 2000, why: 'Why.', work: `OL${n}W`, ...extra });

test('an event’s own book comes first, then its topics’ books in turn, without repeats', () => {
  const data: ReadingData = {
    topics: { a: { name: 'A', books: [B(1), B(2), B(3)] }, b: { name: 'B', books: [B(4), B(1), B(5)] } },
    events: { q: [B(9)] },
  };
  assert.deepEqual(booksFor(data, { id: 'q', topics: ['a', 'b'] }).map((b) => b.work), ['OL9W', 'OL1W', 'OL4W']);
  assert.deepEqual(booksFor(data, { id: 'r', topics: ['a', 'b'] }).map((b) => b.work), ['OL1W', 'OL4W', 'OL2W']);
  assert.deepEqual(booksFor(data, { id: 'r', topics: ['b'] }).map((b) => b.work), ['OL4W', 'OL1W', 'OL5W']);
  assert.deepEqual(booksFor(data, { id: 'r', topics: ['nope'] }), []);
  assert.deepEqual(booksFor(data, { id: 'r' }), []);
});

test('the downloaded list is checked before use', () => {
  const data = parseReading({
    topics: { a: { name: 'A', books: [B(1), { ...B(2), work: 'javascript:alert(1)' }, { ...B(3), cover: 'x' }, null] } },
    events: { q: [B(4, { cover: 12 })], r: 'nonsense' },
  });
  assert.deepEqual(data.topics.a.books.map((b) => b.work), ['OL1W']);
  assert.equal(data.events.q[0].cover, 12);
  assert.deepEqual(data.events.r, []);
  assert.deepEqual(parseReading(null), { topics: {}, events: {} });
  assert.equal(workUrl(B(1)), 'https://openlibrary.org/works/OL1W');
  assert.equal(coverUrl(B(1)), null);
  assert.equal(coverUrl(B(1, { cover: 99 })), 'https://covers.openlibrary.org/b/id/99-M.jpg?default=false');
});

test('the list is downloaded once, and again only after a failure', async () => {
  let calls = 0;
  let fail = true;
  const list = new ReadingList(async () => {
    calls++;
    if (fail) throw new Error('offline');
    return { topics: { a: { name: 'A', books: [B(1)] } }, events: {} };
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await list.books({ id: 'q', topics: ['a'] }), []);
    fail = false;
    assert.equal((await list.books({ id: 'q', topics: ['a'] })).length, 1);
    await list.books({ id: 'r', topics: ['a'] });
    assert.equal(calls, 2);
  } finally {
    console.warn = warn;
  }
});

// ------------------------------------------------------------ the panel ---

let Gazetteer: typeof import('../src/ui/gazetteer.ts').Gazetteer;

before(async () => {
  GlobalRegistrator.register({ url: 'https://chronomap.test/', width: 1024, height: 768 });
  ({ Gazetteer } = await import('../src/ui/gazetteer.ts'));
});

after(async () => {
  await GlobalRegistrator.unregister();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

function openEntry(books: Promise<Book[]>) {
  document.body.innerHTML = '';
  const g = new Gazetteer(document.body);
  // happy-dom's <dialog> may lack showModal.
  const dialog = g.element as HTMLDialogElement & { showModal?: () => void };
  if (typeof dialog.showModal !== 'function') dialog.showModal = () => dialog.setAttribute('open', '');
  g.open({ question: questions[0], index: 0, articleUrl: questions[0].source, summary: Promise.resolve(null), books });
  return g;
}

test('Further reading shows each book with its cover, author, year, reason and Open Library link', async () => {
  const g = openEntry(Promise.resolve([B(1, { cover: 55, title: 'The Collapse', author: 'Mary Elise Sarotte', year: 2014 }), B(2)]));
  await settle();
  const section = g.element.querySelector<HTMLElement>('.gz-reading')!;
  assert.equal(section.hidden, false);
  assert.match(section.textContent ?? '', /Further reading/);
  const items = section.querySelectorAll('.gz-book');
  assert.equal(items.length, 2);
  const first = items[0];
  assert.equal(first.querySelector('.gz-book-title a')?.getAttribute('href'), 'https://openlibrary.org/works/OL1W');
  assert.match(first.textContent ?? '', /Mary Elise Sarotte · 2014/);
  assert.match(first.textContent ?? '', /Why\./);
  const img = first.querySelector('img')!;
  assert.equal(img.getAttribute('loading'), 'lazy');
  assert.equal(img.getAttribute('src'), 'https://covers.openlibrary.org/b/id/55-M.jpg?default=false');
  assert.equal(items[1].querySelector('img'), null, 'no cover id, no cover');
  // A cover that fails to load is removed; the book stays.
  img.dispatchEvent(new Event('error'));
  assert.equal(first.querySelector('.gz-cover'), null);
  assert.ok(first.querySelector('.gz-book-title'));
  // It sits under the Wikipedia summary.
  const body = g.element.querySelector('.gz-body')!;
  const order = [...body.children].map((n) => n.className);
  assert.ok(order.indexOf('gz-reading') > order.indexOf('gz-summary'));
});

test('with no books, or no list, Further reading stays hidden', async () => {
  for (const books of [() => Promise.resolve([]), () => Promise.reject(new Error('x'))]) {
    const g = openEntry(books());
    await settle();
    const section = g.element.querySelector<HTMLElement>('.gz-reading')!;
    assert.equal(section.hidden, true);
    assert.equal(section.children.length, 0);
  }
});
