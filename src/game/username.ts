/**
 * Username rules for the Roll of Honour. The database enforces the same
 * rules in username_problem() (supabase/profiles-leaderboards.sql); this copy
 * only gives the player an answer as they type. tests/leaderboardSql.test.ts
 * runs both on the same names to keep them in step.
 *
 * A name is 3–20 letters, numbers or underscores with at least one letter,
 * unique ignoring case (checked by the database), not a reserved name and
 * not rude. The blocklist is deliberately short and blunt: it catches the
 * obvious, and the admin snippets in the SQL file deal with the rest.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

/** Names nobody may take: they could pass for the game, its staff, or "You". */
export const RESERVED_NAMES = [
  'admin', 'administrator', 'anon', 'anonymous', 'api', 'bot', 'chronomap', 'editor', 'everyone', 'guest',
  'help', 'helpdesk', 'me', 'mod', 'moderator', 'mods', 'nobody', 'none', 'null', 'official', 'owner',
  'player', 'postmaster', 'root', 'security', 'server', 'staff', 'supabase', 'support', 'sysadmin', 'system',
  'team', 'test', 'undefined', 'webmaster', 'you',
];
/** Reserved at the start of a name too: "Admin_Jane", "ChronomapOfficial". */
export const RESERVED_PREFIXES = ['admin', 'chronomap', 'moderator', 'official'];

/** Rude anywhere in a name, even run together with other words. */
export const RUDE_ANYWHERE = [
  'bastard', 'bellend', 'bitch', 'bollock', 'cunt', 'dildo', 'faggot', 'fuck', 'fuk', 'hitler', 'jizz',
  'kkk', 'nigga', 'nigger', 'paedophile', 'pedophile', 'penis', 'porn', 'retard', 'shit', 'slut', 'tosser',
  'tranny', 'twat', 'vagina', 'wank', 'whore',
];
/** Rude only as a whole word, because each hides inside innocent ones (Dickens, Sussex, grapefruit). */
export const RUDE_WORDS = [
  'anal', 'arse', 'ass', 'boob', 'boobs', 'bugger', 'chink', 'clit', 'cock', 'coon', 'crap', 'cum', 'dick',
  'dyke', 'fag', 'gook', 'heil', 'homo', 'kike', 'knob', 'minge', 'nazi', 'nonce', 'paedo', 'paki', 'pedo',
  'piss', 'prick', 'rape', 'sex', 'shag', 'spaz', 'spic', 'tit', 'tits', 'wog',
];
/** Innocent words that contain a RUDE_ANYWHERE word (the Scunthorpe problem). */
export const INNOCENT = ['scunthorpe', 'penistone', 'shiitake'];

/** Digits standing in for letters: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b, 9→g. */
const LEET_FROM = '01345789';
const LEET_TO = 'oieastbg';
const deLeet = (s: string) => s.replace(/[0-9]/g, (d) => (LEET_FROM.includes(d) ? LEET_TO[LEET_FROM.indexOf(d)] : d));

export type UsernameProblem = 'length' | 'characters' | 'letter' | 'reserved' | 'unsuitable';
/** What claim_username() can say on top: the name belongs to someone else. */
export type ClaimProblem = UsernameProblem | 'taken';

/** The problem with a name, or null if it may be claimed (if nobody has it). Mirrors username_problem() in SQL. */
export function usernameProblem(name: string): UsernameProblem | null {
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return 'length';
  if (!/^[A-Za-z0-9_]+$/.test(name)) return 'characters';
  if (!/[A-Za-z]/.test(name)) return 'letter';

  const lowered = name.toLowerCase();
  const collapsed = lowered.replace(/_/g, '');
  const bare = collapsed.replace(/[0-9]+$/, '');
  if ([bare, deLeet(bare), deLeet(collapsed)].some((n) => RESERVED_NAMES.includes(n))) return 'reserved';
  if (RESERVED_PREFIXES.some((p) => collapsed.startsWith(p) || deLeet(collapsed).startsWith(p))) return 'reserved';

  let squashed = deLeet(collapsed);
  for (const w of INNOCENT) squashed = squashed.split(w).join('');
  if (RUDE_ANYWHERE.some((w) => squashed.includes(w))) return 'unsuitable';
  const words = [...lowered.split(/[_0-9]+/), ...deLeet(lowered).split('_')];
  if (words.some((w) => RUDE_WORDS.includes(w))) return 'unsuitable';
  return null;
}

/** What to tell the player about a problem. */
export function problemMessage(problem: ClaimProblem): string {
  switch (problem) {
    case 'length':
      return `Names are ${USERNAME_MIN} to ${USERNAME_MAX} characters long.`;
    case 'characters':
      return 'Use only letters, numbers and underscores (_).';
    case 'letter':
      return 'Names need at least one letter.';
    case 'reserved':
      return 'That name is reserved. Please choose another.';
    case 'unsuitable':
      return 'That name isn’t suitable for the roll. Please choose another.';
    case 'taken':
      return 'That name is already on the roll. Please choose another.';
  }
}

const PROBLEMS: readonly string[] = ['length', 'characters', 'letter', 'reserved', 'unsuitable', 'taken'];
export const isClaimProblem = (v: unknown): v is ClaimProblem => typeof v === 'string' && PROBLEMS.includes(v);
