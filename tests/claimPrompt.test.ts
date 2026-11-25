import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimPromptDue, snoozeClaim, NEVER_SNOOZED, MAX_SNOOZES, SNOOZE_DAYS } from '../src/game/claimPrompt.ts';

test('the prompt shows until it is put off', () => {
  assert.equal(claimPromptDue(NEVER_SNOOZED, '2026-11-25'), true);
});

test('"Not now" hides it for three days', () => {
  assert.equal(SNOOZE_DAYS, 3);
  const s = snoozeClaim(NEVER_SNOOZED, '2026-11-25');
  assert.deepEqual(s, { snoozes: 1, until: '2026-11-28' });
  assert.equal(claimPromptDue(s, '2026-11-25'), false, 'not again today');
  assert.equal(claimPromptDue(s, '2026-11-26'), false);
  assert.equal(claimPromptDue(s, '2026-11-27'), false);
  assert.equal(claimPromptDue(s, '2026-11-28'), true, 'back on the third day after');
  assert.equal(claimPromptDue(s, '2026-12-15'), true);
  // Across a month and a year end.
  assert.equal(snoozeClaim(NEVER_SNOOZED, '2026-12-30').until, '2027-01-02');
});

test('after three snoozes it stops showing on its own', () => {
  assert.equal(MAX_SNOOZES, 3);
  let s = NEVER_SNOOZED;
  let day = '2026-11-25';
  for (let n = 1; n <= 3; n++) {
    assert.equal(claimPromptDue(s, day), true, `shown before snooze ${n}`);
    s = snoozeClaim(s, day);
    assert.equal(s.snoozes, n);
    day = s.until!;
  }
  assert.equal(claimPromptDue(s, day), false);
  assert.equal(claimPromptDue(s, '2030-01-01'), false, 'not even years later');
});
