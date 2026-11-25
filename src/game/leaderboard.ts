/**
 * The Roll of Honour: the four boards as leaderboard() returns them, checked
 * before use, and the logic behind how ranks are shown. No DOM here.
 *
 * Ranking itself is done by the database (supabase/profiles-leaderboards.sql):
 *   - Today, All-time total and Best average: equal values share a rank
 *     (1, 2, 2, 4), shown here as "=2nd".
 *   - All-time best: never shared. Equal best scores are split by whoever
 *     made theirs first (earliest puzzle day, then earliest submission).
 */

export type Board = 'today' | 'total' | 'best' | 'average';
export const BOARDS: readonly Board[] = ['today', 'total', 'best', 'average'];

/** Tab labels, kept short to fit four across a phone. */
export const BOARD_TABS: Record<Board, string> = { today: 'Today', total: 'Total', best: 'Best', average: 'Average' };
/** Full titles, for the tab panel and screen readers. */
export const BOARD_TITLES: Record<Board, string> = {
  today: 'Today’s scores',
  total: 'All-time total',
  best: 'All-time best',
  average: 'Best average',
};
/** Heading of the value column. */
export const VALUE_HEADINGS: Record<Board, string> = { today: 'Points', total: 'Points', best: 'Best', average: 'Average' };

/** Boards that show games played beside the value. */
export const showsGames = (board: Board) => board === 'total' || board === 'average';

/** A row of the top 25. */
export interface BoardRow {
  rank: number;
  username: string;
  value: number;
  /** Daily games played (Total and Average only). */
  games: number | null;
  /** The puzzle day the score was made (Best only). */
  date: string | null;
}

/** The player's own entry; rank and value are null when they aren't on this board. */
export interface YourRow {
  rank: number | null;
  username: string;
  value: number | null;
  /** Every daily game they have played, whichever the board. */
  games: number | null;
  date: string | null;
}

export interface Leaderboard {
  board: Board;
  /** Today's puzzle day (Europe/London). */
  date: string;
  /** Daily games needed to appear on Best average. */
  minGames: number;
  rows: BoardRow[];
  /** Null when the player has no name on the roll. */
  you: YourRow | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRank = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isValue = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(v);
const isDateOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && DATE.test(v));

/** Checks a server reply; anything malformed is treated as "unavailable". */
export function parseLeaderboard(raw: unknown): Leaderboard | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  if (!BOARDS.includes(r.board as Board) || typeof r.date !== 'string' || !DATE.test(r.date) || !isRank(r.minGames)) return null;
  if (!Array.isArray(r.rows)) return null;
  const rows: BoardRow[] = [];
  for (const x of r.rows as Record<string, unknown>[]) {
    if (!x || !isRank(x.rank) || !isName(x.username) || !isValue(x.value)) return null;
    if (!(x.games === null || isCount(x.games)) || !isDateOrNull(x.date)) return null;
    rows.push({ rank: x.rank, username: x.username, value: x.value, games: x.games, date: x.date });
  }
  let you: YourRow | null = null;
  if (r.you != null) {
    const y = r.you as Record<string, unknown>;
    if (typeof y !== 'object' || !isName(y.username)) return null;
    if (!(y.rank === null || isRank(y.rank)) || !(y.value === null || isValue(y.value))) return null;
    if (!(y.games === null || isCount(y.games)) || !isDateOrNull(y.date)) return null;
    you = { rank: y.rank, username: y.username, value: y.value, games: y.games, date: y.date };
  }
  return { board: r.board as Board, date: r.date, minGames: r.minGames, rows: orderRows(r.board as Board, rows), you };
}

/**
 * Rows in display order: by rank, then (on All-time best) earliest first,
 * then by name. The database sends them in this order already; sorting again
 * keeps the display right whatever order they arrive in.
 */
export function orderRows(board: Board, rows: BoardRow[]): BoardRow[] {
  return [...rows].sort(
    (a, b) =>
      a.rank - b.rank ||
      b.value - a.value ||
      (board === 'best' ? (a.date ?? '').localeCompare(b.date ?? '') : 0) ||
      a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  );
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd … 111th. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "3rd", or "=3rd" when someone else shown holds the same rank. */
export const rankLabel = (rank: number, tied: boolean) => `${tied ? '=' : ''}${ordinal(rank)}`;

export interface DisplayRow {
  kind: 'row';
  rank: number;
  rankLabel: string;
  tied: boolean;
  username: string;
  value: number;
  games: number | null;
  date: string | null;
  /** The player's own row. */
  you: boolean;
}

/** Where the player stands, for the line under the board. */
export type YouStatus =
  | { kind: 'unnamed' }
  /** In the top rows, or shown after them. */
  | { kind: 'ranked'; rank: number }
  /** Named, but not on today's board: no result in for today yet. */
  | { kind: 'not-today' }
  /** Named, but short of the games Best average needs. */
  | { kind: 'unqualified'; games: number; needed: number }
  /** Named, but no daily results at all yet. */
  | { kind: 'no-games' };

export interface Display {
  /** The top rows, then (if the player is further down) a gap and their row. */
  rows: (DisplayRow | { kind: 'gap' })[];
  status: YouStatus;
}

/**
 * What the board shows: the top rows with rank labels, the player's row
 * marked (or added after the top rows if they are further down, with a gap
 * if anyone between is left out), and their standing.
 */
export function displayBoard(lb: Leaderboard): Display {
  const you = lb.you;
  const isYou = (name: string) => you != null && name.toLowerCase() === you.username.toLowerCase();
  const listed = lb.rows.some((r) => isYou(r.username));
  const extra: BoardRow | null =
    you && you.rank != null && you.value != null && !listed
      ? { rank: you.rank, username: you.username, value: you.value, games: you.games, date: you.date }
      : null;

  const all = extra ? [...lb.rows, extra] : lb.rows;
  const count = new Map<number, number>();
  for (const r of all) count.set(r.rank, (count.get(r.rank) ?? 0) + 1);
  // Ties never show on All-time best: its ranks are unique by design.
  const tied = (rank: number) => lb.board !== 'best' && (count.get(rank) ?? 0) > 1;
  const toDisplay = (r: BoardRow): DisplayRow => ({
    kind: 'row',
    rank: r.rank,
    rankLabel: rankLabel(r.rank, tied(r.rank)),
    tied: tied(r.rank),
    username: r.username,
    value: r.value,
    games: r.games,
    date: r.date,
    you: isYou(r.username),
  });

  const rows: Display['rows'] = lb.rows.map(toDisplay);
  // Players ranked above you = rank − 1. More of them than rows shown: some are left out.
  if (extra) {
    if (extra.rank - 1 > lb.rows.length) rows.push({ kind: 'gap' });
    rows.push(toDisplay(extra));
  }

  let status: YouStatus;
  if (!you) status = { kind: 'unnamed' };
  else if (you.rank != null) status = { kind: 'ranked', rank: you.rank };
  else if (!you.games) status = { kind: 'no-games' };
  else if (lb.board === 'average') status = { kind: 'unqualified', games: you.games, needed: lb.minGames };
  else status = { kind: 'not-today' };
  return { rows, status };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "9 Nov 2026". */
export function shortDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
