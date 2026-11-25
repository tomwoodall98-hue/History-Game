/**
 * "Further reading" for Read more: two or three books on each event, from
 * src/data/reading.json.
 *
 * Every question is tagged with one or two topics (its `topics`), and each
 * topic has three books; a few events also have a book of their own. Every
 * book in the file has been found on Open Library (scripts/verify-reading.ts
 * builds the file and leaves out anything it couldn't confirm), and carries
 * the Open Library work it was matched to and, usually, a cover.
 *
 * The file is fetched the first time a Read more entry opens, never before,
 * and is not part of the script bundle. Like the Wikipedia summary, a
 * question's books are only asked for once its guess is confirmed (through
 * src/game/readMore.ts).
 */
import type { Question } from './types';

export interface Book {
  title: string;
  author: string;
  /** Year of first publication. */
  year: number;
  /** One line on why it's worth reading. */
  why: string;
  /** Open Library work id, e.g. "OL3378527W". */
  work: string;
  /** Open Library cover id, if it has one. */
  cover?: number;
}

export interface ReadingData {
  topics: Record<string, { name: string; books: Book[] }>;
  /** Books on a single event, by question id. */
  events: Record<string, Book[]>;
}

/** How many books an entry shows. */
export const BOOKS_PER_EVENT = 3;

/** The Open Library page for a book. */
export const workUrl = (book: Book) => `https://openlibrary.org/works/${encodeURIComponent(book.work)}`;

/** A medium-sized cover; Open Library answers 404 (not a blank) when there is none. */
export const coverUrl = (book: Book) =>
  book.cover != null ? `https://covers.openlibrary.org/b/id/${encodeURIComponent(String(book.cover))}-M.jpg?default=false` : null;

/**
 * The books for a question: its own book(s) first, then its topics' books
 * taken in turn (first of each topic, then second of each...), no book twice.
 */
export function booksFor(data: ReadingData, q: Pick<Question, 'id' | 'topics'>, max = BOOKS_PER_EVENT): Book[] {
  const out: Book[] = [];
  const seen = new Set<string>();
  const add = (b: Book | undefined) => {
    if (b && out.length < max && !seen.has(b.work)) {
      seen.add(b.work);
      out.push(b);
    }
  };
  for (const b of data.events[q.id] ?? []) add(b);
  const lists = (q.topics ?? []).map((t) => data.topics[t]?.books ?? []);
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const list of lists) add(list[i]);
  return out;
}

/** Shapes the downloaded file into ReadingData, dropping anything malformed. */
export function parseReading(raw: unknown): ReadingData {
  const data: ReadingData = { topics: {}, events: {} };
  if (!raw || typeof raw !== 'object') return data;
  const r = raw as { topics?: unknown; events?: unknown };
  const books = (list: unknown): Book[] =>
    Array.isArray(list)
      ? list.filter(
          (b): b is Book =>
            !!b &&
            typeof b === 'object' &&
            typeof b.title === 'string' &&
            typeof b.author === 'string' &&
            Number.isInteger(b.year) &&
            typeof b.why === 'string' &&
            typeof b.work === 'string' &&
            /^OL\d+W$/.test(b.work) &&
            (b.cover == null || (Number.isInteger(b.cover) && b.cover > 0)),
        )
      : [];
  if (r.topics && typeof r.topics === 'object') {
    for (const [id, t] of Object.entries(r.topics as Record<string, unknown>)) {
      if (t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string') {
        data.topics[id] = { name: (t as { name: string }).name, books: books((t as { books?: unknown }).books) };
      }
    }
  }
  if (r.events && typeof r.events === 'object') {
    for (const [id, list] of Object.entries(r.events as Record<string, unknown>)) data.events[id] = books(list);
  }
  return data;
}

/**
 * Loads the reading list once, when first asked. A failed download is
 * forgotten, so the next entry tries again.
 */
export class ReadingList {
  private data: Promise<ReadingData> | null = null;

  constructor(private readonly load: () => Promise<unknown>) {}

  /** A question's books; empty if there are none or the list couldn't be loaded. Never rejects. */
  books(q: Pick<Question, 'id' | 'topics'>): Promise<Book[]> {
    this.data ??= this.load()
      .then(parseReading)
      .catch((err) => {
        console.warn('Further reading could not be loaded', err);
        this.data = null;
        return { topics: {}, events: {} };
      });
    return this.data.then((d) => booksFor(d, q));
  }
}
