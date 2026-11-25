/**
 * When the end screen asks an unnamed player to claim a username.
 *
 * "Not now" puts the prompt off for SNOOZE_DAYS days. After MAX_SNOOZES of
 * those it stops appearing on its own; the "Claim a username" link stays
 * for whenever the player wants it.
 */
import { addDays } from './daily';
import type { ClaimPromptState } from './types';

export const SNOOZE_DAYS = 3;
export const MAX_SNOOZES = 3;

export const NEVER_SNOOZED: ClaimPromptState = { snoozes: 0, until: null };

/** Whether the prompt may show on its own on `todayKey`. */
export function claimPromptDue(state: ClaimPromptState, todayKey: string): boolean {
  if (state.snoozes >= MAX_SNOOZES) return false;
  return state.until == null || todayKey >= state.until;
}

/** The state after "Not now" on `todayKey`: hidden for SNOOZE_DAYS days, one more snooze counted. */
export function snoozeClaim(state: ClaimPromptState, todayKey: string): ClaimPromptState {
  return { snoozes: state.snoozes + 1, until: addDays(todayKey, SNOOZE_DAYS) };
}

/** Checks a stored state; anything malformed counts as never snoozed. */
export function parseClaimPrompt(raw: unknown): ClaimPromptState {
  const r = raw as Partial<ClaimPromptState> | null;
  if (!r || typeof r !== 'object') return { ...NEVER_SNOOZED };
  const snoozes = Number.isInteger(r.snoozes) && (r.snoozes as number) >= 0 ? (r.snoozes as number) : 0;
  const until = typeof r.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.until) ? r.until : null;
  return { snoozes, until };
}
