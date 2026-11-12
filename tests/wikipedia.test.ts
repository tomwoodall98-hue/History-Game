import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SummaryCache,
  articleTitle,
  commonsImage,
  parseSummary,
  plainParagraphs,
  plainText,
  summaryUrl,
  type Fetcher,
} from '../src/game/wikipedia.ts';

// ------------------------------------------------------------------ URLs ---

test('the summary endpoint comes from the article URL', () => {
  assert.equal(
    summaryUrl('https://en.wikipedia.org/wiki/Storming_of_the_Bastille'),
    'https://en.wikipedia.org/api/rest_v1/page/summary/Storming_of_the_Bastille',
  );
  assert.equal(summaryUrl('https://en.wikipedia.org/wiki/Brasília'), 'https://en.wikipedia.org/api/rest_v1/page/summary/Bras%C3%ADlia');
  assert.equal(
    summaryUrl('https://en.wikipedia.org/wiki/1973_Chilean_coup_d%27état'),
    "https://en.wikipedia.org/api/rest_v1/page/summary/1973_Chilean_coup_d'%C3%A9tat",
  );
  assert.equal(summaryUrl('https://en.wikipedia.org/wiki/AC/DC'), 'https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC', 'a slash in a title');
  assert.equal(summaryUrl('https://en.m.wikipedia.org/wiki/Waterloo'), 'https://en.wikipedia.org/api/rest_v1/page/summary/Waterloo', 'the mobile site');
  assert.equal(summaryUrl('https://en.wikipedia.org/wiki/Battle_of_Waterloo#Aftermath'), 'https://en.wikipedia.org/api/rest_v1/page/summary/Battle_of_Waterloo');
  assert.equal(articleTitle('https://en.wikipedia.org/wiki/Christ_the_Redeemer_(statue)'), 'Christ_the_Redeemer_(statue)');
});

test('only Wikipedia article URLs are looked up', () => {
  for (const bad of [
    'http://en.wikipedia.org/wiki/Waterloo',
    'https://en.wikipedia.org.evil.example/wiki/Waterloo',
    'https://example.com/wiki/Waterloo',
    'https://en.wikipedia.org/w/index.php?title=Waterloo',
    'https://en.wikipedia.org/wiki/',
    'https://en.wikipedia.org/wiki/%E0%A4%A',
    'not a url',
    '',
  ]) {
    assert.equal(summaryUrl(bad), null, bad);
  }
});

// ------------------------------------------------------------------ text ---

test('HTML is stripped and entities decoded', () => {
  assert.equal(plainText('The <b>Battle</b> of <i>Hastings</i>'), 'The Battle of Hastings');
  assert.equal(plainText('a<script>alert(1)</script>b<style>p{}</style>c'), 'abc');
  assert.equal(plainText('<img src=x onerror=alert(1)>Caen &amp; Rouen&nbsp;&#8212;&#x2013;'), 'Caen & Rouen —–');
  assert.equal(plainText('&lt;b&gt; stays text'), '<b> stays text');
  assert.equal(plainText('a < b and c > d'), 'a < b and c > d', 'lone angle brackets are text');
  assert.equal(plainText('&#xD800;&#0;&bogus;'), '&bogus;');
});

test('extracts become plain paragraphs', () => {
  assert.deepEqual(plainParagraphs('<p>First  one.</p>\n\n<p>Second\tone.</p>\n  \n'), ['First one.', 'Second one.']);
  assert.deepEqual(plainParagraphs(''), []);
});

// --------------------------------------------------------------- summary ---

const standard = {
  type: 'standard',
  title: 'Storming of the Bastille',
  titles: { normalized: 'Storming of the Bastille' },
  extract: 'The <b>Storming of the Bastille</b> occurred in Paris.\nIt was a turning point.',
  thumbnail: {
    source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/57/Prise_de_la_Bastille.jpg/330px-Prise_de_la_Bastille.jpg',
    width: 330,
    height: 260,
  },
  content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Storming_of_the_Bastille' } },
};

test('a standard summary is read as plain text with its picture', () => {
  assert.deepEqual(parseSummary(standard), {
    title: 'Storming of the Bastille',
    paragraphs: ['The Storming of the Bastille occurred in Paris.', 'It was a turning point.'],
    pageUrl: 'https://en.wikipedia.org/wiki/Storming_of_the_Bastille',
    image: {
      src: standard.thumbnail.source,
      width: 330,
      height: 260,
      fileUrl: 'https://commons.wikimedia.org/wiki/File:Prise_de_la_Bastille.jpg',
    },
  });
});

test('disambiguation pages, empty extracts and odd bodies are not used', () => {
  assert.equal(parseSummary({ ...standard, type: 'disambiguation' }), null);
  assert.equal(parseSummary({ ...standard, extract: '  <p> </p> ' }), null);
  assert.equal(parseSummary({ ...standard, extract: undefined }), null);
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary('<html>'), null);
  assert.equal(parseSummary({ ...standard, content_urls: { desktop: { page: 'javascript:alert(1)' } } })?.pageUrl, null);
});

test('only pictures from Wikimedia Commons are shown', () => {
  const thumb = (source: string) => ({ source, width: 300, height: 200 });
  assert.equal(
    commonsImage(thumb('https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/330px-X.jpg?utm_source=en.wikipedia.org'))?.fileUrl,
    'https://commons.wikimedia.org/wiki/File:X.jpg',
  );
  assert.equal(commonsImage(thumb('https://upload.wikimedia.org/wikipedia/commons/a/ab/Small.png'))?.fileUrl, 'https://commons.wikimedia.org/wiki/File:Small.png');
  assert.equal(commonsImage(thumb('https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Poster.jpg/330px-Poster.jpg')), null, 'non-free files live on Wikipedia itself');
  assert.equal(commonsImage(thumb('http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg')), null);
  assert.equal(commonsImage(thumb('https://evil.example/wikipedia/commons/a/ab/X.jpg')), null);
  assert.equal(commonsImage({ source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg', width: 0, height: 10 }), null);
  assert.equal(commonsImage(undefined), null);
});

// ----------------------------------------------------------------- cache ---

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function recorder(respond: (url: string) => ReturnType<Fetcher>) {
  const urls: string[] = [];
  const fetcher: Fetcher = (url) => {
    urls.push(url);
    return respond(url);
  };
  return { urls, fetcher };
}

test('summaries are fetched once and kept for the session', async () => {
  const { urls, fetcher } = recorder(() => ok(standard));
  const cache = new SummaryCache(fetcher);
  const [a, b] = await Promise.all([cache.get('https://en.wikipedia.org/wiki/Storming_of_the_Bastille'), cache.get('https://en.wikipedia.org/wiki/Storming_of_the_Bastille')]);
  assert.equal(a?.title, 'Storming of the Bastille');
  assert.equal(a, b);
  assert.equal((await cache.get('https://en.wikipedia.org/wiki/Storming_of_the_Bastille'))?.title, 'Storming of the Bastille');
  assert.equal(urls.length, 1);
});

test('a failed fetch gives null and is tried again next time; a missing article is remembered', async () => {
  let fail = true;
  const { urls, fetcher } = recorder((url) =>
    url.endsWith('/Missing')
      ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
      : fail
        ? Promise.reject(new TypeError('offline'))
        : ok(standard),
  );
  const cache = new SummaryCache(fetcher);
  const src = 'https://en.wikipedia.org/wiki/Storming_of_the_Bastille';
  assert.equal(await cache.get(src), null);
  fail = false;
  assert.equal((await cache.get(src))?.title, 'Storming of the Bastille');
  assert.equal(await cache.get('https://en.wikipedia.org/wiki/Missing'), null);
  assert.equal(await cache.get('https://en.wikipedia.org/wiki/Missing'), null);
  assert.equal(urls.filter((u) => u.endsWith('/Missing')).length, 1);
  assert.equal(urls.length, 3);
});

test('a server error is not cached', async () => {
  const { urls, fetcher } = recorder(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }));
  const cache = new SummaryCache(fetcher);
  assert.equal(await cache.get('https://en.wikipedia.org/wiki/X'), null);
  assert.equal(await cache.get('https://en.wikipedia.org/wiki/X'), null);
  assert.equal(urls.length, 2);
});

test('a slow answer gives up after the timeout, aborting the request', async () => {
  let signal: AbortSignal | null = null;
  const cache = new SummaryCache((_, init) => {
    signal = init.signal;
    return new Promise(() => {}); // never answers
  }, 30);
  const started = Date.now();
  assert.equal(await cache.get('https://en.wikipedia.org/wiki/Slow'), null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(signal!.aborted, true);
});

test('nothing is fetched for a source that is not a Wikipedia article', async () => {
  const { urls, fetcher } = recorder(() => ok(standard));
  assert.equal(await new SummaryCache(fetcher).get('https://example.com/history'), null);
  assert.equal(urls.length, 0);
});
