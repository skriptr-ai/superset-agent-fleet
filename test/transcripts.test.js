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

// What a shell orchestrator's create looks like in the file, and what is read off each shape.
// The results mirror a real run: `--json > file` followed by the agent's own summary.

const WS_A = '2e3d9526-7c74-47d2-98c7-6e29c9d55246';
const WS_B = 'cf824acb-6987-47de-8ae0-97e988dea466';
const WS_C = 'b0733d68-68bf-4b89-8a41-383dd65f29fd';
const TERM = '64a6f6dc-766b-4a6b-9ef4-13b88bb278af';

const bash = (id, command, ts) =>
  row(
    'assistant',
    {
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    ts,
  );
const answer = (id, content, ts) =>
  row(
    'user',
    { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } },
    ts,
  );
const creates = (calls) => calls.filter((c) => c.verb === 'create');

describe('a shell create', () => {
  const CREATE = 'superset workspaces create --project $P --name "pt-$n" --json > $S/ws-$n.json';

  test('is named by the CLI output when that is what was printed', async () => {
    const { root } = await transcriptWith([
      bash('t1', `superset ws create --project $P --json`, '2026-09-11T10:24:14Z'),
      answer(
        't1',
        `{"workspace":{"id":"${WS_A}","name":"x"},"terminals":[]}`,
        '2026-09-11T10:24:16Z',
      ),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    expect(calls.map((c) => c.toId)).toEqual([WS_A]);
    expect(calls[0].at).toBe(Date.parse('2026-09-11T10:24:14Z'));
  });

  test("is named by the agent's own summary of a file it saved the output to", async () => {
    const { root } = await transcriptWith([
      bash(
        't1',
        `create() { ${CREATE}; }; create 713; create 710; create 716`,
        '2026-09-11T10:24:14Z',
      ),
      answer(
        't1',
        [
          'PT-716 exit=0\nPT-710 exit=0\nPT-713 exit=0',
          `== 713\n{"id":"${WS_A}","name":"pt-713-agent-bugs","branch":"x","path":null,"agent":null}`,
          `== 710\n{"id":"${WS_B}","name":"pt-710-agent-bugs","branch":"x","path":null,"agent":null}`,
          `== 716\n{"id":"${WS_C}","name":"pt-716-agent-bugs","branch":"x","path":null,"agent":null}`,
        ].join('\n'),
        '2026-09-11T10:24:16Z',
      ),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    // All three, not the first two: one Bash call is often a loop.
    expect(calls.map((c) => c.toId)).toEqual([WS_A, WS_B, WS_C]);
  });

  test('is named by a bare id on its own line, which is what --quiet prints', async () => {
    const { root } = await transcriptWith([
      bash('t1', 'superset ws create --project $P --quiet', '2026-09-11T10:24:14Z'),
      answer('t1', `${WS_A}\n`, '2026-09-11T10:24:16Z'),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    expect(calls.map((c) => c.toId)).toEqual([WS_A]);
  });

  test('reads a result Claude filed as blocks the same as one filed as a string', async () => {
    const { root } = await transcriptWith([
      bash('t1', 'superset ws create --project $P --json', '2026-09-11T10:24:14Z'),
      answer('t1', [{ type: 'text', text: `{"workspaceId":"${WS_A}"}` }], '2026-09-11T10:24:16Z'),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    expect(calls.map((c) => c.toId)).toEqual([WS_A]);
  });

  test('whose output named nothing is handed on with the window it ran in', async () => {
    const { root } = await transcriptWith([
      bash(
        't1',
        'ws=$(superset ws create --project $P --quiet); echo made',
        '2026-09-11T10:24:14Z',
      ),
      answer('t1', 'made\n', '2026-09-11T10:24:16Z'),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    expect(calls).toHaveLength(1);
    expect(calls[0].toId).toBeNull();
    expect(calls[0].at).toBe(Date.parse('2026-09-11T10:24:14Z'));
    expect(calls[0].until).toBe(Date.parse('2026-09-11T10:24:16Z'));
    expect(calls[0].fromId).toBe('ws-1');
  });

  test('of a terminal does not take a bare id or an `id` key for a workspace', async () => {
    const { root } = await transcriptWith([
      bash('t1', 'superset terminals create --workspace "$ws" --json', '2026-09-11T10:24:14Z'),
      answer('t1', `{"id":"${TERM}","workspaceId":"${WS_A}"}`, '2026-09-11T10:24:16Z'),
      bash('t2', 'superset terminals create --workspace "$ws" --quiet', '2026-09-11T10:24:17Z'),
      answer('t2', `${TERM}\n`, '2026-09-11T10:24:18Z'),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    // The first names its workspace properly; the second names only a terminal, and since a
    // terminal is not a workspace it is handed on unresolved rather than mis-filed.
    expect(calls.map((c) => c.toId)).toEqual([WS_A, null]);
  });

  test('a send whose output named nothing is dropped, not handed on', async () => {
    const { root } = await transcriptWith([
      bash('t1', 'superset terminals send --workspace "$ws" --text hi', '2026-09-11T10:24:14Z'),
      answer('t1', 'sent\n', '2026-09-11T10:24:16Z'),
    ]);
    expect(await new Transcripts(root).read([ws])).toEqual([]);
  });

  test('through the MCP server is parked and named by its result too', async () => {
    const { root } = await transcriptWith([
      row(
        'assistant',
        {
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'm1',
                name: 'mcp__superset__workspaces_create',
                input: { projectId: 'p', name: 'w', prompt: 'Fix the flaky tests.' },
              },
            ],
          },
        },
        '2026-09-11T10:24:14Z',
      ),
      answer(
        'm1',
        [{ type: 'text', text: `{"workspace":{"id":"${WS_A}"}}` }],
        '2026-09-11T10:24:16Z',
      ),
    ]);
    const calls = creates(await new Transcripts(root).read([ws]));
    expect(calls.map((c) => [c.toId, c.text])).toEqual([[WS_A, 'Fix the flaky tests.']]);
  });
});
