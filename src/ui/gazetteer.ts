/**
 * "Read more": an event's entry in a Victorian gazetteer, opened over the
 * game once its guess is confirmed. The entry leads with our own note and
 * follows it with Wikipedia's summary of the source article, if that comes
 * in time; otherwise the note and a link to the article stand alone.
 *
 * It is a modal <dialog>, closed by its buttons, Escape or a tap outside.
 * On the reveal screen it carries the next-question button too, so reading
 * never costs the player an extra tap.
 */
import type { Question } from '../game/types';
import type { WikiSummary } from '../game/wikipedia';
import { h, roman } from './dom';

export interface EntryOptions {
  question: Question;
  /** The question's place in the day's seven. */
  index: number;
  /** The Wikipedia article the entry comes from. */
  articleUrl: string;
  /** Wikipedia's summary; null when there is none or it didn't arrive in time. */
  summary: Promise<WikiSummary | null>;
  /** On the reveal screen: go on to the next question (or the results) from inside the entry. */
  next?: { label: string; go: () => void };
}

const LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';

const ORNAMENT =
  '<svg viewBox="0 0 120 12" aria-hidden="true"><path d="M2 6h46M72 6h46" stroke="currentColor" stroke-width="0.8"/><path d="M60 1.5l4.5 4.5-4.5 4.5-4.5-4.5z" fill="currentColor"/><circle cx="51" cy="6" r="1.3" fill="currentColor"/><circle cx="69" cy="6" r="1.3" fill="currentColor"/></svg>';

const external = (href: string, text: string, extra: Record<string, string> = {}) =>
  h('a', { href, target: '_blank', rel: 'noopener', ...extra }, text);

export class Gazetteer {
  readonly element: HTMLDialogElement;
  private returnFocus: HTMLElement | null = null;
  /** Bumped on every open and close, so a late summary never lands in the wrong entry. */
  private token = 0;
  private pressedBackdrop = false;

  constructor(parent: HTMLElement) {
    this.element = h('dialog', { class: 'gazetteer', 'aria-labelledby': 'gz-title' });
    // Escape: close our way (restoring focus), not just the browser's.
    this.element.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.close();
    });
    // A tap on the backdrop lands on the dialog itself; the sheet fills the rest.
    // Both ends of the tap must be outside, so a text selection dragged out doesn't close it.
    this.element.addEventListener('pointerdown', (e) => (this.pressedBackdrop = e.target === this.element));
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element && this.pressedBackdrop) this.close();
      this.pressedBackdrop = false;
    });
    parent.append(this.element);
  }

  get isOpen(): boolean {
    return this.element.open;
  }

  open(opts: EntryOptions): void {
    const token = ++this.token;
    const q = opts.question;
    if (!this.element.open) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    }

    const title = h('h2', { class: 'gz-title', id: 'gz-title', tabindex: '-1' }, q.event);
    const summarySlot = h(
      'div',
      { class: 'gz-summary', 'aria-busy': 'true' },
      h('p', { class: 'gz-loading' }, 'Consulting the gazetteer…'),
    );
    const continueLink = external(opts.articleUrl, 'Continue reading on Wikipedia', { class: 'gz-continue' });
    const sourceLink = external(opts.articleUrl, 'Wikipedia');
    const credit = h(
      'p',
      { class: 'gz-credit', hidden: true },
      'From ',
      sourceLink,
      ', ',
      external(LICENCE_URL, 'CC BY-SA', { rel: 'noopener license' }),
    );
    const close = h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.close() }, 'Close');
    const next = opts.next
      ? h(
          'button',
          {
            class: 'ink-button primary',
            type: 'button',
            onclick: () => {
              this.close(false);
              opts.next!.go();
            },
          },
          opts.next.label,
        )
      : null;

    const scroll = h(
      'div',
      { class: 'gz-scroll' },
      // In the scrolling page, so it never sits over the text; Close in the footer stays put.
      h('button', { class: 'gz-x', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: () => this.close() }, '×'),
      h(
        'header',
        { class: 'gz-head' },
        h('p', { class: 'gz-running' }, h('span', null, 'A Gazetteer of History'), h('span', null, `Round ${roman(opts.index + 1)}`)),
        title,
        h('p', { class: 'gz-date' }, q.dateDisplay),
      ),
      h('div', { class: 'gz-body' }, h('p', { class: 'gz-lead' }, q.note), summarySlot, h('p', { class: 'gz-more' }, continueLink), credit),
    );
    this.element.replaceChildren(
      h(
        'div',
        { class: 'gz-sheet' },
        scroll,
        h('footer', { class: 'gz-actions' }, close, next),
      ),
    );
    if (!this.element.open) this.element.showModal();
    scroll.scrollTop = 0;
    title.focus({ preventScroll: true });

    const fill = (s: WikiSummary | null) => {
      if (token !== this.token) return;
      summarySlot.removeAttribute('aria-busy');
      if (!s) {
        summarySlot.replaceChildren();
        summarySlot.hidden = true;
        return;
      }
      const page = s.pageUrl ?? opts.articleUrl;
      continueLink.href = page;
      sourceLink.href = page;
      summarySlot.replaceChildren(
        ...[
          h('div', { class: 'gz-rule', 'aria-hidden': 'true', html: ORNAMENT }),
          s.title ? h('h3', { class: 'gz-article' }, s.title) : null,
          s.image ? this.plate(s) : null,
          ...s.paragraphs.map((p) => h('p', null, p)),
        ].filter((n): n is HTMLElement => n != null),
      );
      credit.hidden = false;
    };
    opts.summary.then(fill, () => fill(null));
  }

  /** The article's picture, printed like an engraving, with a link to its author and licence. */
  private plate(s: WikiSummary): HTMLElement {
    const image = s.image!;
    const img = h('img', {
      src: image.src,
      width: String(image.width),
      height: String(image.height),
      alt: `Illustration from the Wikipedia article “${s.title}”`,
      decoding: 'async',
    });
    const figure = h(
      'figure',
      { class: 'gz-plate' },
      h('div', { class: 'gz-frame' }, img),
      h('figcaption', null, external(image.fileUrl, 'Picture: Wikimedia Commons')),
    );
    img.addEventListener('error', () => figure.remove());
    return figure;
  }

  /** Closes the entry, handing focus back to whatever opened it unless the caller moves it on. */
  close(restoreFocus = true): void {
    if (!this.element.open) return;
    this.token++;
    this.element.close();
    const back = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && back?.isConnected) back.focus({ preventScroll: true });
  }
}
