import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problemMessage, usernameProblem } from '../src/game/username.ts';
import { playerIdFromCode, recoveryCode } from '../src/game/recovery.ts';
import { randomId } from '../src/game/storage.ts';

test('usernames: 3–20 letters, numbers or underscores, with a letter', () => {
  for (const ok of ['Ada', 'ada_lovelace', 'Cartographer_1851', 'x_y', 'A1B', 'abcdefghijklmnopqrst', 'Henry8', '_Mercator_']) {
    assert.equal(usernameProblem(ok), null, ok);
  }
  assert.equal(usernameProblem('ab'), 'length');
  assert.equal(usernameProblem(''), 'length');
  assert.equal(usernameProblem('abcdefghijklmnopqrstu'), 'length', '21 characters');
  assert.equal(usernameProblem('ada lovelace'), 'characters', 'spaces');
  assert.equal(usernameProblem('ada-lovelace'), 'characters');
  assert.equal(usernameProblem('Zoë'), 'characters', 'letters outside A–Z');
  assert.equal(usernameProblem('ab.c'), 'characters');
  assert.equal(usernameProblem('1851'), 'letter', 'a number alone would read as a score');
  assert.equal(usernameProblem('___'), 'letter');
});

test('reserved names are blocked, however they are dressed up', () => {
  for (const name of ['admin', 'ADMIN', 'Admin_', 'ad_min', 'admin1', 'admin_99', '4dmin', '4dm1n', 'Administrator', 'Chronomap', 'chronomap_official', 'Moderator7', 'mod', 'MOD_2', 'root', 'support', 'You', 'null', 'Official_Bob']) {
    assert.equal(usernameProblem(name), 'reserved', name);
  }
  // Containing a reserved word somewhere else is fine.
  for (const name of ['badminton', 'Modernist', 'Rootless', 'supportive_aunt', 'Youngblood', 'Model_T', 'BotanyBay']) {
    assert.equal(usernameProblem(name), null, name);
  }
});

test('the profanity blocklist catches the obvious without the Scunthorpe problem', () => {
  for (const name of ['fuck', 'FuckThis', 'f_u_c_k', 'sh1t_head', 'what_the_fuk', 'b1tch', 'ass', 'Ass_Hat', 'ass69', 'a55', 'big_dick', 'NAZI_1', 'heil_99', 'Hitler_fan', 'pornking']) {
    assert.equal(usernameProblem(name), 'unsuitable', name);
  }
  // Innocent names that contain a rude word.
  for (const name of ['Scunthorpe_Utd', 'Penistone', 'Dickens', 'Charles_Dickens', 'Sussex', 'Middlesex1066', 'Essex_Girl', 'Grapefruit', 'Cockburn', 'Hancock', 'Assam_Tea', 'Classic_Maps', 'Nazir', 'Titanic', 'Cucumber', 'Arsenal', 'Analyst', 'Shiitake']) {
    assert.equal(usernameProblem(name), null, name);
  }
});

test('every problem has a message', () => {
  for (const p of ['length', 'characters', 'letter', 'reserved', 'unsuitable', 'taken'] as const) assert.ok(problemMessage(p).length > 10, p);
});

test('a recovery code carries the player id there and back', () => {
  const id = '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d';
  const code = recoveryCode(id)!;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/, 'seven groups of four, Crockford base32');
  assert.equal(playerIdFromCode(code), id);
  for (let i = 0; i < 200; i++) {
    const r = randomId();
    assert.equal(playerIdFromCode(recoveryCode(r)!), r);
  }
  assert.equal(recoveryCode('not-a-uuid'), null);
  assert.equal(recoveryCode(id.toUpperCase()), code, 'case of the id does not matter');
});

test('recovery codes forgive case, spacing and look-alike letters, but catch typos', () => {
  const id = '3f2b8c1e-9d4a-4b7e-a1c2-5e6f7a8b9c0d';
  const code = recoveryCode(id)!;
  assert.equal(playerIdFromCode(code.toLowerCase()), id);
  assert.equal(playerIdFromCode(`  ${code.replace(/-/g, ' ')}  `), id);
  assert.equal(playerIdFromCode(code.replace(/-/g, '')), id);
  assert.equal(playerIdFromCode(code.replace(/0/g, 'O').replace(/1/g, 'l')), id, 'O for 0, l for 1');

  // Every single-character mistake is caught.
  const plain = code.replace(/-/g, '');
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let caught = 0;
  let tried = 0;
  for (let i = 0; i < plain.length; i++) {
    for (const c of alphabet) {
      if (c === plain[i]) continue;
      tried++;
      if (playerIdFromCode(plain.slice(0, i) + c + plain.slice(i + 1)) === null) caught++;
    }
  }
  assert.equal(caught, tried, 'single typos');
  assert.equal(playerIdFromCode(plain.slice(1)), null, 'too short');
  assert.equal(playerIdFromCode(plain + '0'), null, 'too long');
  assert.equal(playerIdFromCode(plain.replace(/.$/, 'U')), null, 'not in the alphabet');
  assert.equal(playerIdFromCode(''), null);
});
