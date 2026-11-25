/**
 * The Roll of Honour in a simulated browser (happy-dom) with a fake server:
 * tabs, rows, claiming a name, and the recovery code round trip.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { Board, BoardRow, Leaderboard } from '../src/game/leaderboard.ts';
import type { ClaimResult, Profile, StatsService } from '../src/game/statsApi.ts';

let mod: {
  RollOfHonour: typeof import('../src/ui/honours.ts').RollOfHonour;
  LocalStore: typeof import('../src/game/storage.ts').LocalStore;
  recoveryCode: typeof import('../src/game/recovery.ts').recoveryCode;
};

before(async () => {
  GlobalRegistrator.register({ url: 'https://chronomap.test/', width: 390, height: 844 });
  const [ui, storage, recovery] = await Promise.all([import('../src/ui/honours.ts'), import('../src/game/storage.ts'), import('../src/game/recovery.ts')]);
  mod = { RollOfHonour: ui.RollOfHonour, LocalStore: storage.LocalStore, recoveryCode: recovery.recoveryCode };
});

after(async () => {
  await GlobalRegistrator.unregister();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const OTHER = '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d';

/** A fake server holding names by player id. */
function fakeService() {
  const names = new Map<string, string>([[OTHER, 'Ortelius']]);
  const calls: string[] = [];
  const rows = (board: Board): BoardRow[] =>
    board === 'best'
      ? [
          { rank: 1, username: 'Ortelius', value: 6800, games: null, date: '2026-11-02' },
          { rank: 2, username: 'Ada', value: 6800, games: null, date: '2026-11-10' },
        ]
      : [
          { rank: 1, username: 'Ortelius', value: 6000, games: board === 'total' || board === 'average' ? 12 : null, date: null },
          { rank: 1, username: 'Ada', value: 6000, games: board === 'total' || board === 'average' ? 11 : null, date: null },
        ];
  const service: StatsService = {
    submit: async () => true,
    stats: async () => null,
    profile: async (id): Promise<Profile> => {
      calls.push(`profile ${id}`);
      return { username: names.get(id) ?? null, games: names.has(id) ? 12 : 0 };
    },
    claim: async (id, username): Promise<ClaimResult> => {
      calls.push(`claim ${username}`);
      if ([...names.entries()].some(([k, v]) => k !== id && v.toLowerCase() === username.toLowerCase())) return { ok: false, reason: 'taken' };
      names.set(id, username);
      return { ok: true, username };
    },
    leaderboard: async (board, id): Promise<Leaderboard> => {
      calls.push(`board ${board}`);
      const name = id ? names.get(id) : undefined;
      return {
        board,
        date: '2026-11-25',
        minGames: 10,
        rows: rows(board),
        you: name ? { rank: name === 'Ortelius' ? 1 : null, username: name, value: name === 'Ortelius' ? 6000 : null, games: 0, date: null } : null,
      };
    },
  };
  return { service, calls, names };
}

class MemoryStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

test('tabs switch boards; ties show "=", Best never does', async () => {
  const { service, calls } = fakeService();
  const store = new mod.LocalStore(() => '2026-11-25', new MemoryStorage() as unknown as Storage);
  const roll = new mod.RollOfHonour(service, store);
  document.body.replaceChildren(roll.element);
  roll.open();
  await settle();

  const tabs = [...roll.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Today', 'Total', 'Best', 'Average']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false', 'false', 'false']);
  const ranks = () => [...roll.element.querySelectorAll('tbody .roll-rank')].map((c) => c.textContent);
  assert.deepEqual(ranks(), ['=1st', '=1st']);
  assert.match(text(roll.element.querySelector('.honours-you')), /Sign the roll/);

  tabs[2].click();
  await settle();
  assert.equal(tabs[2].getAttribute('aria-selected'), 'true');
  assert.deepEqual(ranks(), ['1st', '2nd']);
  assert.match(text(roll.element.querySelector('tbody')), /2 Nov 2026/);

  // Arrow keys move along the tabs.
  tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  assert.equal(tabs[3].getAttribute('aria-selected'), 'true');
  assert.equal(roll.element.querySelectorAll('thead th').length, 4, 'Average shows games played');
  assert.ok(calls.includes('board average'));
});

test('claiming a name, with the rules checked first', async () => {
  const { service, calls, names } = fakeService();
  const store = new mod.LocalStore(() => '2026-11-25', new MemoryStorage() as unknown as Storage);
  const roll = new mod.RollOfHonour(service, store);
  document.body.replaceChildren(roll.element);
  roll.open();
  await settle();

  const input = roll.element.querySelector<HTMLInputElement>('#honours-name')!;
  const form = input.form!;
  const hint = roll.element.querySelector('#honours-name-hint')!;
  input.value = 'admin';
  input.dispatchEvent(new Event('input'));
  assert.match(hint.textContent!, /reserved/);
  form.requestSubmit();
  await settle();
  assert.ok(!calls.some((c) => c.startsWith('claim')), 'a bad name never reaches the server');

  input.value = 'ortelius';
  input.dispatchEvent(new Event('input'));
  form.requestSubmit();
  await settle();
  assert.match(text(roll.element.querySelector('#honours-name-hint')), /already on the roll/);

  input.value = 'Ada_Lovelace';
  input.dispatchEvent(new Event('input'));
  form.requestSubmit();
  await settle();
  assert.equal(names.get(store.playerId()!), 'Ada_Lovelace');
  assert.match(text(roll.element.querySelector('.honours-profile')), /Entered on the roll as Ada_Lovelace/);
});

test('the recovery code is shown, and restoring from one switches the player', async () => {
  const { service } = fakeService();
  const store = new mod.LocalStore(() => '2026-11-25', new MemoryStorage() as unknown as Storage);
  const roll = new mod.RollOfHonour(service, store);
  document.body.replaceChildren(roll.element);
  roll.open();
  await settle();

  const mine = store.playerId()!;
  assert.equal(text(roll.element.querySelector('.recovery-code')), mod.recoveryCode(mine));
  assert.match(text(roll.element.querySelector('.honours-warning')), /Anyone with this code/);
  assert.ok(!roll.element.innerHTML.includes(mine), 'the raw id is never on the page');

  const input = roll.element.querySelector<HTMLInputElement>('#honours-code')!;
  input.value = 'not a code';
  input.form!.requestSubmit();
  await settle();
  assert.match(text(roll.element.querySelector('#honours-code-note')), /doesn’t look right/);

  input.value = mod.recoveryCode(OTHER)!.toLowerCase();
  input.form!.requestSubmit();
  await settle();
  const note = roll.element.querySelector('#honours-code-note')!;
  assert.match(text(note), /belongs to Ortelius/);
  [...note.querySelectorAll('button')].find((b) => b.textContent === 'Use this code')!.click();
  await settle();
  assert.equal(store.playerId(), OTHER);
  assert.match(text(roll.element.querySelector('.honours-profile')), /Welcome back, Ortelius/);
  assert.equal(text(roll.element.querySelector('.recovery-code')), mod.recoveryCode(OTHER));
  assert.ok(roll.element.querySelector('tbody .roll-row.you'), 'now marked on the board');
});
