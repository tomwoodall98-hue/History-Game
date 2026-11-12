/**
 * Short encyclopaedia entries from Wikipedia's REST page summary
 * (https://en.wikipedia.org/api/rest_v1/page/summary/<title>), for "Read
 * more". Every question's `source` is a Wikipedia article URL; its summary
 * gives the opening paragraph(s) as plain text and a thumbnail.
 *
 * Nothing here knows about questions or rounds: src/game/readMore.ts decides
 * when a question may be looked up (only once its guess is confirmed).
 */

export interface WikiImage {
  src: string;
  width: number;
  height: number;
  /** The file's page on Wikimedia Commons, which names its author and licence. */
  fileUrl: string;
}

export interface WikiSummary {
  /** The article's title, as Wikipedia gives it. */
  title: string;
  /** The summary extract as plain-text paragraphs. */
  paragraphs: string[];
  /** The article itself (after any redirect); null if Wikipedia didn't say. */
  pageUrl: string | null;
  /** The article's lead image, if it has a freely licensed one. */
  image: WikiImage | null;
}

/** How long to wait for a summary before showing the note and link alone. */
export const SUMMARY_TIMEOUT_MS = 4000;

const WIKIPEDIA_HOST = /^[a-z][a-z0-9-]*(\.m)?\.wikipedia\.org$/;

/** The https URL, if `url` is one on a Wikipedia host. */
function wikipediaUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && WIKIPEDIA_HOST.test(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** The article title in a Wikipedia URL ("Storming_of_the_Bastille"), or null. */
export function articleTitle(source: string): string | null {
  const u = wikipediaUrl(source);
  if (!u || !u.pathname.startsWith('/wiki/')) return null;
  let title: string;
  try {
    title = decodeURIComponent(u.pathname.slice('/wiki/'.length));
  } catch {
    return null;
  }
  title = title.replace(/ /g, '_');
  return title && !title.includes('#') ? title : null;
}

/** The REST summary endpoint for a Wikipedia article URL, or null if it isn't one. */
export function summaryUrl(source: string): string | null {
  const u = wikipediaUrl(source);
  const title = articleTitle(source);
  if (!u || !title) return null;
  const host = u.hostname.replace('.m.wikipedia.org', '.wikipedia.org');
  return `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

/** Removes any HTML tags and decodes character references. */
export function plainText(s: string): string {
  return s
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?[a-z!][^>]*>/gi, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] !== '#') return ENTITIES[ref.toLowerCase()] ?? whole;
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
}

/** Plain-text paragraphs from an extract: HTML stripped, blank lines dropped. */
export function plainParagraphs(extract: string): string[] {
  return plainText(extract)
    .split(/\n+/)
    .map((p) => p.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The thumbnail, if it comes from Wikimedia Commons. Every file there is
 * freely licensed; files kept on Wikipedia itself are often non-free
 * (posters, logos, recent photos) and aren't for reuse here.
 */
export function commonsImage(thumb: unknown): WikiImage | null {
  if (!thumb || typeof thumb !== 'object') return null;
  const { source, width, height } = thumb as { source?: unknown; width?: unknown; height?: unknown };
  if (typeof source !== 'string' || typeof width !== 'number' || typeof height !== 'number' || !(width > 0 && height > 0)) return null;
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)wikimedia\.org$/.test(u.hostname)) return null;
  // /wikipedia/commons/thumb/5/57/Name.jpg/330px-Name.jpg or /wikipedia/commons/5/57/Name.jpg
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'wikipedia' || parts[1] !== 'commons') return null;
  const file = parts[2] === 'thumb' ? parts[5] : parts[4];
  if (!file) return null;
  return { src: u.href, width, height, fileUrl: `https://commons.wikimedia.org/wiki/File:${file}` };
}

/**
 * A usable summary from the endpoint's JSON, or null for anything else
 * (a disambiguation page, an article with no extract, an error body).
 */
export function parseSummary(data: unknown): WikiSummary | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as {
    type?: unknown;
    title?: unknown;
    titles?: { normalized?: unknown };
    extract?: unknown;
    thumbnail?: unknown;
    content_urls?: { desktop?: { page?: unknown } };
  };
  if (d.type !== 'standard' || typeof d.extract !== 'string') return null;
  const paragraphs = plainParagraphs(d.extract);
  if (!paragraphs.length) return null;
  const rawTitle = typeof d.titles?.normalized === 'string' ? d.titles.normalized : typeof d.title === 'string' ? d.title : '';
  return {
    title: plainText(rawTitle).trim(),
    paragraphs,
    pageUrl: wikipediaUrl(d.content_urls?.desktop?.page)?.href ?? null,
    image: commonsImage(d.thumbnail),
  };
}

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * Fetches summaries, at most once per article for the session. A summary
 * that fails to arrive (network error, timeout, server error) is forgotten,
 * so opening it again tries again; a missing or unusable article is
 * remembered as null.
 */
export class SummaryCache {
  private readonly cache = new Map<string, Promise<WikiSummary | null>>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly timeoutMs = SUMMARY_TIMEOUT_MS,
  ) {}

  /** The summary for an article URL; null if there is none or it didn't arrive in time. Never rejects. */
  get(source: string): Promise<WikiSummary | null> {
    const url = summaryUrl(source);
    if (!url) return Promise.resolve(null);
    let entry = this.cache.get(url);
    if (!entry) {
      entry = this.load(url).catch(() => {
        this.cache.delete(url);
        return null;
      });
      this.cache.set(url, entry);
    }
    return entry;
  }

  private async load(url: string): Promise<WikiSummary | null> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('Wikipedia summary: timed out'));
      }, this.timeoutMs);
    });
    const request = (async () => {
      const res = await this.fetcher(url, { signal: abort.signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Wikipedia summary: HTTP ${res.status}`);
      return parseSummary(await res.json());
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      request.catch(() => {}); // a late failure after the timeout is of no interest
    }
  }
}
