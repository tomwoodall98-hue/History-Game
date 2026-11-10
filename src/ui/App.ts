import type { MapView } from '../map/MapView';
import { cartoucheSVG, compassRoseSVG } from '../map/ornaments';
import type { LngLat, Question, Puzzle, SavedGame, Persistence, Clock } from '../game/types';
import {
  ROUNDS,
  MAX_SCORE,
  scoreGuess,
  gradeFor,
  emojiFor,
  formatDistance,
  formatNumber,
  shareText,
  type Units,
} from '../game/scoring';
import type { CountryLookup } from '../game/countries';
import { h, roman, countUp, copyText } from './dom';

type Phase = 'start' | 'guess' | 'reveal' | 'results' | 'review';

const PIPS = 7;
/** Longest wait for the country outlines before scoring on distance alone. */
const COUNTRIES_WAIT_MS = 8000;

const floorNote = (floor: number) => `Right country, so at least ${formatNumber(floor)} points.`;

export class App {
  private phase: Phase = 'start';
  private game: SavedGame;
  private units: Units;
  private readonly slip: HTMLElement;
  private readonly panelVeil: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly header: HTMLElement;
  private readonly live: HTMLElement;
  private readonly compass: HTMLElement;
  private primary: HTMLButtonElement | null = null;
  private countdownTimer = 0;
  private revealToken = 0;
  /** Last input type, so keyboard users get focus moved for them. */
  private keyboardMode = false;
  private confirming = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly map: MapView,
    private readonly puzzle: Puzzle,
    private readonly store: Persistence,
    private readonly clock: Clock,
    /** Country outlines for the same-country floor (scoring only); null if unavailable. */
    private readonly countries: () => Promise<CountryLookup | null>,
  ) {
    this.units = store.getUnits();
    const saved = store.loadGame(puzzle.dateKey);
    const ids = puzzle.questions.map((q) => q.id);
    this.game =
      saved && saved.puzzle === puzzle.number && saved.questionIds.join() === ids.join()
        ? saved
        : { dateKey: puzzle.dateKey, puzzle: puzzle.number, questionIds: ids, rounds: [], pendingGuess: null, finished: false };

    this.header = h('header', { class: 'masthead' });
    this.header.innerHTML = cartoucheSVG({ title: 'Chronomap', subtitle: `No. ${puzzle.number}`, idPrefix: 'mh' });
    this.compass = h('div', { class: 'compass', 'aria-hidden': 'true', html: compassRoseSVG() });
    this.slip = h('section', { class: 'slip', 'aria-label': 'Question', hidden: true });
    this.panel = h('section', { class: 'panel', role: 'dialog', 'aria-modal': 'false' });
    this.panelVeil = h('div', { class: 'panel-veil', hidden: true }, this.panel);
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    root.append(this.compass, this.header, this.slip, this.panelVeil, this.live);

    map.onPick((p) => this.onPick(p));
    new ResizeObserver(() => this.updateInsets()).observe(this.slip);
    new ResizeObserver(() => this.updateInsets()).observe(this.header);
    window.addEventListener('resize', () => this.updateInsets());
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('keydown', () => (this.keyboardMode = true), true);
    document.addEventListener('pointerdown', () => (this.keyboardMode = false), true);
  }

  /** Decide where to begin: intro, mid-game, or today's results. */
  start(): void {
    if (this.game.finished) this.showResults(false);
    else if (this.game.rounds.length > 0 || this.game.pendingGuess) this.beginRound();
    else this.showStart();
  }

  // ------------------------------------------------------------- layout ---

  /**
   * Tell the map which parts of it are covered by the slip and masthead, so
   * the whole-world view and fly-tos land in the visible area.
   */
  private updateInsets(): void {
    const mapRect = this.map.svg.getBoundingClientRect();
    if (!mapRect.height) return;
    const gap = 10;
    let bottom = 0;
    let right = 0;
    if (!this.slip.hidden) {
      const r = this.slip.getBoundingClientRect();
      // The stylesheet docks the slip at the bottom, or on the right on
      // short landscape screens; it says which via --slip-dock.
      const dock = getComputedStyle(this.slip).getPropertyValue('--slip-dock').trim();
      if (dock === 'right') right = Math.max(0, mapRect.right - r.left + gap);
      else bottom = Math.max(0, mapRect.bottom - r.top + gap);
    }
    // Lets the zoom buttons sit just above the slip on phones.
    this.root.style.setProperty('--slip-clearance', `${Math.round(bottom)}px`);
    // Reserve the masthead's band only if the whole-world view would run
    // underneath it (portrait screens); on wide screens it sits in the margin.
    let top = 0;
    const hr = this.header.getBoundingClientRect();
    if (hr.height && getComputedStyle(this.header).visibility !== 'hidden') {
      const sheet = this.map.fitRectFor({ top: 0, bottom, right });
      const overlaps = sheet.left < hr.right && sheet.right > hr.left && sheet.top < hr.bottom;
      if (overlaps) top = Math.max(0, hr.bottom - mapRect.top + gap);
    }
    this.map.setInsets({ top, bottom, right });
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.root.dataset.phase = phase;
  }

  private announce(text: string): void {
    this.live.textContent = '';
    window.setTimeout(() => (this.live.textContent = text), 50);
  }

  private save(): void {
    this.store.saveGame(this.game);
  }

  private get roundIndex(): number {
    return this.game.rounds.length;
  }

  private get total(): number {
    return this.game.rounds.reduce((s, r) => s + r.score, 0);
  }

  private question(i: number): Question {
    return this.puzzle.questions[i];
  }

  // ------------------------------------------------------------ screens ---

  private showStart(): void {
    this.setPhase('start');
    this.slip.hidden = true;
    this.map.setPickEnabled(false);
    this.map.clearMarkers();
    this.panel.className = 'panel panel-start';
    this.panel.setAttribute('aria-label', 'Chronomap');
    const begin = h('button', { class: 'ink-button big', type: 'button', onclick: () => this.begin() }, 'Begin');
    this.primary = begin;
    this.panel.replaceChildren(
      h('div', { class: 'start-cartouche', html: cartoucheSVG({ title: 'Chronomap', subtitle: 'A Daily Atlas of History', idPrefix: 'st' }) }),
      h('p', { class: 'start-date' }, this.puzzle.dateLabel),
      h('p', { class: 'start-number' }, `Puzzle No. ${this.puzzle.number}`),
      h('div', { class: 'rule', 'aria-hidden': 'true' }),
      h(
        'p',
        { class: 'start-blurb' },
        'Seven events from history, each with its date. Mark on the map where each one took place: the nearer your mark, the more points you score, up to 1,000 a round. The questions grow harder as you go.',
      ),
      this.helpList(),
      begin,
    );
    this.panelVeil.hidden = false;
    this.updateInsets();
    this.map.resetView(0);
    requestAnimationFrame(() => begin.focus());
  }

  /** How-to-play notes; folded away once the player has seen them. */
  private helpList(): HTMLElement {
    const list = h(
      'ul',
      { class: 'start-help' },
      h('li', null, 'Drag to pan; scroll, pinch or use the buttons to zoom.'),
      h('li', null, 'Click or tap to place your mark, then confirm.'),
      h('li', null, 'Keyboard: arrows pan, + and − zoom, Space marks the centre, Enter confirms.'),
    );
    if (!this.store.hasSeenIntro()) return list;
    return h('details', { class: 'start-details' }, h('summary', null, 'How to play'), list);
  }

  private begin(): void {
    this.store.setSeenIntro();
    this.beginRound();
  }

  private beginRound(): void {
    const i = this.roundIndex;
    if (i >= ROUNDS) {
      this.finish();
      return;
    }
    this.revealToken++;
    this.setPhase('guess');
    this.panelVeil.hidden = true;
    this.map.clearReview();
    this.map.clearMarkers();
    const q = this.question(i);
    const confirm = h(
      'button',
      { class: 'ink-button primary', type: 'button', disabled: true, onclick: () => void this.confirm() },
      'Confirm',
    );
    this.primary = confirm;
    const hint = h('p', { class: 'slip-hint' }, 'Click or tap the map to place your mark.');
    this.slip.className = 'slip slip-question';
    this.slip.replaceChildren(
      this.slipHeader(i),
      h(
        'div',
        { class: 'slip-body' },
        h('h2', { class: 'event', id: 'event-title' }, q.event),
        h('p', { class: 'event-date' }, q.dateDisplay),
      ),
      h('div', { class: 'slip-actions' }, hint, confirm),
    );
    this.slip.setAttribute('aria-labelledby', 'event-title');
    this.slip.hidden = false;
    this.map.setPickEnabled(true);
    if (this.game.pendingGuess) this.onPick(this.game.pendingGuess);
    this.updateInsets();
    this.map.resetView(i === 0 ? 0 : 700);
    this.announce(`Round ${i + 1} of ${ROUNDS}. ${q.event}, ${q.dateDisplay}. Place your mark on the map.`);
    // Keyboard players land on the map, ready to pan and press Space.
    if (this.keyboardMode) requestAnimationFrame(() => this.map.svg.focus({ preventScroll: true }));
  }

  private slipHeader(i: number): HTMLElement {
    const pips = h(
      'span',
      { class: 'pips', role: 'img', 'aria-label': `Difficulty ${i + 1} of ${PIPS}` },
      ...Array.from({ length: PIPS }, (_, p) => h('span', { class: p <= i ? 'pip on' : 'pip' })),
    );
    return h(
      'div',
      { class: 'slip-header' },
      h('span', { class: 'round-label' }, `Round ${roman(i + 1)} of ${roman(ROUNDS)}`),
      pips,
      h(
        'span',
        { class: 'running-total', 'aria-label': `Score so far ${formatNumber(this.total)}` },
        h('span', { class: 'running-label', 'aria-hidden': 'true' }, 'Score '),
        formatNumber(this.total),
      ),
    );
  }

  private onPick(p: LngLat): void {
    if (this.phase !== 'guess') return;
    this.map.setGuess(p);
    this.game.pendingGuess = p;
    this.save();
    if (this.primary) this.primary.disabled = false;
    const hint = this.slip.querySelector('.slip-hint');
    if (hint) hint.textContent = 'Click elsewhere to move your mark.';
  }

  private async confirm(): Promise<void> {
    if (this.phase !== 'guess' || this.confirming) return;
    const guess = this.map.getGuess();
    if (!guess) return;
    // The outlines normally arrived while the map was being read; if not, wait
    // for them (within reason) so the same-country floor isn't missed.
    this.confirming = true;
    this.map.setPickEnabled(false);
    if (this.primary) this.primary.disabled = true;
    const countries = await Promise.race([
      this.countries(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), COUNTRIES_WAIT_MS)),
    ]);
    this.confirming = false;
    const i = this.roundIndex;
    const q = this.question(i);
    const { distanceKm, score, countryFloor } = scoreGuess(q, guess, countries);
    this.game.rounds.push({ questionId: q.id, guess, distanceKm, score, ...(countryFloor ? { countryFloor } : {}) });
    this.game.pendingGuess = null;
    if (this.game.rounds.length >= ROUNDS) this.game.finished = true;
    this.save();
    this.showReveal(i, true);
  }

  private showReveal(i: number, animate: boolean): void {
    this.setPhase('reveal');
    this.map.setPickEnabled(false);
    const q = this.question(i);
    const r = this.game.rounds[i];
    const answer: LngLat = [q.lng, q.lat];
    const last = i === ROUNDS - 1;
    const next = h(
      'button',
      { class: 'ink-button primary', type: 'button', onclick: () => (last ? this.finish() : this.beginRound()) },
      last ? 'See results' : 'Next',
    );
    this.primary = next;
    const points = h('span', { class: 'points-value' }, animate ? '0' : formatNumber(r.score));
    const distance = h('span', { class: 'distance-value' }, formatDistance(r.distanceKm, this.units));
    const grade = gradeFor(r.score);
    this.slip.className = `slip slip-reveal grade-${grade}`;
    this.slip.replaceChildren(
      this.slipHeader(i),
      h(
        'div',
        { class: 'slip-body' },
        h('h2', { class: 'event small', id: 'event-title' }, q.event, h('span', { class: 'event-date-inline' }, ` — ${q.dateDisplay}`)),
        h(
          'div',
          { class: 'result-line' },
          h('span', { class: `grade-chip grade-${grade}`, 'aria-hidden': 'true' }, emojiFor(r.score)),
          h('span', { class: 'points' }, points, ' points'),
          h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          h('span', { class: 'distance' }, distance, ' away'),
          this.unitToggle(() => (distance.textContent = formatDistance(r.distanceKm, this.units))),
        ),
        r.countryFloor ? h('p', { class: 'floor-note' }, floorNote(r.countryFloor)) : null,
        h('p', { class: 'note' }, q.note),
      ),
      h(
        'div',
        { class: 'slip-actions' },
        h('a', { class: 'source-link', href: q.source, target: '_blank', rel: 'noopener' }, 'Read more'),
        next,
      ),
    );
    this.slip.hidden = false;
    this.updateInsets();
    const token = ++this.revealToken;
    const pts: LngLat[] = r.guess ? [r.guess, answer] : [answer];
    this.map.fitPoints(pts, animate ? 850 : 0, 12);
    if (animate) {
      countUp(points, r.score, formatNumber, 800);
      window.setTimeout(() => {
        if (token === this.revealToken) void this.map.showAnswer(answer, r.guess, true);
      }, 650);
    } else {
      void this.map.showAnswer(answer, r.guess, false);
    }
    this.announce(
      `${formatNumber(r.score)} points. Your mark was ${formatDistance(r.distanceKm, this.units)} from the answer. ${r.countryFloor ? `${floorNote(r.countryFloor)} ` : ''}${q.note}`,
    );
    requestAnimationFrame(() => next.focus({ preventScroll: true }));
  }

  private unitToggle(onChange: () => void): HTMLElement {
    const make = (u: Units, label: string) =>
      h(
        'button',
        {
          type: 'button',
          class: this.units === u ? 'unit on' : 'unit',
          'aria-pressed': String(this.units === u),
          onclick: (e: Event) => {
            this.units = u;
            this.store.setUnits(u);
            const group = (e.currentTarget as HTMLElement).parentElement!;
            for (const b of Array.from(group.children) as HTMLElement[]) {
              const on = b.dataset.unit === u;
              b.classList.toggle('on', on);
              b.setAttribute('aria-pressed', String(on));
            }
            onChange();
          },
          dataset: { unit: u },
        },
        label,
      );
    return h('span', { class: 'unit-toggle', role: 'group', 'aria-label': 'Distance units' }, make('km', 'km'), make('mi', 'mi'));
  }

  private finish(): void {
    this.game.finished = true;
    this.save();
    this.showResults(true);
  }

  private showResults(animate: boolean): void {
    this.setPhase('results');
    this.slip.hidden = true;
    this.map.setPickEnabled(false);
    this.map.clearMarkers();
    const rounds = this.game.rounds;
    const scores = rounds.map((r) => r.score);
    this.map.showReview(rounds.map((r, i) => ({ guess: r.guess, answer: [this.question(i).lng, this.question(i).lat] as LngLat })));

    const totalEl = h('span', { class: 'total-value' }, animate ? '0' : formatNumber(this.total));
    const shareBtn = h('button', { class: 'ink-button primary', type: 'button' }, 'Share result');
    const shareStatus = h('span', { class: 'share-status', role: 'status' });
    shareBtn.addEventListener('click', async () => {
      const url = location.href.split('#')[0].split('?')[0];
      const ok = await copyText(shareText(this.puzzle.number, scores, url));
      shareStatus.textContent = ok ? 'Copied to clipboard' : 'Could not copy. Please copy it by hand.';
      if (!ok) shareStatus.append(h('pre', { class: 'share-fallback' }, shareText(this.puzzle.number, scores, url)));
      window.setTimeout(() => (shareStatus.textContent = ''), 4000);
    });
    this.primary = shareBtn;

    const table = h(
      'ol',
      { class: 'breakdown' },
      ...rounds.map((r, i) => {
        const q = this.question(i);
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: 'breakdown-row',
              'aria-label': `Round ${i + 1}: ${q.event}, ${formatNumber(r.score)} points, ${formatDistance(r.distanceKm, this.units)} away. Show on map.`,
              onclick: () => this.showReview(i),
            },
            h('span', { class: 'b-num' }, roman(i + 1)),
            h('span', { class: 'b-event' }, h('span', { class: 'b-title' }, q.event), h('span', { class: 'b-date' }, q.dateDisplay)),
            h('span', { class: 'b-dist' }, formatDistance(r.distanceKm, this.units)),
            h('span', { class: 'b-score' }, formatNumber(r.score)),
            h('span', { class: 'b-emoji', 'aria-hidden': 'true' }, emojiFor(r.score)),
          ),
        );
      }),
    );

    const stats = this.store.stats();
    const countdown = h('span', { class: 'countdown-value' }, '');
    this.panel.className = 'panel panel-results';
    this.panel.setAttribute('aria-label', `Results for puzzle number ${this.puzzle.number}`);
    this.panel.replaceChildren(
      h('p', { class: 'results-kicker' }, `Puzzle No. ${this.puzzle.number} · ${this.puzzle.dateLabel}`),
      h('h2', { class: 'results-title' }, 'Your Atlas'),
      h(
        'p',
        { class: 'total' },
        totalEl,
        h('span', { class: 'total-max' }, ` / ${formatNumber(MAX_SCORE)}`),
      ),
      h('p', { class: 'emoji-row', 'aria-hidden': 'true' }, scores.map(emojiFor).join('')),
      table,
      h('div', { class: 'share-row' }, shareBtn, shareStatus),
      h(
        'dl',
        { class: 'stats' },
        h('div', null, h('dt', null, 'Played'), h('dd', null, String(stats.played))),
        h('div', null, h('dt', null, 'Streak'), h('dd', null, String(stats.currentStreak))),
        h('div', null, h('dt', null, 'Best streak'), h('dd', null, String(stats.maxStreak))),
        h('div', null, h('dt', null, 'Average'), h('dd', null, formatNumber(stats.averageScore))),
      ),
      h('p', { class: 'countdown' }, 'Next puzzle in ', countdown),
      h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.showReview(null) }, 'Explore the map'),
    );
    this.panelVeil.hidden = false;
    this.updateInsets();
    this.map.resetView(animate ? 700 : 0);
    if (animate) countUp(totalEl, this.total, formatNumber, 1100);
    this.startCountdown(countdown);
    this.announce(`Finished. ${formatNumber(this.total)} out of ${formatNumber(MAX_SCORE)}.`);
    requestAnimationFrame(() => shareBtn.focus({ preventScroll: true }));
  }

  private startCountdown(node: HTMLElement): void {
    window.clearInterval(this.countdownTimer);
    const tick = () => {
      const ms = this.clock.msUntilNext();
      if (ms <= 0 || this.clock.todayKey() !== this.puzzle.dateKey) {
        window.clearInterval(this.countdownTimer);
        node.replaceChildren(
          h('button', { class: 'ink-button subtle', type: 'button', onclick: () => location.reload() }, 'Play the new puzzle'),
        );
        return;
      }
      const s = Math.floor(ms / 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      node.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    };
    tick();
    this.countdownTimer = window.setInterval(tick, 1000);
  }

  /** Results map view: every guess and answer, with a slip to go back. */
  private showReview(index: number | null): void {
    this.setPhase('review');
    this.panelVeil.hidden = true;
    const back = h('button', { class: 'ink-button primary', type: 'button', onclick: () => this.closeReview() }, 'Back to results');
    this.primary = back;
    const q = index != null ? this.question(index) : null;
    const r = index != null ? this.game.rounds[index] : null;
    this.slip.className = 'slip slip-review';
    this.slip.replaceChildren(
      h(
        'div',
        { class: 'slip-body' },
        q && r
          ? [
              h('h2', { class: 'event small' }, `${roman(index! + 1)}. ${q.event}`, h('span', { class: 'event-date-inline' }, ` — ${q.dateDisplay}`)),
              h(
                'p',
                { class: 'result-line' },
                h('span', { class: 'grade-chip', 'aria-hidden': 'true' }, emojiFor(r.score)),
                ` ${formatNumber(r.score)} points · ${formatDistance(r.distanceKm, this.units)} away`,
              ),
              r.countryFloor ? h('p', { class: 'floor-note' }, floorNote(r.countryFloor)) : null,
              h('p', { class: 'note' }, q.note),
            ]
          : h('p', { class: 'slip-hint' }, 'Every mark you made, and where history happened. Pan and zoom to explore.'),
      ),
      h('div', { class: 'slip-actions' }, q ? h('a', { class: 'source-link', href: q.source, target: '_blank', rel: 'noopener' }, 'Read more') : h('span'), back),
    );
    this.slip.hidden = false;
    this.updateInsets();
    this.map.highlightReview(index);
    requestAnimationFrame(() => back.focus({ preventScroll: true }));
  }

  private closeReview(): void {
    this.slip.hidden = true;
    this.map.highlightReview(null);
    this.showResults(false);
  }

  // ----------------------------------------------------------- keyboard ---

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    const onControl = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Enter' && !onControl && this.primary && !this.primary.disabled && this.primary.isConnected) {
      e.preventDefault();
      this.primary.click();
    } else if ((e.key === 'n' || e.key === 'N') && this.phase === 'reveal' && !onControl) {
      this.primary?.click();
    } else if (e.key === 'Escape' && this.phase === 'review') {
      this.closeReview();
    }
  }
}
