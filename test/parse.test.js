// The screens that motivated each status rule, so a spinner frame or a chrome line Claude Code
// changes breaks a test here rather than the view. The fixtures are real screens captured from
// the fleet on 2026-09-10 with the prose replaced; the chrome is untouched.

import { describe, expect, test } from 'bun:test';
import { classifyTerminal } from '../lib/parse.js';
import { mergeStatus } from '../lib/world.js';
import fixtures from './fixtures.json';

const CHROME = `
──────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────
  ◇ Fable 5.1  ┊  high  ┊  10%  ┊  ⎇ main  ┊  ⌂ mac
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent`;

const claude = (body) => classifyTerminal({ title: '◐ task', text: `${body}\n${CHROME}` });

describe('Claude spinner', () => {
  // From the 2.1.267 binary: ["·","✢","✳","✶","✻","✽"], one build with "*" for "✳".
  for (const glyph of ['·', '✢', '✳', '✶', '✻', '✽', '*']) {
    test(`frame ${glyph} is working`, () => {
      const t = claude(`⏺ Some narration.\n\n${glyph} Whirring… (15m 5s · ↓ 59.0k tokens)`);
      expect(t.status).toBe('working');
      expect(t.mark).toBe('working');
      expect(t.activity).toBe('Whirring · 15m 5s · ↓ 59.0k tokens');
    });
  }

  test('the captured ✶ frame that used to read as idle', () => {
    const t = classifyTerminal({ title: '◐ PT-643', text: fixtures.spinnerSixPointed });
    expect(t.status).toBe('working');
    expect(t.flavor).toBe('claude');
  });

  test('waiting on sub-agents is working', () => {
    const t = classifyTerminal({ title: '◐ PT-659', text: fixtures.waitingOnSubagent });
    expect(t.status).toBe('working');
    expect(t.activity).toBe('waiting on 1 sub-agent');
    expect(claude('✻ Waiting for 3 background agents to finish').activity).toBe(
      'waiting on 3 sub-agents',
    );
  });

  test('a done line is idle, with a mark', () => {
    const t = classifyTerminal({ title: '◑ main', text: fixtures.done });
    expect(t.status).toBe('idle');
    expect(t.mark).toBe('done');
    expect(t.activity).toBe('done');
  });

  test('a new spinner below the previous done line wins', () => {
    const t = claude(
      '✻ Crunched for 7m 1s · done 6:57 PM\n\n❯ Commit it\n\n✽ Doing… (4s · ↓ 1.2k tokens)',
    );
    expect(t.status).toBe('working');
  });

  test('a done line below an old spinner frame wins', () => {
    const t = claude(
      '✽ Doing… (4s · ↓ 1.2k tokens)\n\n⏺ All done.\n\n✻ Crunched for 7m · done 6:57 PM',
    );
    expect(t.status).toBe('idle');
    expect(t.mark).toBe('done');
  });

  test('an interrupt is idle, with a mark', () => {
    const t = claude(
      '✽ Doing… (4s · ↓ 1.2k tokens)\n  ⎿  Interrupted · What should Claude do instead?',
    );
    expect(t.status).toBe('idle');
    expect(t.mark).toBe('interrupted');
  });

  test('a permission prompt is waiting whatever is above it', () => {
    const t = claude(
      '✽ Doing… (4s · ↓ 1.2k tokens)\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No',
    );
    expect(t.status).toBe('waiting');
  });

  test('no marker at all is idle with no mark', () => {
    const t = claude('⏺ Some narration and nothing else.');
    expect(t.status).toBe('idle');
    expect(t.mark).toBeNull();
  });
});

describe('Codex', () => {
  const codex = (body) =>
    classifyTerminal({
      title: '',
      text: `${body}\n  gpt-6-astra · panoramic-oxygen · main · Context 54% left`,
    });

  test('spinner is working', () => {
    expect(codex('• Working (11m 04s • esc to interrupt)').status).toBe('working');
  });

  test('the prompt line is idle with a mark', () => {
    const t = codex('• Done.\n\n› Ask Codex to do anything');
    expect(t.status).toBe('idle');
    expect(t.mark).toBe('done');
  });
});

describe('merging the screen with the hooks', () => {
  const screen = (status, mark, activity = null) => ({ status, mark, activity });
  const hook = (lastEventType, subagents) => ({
    lastEventType,
    ...(subagents ? { subagents } : {}),
  });

  test('no binding: the screen stands', () => {
    expect(mergeStatus(screen('idle', null), undefined)).toMatchObject({
      status: 'idle',
      evidence: 'screen',
    });
  });

  test('a silent screen takes the hooks', () => {
    expect(mergeStatus(screen('idle', null), hook('Start'))).toMatchObject({
      status: 'working',
      activity: 'working',
      evidence: 'hooks',
    });
    expect(mergeStatus(screen('idle', null), hook('Stop'))).toMatchObject({
      status: 'idle',
      evidence: 'hooks',
    });
    expect(
      mergeStatus(screen('idle', null), hook('Start', [{ id: 'a' }, { id: 'b' }])),
    ).toMatchObject({
      status: 'working',
      activity: 'waiting on 2 sub-agents',
      subagents: 2,
    });
  });

  test('a marked screen beats a stale binding both ways', () => {
    // Escape fires no hook: the binding says Start, the screen says interrupted.
    expect(mergeStatus(screen('idle', 'interrupted'), hook('Start')).status).toBe('idle');
    expect(mergeStatus(screen('idle', 'done'), hook('Start')).status).toBe('idle');
    // A wakeup that submitted no prompt: the binding says Stop, the screen is spinning.
    expect(mergeStatus(screen('working', 'working', 'Doing · 4s'), hook('Stop'))).toMatchObject({
      status: 'working',
      activity: 'Doing · 4s',
      evidence: 'screen',
    });
  });

  test('a permission prompt from either side is waiting', () => {
    expect(mergeStatus(screen('waiting', 'waiting'), hook('Start')).status).toBe('waiting');
    expect(mergeStatus(screen('working', 'working'), hook('PermissionRequest')).status).toBe(
      'waiting',
    );
  });

  test('an unknown event type leaves the screen alone', () => {
    expect(mergeStatus(screen('idle', null), hook('Attached'))).toMatchObject({
      status: 'idle',
      evidence: 'screen',
    });
  });

  test('a shell is a shell', () => {
    expect(mergeStatus(screen('shell', null), hook('Start')).status).toBe('shell');
  });
});
