/**
 * The Roll of Honour: four leaderboards on a ruled ledger page with index
 * tabs, and the player's own entry (claim a name, recovery code, restore).
 * The data and rank logic live in game/leaderboard.ts; this is the DOM.
 */
import type { Persistence } from '../game/types';
import type { Profile, StatsService } from '../game/statsApi';
import {
  BOARDS,
  BOARD_TABS,
  BOARD_TITLES,
  VALUE_HEADINGS,
  displayBoard,
  ordinal,
  shortDay,
  showsGames,
  type Board,
  type Display,
  type Leaderboard,
} from '../game/leaderboard';
import { playerIdFromCode, recoveryCode } from '../game/recovery';
import { formatNumber } from '../game/scoring';
import { claimForm, UNREACHABLE } from './claimForm';
import { h, copyText } from './dom';

/** Boards fetched within this long are shown again without asking. */
const FRESH_MS = 60_000;

/** Children for replaceChildren, skipping the ones left out (null). */
const nodes = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x != null);

type ProfileState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'no-storage' } | { kind: 'ready'; profile: Profile };

export class RollOfHonour {
  readonly element: HTMLElement;
  private board: Board = 'today';
  private readonly cache = new Map<Board, { at: number; lb: Leaderboard | null }>();
  private readonly tabs = new Map<Board, HTMLButtonElement>();
  private readonly sheet: HTMLElement;
  private readonly profileSlot: HTMLElement;
  private readonly keySlot: HTMLElement;
  private profile: ProfileState = { kind: 'loading' };
  private boardToken = 0;
  private profileToken = 0;
  /** The name form is open (always, until a name is claimed). */
  private editing = false;
  /** Focus the name field once the profile has loaded (opened from "Claim a username"). */
  private focusName = false;

  constructor(
    private readonly service: StatsService,
    private readonly store: Persistence,
    /** Told the player's name (null for none) whenever the roll learns it. */
    private readonly onName: (username: string | null) => void = () => {},
  ) {
    const tablist = h('div', { class: 'honours-tabs', role: 'tablist', 'aria-label': 'Leaderboards' });
    for (const b of BOARDS) {
      const tab = h(
        'button',
        {
          type: 'button',
          class: 'honours-tab',
          role: 'tab',
          id: `honours-tab-${b}`,
          'aria-controls': 'honours-sheet',
          title: BOARD_TITLES[b],
          onclick: () => this.select(b),
          onkeydown: (e: KeyboardEvent) => this.onTabKey(e, b),
        },
        BOARD_TABS[b],
      );
      this.tabs.set(b, tab);
      tablist.append(tab);
    }
    this.sheet = h('div', { class: 'honours-sheet', id: 'honours-sheet', role: 'tabpanel', 'aria-live': 'polite' });
    this.profileSlot = h('section', { class: 'honours-profile', 'aria-label': 'Your name on the roll' });
    this.keySlot = h('div', { class: 'honours-keys' });
    this.element = h(
      'div',
      { class: 'honours' },
      h('div', { class: 'honours-book' }, tablist, this.sheet),
      this.profileSlot,
      this.keySlot,
      h('p', { class: 'archive-note' }, 'Only daily games played on the day count. Archive games never do.'),
    );
  }

  /** Call each time the roll is shown: refreshes whatever is stale. */
  open(opts: { focusName?: boolean } = {}): void {
    this.focusName = !!opts.focusName;
    void this.loadProfile();
    this.select(this.board, false);
    this.renderKeys();
  }

  /** A name claimed elsewhere (the end-screen prompt): show it here too. */
  named(username: string): void {
    const games = this.profile.kind === 'ready' ? this.profile.profile.games : 0;
    this.profile = { kind: 'ready', profile: { username, games } };
    this.editing = false;
    this.cache.clear();
    this.renderProfile();
  }

  /** The tab to focus when the roll opens. */
  get focusTarget(): HTMLElement {
    return this.tabs.get(this.board)!;
  }

  private get playerId(): string | null {
    return this.store.playerId();
  }

  // ------------------------------------------------------------- boards ---

  private select(board: Board, focus = false): void {
    this.board = board;
    for (const [b, tab] of this.tabs) {
      const on = b === board;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      tab.classList.toggle('on', on);
    }
    this.sheet.setAttribute('aria-labelledby', `honours-tab-${board}`);
    if (focus) this.tabs.get(board)!.focus();
    const cached = this.cache.get(board);
    if (cached && cached.lb && Date.now() - cached.at < FRESH_MS) this.renderBoard(cached.lb);
    else void this.loadBoard(board);
  }

  /** Arrow keys, Home and End move between the tabs. */
  private onTabKey(e: KeyboardEvent, board: Board): void {
    const i = BOARDS.indexOf(board);
    const n = BOARDS.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    this.select(BOARDS[to], true);
  }

  private async loadBoard(board: Board): Promise<void> {
    const token = ++this.boardToken;
    const cached = this.cache.get(board)?.lb;
    if (cached) this.renderBoard(cached);
    else this.renderSheet(h('p', { class: 'honours-note' }, 'Turning the pages…'));
    const lb = await this.service.leaderboard(board, this.playerId);
    if (lb) this.cache.set(board, { at: Date.now(), lb });
    if (token !== this.boardToken || board !== this.board) return;
    if (lb) this.renderBoard(lb);
    else if (!cached) this.renderSheet(h('p', { class: 'honours-note' }, UNREACHABLE));
  }

  private renderSheet(...content: Node[]): void {
    this.sheet.replaceChildren(h('h3', { class: 'honours-title' }, BOARD_TITLES[this.board]), ...content);
  }

  private renderBoard(lb: Leaderboard): void {
    const display = displayBoard(lb);
    const content: Node[] = [];
    if (lb.board === 'today') content.push(h('p', { class: 'honours-sub' }, shortDay(lb.date)));
    if (lb.board === 'average') content.push(h('p', { class: 'honours-sub' }, `At least ${lb.minGames} daily games`));
    content.push(display.rows.length ? this.table(lb, display) : h('p', { class: 'honours-note' }, emptyNote(lb)));
    const status = statusLine(display, lb);
    if (status) content.push(h('p', { class: 'honours-you' }, status));
    this.renderSheet(...content);
  }

  private table(lb: Leaderboard, display: Display): HTMLTableElement {
    const games = showsGames(lb.board);
    const cols = games ? 4 : 3;
    const head = h(
      'tr',
      null,
      h('th', { scope: 'col', class: 'roll-rank' }, 'No.'),
      h('th', { scope: 'col', class: 'roll-name' }, 'Name'),
      games ? h('th', { scope: 'col', class: 'roll-games' }, 'Games') : null,
      h('th', { scope: 'col', class: 'roll-value' }, VALUE_HEADINGS[lb.board]),
    );
    const body = display.rows.map((r) => {
      if (r.kind === 'gap') {
        const mark = h('span', { 'aria-hidden': 'true' }, '⁂');
        return h('tr', { class: 'roll-gap' }, h('td', { colspan: String(cols) }, mark, h('span', { class: 'sr-only' }, 'Others between')));
      }
      return h(
        'tr',
        { class: r.you ? 'roll-row you' : 'roll-row' },
        h('td', { class: 'roll-rank' }, r.rankLabel),
        h(
          'th',
          { scope: 'row', class: 'roll-name' },
          r.you ? h('span', { class: 'roll-hand', 'aria-hidden': 'true' }, '☞') : null,
          h('span', { class: 'roll-username' }, r.username),
          r.you ? h('span', { class: 'sr-only' }, ' (you)') : null,
          lb.board === 'best' && r.date ? h('span', { class: 'roll-date' }, shortDay(r.date)) : null,
        ),
        games ? h('td', { class: 'roll-games' }, r.games != null ? formatNumber(r.games) : '') : null,
        h('td', { class: 'roll-value' }, formatNumber(r.value)),
      );
    });
    return h(
      'table',
      { class: `roll roll-${lb.board}` },
      h('caption', { class: 'sr-only' }, `${BOARD_TITLES[lb.board]}: the top ${lb.rows.length}`),
      h('thead', null, head),
      h('tbody', null, body),
    );
  }

  // ------------------------------------------------------------ profile ---

  private async loadProfile(): Promise<void> {
    const id = this.playerId;
    const token = ++this.profileToken;
    if (!id) {
      this.profile = { kind: 'no-storage' };
      this.renderProfile();
      return;
    }
    if (this.profile.kind !== 'ready') {
      this.profile = { kind: 'loading' };
      this.renderProfile();
    }
    const profile = await this.service.profile(id);
    if (token !== this.profileToken) return;
    if (profile) this.profile = { kind: 'ready', profile };
    else if (this.profile.kind !== 'ready') this.profile = { kind: 'unavailable' };
    this.renderProfile();
    if (profile) this.onName(profile.username);
    if (this.focusName) {
      this.focusName = false;
      this.profileSlot.querySelector<HTMLInputElement>('#honours-name')?.focus();
    }
  }

  private renderProfile(message?: string): void {
    const slot = this.profileSlot;
    const p = this.profile;
    if (p.kind === 'loading') {
      slot.replaceChildren(h('p', { class: 'honours-note' }, 'Consulting the register…'));
      return;
    }
    if (p.kind === 'no-storage') {
      slot.replaceChildren(h('p', { class: 'honours-note' }, 'This browser isn’t keeping data for this site, so a name can’t be kept here.'));
      return;
    }
    if (p.kind === 'unavailable') {
      slot.replaceChildren(h('p', { class: 'honours-note' }, UNREACHABLE));
      return;
    }
    const name = p.profile.username;
    if (name && !this.editing) {
      slot.replaceChildren(
        ...nodes(
          h('p', { class: 'honours-entered' }, 'Entered on the roll as ', h('strong', null, name), '.'),
          message ? h('p', { class: 'honours-note', role: 'status' }, message) : null,
          h('button', { type: 'button', class: 'ink-button subtle', onclick: () => this.edit(true) }, 'Change name'),
        ),
      );
      return;
    }
    const blurb = name
      ? null
      : h(
          'p',
          { class: 'honours-blurb' },
          'Choose a name to appear on the leaderboards. Every daily game you’ve played in this browser counts straight away. No email, no password, nothing personal.',
        );
    slot.replaceChildren(...nodes(h('h3', { class: 'honours-heading' }, name ? 'Change your name' : 'Sign the roll'), blurb, this.nameForm(name)));
  }

  private edit(on: boolean): void {
    this.editing = on;
    this.renderProfile();
    if (on) this.profileSlot.querySelector('input')?.focus();
  }

  private nameForm(current: string | null): HTMLFormElement {
    return claimForm({
      service: this.service,
      playerId: () => this.playerId,
      current,
      id: 'honours-name',
      onCancel: current ? () => this.edit(false) : undefined,
      onClaimed: (username) => {
        const games = this.profile.kind === 'ready' ? this.profile.profile.games : 0;
        this.profile = { kind: 'ready', profile: { username, games } };
        this.editing = false;
        this.cache.clear();
        this.renderProfile(current ? 'Your name is changed.' : 'Your name is on the roll.');
        this.profileSlot.querySelector<HTMLElement>('button')?.focus();
        void this.loadBoard(this.board);
        this.onName(username);
      },
    });
  }

  // -------------------------------------------------- recovery / restore ---

  private renderKeys(): void {
    const id = this.playerId;
    if (!id) {
      this.keySlot.replaceChildren();
      return;
    }
    this.keySlot.replaceChildren(this.recoveryPanel(id), this.restorePanel(id));
  }

  private recoveryPanel(id: string): HTMLElement {
    const code = recoveryCode(id) ?? '';
    const status = h('span', { class: 'share-status', role: 'status' });
    return h(
      'details',
      { class: 'honours-details' },
      h('summary', null, 'Your recovery code'),
      h('p', { class: 'recovery-code', translate: 'no' }, code),
      h(
        'p',
        { class: 'honours-field center' },
        h(
          'button',
          {
            type: 'button',
            class: 'ink-button subtle',
            onclick: async () => {
              const ok = await copyText(code);
              status.textContent = ok ? 'Copied' : 'Could not copy. Please copy it by hand.';
              window.setTimeout(() => (status.textContent = ''), 4000);
            },
          },
          'Copy code',
        ),
        status,
      ),
      h(
        'p',
        { class: 'honours-warning' },
        h('strong', null, 'Keep it to yourself. '),
        'Anyone with this code can use your name and add their results to it.',
      ),
      h('p', { class: 'honours-blurb' }, 'To carry your name to another device or browser, open the Roll of Honour there and use “Restore from a code”.'),
    );
  }

  private restorePanel(currentId: string): HTMLElement {
    const input = h('input', {
      type: 'text',
      id: 'honours-code',
      class: 'ink-input code',
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'XXXX-XXXX-XXXX-…',
      'aria-describedby': 'honours-code-note',
    });
    const note = h('div', { class: 'honours-hint', id: 'honours-code-note', 'aria-live': 'polite' });
    const check = h('button', { type: 'submit', class: 'ink-button primary' }, 'Check');
    const form = h(
      'form',
      {
        class: 'honours-form',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          note.classList.remove('bad');
          const id = playerIdFromCode(input.value);
          if (!id) {
            note.classList.add('bad');
            note.textContent = 'That code doesn’t look right. Check it and try again.';
            return input.focus();
          }
          if (id === currentId) {
            note.textContent = 'That is this browser’s own code already.';
            return;
          }
          check.disabled = true;
          note.textContent = 'Checking the code…';
          const found = await this.service.profile(id);
          check.disabled = false;
          note.replaceChildren(...this.restoreConfirm(id, found, () => (note.textContent = '')));
          note.querySelector<HTMLElement>('button')?.focus();
        },
      },
      h('label', { for: 'honours-code', class: 'honours-label' }, 'Recovery code'),
      h('div', { class: 'honours-field' }, input, check),
      note,
    );
    return h(
      'details',
      { class: 'honours-details' },
      h('summary', null, 'Restore from a code'),
      h('p', { class: 'honours-blurb' }, 'Played elsewhere? Enter the recovery code from that device to use its name here.'),
      form,
    );
  }

  private restoreConfirm(id: string, found: Profile | null, cancel: () => void): Node[] {
    const games = (n: number) => `${formatNumber(n)} daily ${n === 1 ? 'game' : 'games'}`;
    const what = !found
      ? h('p', null, 'The code is valid, though the roll couldn’t be checked just now.')
      : found.username
        ? h('p', null, 'This code belongs to ', h('strong', null, found.username), ` (${games(found.games)}).`)
        : h('p', null, `This code has no name on the roll yet (${games(found.games)}).`);
    const mine = this.profile.kind === 'ready' ? this.profile.profile.username : null;
    return [
      what,
      h(
        'p',
        { class: 'honours-warning' },
        'Using it replaces this browser’s player. Results this browser has sent so far stay with ',
        mine ? h('strong', null, mine) : 'its old, anonymous player',
        mine ? ', so copy that recovery code first if you may want it back.' : '.',
        ' Your streak here is unchanged.',
      ),
      h(
        'p',
        { class: 'honours-field center' },
        h('button', { type: 'button', class: 'ink-button primary', onclick: () => this.restore(id, found) }, 'Use this code'),
        h('button', { type: 'button', class: 'ink-button subtle', onclick: cancel }, 'Cancel'),
      ),
    ];
  }

  private restore(id: string, found: Profile | null): void {
    if (!this.store.setPlayerId(id)) {
      this.keySlot.append(h('p', { class: 'honours-hint bad', role: 'alert' }, 'This browser couldn’t keep the code.'));
      return;
    }
    this.cache.clear();
    this.editing = false;
    this.profile = found ? { kind: 'ready', profile: found } : { kind: 'loading' };
    this.renderProfile(found?.username ? `Restored. Welcome back, ${found.username}.` : 'Restored.');
    if (found) this.onName(found.username);
    else void this.loadProfile();
    this.renderKeys();
    void this.loadBoard(this.board);
    this.profileSlot.scrollIntoView?.({ block: 'nearest' });
  }
}

function emptyNote(lb: Leaderboard): string {
  if (lb.board === 'today') return 'No names on today’s roll yet.';
  if (lb.board === 'average') return `Nobody on the roll has played ${lb.minGames} daily games yet.`;
  return 'No names on the roll yet.';
}

/** The line under the board about the player's own standing. */
function statusLine(display: Display, lb: Leaderboard): string | null {
  const s = display.status;
  switch (s.kind) {
    case 'unnamed':
      return 'Sign the roll below to take your place.';
    case 'ranked':
      return `You stand ${display.rows.some((r) => r.kind === 'row' && r.you && r.tied) ? 'joint ' : ''}${ordinal(s.rank)}.`;
    case 'not-today':
      return 'Your name will appear here once today’s puzzle is done.';
    case 'unqualified':
      return `You’ve played ${s.games} of the ${s.needed} daily games needed.`;
    case 'no-games':
      return lb.board === 'today' ? 'Your name will appear here once today’s puzzle is done.' : 'Your name will appear once you’ve finished a daily puzzle.';
  }
}
