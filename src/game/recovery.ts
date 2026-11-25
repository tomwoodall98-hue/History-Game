/**
 * Recovery codes: the anonymous player id, written so a person can copy it
 * to another device. The code *is* the id (Crockford base32, plus two check
 * characters to catch typos), so restoring needs no server: whoever holds the
 * code holds the profile, which is why the panel warns to keep it private.
 *
 *   uuid (128 bits) → 26 base32 characters (2 padding bits) + 2 check
 *   characters → 28 characters in seven groups of four:
 *   ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345
 */

/** Crockford's base32: no I, L, O or U, so it reads aloud and copies by hand well. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_CHARS = 26;
const CODE_CHARS = DATA_CHARS + 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const bytesOf = (uuid: string): number[] => uuid.replace(/-/g, '').match(/../g)!.map((x) => parseInt(x, 16));

/** Ten bits from the 16 bytes: catches any single mistyped character and most swaps. */
function checksum(bytes: number[]): number {
  let h = 0;
  for (const b of bytes) h = (h * 131 + b) % 1021;
  return h;
}

/** The recovery code for a player id, or null if it isn't one. */
export function recoveryCode(playerId: string): string | null {
  const id = playerId.toLowerCase();
  if (!UUID.test(id)) return null;
  const bytes = bytesOf(id);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  bits = bits.padEnd(DATA_CHARS * 5, '0');
  let out = '';
  for (let i = 0; i < DATA_CHARS; i++) out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  const sum = checksum(bytes);
  out += ALPHABET[sum >> 5] + ALPHABET[sum & 31];
  return out.match(/.{4}/g)!.join('-');
}

/**
 * The player id in a typed or pasted code, or null if it isn't a valid code.
 * Forgiving about case, spaces, dashes, and the letters Crockford reads as
 * digits (O for 0, I and L for 1).
 */
export function playerIdFromCode(code: string): string | null {
  const clean = code
    .toUpperCase()
    .replace(/[\s\-–—]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (clean.length !== CODE_CHARS || ![...clean].every((c) => ALPHABET.includes(c))) return null;
  let bits = '';
  for (const c of clean.slice(0, DATA_CHARS)) bits += ALPHABET.indexOf(c).toString(2).padStart(5, '0');
  if (bits.slice(128) !== '00') return null;
  const bytes = bits
    .slice(0, 128)
    .match(/.{8}/g)!
    .map((b) => parseInt(b, 2));
  const sum = ALPHABET.indexOf(clean[DATA_CHARS]) * 32 + ALPHABET.indexOf(clean[DATA_CHARS + 1]);
  if (sum !== checksum(bytes)) return null;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID.test(id) ? id : null;
}
