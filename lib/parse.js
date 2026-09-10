// Turning a terminal screen back into an agent.
//
// `superset terminals read` hands back the visible screen as text — the same thing a human
// sees. Everything Superset Agent Fleet knows about an agent (is it working, which model, what did it
// last say, who did it just message) is recovered from that text here, so all the guessing
// lives in one file with the sample screens that motivated each pattern written next to it.
//
// The patterns are deliberately anchored to each CLI's own chrome rather than to loose
// keywords. "esc to interrupt" appears BOTH in Codex's working spinner and in its
// "messages queued" notice, so a bare substring test reports a waiting agent as busy.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

/**
 * A uuid as it may appear on a screen: hex, dashes and whatever whitespace a hard wrap
 * pushed into the middle of it. Claude renders a command inside a box narrower than the
 * terminal and wraps it mid-token, so `--workspace 48c1e920-8fdb-46ee-968e-ef48de4fc54b`
 * reaches this file as two pieces, and a strict uuid pattern sees neither of them.
 */
const LOOSE_UUID = '[0-9a-f][0-9a-f\\s-]{34,44}';

/** Shell prompts title themselves `user@host:path`; agents title themselves after the task. */
const SHELL_TITLE_RE = /^[\w.-]+@[\w.-]+:/;

/**
 * A shell sitting at its prompt with nothing else to show for itself: `❯`, `$`, `%`, `➜`.
 *
 * Needed because the title test above only works on THIS machine. A terminal read from another
 * host arrives with an empty title whatever it is running, so every remote shell fell through
 * to `unknown`, and `unknown` is kept as an agent — ten `pip install` scrollbacks were being
 * drawn as ten rooms full of nobody. Agent terminals on the same hosts all carry a real title,
 * so the two are cleanly separable; this is only ever consulted once the agent chrome tests
 * above have already declined, so a recognised agent can never be demoted to a shell by it.
 */
const SHELL_PROMPT_TAIL_RE = /^\s*[❯➜$%#>]\s*$/;

/** The bottom line of a screen that actually has something on it. */
function lastLine(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return '';
}

// `  ◇ Opus 5  ┊  high  ┊  20%  ┊  ⎇ preben/pt-448-…  ┊  ⌂ mac`
const CLAUDE_STATUS_RE = /◇\s*([^┊|\n]+?)\s*┊/;
const CLAUDE_BRANCH_RE = /⎇\s*(\S+)/;

// `  gpt-6-astra · panoramic-oxygen · milestone-three-backlog · Context 54% …`
const CODEX_FOOTER_RE = /^\s*([a-z][\w.-]*(?:-[\w.]+)*)\s+·\s+(\S+)\s+·\s+(\S+)\s+·\s+Cont/m;

/**
 * The glyph at the left of Claude's spinner line, and of the done line it turns into.
 *
 * Claude Code animates it through six frames, played forward and then back:
 *
 *     ["·", "✢", "✳", "✶", "✻", "✽"]      (from the 2.1.267 binary; one build swaps `✳` for `*`)
 *
 * Every frame has to be here. This class was missing `✶` for a long time, and the cost was
 * not a rare miss: a screen read on that frame — one poll in six — found no spinner, fell
 * through to idle, and walked a working session out of the room and back in on the next tick.
 * The frames are checked against real screens in test/parse.test.js.
 */
const SPINNER_GLYPH = '[·✢✳✶✻✽∗*]';

// Claude's spinner: `· Bloviating… (16m 34s · ↓ 14.4k tokens)` / `(… · esc to interrupt)`.
const CLAUDE_WORKING_RE = new RegExp(
  `^[ \\t]*${SPINNER_GLYPH}[ \\t]+(\\S[^(\\n]*?)[ \\t]*\\((\\d[^)\\n]*(?:esc to interrupt|↓|↑|tokens)[^)\\n]*)\\)`,
  'm',
);

/**
 * Claude with nothing in flight but its sub-agents: `✻ Waiting for 1 background agent to
 * finish`. Same slot as the spinner, no timer in brackets — so the spinner pattern declines
 * it, and a session that has fanned its work out to sub-agents used to read as resting.
 */
const CLAUDE_SUBAGENT_WAIT_RE = new RegExp(
  `^[ \\t]*${SPINNER_GLYPH}[ \\t]+Waiting for (\\d+) background (agent|task)s?\\b`,
  'm',
);

// Claude at rest: `✻ Sautéed for 56s · done 11:20 AM`.
const CLAUDE_DONE_RE = new RegExp(
  `^[ \\t]*${SPINNER_GLYPH}[ \\t]+(\\S[^\\n]*?)[ \\t]+for[ \\t]+[\\dhms ]+[ \\t]*·[ \\t]*done\\b`,
  'm',
);

/**
 * Claude stopped by a human: `⎿  Interrupted · What should Claude do instead?`. There is no
 * done line after an interrupt, and — per the host service's own source — no Stop hook
 * either, so this is the only evidence anywhere that the turn is over.
 */
const CLAUDE_INTERRUPTED_RE = /^[ \t]*[⎿└]?[ \t]*Interrupted\b/m;

// Codex's spinner: `• Working (11m 04s • esc to interrupt)`.
const CODEX_WORKING_RE = /^[ \t]*[•·][ \t]+(Working|Thinking|Running)[ \t]*\((\d[^)\n]*)\)/m;

// Codex parks on this line whenever it has nothing in flight.
const CODEX_PROMPT_RE = /^\s*›\s*Ask Codex to do anything/m;

/**
 * Codex's startup gate: it will not run in a directory until a human has trusted it.
 *
 * This is chrome like any other, and it matters more than most, because it is the ONE screen a
 * freshly spawned Codex shows before it has drawn a footer or its prompt line. Without this a
 * new Codex workspace is `unknown` for exactly as long as it is stuck — which is to say, for
 * as long as anybody would want to be told about it.
 */
const CODEX_TRUST_RE = /Do you trust the contents of this directory|Trusting will apply to the/;

/**
 * A permission prompt blocks the agent on a HUMAN, which is the one state the orchestrator
 * cannot clear by sending another message — worth its own colour in the world.
 *
 * Both marker glyphs are matched. Claude points at a choice with `❯` and Codex with `›`, and
 * keying on Claude's alone made every Codex agent sitting on a numbered prompt — including the
 * trust gate every new Codex workspace opens with — report as idle: not merely uncoloured, but
 * described as the opposite of what it was.
 */
const WAITING_RE =
  /(Do you want to (?:proceed|make|create)|Do you trust|[❯›]\s*1\.\s*Yes|Allow this|\[y\/n\]|\(y\/N\)|Approve\?|Waiting for your input)/i;

// Codex holds follow-ups until the current tool call lands, and prints them verbatim. This is
// the one place a message's real TEXT is visible, so it is the best source for a speech bubble.
const QUEUED_HEADER_RE = /^\s*[•·]\s*Messages to be submitted after next tool call/m;

/**
 * Screen furniture that is never something the agent "said": tool-output gutters, box rules,
 * the prompt box, the status bar, and Claude's recap/hint lines.
 */
const CHROME_LINE_RE =
  /^\s*(?:›|❯|>|⏵|✔|✗|◇|⎿|└|│|↳|┊|※|\.\.\.|…)|[─━═]{6,}|^\s*[+·]?\s*…\s*\+\d+\s+lines/;

const STATUS_LINE_RE =
  /(esc to interrupt|ctrl \+ |ctrl\+|bypass permissions|Cont(?:ext)?\s*\d*%?…?|Update installed|for side|·\s*done\s+\d|new task\?\s*\/clear|↓\s*[\d.]+k?\s*tokens|background terminal running)/i;

// A trailing `· 9m 28s` is Claude's per-tool elapsed counter. The row it decorates reads as
// clean prose (it is the tool's own description) and would otherwise win the bubble over the
// narration above it.
const TOOL_ELAPSED_SUFFIX_RE = /·\s*(?:\d+m\s*)?\d+s\s*$/;

/**
 * Which CLI is in this terminal. Keyed off each tool's own chrome rather than the title,
 * because Superset rewrites the title to the task name and a bare shell keeps `user@host:path`.
 *
 * @returns {'claude'|'codex'|'shell'|'unknown'}
 */
function detectFlavor(title, text) {
  if (CODEX_FOOTER_RE.test(text) || CODEX_PROMPT_RE.test(text) || CODEX_TRUST_RE.test(text))
    return 'codex';
  if (CLAUDE_STATUS_RE.test(text) || /⏵⏵|bypass permissions on/.test(text)) return 'claude';
  if (SHELL_TITLE_RE.test(title || '')) return 'shell';
  // No chrome, no title, nothing but a prompt: a shell on another host. See SHELL_PROMPT_TAIL_RE.
  if (!String(title ?? '').trim() && SHELL_PROMPT_TAIL_RE.test(lastLine(text))) return 'shell';
  return 'unknown';
}

/**
 * The screen is a transcript with a fixed block of UI pinned under it. Everything from the
 * spinner/done line down — recap, hint, prompt box, status bar — is that UI, so the earliest
 * of those markers is where the agent's own output stops. Anchoring on it is what keeps
 * `lastUtterance` from reporting "Bloviating… (20m 40s)" as something the agent said.
 */
function transcriptEnd(text) {
  const markers = [
    CLAUDE_WORKING_RE,
    CLAUDE_SUBAGENT_WAIT_RE,
    CLAUDE_DONE_RE,
    CODEX_WORKING_RE,
    CODEX_PROMPT_RE,
    /^\s*※\s*recap:/m,
  ];
  let cut = text.length;
  for (const re of markers) {
    // `re` is /m but not /g, so scan backwards over successive tails for the LAST hit.
    let from = 0;
    let last = -1;
    for (;;) {
      const hit = re.exec(text.slice(from));
      if (!hit) break;
      last = from + hit.index;
      from = last + Math.max(hit[0].length, 1);
    }
    if (last !== -1 && last < cut) cut = last;
  }
  return cut;
}

/**
 * Prose, as opposed to the shell lines and JSON blobs an agent is equally likely to have
 * left at the bottom of its transcript. Tool output is what the agent RAN; the bubble wants
 * what it SAID, and the two are only separable by shape once the gutter characters are gone.
 */
function looksLikeProse(line) {
  if (line.length < 12) return false;
  const words = line.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w));
  if (words.length < 4) return false;
  const letters = (line.match(/[A-Za-z ]/g) ?? []).length / line.length;
  if (letters < 0.62) return false;
  return !/[{}`|]|=>|\$\(|2>&1|<\/|\/\*|;\s*(?:do|done|then|fi)\b|^\s*(?:\$|#|npm|bun|git|cd|sed|grep|cat)\s/.test(
    line,
  );
}

/**
 * Last thing the agent said in prose, for the speech bubble.
 *
 * Codex marks each narration turn with a `•` bullet at the left margin and gutters tool
 * output under it, so the last non-tool bullet is exactly the right block. Claude has no such
 * marker — its narration is plain indented text — so there the trailing prose paragraph is
 * collected instead, with shell and code lines rejected by shape.
 */
export function lastUtterance(text, maxChars = 260) {
  const lines = text.slice(0, transcriptEnd(text)).split('\n');

  const TOOL_HEADER =
    /^(Ran|Explored|Read|Search|Bash|Update|Write|Edit(ed)?|Created|Deleted|Listed|Fetched|Grep|Glob|Task|Searched|Fetched|Working|Thinking|Waiting for background terminal|Background command|Messages to be)\b/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const bullet = /^\s{0,3}[•⏺●]\s+(\S.*)$/.exec(lines[i]);
    if (!bullet) continue;
    const said = bullet[1].trim();
    // A bullet can also head a tool row, whose one-line description reads like prose but
    // carries the elapsed counter. Narration never does.
    if (TOOL_HEADER.test(said) || TOOL_ELAPSED_SUFFIX_RE.test(said) || !looksLikeProse(said))
      continue;
    const block = [said];
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j];
      if (!cont.trim() || /^\s{0,3}[•⏺●]\s/.test(cont) || CHROME_LINE_RE.test(cont)) break;
      block.push(cont.trim());
    }
    return clamp(block.join(' '), maxChars);
  }

  const prose = [];
  for (let i = lines.length - 1; i >= 0 && prose.length < 6; i--) {
    const raw = lines[i];
    const line = raw.replace(/^\s*[•·⏺●]\s+/, '').trim();
    if (!line) {
      if (prose.length) break; // a blank line above collected prose ends the paragraph
      continue;
    }
    const isTooling =
      TOOL_HEADER.test(line) || TOOL_ELAPSED_SUFFIX_RE.test(line) || !looksLikeProse(line);
    if (CHROME_LINE_RE.test(raw) || STATUS_LINE_RE.test(raw) || isTooling) {
      if (prose.length) break;
      continue;
    }
    prose.unshift(line);
  }
  return clamp(prose.join(' '), maxChars);
}

function clamp(value, maxChars) {
  const joined = value.replace(/\s+/g, ' ').trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

/** Messages the agent has received but not yet started on. */
export function queuedMessages(text) {
  const match = QUEUED_HEADER_RE.exec(text);
  if (!match) return [];
  const after = text.slice(match.index + match[0].length).split('\n');
  const out = [];
  let current = null;
  for (const line of after) {
    const started = /^\s*↳\s*(.*)$/.exec(line);
    if (started) {
      if (current) out.push(current);
      current = started[1].trim();
      continue;
    }
    if (current === null) continue;
    const trimmed = line.trim();
    // Continuation lines are indented under the ↳; anything else ends the block.
    if (!trimmed || CHROME_LINE_RE.test(line) || /^\s*[•·]/.test(line)) break;
    current += ` ${trimmed}`;
  }
  if (current) out.push(current);
  return out.map((m) => (m.length > 400 ? `${m.slice(0, 399)}…` : m)).filter(Boolean);
}

/**
 * The value of `--text`, which is where a message's actual words are.
 *
 * The agent CLIs elide a long command as `… +11 lines`, so the quote frequently never closes
 * on screen. A truncated prefix is still worth showing — it is the opening of the real
 * message — so it is returned with an ellipsis rather than thrown away for being incomplete.
 */
function parseTextArg(window) {
  // The screen elides a long command as `… +11 lines`, so a message's quote often never
  // closes. Whether the value is complete is decided by that marker rather than by the
  // regex, which will happily backtrack onto some earlier apostrophe to find a closer.
  const elided = /--text[\s\S]*…\s*\+\d+\s+lines?/.test(window);

  // `'\''` inside a single-quoted shell string is an ESCAPED apostrophe: it continues the
  // same argument. Matching it as part of the body is what stops a message being cut at the
  // first apostrophe the orchestrator wrote.
  const single = /--text\s+'((?:[^']|'\\'')*)'/.exec(window);
  const double = /--text\s+"((?:[^"]|\\")*)"/.exec(window);
  const closed = single ?? double;
  if (closed) return clean(unescapeShell(closed[1]), elided);

  const unterminated = /--text\s+(['"])([\s\S]*)$/.exec(window);
  if (unterminated) return clean(unescapeShell(unterminated[2]), true);

  // An unquoted value is a single shell word. A stray quote here means an opening quote was
  // captured without its body, which is not a message.
  const bare = /--text\s+([^\s'"][^\s]*)/.exec(window);
  return bare ? clean(bare[1], false) : null;
}

const unescapeShell = (value) => value.replace(/'\\''/g, "'").replace(/\\"/g, '"');

function clean(raw, truncated) {
  const text = raw
    // `└` and `⎿` open the CLI's own result gutter. They cannot occur inside a shell argument
    // on screen, so they mark exactly where an unterminated quote stopped being the message.
    .split(/[└⎿]/)[0]
    .replace(/…\s*\+\d+\s+lines?/g, '')
    .replace(/\s+--(?:no-)?[a-z-]+\b.*$/, '') // a following flag, not part of the message
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const capped = text.length > 320 ? `${text.slice(0, 319)}…` : text;
  return truncated && !capped.endsWith('…') ? `${capped}…` : capped;
}

/**
 * The uuid given to `--workspace` / `--terminal`, put back together across a hard wrap.
 *
 * The whitespace is stripped and the result checked against a real uuid rather than trusted:
 * a loose match that does not reassemble into one is a coincidence in some table, not an id.
 */
function idAfter(flag, window) {
  const hit = new RegExp(`--${flag}\\s+(${LOOSE_UUID})`).exec(window);
  if (!hit) return null;
  const id = hit[1].replace(/\s+/g, '').slice(0, 36);
  return UUID_RE.test(id) ? id : null;
}

/**
 * Every `superset` invocation visible on this screen, with the workspace it targets.
 *
 * An orchestrator's screen is a log of the CLI calls it made, which is the only place the
 * fleet's message traffic is observable at all — nothing in the CLI exposes a message history.
 * Wrapped commands are re-joined first: the agent CLIs break a long command across lines and
 * gutter the continuation with `│`, which would otherwise split a uuid in half.
 */
export function extractCliCalls(text) {
  const flat = text.replace(/[│┃]/g, ' ').replace(/\s+/g, ' ');
  const calls = [];
  const verbRe = /superset\s+(terminals|term|workspaces|ws|agents|tasks)\s+([a-z]+)/g;
  let match;
  while ((match = verbRe.exec(flat)) !== null) {
    const noun = match[1];
    const verb = match[2];
    // Bound the argument window at the next invocation so one command cannot claim the
    // next one's --workspace when its own scrolled off or was elided as `… +N lines`.
    const rest = flat.slice(match.index + match[0].length);
    const nextCall = rest.search(/superset\s+(?:terminals|term|workspaces|ws|agents|tasks)\s/);
    const span = verb === 'send' ? 900 : 320;
    const window = rest.slice(0, nextCall === -1 ? span : Math.min(nextCall, span));

    const workspaceId = idAfter('workspace', window);
    if (!workspaceId) continue;

    calls.push({
      noun,
      verb,
      workspaceId,
      terminalId: idAfter('terminal', window),
      text: parseTextArg(window),
    });
  }
  return calls;
}

/**
 * The last thing on the screen that says whether a turn is running, and where it says it.
 *
 * Position matters more than precedence. A finished turn leaves its done line on screen, and
 * when the next message arrives the new spinner draws BELOW it: for the first screenful of
 * the new turn both are in the tail. Checking the done line first read every freshly
 * re-prompted session as resting until the done line scrolled away — so whichever marker is
 * lowest on the screen is the one describing now.
 *
 * `waiting` is the exception and is checked anywhere in the tail: a permission prompt is
 * drawn under the spinner, and a session blocked on a human is blocked whatever the spinner
 * above it says.
 *
 * @returns {{mark: 'working'|'done'|'waiting'|'interrupted'|null, activity: string|null}}
 */
function lastMark(tail, flavor) {
  if (WAITING_RE.test(tail)) return { mark: 'waiting', activity: 'needs a human' };

  const candidates = [];
  const consider = (re, mark, activityOf) => {
    const hit = re.exec(tail);
    if (hit) candidates.push({ at: hit.index, mark, activity: activityOf(hit) });
  };

  if (flavor === 'codex') {
    consider(CODEX_WORKING_RE, 'working', (m) => `${m[1]} · ${m[2]}`);
    consider(CODEX_PROMPT_RE, 'done', () => 'done');
  } else {
    consider(CLAUDE_WORKING_RE, 'working', (m) => `${m[1].replace(/…$/, '')} · ${m[2]}`);
    consider(
      CLAUDE_SUBAGENT_WAIT_RE,
      'working',
      (m) => `waiting on ${m[1]} sub-agent${m[1] === '1' ? '' : 's'}`,
    );
    consider(CLAUDE_DONE_RE, 'done', () => 'done');
    consider(CLAUDE_INTERRUPTED_RE, 'interrupted', () => 'interrupted');
  }

  if (!candidates.length) return { mark: null, activity: null };
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0];
}

/**
 * Read one terminal screen into the fields the world needs.
 *
 * `status` is the screen's best answer and `mark` is how sure it is: a mark names the line the
 * status came from, and a null mark means nothing on screen said either way — the spinner is
 * between frames, the screen was just cleared — and the status is only the default. The world
 * fills that gap from the host service's hook state, which has no frames to miss; see
 * lib/world.js.
 */
export function classifyTerminal({ title = '', text = '' }) {
  const flavor = detectFlavor(title, text);
  const tail = text.split('\n').slice(-28).join('\n');

  let model = null;
  let branch = null;
  if (flavor === 'claude') {
    model = CLAUDE_STATUS_RE.exec(text)?.[1]?.trim() ?? null;
    branch = CLAUDE_BRANCH_RE.exec(text)?.[1] ?? null;
  } else if (flavor === 'codex') {
    const footer = CODEX_FOOTER_RE.exec(text);
    model = footer?.[1] ?? null;
    branch = footer?.[3] ?? null;
  }

  const queued = queuedMessages(tail);

  let status = 'idle';
  let mark = null;
  let activity = null;
  if (flavor === 'shell') {
    status = 'shell';
  } else {
    const found = lastMark(tail, flavor);
    mark = found.mark;
    activity = found.activity;
    if (mark === 'working' || mark === 'waiting') status = mark;
  }

  // A queued follow-up means a message landed while the agent was mid-tool-call. It is still
  // working, but the interesting fact is the unread mail, so surface that instead.
  if (queued.length && status === 'working') activity = `reading ${queued.length} new message`;

  return {
    flavor,
    model,
    branch,
    status,
    mark,
    activity,
    queued,
    says: flavor === 'shell' ? '' : lastUtterance(text),
    calls: extractCliCalls(text),
  };
}
