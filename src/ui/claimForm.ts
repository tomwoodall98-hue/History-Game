/**
 * The form for claiming (or changing) a username: checks the rules as the
 * player types, then asks the server. Used by the Roll of Honour and, inline,
 * by the claim prompt on the end screen.
 */
import type { StatsService } from '../game/statsApi';
import { USERNAME_MAX, USERNAME_MIN, problemMessage, usernameProblem } from '../game/username';
import { h } from './dom';

export const UNREACHABLE = 'The roll can’t be reached just now. Please try again later.';

export interface ClaimFormOptions {
  service: StatsService;
  playerId: () => string | null;
  /** The player's name now, when changing it; null when claiming one. */
  current: string | null;
  /** Id of the input; the hint is `${id}-hint`. */
  id: string;
  /** Called once the server has the name. */
  onClaimed: (username: string) => void;
  /** Shows a Cancel button when given; also called if the name is left unchanged. */
  onCancel?: () => void;
}

export function claimForm(o: ClaimFormOptions): HTMLFormElement {
  const hintId = `${o.id}-hint`;
  const hintText = `${USERNAME_MIN}–${USERNAME_MAX} letters, numbers or underscores.`;
  const input = h('input', {
    type: 'text',
    id: o.id,
    class: 'ink-input',
    name: 'username',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    maxlength: String(USERNAME_MAX),
    'aria-describedby': hintId,
    value: o.current ?? '',
  });
  const hint = h('p', { class: 'honours-hint', id: hintId, 'aria-live': 'polite' }, hintText);
  const submit = h('button', { type: 'submit', class: 'ink-button primary' }, o.current ? 'Save' : 'Sign');
  let tried = false;
  const check = (): boolean => {
    const value = input.value.trim();
    // While typing, say nothing about length until the name is long enough to judge.
    const problem = usernameProblem(value);
    const show = problem && (tried || (problem !== 'length' && value.length > 0) || value.length > USERNAME_MAX);
    hint.textContent = show ? problemMessage(problem) : hintText;
    hint.classList.toggle('bad', !!show);
    input.setAttribute('aria-invalid', String(!!show));
    return !problem;
  };
  input.addEventListener('input', check);
  const form = h(
    'form',
    {
      class: 'honours-form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        tried = true;
        if (!check()) return input.focus();
        const id = o.playerId();
        if (!id) return;
        const name = input.value.trim();
        if (o.current && name === o.current) return o.onCancel?.();
        submit.disabled = true;
        hint.textContent = 'Entering your name…';
        const result = await o.service.claim(id, name);
        submit.disabled = false;
        if (!result.ok) {
          hint.textContent = result.reason === 'unavailable' ? UNREACHABLE : problemMessage(result.reason);
          hint.classList.add('bad');
          input.setAttribute('aria-invalid', String(result.reason !== 'unavailable'));
          input.focus();
          return;
        }
        o.onClaimed(result.username);
      },
    },
    h('label', { for: o.id, class: 'honours-label' }, 'Name'),
    h('div', { class: 'honours-field' }, input, submit),
    hint,
  );
  if (o.onCancel) {
    form.append(h('button', { type: 'button', class: 'ink-button subtle small', onclick: () => o.onCancel!() }, 'Cancel'));
  }
  return form;
}
