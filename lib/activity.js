// What an agent is DOING, worked out from the tools it has been calling.
//
// "Working" is one word for a dozen different things, and the ones worth telling apart are the
// ones a person glancing at a room full of agents wants to know: is it still reading around, is
// it changing files, is it running the tests, is it clicking through the app in a browser, is
// it about to commit. None of that is on a status line anywhere. It is, however, implicit in
// the sequence of tool calls, which Claude Code records exactly in its transcript and every CLI
// paints approximately on its screen — so this file turns a list of tool calls into a phase,
// and a turn's worth of them into a trail.
//
// Everything here is a heuristic on tool names and shell commands, and it is kept in one place
// so a new tool or a new test runner is one line here rather than a hunt.

/** The phases, in the words the view uses. `past` is how a phase reads once it is over. */
export const PHASES = {
  reading: { label: 'researching', past: 'researched' },
  editing: { label: 'implementing', past: 'implemented' },
  testing: { label: 'testing', past: 'tested' },
  browsing: { label: 'verifying in the browser', past: 'verified in the browser' },
  building: { label: 'building', past: 'built' },
  running: { label: 'running the app', past: 'ran the app' },
  shipping: { label: 'committing', past: 'committed' },
  delegating: { label: 'delegating to sub-agents', past: 'delegated' },
  orchestrating: { label: 'driving the fleet', past: 'drove the fleet' },
  asking: { label: 'asking you a question', past: 'asked you' },
  thinking: { label: 'thinking', past: 'thought' },
};

/**
 * When one command does several things — `bun test && git commit` — the one that names the
 * intent wins. A test run before a commit is part of committing; a `cd` before anything is
 * part of nothing.
 */
const PRIORITY = [
  'browsing',
  'shipping',
  'orchestrating',
  'testing',
  'building',
  'running',
  'delegating',
  'editing',
  'reading',
];

const READ_TOOLS = /^(Read|Glob|Grep|LS|ToolSearch|WebFetch|WebSearch|NotebookRead|Explore|Skill)$/;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|StrReplace|ApplyPatch|apply_patch)$/;
const DELEGATE_TOOLS = /^(Agent|Task|Workflow)$/;
const BROWSER_TOOLS =
  /^mcp__(claude-in-chrome|claude_in_chrome|browser|browser-use|browseruse|playwright|puppeteer|chrome)/i;
const FLEET_TOOLS = /^mcp__superset__/;

// Shell command shapes. Each is tested against ONE segment of a pipeline (see `segments`), so
// `2>&1` and `| grep` in the same command cannot make a test run look like an edit.
const BROWSING_RE =
  /\b(agent-browser|playwright|puppeteer|cypress|chromium|webdriver|browser-use)\b/i;
const TESTING_RE =
  /(\b(bun|npm|pnpm|yarn|deno)\s+(run\s+)?(test|tests|lint|check|typecheck|type-check|e2e)\b|\b(vitest|jest|mocha|ava|tap|pytest|py\.test|unittest|nose2|cargo\s+test|go\s+test|swift\s+test|xcodebuild\s+test|phpunit|rspec|minitest|tsc\b|eslint|biome\s+(check|lint)|ruff\b|mypy|pyright|flake8|pylint|prettier\s+--check|golangci-lint|clippy|make\s+(test|check|lint))\b)/i;
const SHIPPING_RE =
  /\bgit\s+(commit|push|merge|rebase|tag|cherry-pick)\b|\bgh\s+(pr|release)\s+(create|merge|edit|ready)\b/;
// Only COMMANDS to the fleet count as driving it: a list or a read is what a status sweep
// does, and this very tool does it every tick.
const FLEET_RE =
  /\bsuperset-send\b|\bsuperset\s+(terminals?|term)\s+(send|create)\b|\bsuperset\s+(workspaces?|ws|agents?)\s+create\b/;
const BUILDING_RE =
  /(\b(bun|npm|pnpm|yarn)\s+run\s+build\b|\bbun\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\bswift\s+build\b|\bxcodebuild\b(?!\s+test)|\bxcodegen\b|\bmake\b(?!\s+(test|check|lint|run|dev))|\btsc\s+-b\b|\bnext\s+build\b|\bvite\s+build\b|\bdocker\s+(build|compose\s+build)\b)/;
const RUNNING_RE =
  /(\b(bun|npm|pnpm|yarn)\s+(run\s+)?(dev|start|serve|preview)\b|\bbun\s+[\w./-]+\.(js|ts)\b|\bnode\s+[\w./-]+\.(js|mjs)\b|\bpython3?\s+[\w./-]+\.py\b|\bcargo\s+run\b|\bgo\s+run\b|\bdocker\s+(run|compose\s+up)\b|\bnext\s+dev\b|\bvite\b(?!\s+build)|\buvicorn\b|\bflask\s+run\b|\bstart\.sh\b|\blaunchctl\b|\bopen\s+http)/;
// A write to the tree: an in-place sed, a heredoc, a redirect into a file (not `2>&1`, not
// `/dev/null`), the file utilities, and package installs.
const EDITING_RE =
  /(\bsed\s+-i\b|\bpatch\b|\bmv\b|\bcp\b|\brm\b|\bmkdir\b|\btouch\b|\bln\s+-s|\bchmod\b|\btee\b|<<-?\s*['"]?\w+|(?<![0-9&<])>>?\s*(?!&|\/dev\/null)[\w.\/~$'"-]|\b(npm|pnpm|yarn)\s+(install|i|add|remove|uninstall)\b|\bbun\s+(add|install|remove)\b|\buv\s+(add|sync|pip)\b|\bpip3?\s+install\b|\bcargo\s+add\b|\bgit\s+(checkout|switch|stash|reset|clean|apply)\b)/;

/** A command as a list of the things it does, without the `cd` that only says where. */
function segments(command) {
  return String(command ?? '')
    .split(/\s*(?:&&|\|\||;|\|)\s*|\n+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        !/^cd\s/.test(s) &&
        !/^(export|set|source|\.)\s/.test(s) &&
        // `S=/tmp/x` on its own is a variable being set, not a thing being done.
        !/^\w+=(?:'[^']*'|"[^"]*"|\S*)$/.test(s),
    );
}

/**
 * Which phase one shell command belongs to, and the segment that decided it.
 *
 * @returns {{phase: string, detail: string}}
 */
export function commandPhase(command) {
  const parts = segments(command);
  if (!parts.length) return { phase: 'reading', detail: shorten(command) };
  const tests = [
    ['browsing', BROWSING_RE],
    ['shipping', SHIPPING_RE],
    ['orchestrating', FLEET_RE],
    ['testing', TESTING_RE],
    ['building', BUILDING_RE],
    ['running', RUNNING_RE],
    ['editing', EDITING_RE],
  ];
  let best = null;
  for (const part of parts) {
    for (const [phase, re] of tests) {
      if (!re.test(part)) continue;
      if (!best || PRIORITY.indexOf(phase) < PRIORITY.indexOf(best.phase)) {
        best = { phase, detail: commandDetail(part) };
      }
      break;
    }
  }
  return best ?? { phase: 'reading', detail: commandDetail(parts[0]) };
}

/**
 * One shell segment as something a person can read at a glance: the command without the
 * environment it was given, without the script it was handed inline, and not a control
 * structure — `for s in …` is a loop, and the loop is the fact worth stating.
 */
function commandDetail(segment) {
  let text = String(segment ?? '')
    .replace(/^(?:\w+=(?:'[^']*'|"[^"]*"|\S*)\s+)+/, '')
    .trim();
  const control = /^(if|for|while|until|case|then|do|else|elif|fi|done|\{|\()\b/.exec(text);
  if (control) return `a shell ${/^(for|while|until)$/.test(control[1]) ? 'loop' : 'script'}`;
  // `bun -e 'import …'` / `python3 - <<'PY'`: the program is the point, not its source.
  const heredoc = /^([^'"<]{2,40}?)\s+<</.exec(text);
  if (heredoc) return shorten(`${heredoc[1]} …`);
  const quoted = /^([^'"]{2,40}?)\s+(['"])(.*)$/.exec(text);
  // A quote that never closes on this line opened a script that continues on the next.
  if (quoted && (!quoted[3].includes(quoted[2]) || text.length - quoted[1].length > 12))
    text = `${quoted[1]} …`;
  return shorten(text);
}

const basename = (path) =>
  String(path ?? '')
    .split('/')
    .filter(Boolean)
    .pop() ?? '';

function shorten(text, max = 48) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * One tool call as a phase and the thing it touched.
 *
 * @param {{name: string, input?: object}} tool
 * @returns {{phase: string, detail: string | null}}
 */
export function toolPhase(tool) {
  const name = String(tool?.name ?? '');
  const input = tool?.input ?? {};
  if (name === 'Bash' || name === 'bash' || name === 'shell' || name === 'exec_command') {
    return commandPhase(input.command ?? input.cmd ?? tool.detail);
  }
  if (EDIT_TOOLS.test(name)) {
    return {
      phase: 'editing',
      detail: basename(input.file_path ?? input.notebook_path ?? input.path) || null,
    };
  }
  if (READ_TOOLS.test(name)) {
    const detail =
      name === 'Skill'
        ? `/${input.skill ?? ''}`
        : basename(input.file_path ?? input.path) ||
          (input.pattern ? `“${shorten(input.pattern, 30)}”` : null) ||
          (input.query ? `“${shorten(input.query, 30)}”` : null) ||
          (input.url ? hostOf(input.url) : null);
    return { phase: 'reading', detail: detail || null };
  }
  if (DELEGATE_TOOLS.test(name)) {
    return { phase: 'delegating', detail: shorten(input.description ?? '', 40) || null };
  }
  if (name === 'AskUserQuestion') return { phase: 'asking', detail: null };
  if (BROWSER_TOOLS.test(name)) {
    const action = name.split('__').pop() ?? '';
    return { phase: 'browsing', detail: action.replace(/_/g, ' ') || null };
  }
  if (FLEET_TOOLS.test(name)) {
    const action = name.replace(FLEET_TOOLS, '');
    const detail =
      action === 'terminals_send'
        ? 'messaging a worker'
        : action === 'terminals_read'
          ? 'checking on a worker'
          : /create/.test(action)
            ? 'spawning a worker'
            : action.replace(/_/g, ' ');
    return { phase: 'orchestrating', detail };
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (mcp) return { phase: 'reading', detail: mcp[1].replace(/[_-]+/g, ' ') };
  return { phase: 'reading', detail: name || null };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return shorten(url, 30);
  }
}

/**
 * The phase a turn is in NOW, and the trail of phases it went through to get there.
 *
 * The last tool is not always the answer. An agent implementing something reads the file it
 * just changed, and that one Read should not flip it back to "researching"; so a read that
 * follows other work within the last few calls keeps that work's phase. A long run of reads
 * is researching again, and does flip it.
 *
 * The trail is the turn's story with the noise taken out: consecutive calls in one phase are
 * one step, and a single read sandwiched between two steps of the same phase is dropped.
 *
 * @param {{name: string, input?: object, at?: number}[]} tools in call order
 * @returns {{phase: string, label: string, detail: string | null, trail: string[],
 *   tools: number, since: number | null}}
 */
export function turnSummary(tools) {
  const steps = (tools ?? []).map((t) => ({ ...toolPhase(t), at: t.at ?? null }));
  if (!steps.length) {
    return {
      phase: 'thinking',
      label: PHASES.thinking.label,
      detail: null,
      trail: [],
      story: [],
      tools: 0,
      since: null,
    };
  }

  // Collapse runs, then drop one-read blips between two steps of the same phase.
  const runs = [];
  for (const step of steps) {
    const last = runs[runs.length - 1];
    if (last && last.phase === step.phase) last.n += 1;
    else runs.push({ phase: step.phase, n: 1 });
  }
  const trimmed = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const blip =
      run.phase === 'reading' &&
      run.n === 1 &&
      i > 0 &&
      i < runs.length - 1 &&
      runs[i - 1].phase === runs[i + 1].phase;
    if (blip) continue;
    const last = trimmed[trimmed.length - 1];
    if (last && last.phase === run.phase) last.n += run.n;
    else trimmed.push({ ...run });
  }
  // The current phase: the last call, unless it is a read tucked in behind other recent work.
  const recent = steps.slice(-4);
  let now = steps[steps.length - 1];
  if (now.phase === 'reading') {
    const work = recent.filter((s) => s.phase !== 'reading');
    const reads = recent.length - work.length;
    if (work.length && reads <= 2) now = work[work.length - 1];
  }
  // A read absorbed into the current phase is not a step of its own at the end either.
  const tail = trimmed[trimmed.length - 1];
  if (tail && tail.phase === 'reading' && now.phase !== 'reading' && tail.n <= 2) trimmed.pop();
  const trail = trimmed.map((r) => r.phase);

  // The story so far, in the past tense, up to (not including) what is happening now. A long
  // turn is told from its last few steps: nobody needs the whole afternoon on a card.
  const shown = trail.slice(-6);
  const before = shown[shown.length - 1] === now.phase ? shown.slice(0, -1) : shown;
  return {
    phase: now.phase,
    label: PHASES[now.phase]?.label ?? now.phase,
    detail: now.detail,
    trail: shown,
    story: before.map((p) => PHASES[p]?.past ?? p),
    tools: steps.length,
    since: now.at,
  };
}

// ── The screen, when there is no transcript ──────────────────────────────────────────────────

/**
 * Tool calls read back off a screen, for the agents whose transcript is out of reach: Codex,
 * and anything on another machine. This is the same guess the rest of the screen parser
 * makes — whatever survived the last repaint — and it is only consulted when nothing recorded
 * the calls exactly.
 *
 * Claude Code (2.1.x) paints a Bash call as its one-line description with the command in a
 * gutter under it, and the other tools as `⏺ Name(argument)`. Codex bullets each tool with a
 * past-tense verb: `• Ran bun test`, `• Edited lib/x.js`, `• Explored`.
 *
 * Only the CURRENT turn counts, which on screen is everything after the last prompt echo.
 *
 * @returns {{name: string, input: object}[]}
 */
export function screenTools(text) {
  const lines = String(text ?? '').split('\n');

  // The last prompt the human (or the orchestrator) typed: Claude echoes it as `❯ text`,
  // Codex as `› text`. The empty prompt box at the bottom is `❯ ` with nothing after it.
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^[❯›]\s+\S/.test(lines[i]) && !/^[❯›]\s+Ask Codex/.test(lines[i])) start = i + 1;
  }

  const tools = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const gutter = /^\s*⎿\s+\$\s+(.+)$/.exec(line);
    if (gutter) {
      tools.push({ name: 'Bash', input: { command: gutter[1] } });
      continue;
    }
    const claude =
      /^\s{0,3}[⏺●]\s+(Read|Edit|Update|Write|MultiEdit|Glob|Grep|Search|Fetch|WebFetch|WebSearch|Task|Agent|Skill|Bash)\((.*?)\)?\s*$/.exec(
        line,
      );
    if (claude) {
      const [, verb, arg] = claude;
      const name =
        verb === 'Update'
          ? 'Edit'
          : verb === 'Search'
            ? 'Grep'
            : verb === 'Fetch'
              ? 'WebFetch'
              : verb;
      const input =
        name === 'Bash'
          ? { command: arg }
          : name === 'Grep'
            ? { pattern: arg.replace(/^pattern:\s*/, '') }
            : name === 'Task' || name === 'Agent'
              ? { description: arg }
              : { file_path: arg };
      tools.push({ name, input });
      continue;
    }
    const codex =
      /^\s{0,3}[•·]\s+(Ran|Explored|Read|Searched|Listed|Edited|Added|Created|Deleted|Wrote)\b\s*(.*)$/.exec(
        line,
      );
    if (codex) {
      const [, verb, arg] = codex;
      if (verb === 'Ran') tools.push({ name: 'Bash', input: { command: arg } });
      else if (/^(Edited|Added|Created|Deleted|Wrote)$/.test(verb))
        tools.push({ name: 'Edit', input: { file_path: arg } });
      else tools.push({ name: 'Read', input: { file_path: arg } });
    }
  }
  return tools;
}

// ── The task ─────────────────────────────────────────────────────────────────────────────────

/**
 * A prompt's opening, as a one-line summary of what was asked.
 *
 * Briefs from an orchestrator open with the ask and go on for paragraphs; a person's prompt
 * tends to open with a preamble. Either way the first sentence is the best single line there
 * is, once the markup that sometimes wraps a prompt is stripped.
 */
export function promptGist(prompt, max = 140) {
  const text = String(prompt ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<[^>\n]{1,40}>/g, ' ')
    // `# Task` is a label; `# Fix the parser so ✶ counts` is the ask. Short headings go.
    .replace(/^#+\s*(?:\S+\s*){1,3}$/gm, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  // `You are in a Superset workspace for Linear issue PT-666: …` is a common opening, and the
  // half after the colon is the task.
  const lead = /^You are (?:in|working in) a [^:]{0,80}:\s*(.+)$/i.exec(text);
  const body = lead ? lead[1] : text;
  const sentence = /^(.{20,}?[.!?])(?:\s|$)/.exec(body)?.[1] ?? body;
  return shorten(sentence, max);
}

/**
 * Whether a prompt is something a person or an orchestrator actually said, as opposed to
 * the harness talking to itself: slash-command echoes, hook output, tool results wrapped as a
 * user turn, a wake-up from a scheduled loop.
 */
export function isRealPrompt(text) {
  const body = String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
  if (!body) return false;
  if (
    /^<(command-name|command-message|local-command-stdout|local-command-stderr|task-notification|ide_opened_file|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)/.test(
      body,
    )
  )
    return false;
  return true;
}
