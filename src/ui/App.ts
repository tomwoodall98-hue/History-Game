import type { GlobeView } from '../map/GlobeView';
import { cartoucheSVG, compassRoseSVG } from '../map/ornaments';
import type { LngLat, Question, Puzzle, SavedGame, Persistence, Clock, PastDay, PlayedGame, PuzzleMode, RoundResult } from '../game/types';
import { archiveDays, formatDateLabel, puzzleNumber, LAUNCH_DATE } from '../game/daily';
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
import type { StatsService } from '../game/statsApi';
import { betterThan, hardestQuestion, isEarlyDays, topPercent, type DayStats } from '../game/stats';
import { statsPlateSVG } from './statsPlate';
import { ReadMore } from '../game/readMore';
import type { SummaryCache } from '../game/wikipedia';
import type { ReadingList } from '../game/reading';
import { Gazetteer, type EntryOptions } from './gazetteer';
import { RollOfHonour } from './honours';
import { claimForm } from './claimForm';
import { projectedRank, projectionText, type Leaderboard } from '../game/leaderboard';
import { claimPromptDue, MAX_SNOOZES, SNOOZE_DAYS } from '../game/claimPrompt';
import { routeQuery } from '../game/route';
import { h, roman, countUp, copyText } from './dom';

type Phase = 'start' | 'guess' | 'reveal' | 'results' | 'review' | 'ledger' | 'honours';

const PIPS = 7;
/** Longest wait for the country outlines before scoring on distance alone. */
const COUNTRIES_WAIT_MS = 8000;

const floorNote = (floor: number) => `Right country, so at least ${formatNumber(floor)} points.`;

/** Link to a day (played, reviewed or practised), or (with no day) back to today's puzzle. */
const dayHref = (dateKey?: string, mode?: PuzzleMode) => `${location.pathname}${routeQuery(dateKey, mode)}`;

const monthLabel = (dateKey: string) => formatDateLabel(dateKey).split(' ').slice(2).join(' '); // "November 2026"
const shortDate = (dateKey: string) => formatDateLabel(dateKey).split(' ').slice(0, 3).join(' '); // "Monday 9 November"

/** Children for replaceChildren, skipping the ones left out (null). */
const nodes = (...xs: (Node | null | (Node | null)[])[]): Node[] => xs.flat().filter((x): x is Node => x != null);

/** The red rubber stamp that marks an archive, practice or review game. */
const archiveStamp = (label = 'Archive') => h('span', { class: 'archive-stamp' }, label);

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const knownDistance = (r: RoundResult) => r.guess != null && Number.isFinite(r.distanceKm);

/**
 * The rounds to review: the original in full, or (for a daily game saved
 * before guesses were kept) its scores alone, with no marks.
 */
function reviewRounds(played: PlayedGame, ids: string[]): RoundResult[] {
  return played.rounds ?? played.scores.map((score, i) => ({ questionId: ids[i] ?? '', guess: null, distanceKm: NaN, score }));
}

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
  /** The day's anonymous stats, as last fetched; null if unavailable. */
  private dayStats: DayStats | null = null;
  private statsState: 'loading' | 'ready' | 'unavailable' = 'loading';
  private statsFetchedAt = 0;
  private statsToken = 0;
  /** One submission attempt per visit: the finish, or a retry when the page is next opened. */
  private submitTried = false;
  /** Where the results screen shows stats, while it is open. */
  private statsSlot: HTMLElement | null = null;
  private averageCells: { cell: HTMLElement; row: HTMLElement; label: string }[] = [];
  /** Wikipedia, reachable only for questions already answered. */
  private readonly readMore: ReadMore;
  private readonly gazetteer: Gazetteer;
  /** The leaderboards, made the first time they are opened. */
  private honours: RollOfHonour | null = null;
  /** Played (the default), practice (never scored) or review (read-only). */
  private readonly mode: PuzzleMode;
  /** The day's original result, in practice and review. */
  private readonly original: PlayedGame | null;
  /** Reviewing a day whose guesses weren't kept, only its scores. */
  private readonly guessesMissing: boolean;
  /** The question shown in the step-by-step review, while it is open. */
  private stepAt: number | null = null;
  /** The player's name on the roll: undefined until known (or without stats), null for none. */
  private username: string | null | undefined = undefined;
  /** "Claim a username" under the masthead, for players without one. */
  private readonly claimLink: HTMLButtonElement;
  /** Where the results screen asks for a username, while it is open. */
  private claimSlot: HTMLElement | null = null;
  private claimRank: HTMLElement | null = null;
  private claimView: 'ask' | 'form' | 'done' | 'off' = 'ask';
  /** Today's board, for where the player would rank. */
  private todayBoard: Leaderboard | null = null;
  private boardRequested = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly map: GlobeView,
    private readonly puzzle: Puzzle,
    private readonly store: Persistence,
    private readonly clock: Clock,
    /** Country outlines for the same-country floor (scoring only); null if unavailable. */
    private readonly countries: () => Promise<CountryLookup | null>,
    /** Anonymous daily stats; null when not configured. */
    private readonly statsService: StatsService | null = null,
    /** Wikipedia summaries for "Read more"; null to offer the note and link alone. */
    summaries: SummaryCache | null = null,
    /** "Further reading" books for Read more; null to leave them out. */
    reading: ReadingList | null = null,
  ) {
    this.units = store.getUnits();
    const ids = puzzle.questions.map((q) => q.id);
    const fresh = (): SavedGame => ({ dateKey: puzzle.dateKey, puzzle: puzzle.number, questionIds: ids, rounds: [], pendingGuess: null, finished: false });
    const fits = (g: SavedGame | null) => (g && g.puzzle === puzzle.number && g.questionIds.join() === ids.join() ? g : null);
    const original = puzzle.mode === 'practice' || puzzle.mode === 'review' ? store.playedGame(puzzle.dateKey) : null;
    // There is nothing to review without an original result.
    this.mode = puzzle.mode === 'review' && !original ? 'play' : (puzzle.mode ?? 'play');
    this.original = original;
    this.guessesMissing = this.mode === 'review' && !original?.rounds;
    if (this.mode === 'review') {
      this.game = { ...fresh(), rounds: reviewRounds(original!, ids), finished: true };
    } else if (this.mode === 'practice') {
      // Each Replay is a fresh attempt; only one left unfinished carries on.
      const saved = fits(store.loadPracticeGame(puzzle.dateKey));
      this.game = saved && !saved.finished ? saved : fresh();
    } else {
      this.game = fits(puzzle.archive ? store.loadArchiveGame(puzzle.dateKey) : store.loadGame(puzzle.dateKey)) ?? fresh();
    }

    const label = this.mode === 'practice' ? 'Practice' : this.mode === 'review' ? 'Review' : puzzle.archive ? 'Archive' : null;
    this.header = h('header', { class: 'masthead' });
    this.header.innerHTML = cartoucheSVG({
      title: 'Chronomap',
      subtitle: label ? `${label} · No. ${puzzle.number}` : `No. ${puzzle.number}`,
      idPrefix: 'mh',
    });
    if (label) {
      this.header.append(archiveStamp(label));
      root.dataset.mode = label.toLowerCase();
    }
    this.claimLink = h('button', { class: 'claim-link', type: 'button', hidden: true, onclick: () => this.openClaim() }, 'Claim a username');
    this.header.append(this.claimLink);
    this.compass = h('div', { class: 'compass', 'aria-hidden': 'true', html: compassRoseSVG() });
    this.slip = h('section', { class: 'slip', 'aria-label': 'Question', hidden: true });
    this.panel = h('section', { class: 'panel', role: 'dialog', 'aria-modal': 'false' });
    this.panelVeil = h('div', { class: 'panel-veil', hidden: true }, this.panel);
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    root.append(this.compass, this.header, this.slip, this.panelVeil, this.live);
    this.readMore = new ReadMore(puzzle.questions, () => this.game.rounds, summaries, reading);
    this.gazetteer = new Gazetteer(root);

    map.onPick((p) => this.onPick(p));
    new ResizeObserver(() => this.updateInsets()).observe(this.slip);
    new ResizeObserver(() => this.updateInsets()).observe(this.header);
    window.addEventListener('resize', () => this.updateInsets());
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('keydown', () => (this.keyboardMode = true), true);
    document.addEventListener('pointerdown', () => (this.keyboardMode = false), true);
    if (statsService) void this.loadProfile();
  }

  /** Decide where to begin: intro, mid-game, today's results, or the first question to review. */
  start(): void {
    if (this.mode === 'review') this.showStep(0);
    else if (this.game.finished) this.showResults(false);
    else if (this.game.rounds.length > 0 || this.game.pendingGuess) this.beginRound();
    else this.showStart();
  }

  // ------------------------------------------------------------- layout ---

  /**
   * Tell the map which parts of it are covered by the slip and masthead, so
   * the whole-world view and fly-tos land in the visible area.
   */
  private updateInsets(): void {
    const mapRect = this.map.element.getBoundingClientRect();
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

  /** Saves progress where this mode keeps it. A review saves nothing; practice never touches a result. */
  private save(): void {
    if (this.mode === 'review') return;
    if (this.mode === 'practice') this.store.savePracticeGame(this.game);
    else if (this.puzzle.archive) this.store.saveArchiveGame(this.game);
    else this.store.saveGame(this.game);
  }

  private get originalTotal(): number | null {
    return this.original ? sum(this.original.scores) : null;
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
    const practice = this.mode === 'practice';
    this.panel.setAttribute(
      'aria-label',
      practice ? `Chronomap practice, puzzle number ${this.puzzle.number}` : this.puzzle.archive ? `Chronomap archive, puzzle number ${this.puzzle.number}` : 'Chronomap',
    );
    const begin = h('button', { class: 'ink-button big', type: 'button', onclick: () => this.begin() }, practice ? 'Begin practice' : 'Begin');
    const original = this.originalTotal;
    this.primary = begin;
    this.panel.replaceChildren(
      ...nodes(
        h('div', { class: 'start-cartouche', html: cartoucheSVG({ title: 'Chronomap', subtitle: 'A Daily Atlas of History', idPrefix: 'st' }) }),
        practice ? h('p', { class: 'start-stamp' }, archiveStamp('Practice')) : this.puzzle.archive ? h('p', { class: 'start-stamp' }, archiveStamp()) : null,
        h('p', { class: 'start-date' }, this.puzzle.dateLabel),
        h('p', { class: 'start-number' }, `Puzzle No. ${this.puzzle.number}`),
        h('div', { class: 'rule', 'aria-hidden': 'true' }),
        h(
          'p',
          { class: 'start-blurb' },
          'Seven events from history, each with its date. Mark on the globe where each one took place: the nearer your mark, the more points you score, up to 1,000 a round. The questions grow harder as you go.',
        ),
        practice
          ? h(
              'p',
              { class: 'archive-note practice-note' },
              h('strong', null, 'Practice: not scored. '),
              `Your original result${original != null ? ` of ${formatNumber(original)}` : ''} stays as it is. This replay never counts towards your streak, averages or the leaderboards.`,
            )
          : this.puzzle.archive
            ? h('p', { class: 'archive-note' }, `From the archive: this game is kept apart from your daily results and doesn't count towards your streak.`)
            : null,
        this.helpList(),
        begin,
        this.archiveLinks(() => this.showStart()),
      ),
    );
    this.panelVeil.hidden = false;
    this.updateInsets();
    this.map.resetView(0);
    requestAnimationFrame(() => begin.focus());
  }

  /**
   * "Past puzzles", the Roll of Honour and "Claim a username" (with stats
   * on), and away from today's daily, "Today's puzzle" (and its review, once
   * it is played).
   */
  private archiveLinks(back: () => void): HTMLElement {
    const awayFromToday = this.puzzle.archive || this.mode !== 'play';
    const today = this.clock.todayKey();
    const reviewingToday = this.mode === 'review' && this.puzzle.dateKey === today;
    const todayPlayed = awayFromToday && !reviewingToday && this.store.playedGame(today) != null;
    return h(
      'p',
      { class: 'archive-links' },
      h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.showLedger(back) }, 'Past puzzles'),
      this.statsService
        ? h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.showHonours(back) }, 'Roll of Honour')
        : null,
      this.statsService
        ? h(
            'button',
            { class: 'ink-button subtle claim-open', type: 'button', hidden: this.username !== null, onclick: () => this.showHonours(back, true) },
            'Claim a username',
          )
        : null,
      awayFromToday ? h('a', { class: 'ink-button subtle', href: dayHref() }, 'Today’s puzzle') : null,
      todayPlayed ? h('a', { class: 'ink-button subtle', href: dayHref(today, 'review') }, 'Review today’s puzzle') : null,
    );
  }

  /** How-to-play notes; folded away once the player has seen them. */
  private helpList(): HTMLElement {
    const list = h(
      'ul',
      { class: 'start-help' },
      h('li', null, 'Drag to turn the globe; scroll, pinch or use the buttons to zoom.'),
      h('li', null, 'Click or tap to place your mark, then confirm.'),
      h('li', null, 'Keyboard: arrows turn, + and − zoom, Space marks the centre, Enter confirms.'),
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
    const hint = h('p', { class: 'slip-hint' }, 'Click or tap the globe to place your mark.');
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
    if (this.keyboardMode) requestAnimationFrame(() => this.map.element.focus({ preventScroll: true }));
  }

  private pips(i: number): HTMLElement {
    return h(
      'span',
      { class: 'pips', role: 'img', 'aria-label': `Difficulty ${i + 1} of ${PIPS}` },
      ...Array.from({ length: PIPS }, (_, p) => h('span', { class: p <= i ? 'pip on' : 'pip' })),
    );
  }

  private slipHeader(i: number): HTMLElement {
    return h(
      'div',
      { class: 'slip-header' },
      h('span', { class: 'round-label' }, `${this.mode === 'practice' ? 'Practice · ' : ''}Round ${roman(i + 1)} of ${roman(ROUNDS)}`),
      this.pips(i),
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
        this.readMoreButton(i, { label: last ? 'See results' : 'Next question', go: () => next.click() }) ?? h('span'),
        next,
      ),
    );
    this.slip.hidden = false;
    this.updateInsets();
    // The guess is locked in, so the entry can be fetched while the reveal plays.
    this.readMore.prefetch(i);
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
    this.stepAt = null;
    this.slip.hidden = true;
    this.map.setPickEnabled(false);
    this.map.clearMarkers();
    const rounds = this.game.rounds;
    const scores = rounds.map((r) => r.score);
    this.map.showReview(this.reviewItems());

    const mode = this.mode;
    const archive = this.puzzle.archive;
    const playing = mode === 'play';
    const todayDaily = playing && !archive;
    const practice = mode === 'practice';

    const totalEl = h('span', { class: 'total-value' }, animate ? '0' : formatNumber(this.total));
    const step = h(
      'button',
      { class: playing ? 'ink-button subtle' : 'ink-button primary', type: 'button', onclick: () => this.showStep(0) },
      todayDaily ? 'Review today’s puzzle' : mode === 'review' ? 'Step through again' : 'Review question by question',
    );
    let shareRow: HTMLElement | null = null;
    if (playing) {
      // Practice and reviews are never shared: they aren't results.
      const shareBtn = h('button', { class: 'ink-button primary', type: 'button' }, 'Share result');
      const shareStatus = h('span', { class: 'share-status', role: 'status' });
      shareBtn.addEventListener('click', async () => {
        const url = location.href.split('#')[0].split('?')[0];
        const top = this.dayStats ? topPercent(this.dayStats) : null;
        const text = shareText(this.puzzle.number, scores, url, archive, top);
        const ok = await copyText(text);
        shareStatus.textContent = ok ? 'Copied to clipboard' : 'Could not copy. Please copy it by hand.';
        if (!ok) shareStatus.append(h('pre', { class: 'share-fallback' }, text));
        window.setTimeout(() => (shareStatus.textContent = ''), 4000);
      });
      shareRow = h('div', { class: 'share-row' }, shareBtn, shareStatus);
      this.primary = shareBtn;
    } else {
      this.primary = step;
    }

    this.averageCells = [];
    const table = h(
      'ol',
      { class: 'breakdown' },
      ...rounds.map((r, i) => {
        const q = this.question(i);
        const dist = knownDistance(r) ? formatDistance(r.distanceKm, this.units) : null;
        const label = `Round ${i + 1}: ${q.event}, ${formatNumber(r.score)} points${dist ? `, ${dist} away` : ''}`;
        const average = h('span', { class: 'b-avg', 'aria-hidden': 'true' });
        const row = h(
          'button',
          { type: 'button', class: 'breakdown-row', 'aria-label': `${label}. Review it on the map.`, onclick: () => this.showStep(i) },
          h('span', { class: 'b-num' }, roman(i + 1)),
          h('span', { class: 'b-title' }, q.event),
          h('span', { class: 'b-dist' }, dist ?? '—'),
          h('span', { class: 'b-score' }, formatNumber(r.score)),
          h('span', { class: 'b-emoji', 'aria-hidden': 'true' }, emojiFor(r.score)),
        );
        this.averageCells.push({ cell: average, row, label });
        const more = this.readMoreButton(i);
        more?.setAttribute('aria-label', `Read more about ${q.event}`);
        if (more) more.className = 'b-more';
        return h('li', { class: 'breakdown-item' }, row, h('span', { class: 'b-sub' }, h('span', { class: 'b-date' }, q.dateDisplay), more), average);
      }),
    );
    this.statsSlot = this.statsService && playing ? h('section', { class: 'day-stats', 'aria-label': 'How everyone else did', 'aria-live': 'polite' }) : null;
    this.claimSlot = this.statsService && todayDaily ? h('section', { class: 'claim-prompt', 'aria-labelledby': 'claim-title', hidden: true }) : null;
    this.claimRank = this.claimSlot ? h('p', { class: 'claim-rank', hidden: true }) : null;

    const stats = this.store.stats();
    const countdown = h('span', { class: 'countdown-value' }, '');
    const original = this.originalTotal;
    const stampLabel = practice ? 'Practice' : mode === 'review' ? 'Review' : archive ? 'Archive' : null;
    this.panel.className = `panel panel-results${practice ? ' panel-practice' : ''}`;
    this.panel.setAttribute(
      'aria-label',
      `${practice ? 'Practice results' : mode === 'review' ? 'Review of' : 'Results for'} ${archive && playing ? 'archive ' : ''}puzzle number ${this.puzzle.number}`,
    );
    this.panel.replaceChildren(
      ...nodes(
        stampLabel ? h('p', { class: 'start-stamp' }, archiveStamp(stampLabel)) : null,
        h('p', { class: 'results-kicker' }, `Puzzle No. ${this.puzzle.number} · ${this.puzzle.dateLabel}`),
        h('h2', { class: 'results-title' }, practice ? 'Practice: not scored' : 'Your Atlas'),
        h('p', { class: 'total' }, totalEl, h('span', { class: 'total-max' }, ` / ${formatNumber(MAX_SCORE)}`)),
        practice && original != null
          ? h('p', { class: 'practice-compare' }, `Original: ${formatNumber(original)} · Practice: ${formatNumber(this.total)}`)
          : null,
        h('p', { class: 'emoji-row', 'aria-hidden': 'true' }, scores.map(emojiFor).join('')),
        this.claimSlot,
        table,
        this.statsSlot,
        shareRow,
        todayDaily
          ? [
              h(
                'dl',
                { class: 'stats' },
                h('div', null, h('dt', null, 'Played'), h('dd', null, String(stats.played))),
                h('div', null, h('dt', null, 'Streak'), h('dd', null, String(stats.currentStreak))),
                h('div', null, h('dt', null, 'Best streak'), h('dd', null, String(stats.maxStreak))),
                h('div', null, h('dt', null, 'Average'), h('dd', null, formatNumber(stats.averageScore))),
              ),
              h('p', { class: 'countdown' }, 'Next puzzle in ', countdown),
            ]
          : null,
        practice
          ? h('p', { class: 'archive-note' }, 'Practice games are never scored: your original result, streak, averages and the leaderboards are untouched.')
          : null,
        mode === 'review' && this.guessesMissing
          ? h('p', { class: 'archive-note' }, 'Your guesses weren’t recorded for this day, only your scores. The answers are all on the globe.')
          : null,
        playing && archive
          ? h('p', { class: 'archive-note' }, 'Archive games are kept apart from your daily results and don’t count towards your streak.')
          : null,
        h('p', { class: 'archive-links' }, step, h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.showExplore() }, 'Explore the globe')),
        this.archiveLinks(() => this.showResults(false)),
      ),
    );
    this.panelVeil.hidden = false;
    this.updateInsets();
    this.map.resetView(animate ? 700 : 0);
    if (animate) countUp(totalEl, this.total, formatNumber, 1100);
    if (todayDaily) this.startCountdown(countdown);
    this.renderClaimPrompt();
    // Fresh stats each time the results are opened (they fill up through the day).
    if (Date.now() - this.statsFetchedAt > 30_000) void this.refreshStats();
    else this.renderStats();
    this.announce(
      practice
        ? `Practice finished, not scored. ${formatNumber(this.total)} out of ${formatNumber(MAX_SCORE)}${original != null ? `; your original score was ${formatNumber(original)}` : ''}.`
        : mode === 'review'
          ? `Review of puzzle ${this.puzzle.number}: ${formatNumber(this.total)} out of ${formatNumber(MAX_SCORE)}.`
          : `Finished. ${formatNumber(this.total)} out of ${formatNumber(MAX_SCORE)}.`,
    );
    const focus = this.primary;
    requestAnimationFrame(() => focus?.focus({ preventScroll: true }));
  }

  /** Every round's mark and answer, for the review map. */
  private reviewItems(): { guess: LngLat | null; answer: LngLat }[] {
    return this.game.rounds.map((r, i) => ({ guess: r.guess, answer: [this.question(i).lng, this.question(i).lat] as LngLat }));
  }

  // -------------------------------------------------------- claim prompt ---

  /** Fetches the player's name, to know whether to offer one. Never throws. */
  private async loadProfile(): Promise<void> {
    const id = this.store.playerId();
    if (!id || !this.statsService) return; // a name couldn't be kept in this browser
    const profile = await this.statsService.profile(id);
    if (profile) this.setUsername(profile.username);
  }

  private setUsername(name: string | null): void {
    this.username = name;
    this.claimLink.hidden = name !== null;
    for (const el of this.root.querySelectorAll<HTMLElement>('.claim-open')) el.hidden = name !== null;
    this.renderClaimPrompt();
  }

  /** "Claim a username" from the masthead: the roll, then back to whatever was on screen. */
  private openClaim(): void {
    this.showHonours(this.resumeScreen(), true);
  }

  /** How to get back to the screen showing now. */
  private resumeScreen(): () => void {
    switch (this.phase) {
      case 'start':
        return () => this.showStart();
      case 'guess':
        return () => this.beginRound();
      case 'reveal': {
        const i = this.roundIndex - 1;
        return () => this.showReveal(i, false);
      }
      case 'review': {
        const i = this.stepAt;
        return i != null ? () => this.showStep(i) : () => this.showResults(false);
      }
      case 'ledger':
      case 'honours':
        return this.closeLedger ?? (() => this.start());
      default:
        return () => this.showResults(false);
    }
  }

  /**
   * Whether the end screen asks for a username: a finished daily, today,
   * from a player known to have no name, unless they put it off recently.
   */
  private claimEligible(): boolean {
    if (!this.statsService || this.mode !== 'play' || this.puzzle.archive || !this.game.finished) return false;
    if (this.claimView === 'done') return true;
    if (this.claimView === 'off' || this.username !== null) return false; // undefined: not known yet
    const today = this.clock.todayKey();
    if (this.game.dateKey !== today) return false;
    return this.claimView === 'form' || claimPromptDue(this.store.claimPrompt(), today);
  }

  private renderClaimPrompt(): void {
    const slot = this.claimSlot;
    if (!slot?.isConnected) return;
    if (!this.claimEligible()) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }
    slot.hidden = false;
    const title = h('h3', { class: 'claim-title', id: 'claim-title', tabindex: '-1' }, 'Claim your place on the leaderboard');
    if (this.claimView === 'done') {
      const roll = h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.showHonours(() => this.showResults(false)) }, 'See the Roll of Honour');
      slot.replaceChildren(
        h('h3', { class: 'claim-title', id: 'claim-title' }, 'Your name is on the roll'),
        h('p', { class: 'claim-blurb' }, 'Today’s score, and every daily game you’ve played in this browser, now count under ', h('strong', null, this.username ?? ''), '.'),
        h('p', { class: 'claim-actions' }, roll),
      );
      return;
    }
    if (!this.boardRequested) void this.loadTodayBoard();
    this.updateClaimRank();
    const rank = this.claimRank!;
    if (this.claimView === 'form') {
      if (slot.querySelector('form')) return; // already open: leave what is being typed alone
      const form = claimForm({
        service: this.statsService!,
        playerId: () => this.store.playerId(),
        current: null,
        id: 'claim-name',
        onCancel: () => {
          this.claimView = 'ask';
          this.renderClaimPrompt();
          slot.querySelector<HTMLElement>('.claim-choose')?.focus();
        },
        onClaimed: (name) => {
          this.claimView = 'done';
          this.honours?.named(name);
          this.setUsername(name);
          this.announce(`Your name, ${name}, is on the roll.`);
          slot.querySelector<HTMLElement>('button')?.focus();
        },
      });
      slot.replaceChildren(title, rank, form);
      form.querySelector('input')?.focus();
      return;
    }
    const choose = h(
      'button',
      {
        class: 'ink-button primary claim-choose',
        type: 'button',
        onclick: () => {
          this.claimView = 'form';
          this.renderClaimPrompt();
        },
      },
      'Choose a username',
    );
    const later = h('button', { class: 'ink-button subtle', type: 'button', onclick: () => this.snoozeClaim() }, 'Not now');
    slot.replaceChildren(
      title,
      rank,
      h('p', { class: 'claim-blurb' }, 'Choose a name for the Roll of Honour. No email, no password.'),
      h('p', { class: 'claim-actions' }, choose, later),
    );
  }

  /** "Not now": hidden for a few days; after a few of those, for good. */
  private snoozeClaim(): void {
    const today = this.clock.todayKey();
    this.store.snoozeClaimPrompt(today);
    this.claimView = 'off';
    this.renderClaimPrompt();
    const final = this.store.claimPrompt().snoozes >= MAX_SNOOZES;
    this.announce(
      final
        ? 'We won’t ask again. You can claim a username any time from the links below.'
        : `We’ll ask again in ${SNOOZE_DAYS} days. You can claim a username any time from the links below.`,
    );
    this.primary?.focus({ preventScroll: true });
  }

  private async loadTodayBoard(): Promise<void> {
    if (!this.statsService) return;
    this.boardRequested = true;
    const lb = await this.statsService.leaderboard('today', null);
    if (lb && lb.date === this.game.dateKey) this.todayBoard = lb;
    this.updateClaimRank();
  }

  /** "You'd be 4th of 37 today", once the board (or the day's stats) are in. */
  private updateClaimRank(): void {
    const el = this.claimRank;
    if (!el) return;
    const better = this.statsState === 'ready' && this.dayStats ? betterThan(this.dayStats) : null;
    const p = projectedRank(this.total, this.todayBoard, better);
    el.textContent = p ? projectionText(p) : '';
    el.hidden = !p;
  }

  // -------------------------------------------------------------- stats ---

  /** Submits today's result if it is due, then fetches the day's stats. Never throws. */
  private async refreshStats(): Promise<void> {
    if (!this.statsService || !this.game.finished || this.mode !== 'play') return;
    const token = ++this.statsToken;
    if (!this.dayStats) this.statsState = 'loading';
    this.renderStats();
    await this.submitIfDue();
    const stats = await this.statsService.stats(this.puzzle.dateKey, this.total);
    if (token !== this.statsToken) return;
    // Keep what we had if a refresh fails; say "unavailable" only with nothing to show.
    if (stats || !this.dayStats) {
      this.dayStats = stats;
      this.statsState = stats ? 'ready' : 'unavailable';
    }
    this.statsFetchedAt = Date.now();
    this.renderStats();
    this.updateClaimRank();
  }

  /**
   * Today's daily result goes to the stats once: when it is finished, or, if
   * that failed, on the next visit. Archive games never submit.
   */
  private async submitIfDue(): Promise<void> {
    const service = this.statsService;
    if (!service || this.submitTried || this.mode !== 'play' || this.puzzle.archive || !this.game.finished || this.game.rounds.length !== ROUNDS) return;
    const date = this.game.dateKey;
    if (date !== this.clock.todayKey()) return; // the database takes only today's results
    const state = this.store.submission(date);
    if (state.done || state.tries >= 2) return;
    const playerId = this.store.playerId();
    if (!playerId) return;
    this.submitTried = true;
    const rounds = this.game.rounds.map((r) => r.score);
    const ok = await service.submit({ playerId, date, total: rounds.reduce((a, b) => a + b, 0), rounds });
    this.store.recordSubmission(date, ok);
  }

  private renderStats(): void {
    const slot = this.statsSlot;
    if (!slot?.isConnected) return;
    const stats = this.statsState === 'ready' ? this.dayStats : null;
    const archive = this.puzzle.archive;
    const title = h('h3', { class: 'day-stats-title' }, archive ? 'That Day’s Returns' : 'The Day’s Returns');

    for (const [i, { cell, row, label }] of this.averageCells.entries()) {
      const avg = stats?.players ? stats.questionAverages[i] : null;
      cell.textContent = avg != null ? `avg ${formatNumber(avg)}` : '';
      row.setAttribute('aria-label', `${label}${avg != null ? `; everyone's average ${formatNumber(avg)}` : ''}. Show on map.`);
    }

    if (!stats) {
      const text = this.statsState === 'loading' ? 'Consulting the ledgers…' : 'Stats unavailable.';
      slot.replaceChildren(title, h('p', { class: 'day-stats-note' }, text));
      return;
    }
    if (stats.players === 0) {
      const text = archive ? 'No results were recorded for this day.' : 'No results in yet, so check back later.';
      slot.replaceChildren(title, h('p', { class: 'day-stats-note' }, text));
      return;
    }

    const n = stats.players;
    const explorers = `${formatNumber(n)} ${n === 1 ? 'explorer' : 'explorers'}`;
    const pct = betterThan(stats);
    const hardest = hardestQuestion(stats);
    const plate = h('div', { class: 'stats-plate', html: statsPlateSVG(stats, this.total, `plate${this.puzzle.number}`) });
    slot.replaceChildren(
      ...nodes(
        title,
        h(
          'p',
          { class: 'day-stats-line' },
          `${explorers} ${archive ? 'that day' : 'today'}`,
          h('span', { class: 'sep', 'aria-hidden': 'true' }, ' · '),
          `average ${formatNumber(stats.average ?? 0)}`,
        ),
        pct != null
          ? h('p', { class: 'day-stats-rank' }, archive ? 'You’d have scored better than ' : 'You scored better than ', h('strong', null, `${pct}%`), ' of players.')
          : null,
        plate,
        hardest != null && n > 1
          ? h('p', { class: 'day-stats-note' }, `Hardest question: ${roman(hardest + 1)}, averaging ${formatNumber(stats.questionAverages[hardest] ?? 0)}.`)
          : null,
        isEarlyDays(stats)
          ? h(
              'p',
              { class: 'day-stats-note' },
              archive ? `Only ${explorers} played that day.` : `Early days: only ${explorers} so far, so check back later.`,
            )
          : null,
        archive ? h('p', { class: 'day-stats-note' }, 'Archive games are compared, never counted.') : null,
      ),
    );
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
  private showExplore(): void {
    this.setPhase('review');
    this.stepAt = null;
    this.panelVeil.hidden = true;
    const back = h('button', { class: 'ink-button primary', type: 'button', onclick: () => this.closeReview() }, 'Back to results');
    this.primary = back;
    this.slip.className = 'slip slip-review';
    this.slip.replaceChildren(
      h(
        'div',
        { class: 'slip-body' },
        h(
          'p',
          { class: 'slip-hint' },
          this.guessesMissing
            ? 'Where history happened. Your guesses weren’t recorded for this day.'
            : 'Every mark you made, and where history happened. Turn and zoom the globe to explore.',
        ),
      ),
      h('div', { class: 'slip-actions' }, h('span'), back),
    );
    this.slip.hidden = false;
    this.updateInsets();
    this.map.highlightReview(null);
    requestAnimationFrame(() => back.focus({ preventScroll: true }));
  }

  /**
   * The review, one question at a time: the event and its date, the mark
   * and the answer with the arc between them, distance, score and Read more.
   */
  private showStep(i: number): void {
    const rounds = this.game.rounds;
    if (!rounds[i]) return;
    const entering = this.phase !== 'review';
    this.setPhase('review');
    this.stepAt = i;
    window.clearInterval(this.countdownTimer);
    this.panelVeil.hidden = true;
    this.map.setPickEnabled(false);
    // The marks and arcs are drawn once, on the way in; each step then turns to its own.
    if (entering) this.map.showReview(this.reviewItems());

    const n = rounds.length;
    const q = this.question(i);
    const r = rounds[i];
    const last = i === n - 1;
    const prev = h(
      'button',
      { class: 'ink-button subtle step-prev', type: 'button', disabled: i === 0, 'aria-label': 'Previous question', title: 'Previous question', onclick: () => this.showStep(i - 1) },
      '‹',
    );
    const next = h(
      'button',
      { class: 'ink-button primary', type: 'button', onclick: () => (last ? this.closeReview() : this.showStep(i + 1)) },
      last ? 'Done' : 'Next',
    );
    this.primary = next;
    const close = h('button', { class: 'step-close', type: 'button', 'aria-label': 'Close the review', onclick: () => this.closeReview() }, 'Close');
    const known = knownDistance(r);
    const distance = h('span', { class: 'distance-value' }, known ? formatDistance(r.distanceKm, this.units) : '');
    const grade = gradeFor(r.score);
    const missing = this.guessesMissing ? 'Your guesses weren’t recorded for this day.' : 'No mark was recorded for this question.';

    this.slip.className = `slip slip-reveal slip-step grade-${grade}`;
    this.slip.replaceChildren(
      h(
        'div',
        { class: 'slip-header' },
        h('span', { class: 'round-label' }, `${this.mode === 'practice' ? 'Practice' : 'Review'} · ${roman(i + 1)} of ${roman(n)}`),
        this.pips(i),
        close,
      ),
      h(
        'div',
        { class: 'slip-body' },
        h('h2', { class: 'event small', id: 'event-title' }, q.event, h('span', { class: 'event-date-inline' }, ` — ${q.dateDisplay}`)),
        h(
          'div',
          { class: 'result-line' },
          h('span', { class: `grade-chip grade-${grade}`, 'aria-hidden': 'true' }, emojiFor(r.score)),
          h('span', { class: 'points' }, formatNumber(r.score), ' points'),
          known
            ? [
                h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
                h('span', { class: 'distance' }, distance, ' away'),
                this.unitToggle(() => (distance.textContent = formatDistance(r.distanceKm, this.units))),
              ]
            : null,
        ),
        known ? null : h('p', { class: 'missing-note' }, missing),
        r.countryFloor ? h('p', { class: 'floor-note' }, floorNote(r.countryFloor)) : null,
        h('p', { class: 'note' }, q.note),
      ),
      h(
        'div',
        { class: 'slip-actions' },
        this.readMoreButton(i, { label: last ? 'Done' : 'Next question', go: () => next.click() }) ?? h('span'),
        h('span', { class: 'step-nav' }, prev, next),
      ),
    );
    this.slip.setAttribute('aria-labelledby', 'event-title');
    this.slip.hidden = false;
    this.updateInsets();
    this.map.highlightReview(i);
    this.announce(
      `Question ${i + 1} of ${n}. ${q.event}, ${q.dateDisplay}. ${formatNumber(r.score)} points${known ? `, ${formatDistance(r.distanceKm, this.units)} away` : `. ${missing}`}. ${q.note}`,
    );
    requestAnimationFrame(() => next.focus({ preventScroll: true }));
  }

  // ------------------------------------------------------------- ledger ---

  /** The almanac of past puzzles, like a page from a ledger. */
  private showLedger(back: () => void): void {
    this.setPhase('ledger');
    window.clearInterval(this.countdownTimer);
    this.slip.hidden = true;
    this.map.setPickEnabled(false);
    const today = this.clock.todayKey();
    const days = archiveDays(today);
    const past = this.store.pastDays(today);
    const close = h('button', { class: 'ink-button primary', type: 'button', onclick: () => back() }, 'Close');
    this.primary = close;
    this.closeLedger = back;

    const months: HTMLElement[] = [];
    let list: HTMLElement | null = null;
    let month = '';
    for (const d of days) {
      if (monthLabel(d) !== month) {
        month = monthLabel(d);
        list = h('ol', { class: 'ledger' });
        months.push(h('section', { class: 'ledger-month', 'aria-label': month }, h('h3', null, month), list));
      }
      list!.append(h('li', null, this.ledgerRow(d, past[d])));
    }

    this.panel.className = 'panel panel-ledger';
    this.panel.setAttribute('aria-label', 'Past puzzles');
    this.panel.replaceChildren(
      h('p', { class: 'results-kicker' }, `Every puzzle since ${formatDateLabel(LAUNCH_DATE).split(' ').slice(1).join(' ')}`),
      h('h2', { class: 'results-title' }, 'The Almanac'),
      h('div', { class: 'rule', 'aria-hidden': 'true' }),
      days.length
        ? h('div', { class: 'ledger-pages' }, months)
        : h('p', { class: 'archive-note' }, 'Nothing here yet: each day’s puzzle joins the almanac the day after.'),
      h('p', { class: 'archive-note' }, 'Today’s puzzle joins the almanac tomorrow. Archive games don’t count towards your streak.'),
      close,
    );
    this.panelVeil.hidden = false;
    this.panelVeil.scrollTop = 0;
    requestAnimationFrame(() => (this.panel.querySelector<HTMLElement>('a.ledger-row') ?? close).focus({ preventScroll: true }));
  }

  private closeLedger: (() => void) | null = null;

  // ------------------------------------------------------ roll of honour ---

  /** The leaderboards and the player's name, on a ledger page. */
  private showHonours(back: () => void, focusName = false): void {
    if (!this.statsService) return;
    this.setPhase('honours');
    window.clearInterval(this.countdownTimer);
    this.slip.hidden = true;
    this.map.setPickEnabled(false);
    const honours = (this.honours ??= new RollOfHonour(this.statsService, this.store, (name) => this.setUsername(name)));
    const close = h('button', { class: 'ink-button primary', type: 'button', onclick: () => back() }, 'Close');
    this.primary = close;
    this.closeLedger = back;
    this.panel.className = 'panel panel-honours';
    this.panel.setAttribute('aria-label', 'Roll of Honour');
    this.panel.replaceChildren(
      h('p', { class: 'results-kicker' }, 'Daily games, played on the day'),
      h('h2', { class: 'results-title' }, 'Roll of Honour'),
      h('div', { class: 'rule', 'aria-hidden': 'true' }),
      honours.element,
      close,
    );
    honours.open({ focusName });
    this.panelVeil.hidden = false;
    this.panelVeil.scrollTop = 0;
    // From "Claim a username", the name field takes focus once the profile is in.
    if (!focusName) requestAnimationFrame(() => honours.focusTarget.focus({ preventScroll: true }));
  }

  private ledgerRow(dateKey: string, day: PastDay | undefined): HTMLElement {
    const total = day ? day.scores.reduce((a, b) => a + b, 0) : 0;
    const label = `No. ${puzzleNumber(dateKey)}`;
    const date = shortDate(dateKey);
    let entry: HTMLElement;
    let spoken: string;
    if (!day) {
      entry = h('span', { class: 'ledger-entry unplayed' }, 'Unplayed');
      spoken = 'not played';
    } else if (!day.finished) {
      entry = h('span', { class: 'ledger-entry unplayed' }, `In progress · ${day.scores.length} of ${ROUNDS}`);
      spoken = `in progress, ${day.scores.length} of ${ROUNDS} rounds`;
    } else {
      entry = h(
        'span',
        { class: 'ledger-entry' },
        h('span', { class: 'ledger-squares', 'aria-hidden': 'true' }, day.scores.map(emojiFor).join('')),
        h('span', { class: 'ledger-score' }, formatNumber(total)),
      );
      spoken = `${formatNumber(total)} points${day.via === 'daily' ? ', played on the day' : ', from the archive'}`;
    }
    const cells = [
      h('span', { class: 'ledger-no' }, label),
      h('span', { class: 'ledger-date' }, date, day?.via === 'daily' && day.finished ? h('span', { class: 'ledger-ontheday' }, ' · on the day') : null),
      h('span', { class: 'ledger-leader', 'aria-hidden': 'true' }),
      entry,
    ];
    // A finished day is in the books: review it, or replay it as practice. Everything else opens in the archive.
    if (day?.finished) {
      const actions = h(
        'span',
        { class: 'ledger-actions' },
        h('a', { class: 'ledger-action', href: dayHref(dateKey, 'review'), 'aria-label': `Review ${label}, ${date}` }, 'Review'),
        h('a', { class: 'ledger-action', href: dayHref(dateKey, 'practice'), 'aria-label': `Replay ${label}, ${date}, as practice (not scored)` }, 'Replay'),
      );
      return h('div', { class: 'ledger-row done', role: 'group', 'aria-label': `${label}, ${date}: ${spoken}` }, cells, actions);
    }
    return h('a', { class: 'ledger-row', href: dayHref(dateKey), 'aria-label': `${label}, ${date}: ${spoken}. Open in the archive.` }, cells);
  }

  private closeReview(): void {
    this.slip.hidden = true;
    this.map.highlightReview(null);
    this.showResults(false);
  }

  // ---------------------------------------------------------- read more ---

  /** "Read more" for an answered question; nothing for one still to play. */
  private readMoreButton(i: number, next?: EntryOptions['next']): HTMLButtonElement | null {
    if (!this.readMore.unlocked(i)) return null;
    return h(
      'button',
      { class: 'ink-button subtle read-more', type: 'button', 'aria-haspopup': 'dialog', onclick: () => this.openEntry(i, next) },
      'Read more',
    );
  }

  private openEntry(i: number, next?: EntryOptions['next']): void {
    const articleUrl = this.readMore.articleUrl(i);
    if (!articleUrl) return;
    this.gazetteer.open({
      question: this.question(i),
      index: i,
      articleUrl,
      summary: this.readMore.summary(i),
      books: this.readMore.books(i),
      next,
    });
  }

  // ----------------------------------------------------------- keyboard ---

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    // The open entry handles its own keys (Escape closes it).
    if (this.gazetteer.isOpen) return;
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
    } else if (e.key === 'Escape' && (this.phase === 'ledger' || this.phase === 'honours')) {
      this.closeLedger?.();
    }
  }
}
