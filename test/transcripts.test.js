// What a transcript says a session is about: its own title, the prompt it is on, and the tool
// calls since. The records mirror the shapes Claude Code 2.1.267 writes.

import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transcripts, projectSlug } from '../lib/transcripts.js';

const CWD = '/tmp/worktrees/x/y';
const ws = { id: 'ws-1', worktreePath: CWD };

const row = (type, extra, ts) =>
  JSON.stringify({ type, cwd: CWD, isSidechain: false, timestamp: ts, ...extra });
const user = (text, ts) => row('user', { message: { role: 'user', content: text } }, ts);
const result = (ts) =>
  row('user', { message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }, ts);
const call = (name, input, ts) =>
  row(
    'assistant',
    { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } },
    ts,
  );
const said = (text, ts) =>
  row('assistant', { message: { role: 'assistant', content: [{ type: 'text', text }] } }, ts);

async function transcriptWith(lines) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-transcripts-'));
  const dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'abc.jsonl'), `${lines.join('\n')}\n`);
  return { root, dir };
}

describe('sessionOf', () => {
  test('title, current prompt, and the tools since it', async () => {
    const { root } = await transcriptWith([
      user('Fix the parser so ✶ counts as working.', '2026-09-10T10:00:00Z'),
      call('Read', { file_path: '/tmp/worktrees/x/y/lib/parse.js' }, '2026-09-10T10:00:05Z'),
      result('2026-09-10T10:00:06Z'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Spinner frame fix', sessionId: 'abc' }),
      call('Edit', { file_path: '/tmp/worktrees/x/y/lib/parse.js' }, '2026-09-10T10:00:10Z'),
      said('Running the tests now.', '2026-09-10T10:00:12Z'),
      call('Bash', { command: 'bun test' }, '2026-09-10T10:00:13Z'),
    ]);
    const t = new Transcripts(root);
    await t.read([ws]);
    const s = t.sessionOf('ws-1');
    expect(s.title).toBe('Spinner frame fix');
    expect(s.prompt).toBe('Fix the parser so ✶ counts as working.');
    expect(s.firstPrompt).toBe(s.prompt);
    expect(s.tools.map((x) => x.name)).toEqual(['Read', 'Edit', 'Bash']);
    expect(s.tools[2].input.command).toBe('bun test');
    expect(s.narration).toBe('Running the tests now.');
    expect(s.at).toBe(Date.parse('2026-09-10T10:00:13Z'));
  });

  test('a new prompt opens a new turn; slash commands and tool results do not', async () => {
    const { root } = await transcriptWith([
      user('First task.', '2026-09-10T10:00:00Z'),
      call('Edit', { file_path: '/a' }, '2026-09-10T10:00:01Z'),
      result('2026-09-10T10:00:02Z'),
      user('<command-name>/clear</command-name>', '2026-09-10T10:00:03Z'),
      user('Second task.', '2026-09-10T10:01:00Z'),
      call('Read', { file_path: '/b' }, '2026-09-10T10:01:01Z'),
    ]);
    const t = new Transcripts(root);
    await t.read([ws]);
    const s = t.sessionOf('ws-1');
    expect(s.prompt).toBe('Second task.');
    expect(s.firstPrompt).toBe('First task.');
    expect(s.tools.map((x) => x.name)).toEqual(['Read']);
  });

  test('a sub-agent transcript row and a foreign cwd are ignored', async () => {
    const { root } = await transcriptWith([
      user('Task.', '2026-09-10T10:00:00Z'),
      JSON.stringify({
        type: 'assistant',
        cwd: CWD,
        isSidechain: true,
        timestamp: '2026-09-10T10:00:01Z',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'bun test' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: '/somewhere/else',
        timestamp: '2026-09-10T10:00:02Z',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/z' } }] },
      }),
    ]);
    const t = new Transcripts(root);
    await t.read([ws]);
    expect(t.sessionOf('ws-1').tools).toEqual([]);
  });

  test('the file is read forward: a later read adds the new calls only', async () => {
    const { root, dir } = await transcriptWith([
      user('Task.', '2026-09-10T10:00:00Z'),
      call('Read', { file_path: '/a' }, '2026-09-10T10:00:01Z'),
    ]);
    const t = new Transcripts(root);
    await t.read([ws]);
    expect(t.sessionOf('ws-1').tools.length).toBe(1);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      join(dir, 'abc.jsonl'),
      `${call('Edit', { file_path: '/a' }, '2026-09-10T10:00:02Z')}\n`,
    );
    await t.read([ws]);
    expect(t.sessionOf('ws-1').tools.map((x) => x.name)).toEqual(['Read', 'Edit']);
  });

  test('nothing known is null', async () => {
    const t = new Transcripts(null);
    await t.read([ws]);
    expect(t.sessionOf('ws-1')).toBeNull();
  });
});
