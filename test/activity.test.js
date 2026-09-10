// The tool calls that motivated each phase rule. A new test runner or a new browser tool is a
// line in lib/activity.js and a case here.

import { describe, expect, test } from 'bun:test';
import {
  commandPhase,
  toolPhase,
  turnSummary,
  screenTools,
  promptGist,
  isRealPrompt,
} from '../lib/activity.js';

describe('commandPhase', () => {
  const cases = [
    ['bun test', 'testing'],
    ['cd /x && bun test lib/parse', 'testing'],
    ['npm run lint', 'testing'],
    ['npx tsc --noEmit', 'testing'],
    ['pytest -q tests/', 'testing'],
    ['git add -A && git commit -m "x"', 'shipping'],
    ['gh pr create --base dev --title x', 'shipping'],
    ['superset terminals send --workspace x --text hi', 'orchestrating'],
    ['superset-send --workspace x --terminal y --text hi', 'orchestrating'],
    ['superset workspaces list --json | jq .', 'reading'],
    ['superset terminals read --workspace x --terminal y', 'reading'],
    ['bun run build', 'building'],
    ['xcodebuild -scheme App build', 'building'],
    ['xcodebuild test -scheme App', 'testing'],
    ['bun run dev', 'running'],
    ['./start.sh', 'running'],
    ['agent-browser open http://localhost:3000', 'browsing'],
    ['npx playwright test', 'browsing'],
    ["sed -i '' 's/a/b/' lib/x.js", 'editing'],
    ["cat > lib/a.js <<'EOF'\nx\nEOF", 'editing'],
    ['echo hi >> notes.md', 'editing'],
    ['bun add zod', 'editing'],
    ['cat lib/x.js | head -40', 'reading'],
    ['curl -s localhost:4400/api/health 2>&1 | jq .', 'reading'],
    ['rg -n "says" public/ > /dev/null; echo $?', 'reading'],
    ['git log --oneline -5 && git status', 'reading'],
    ['sed -n 1,40p lib/x.js', 'reading'],
  ];
  for (const [command, phase] of cases) {
    test(`${JSON.stringify(command)} is ${phase}`, () => {
      expect(commandPhase(command).phase).toBe(phase);
    });
  }

  test('the deciding segment is the detail', () => {
    expect(commandPhase('cd /x && bun test lib/parse && echo done').detail).toBe(
      'bun test lib/parse',
    );
  });

  test('a commit after a test run is committing', () => {
    expect(commandPhase('bun test && git commit -am x').phase).toBe('shipping');
  });

  test('the detail is the command, not its environment, script or control flow', () => {
    expect(commandPhase("PORT=4401 STATE='' bun server.js")).toEqual({
      phase: 'running',
      detail: 'bun server.js',
    });
    expect(commandPhase("bun -e 'import x from y; console.log(x)'").detail).toBe('bun -e …');
    expect(commandPhase("python3 - <<'PY'\nprint(1)\nPY").detail).toBe('python3 - …');
    expect(commandPhase('bun -e "\nimport x from y;\nconsole.log(x)"').detail).toBe('bun -e …');
    expect(commandPhase('for s in a b c; do echo $s; done').detail).toBe('a shell loop');
    expect(commandPhase('S=/tmp/out; bun test > $S/log').detail).toBe('bun test > $S/log');
    expect(commandPhase('S=/tmp/out; bun test > $S/log').phase).toBe('testing');
    expect(commandPhase('if git merge-base --is-ancestor a b; then echo y; fi').detail).toBe(
      'a shell script',
    );
  });
});

describe('toolPhase', () => {
  test('file tools', () => {
    expect(toolPhase({ name: 'Read', input: { file_path: '/a/b/parse.js' } })).toEqual({
      phase: 'reading',
      detail: 'parse.js',
    });
    expect(toolPhase({ name: 'Edit', input: { file_path: '/a/b/world.js' } })).toEqual({
      phase: 'editing',
      detail: 'world.js',
    });
    expect(toolPhase({ name: 'Write', input: { file_path: '/a/new.js' } }).phase).toBe('editing');
    expect(toolPhase({ name: 'Grep', input: { pattern: 'says' } })).toEqual({
      phase: 'reading',
      detail: '“says”',
    });
  });

  test('browser, fleet, sub-agent and question tools', () => {
    expect(toolPhase({ name: 'mcp__claude-in-chrome__computer', input: {} }).phase).toBe(
      'browsing',
    );
    expect(toolPhase({ name: 'mcp__superset__terminals_send', input: {} })).toEqual({
      phase: 'orchestrating',
      detail: 'messaging a worker',
    });
    expect(toolPhase({ name: 'Agent', input: { description: 'Find the parser' } })).toEqual({
      phase: 'delegating',
      detail: 'Find the parser',
    });
    expect(toolPhase({ name: 'AskUserQuestion', input: {} }).phase).toBe('asking');
  });

  test('an unknown MCP tool is research, named after its server', () => {
    expect(toolPhase({ name: 'mcp__linear__get_issue', input: {} })).toEqual({
      phase: 'reading',
      detail: 'linear',
    });
  });
});

describe('turnSummary', () => {
  const read = (f) => ({ name: 'Read', input: { file_path: f } });
  const edit = (f) => ({ name: 'Edit', input: { file_path: f } });
  const bash = (command) => ({ name: 'Bash', input: { command } });

  test('no tools is thinking', () => {
    expect(turnSummary([])).toMatchObject({ phase: 'thinking', trail: [], story: [], tools: 0 });
  });

  test('research then implementation then a test run', () => {
    const s = turnSummary([read('a'), read('b'), edit('a'), edit('b'), bash('bun test')]);
    expect(s.phase).toBe('testing');
    expect(s.detail).toBe('bun test');
    expect(s.trail).toEqual(['reading', 'editing', 'testing']);
    expect(s.story).toEqual(['researched', 'implemented']);
    expect(s.tools).toBe(5);
  });

  test('re-reading the file you just edited is still implementing', () => {
    const s = turnSummary([read('a'), edit('a'), read('a')]);
    expect(s.phase).toBe('editing');
    expect(s.trail).toEqual(['reading', 'editing']);
  });

  test('a long run of reads after edits is researching again', () => {
    const s = turnSummary([edit('a'), read('a'), read('b'), read('c'), read('d')]);
    expect(s.phase).toBe('reading');
    expect(s.story).toEqual(['implemented']);
  });

  test('a single read between two edits is not a step', () => {
    const s = turnSummary([edit('a'), read('b'), edit('c'), bash('bun test')]);
    expect(s.trail).toEqual(['editing', 'testing']);
  });
});

describe('screenTools', () => {
  test('Claude 2.1: a Bash call is a description over a gutter, other tools are Name(arg)', () => {
    const screen = [
      '❯ Make the tests pass',
      '',
      '⏺ Read(lib/parse.js)',
      '  ⎿  Read 40 lines',
      '',
      '⏺ Update(lib/parse.js)',
      '  ⎿  Updated lib/parse.js with 2 additions',
      '',
      '⏺ Run the suite',
      '  ⎿  $ bun test',
      '',
      '· Testing… (12s · ↓ 1.2k tokens)',
    ].join('\n');
    const tools = screenTools(screen);
    expect(tools.map((t) => t.name)).toEqual(['Read', 'Edit', 'Bash']);
    expect(tools[2].input.command).toBe('bun test');
    expect(turnSummary(tools).phase).toBe('testing');
  });

  test('only the current turn counts', () => {
    const screen = ['❯ first', '⏺ Update(a.js)', '❯ second', '⏺ Read(b.js)', '❯ '].join('\n');
    expect(screenTools(screen).map((t) => t.name)).toEqual(['Read']);
  });

  test('Codex bullets each tool with a verb', () => {
    const screen = ['› do it', '• Explored', '• Edited src/a.ts', '• Ran bun test'].join('\n');
    const tools = screenTools(screen);
    expect(tools.map((t) => t.name)).toEqual(['Read', 'Edit', 'Bash']);
    expect(turnSummary(tools).phase).toBe('testing');
  });
});

describe('promptGist', () => {
  test('a Superset brief opens with the workspace line, and the task is after the colon', () => {
    expect(
      promptGist(
        'You are in a Superset workspace for Linear issue PT-666: a folder share on a pre-deploy project is refused when any document has no live fragment. Read it with the linear tool.',
      ),
    ).toBe(
      'a folder share on a pre-deploy project is refused when any document has no live fragment.',
    );
  });

  test('the first sentence of an ordinary prompt', () => {
    expect(promptGist("Alright, let's update the hover. Right now we see the last message.")).toBe(
      "Alright, let's update the hover.",
    );
  });

  test('markup and headings are stripped, and nothing is nothing', () => {
    expect(
      promptGist('<system-reminder>ignore</system-reminder>\n# Task\nFix the build now.'),
    ).toBe('Fix the build now.');
    expect(promptGist('')).toBeNull();
  });
});

describe('isRealPrompt', () => {
  test('the harness talking to itself is not a prompt', () => {
    expect(isRealPrompt('<command-name>/clear</command-name>')).toBe(false);
    expect(isRealPrompt('<local-command-stdout>ok</local-command-stdout>')).toBe(false);
    expect(isRealPrompt('<task-notification>done</task-notification>')).toBe(false);
    expect(isRealPrompt('<system-reminder>x</system-reminder>')).toBe(false);
  });
  test('a person or an orchestrator is', () => {
    expect(isRealPrompt('Fix the build.')).toBe(true);
    expect(isRealPrompt('<system-reminder>x</system-reminder>Fix the build.')).toBe(true);
  });
});
