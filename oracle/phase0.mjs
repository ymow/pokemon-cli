#!/usr/bin/env node
// oracle/phase0.mjs — Phase 0 "spike" for the CLI oracle.
// ----------------------------------------------------------------------------
// Goal of this phase: BEFORE building the expensive PTY wrapper, find out whether
// Claude can usefully predict your next steps + the decision branches ahead, given
// only your recent shell history + current git state.
//
// Zero dependencies: Node 18+ has global fetch, so we call the Anthropic Messages
// API over raw HTTP. No `npm install`. Later phases switch to @anthropic-ai/sdk.
//
// Usage:
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node oracle/phase0.mjs                 # uses your real zsh history + git state
//   node oracle/phase0.mjs --n 60          # look at the last 60 history commands
//   node oracle/phase0.mjs --dry           # print the context it would send, no API call
// ----------------------------------------------------------------------------

import { execSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const MODEL = "claude-opus-4-8";
const GHOST_MODEL = "claude-haiku-4-5"; // fast single-line "ghost text" guess (Phase 3)
const API_URL = "https://api.anthropic.com/v1/messages";

// --- tiny arg parsing ------------------------------------------------------
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const WATCH = args.includes("--watch");
// --auto: re-predict automatically when the watched tmux pane settles after a
// command (no Enter needed). Needs ORACLE_PANE. See Phase 4 in README.
const AUTO = args.includes("--auto");
// Configurable timings. ORACLE_POLL_MS / ORACLE_SETTLE_MS override the defaults;
// anything unset, empty, non-numeric, zero, or negative falls back to the default.
const envInt = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const POLL_MS = envInt("ORACLE_POLL_MS", 600); // how often to sample the pane
const SETTLE_MS = envInt("ORACLE_SETTLE_MS", 1200); // pane must be unchanged this long before we re-predict
// Watchdogs so a hung `claude` (auth prompt, network stall) can never freeze the
// panel. Ghost is best-effort (skip on timeout); the full prediction rejects.
const GHOST_TIMEOUT_MS = envInt("ORACLE_GHOST_TIMEOUT_MS", 8000);
const CLI_TIMEOUT_MS = envInt("ORACLE_CLI_TIMEOUT_MS", 90000);
// Backend: default reuses the local `claude` CLI's login (no API key needed).
// `--api` opts into a direct api.anthropic.com call with ANTHROPIC_API_KEY.
const USE_API = args.includes("--api");
// Framing for the Phase 3 ghost line. Phase 5 (agent vs shell) can flip this to
// "agent"; absent that, it degrades gracefully to "shell".
const GHOST_MODE = process.env.ORACLE_MODE === "agent" ? "agent" : "shell";
const nIdx = args.indexOf("--n");
const HISTORY_N = nIdx !== -1 ? parseInt(args[nIdx + 1], 10) || 40 : 40;

// --- ANSI helpers ----------------------------------------------------------
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

// --- context collectors ----------------------------------------------------

// Parse zsh history. Extended format lines look like:  ": 1700000000:0;git status"
// Plain lines are just the command. We strip the metadata and keep the command.
function readShellHistory(n) {
  const file = process.env.HISTFILE || join(homedir(), ".zsh_history");
  if (!existsSync(file)) return { file, commands: [] };
  // zsh history can contain invalid UTF-8 (metafied bytes); read latin1 to avoid throws.
  const raw = readFileSync(file, "latin1");
  const lines = raw.split("\n");
  const commands = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^: \d+:\d+;(.*)$/);
    const cmd = (m ? m[1] : line).trim();
    if (cmd) commands.push(cmd);
  }
  return { file, commands: commands.slice(-n) };
}

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function gitState() {
  const inside = sh("git rev-parse --is-inside-work-tree") === "true";
  if (!inside) return { repo: false };
  return {
    repo: true,
    branch: sh("git branch --show-current"),
    status: sh("git status --short"),
    recentLog: sh("git log --oneline -5"),
    ahead: sh("git rev-list --count @{u}..HEAD 2>/dev/null"),
    behind: sh("git rev-list --count HEAD..@{u} 2>/dev/null"),
  };
}

// If launched beside a tmux pane (Phase 1 wrapper sets ORACLE_PANE), grab what's
// live on that pane's screen — this is what makes the oracle "watch your session".
function captureExtra() {
  const pane = process.env.ORACLE_PANE;
  if (!pane) return "";
  return sh(`tmux capture-pane -p -t '${pane.replace(/'/g, "")}'`);
}

// The foreground command of the watched pane. NOTE: `claude` is a node script,
// so this typically reports "node" — used only as a soft corroborator below.
function paneCurrentCommand() {
  const pane = process.env.ORACLE_PANE;
  if (!pane) return "";
  return sh(`tmux display-message -p -t '${pane.replace(/'/g, "")}' '#{pane_current_command}'`);
}

// --- agent-mode detection --------------------------------------------------
// Decide whether the watched pane is running an interactive Claude Code session
// (vs a plain shell). `claude` runs under node, so pane_current_command alone is
// unreliable; we drive detection off STABLE Claude Code UI text markers and use
// the command name only as a tie-breaker. Require two independent signals so a
// shell that merely prints the word "Claude" doesn't flip us into agent mode.
//
// Markers are grouped: a STRUCTURAL marker (the input box) AND an INTERACTION
// marker (a hint line). Box-drawing border chars + a leading "> " prompt are the
// most version-stable structural cues; the hint lines move around but several are
// OR'd so any one suffices.
const AGENT_STRUCTURAL = [
  /\n>\s/,            // the "> " input prompt line inside Claude Code's box
  /[╭╰].*[─]{3,}/, // rounded box-drawing border of the input box (╭──…  ╰──…)
];
const AGENT_INTERACTION = [
  /esc to interrupt/i,
  /⏵⏵\s*accept edits/, // ⏵⏵ accept edits
  /\? for shortcuts/i,
  /✻/,            // ✻ spinner / Claude Code glyph
];

function detectAgentMode(paneText) {
  if (process.env.ORACLE_FORCE_MODE === "agent") return true;
  if (process.env.ORACLE_FORCE_MODE === "shell") return false;
  const text = paneText || "";
  if (!text.trim()) return false;
  const hasStructural = AGENT_STRUCTURAL.some((re) => re.test(text));
  const hasInteraction = AGENT_INTERACTION.some((re) => re.test(text));
  // Soft corroborator: pane_current_command sometimes is literally "claude".
  const cmd = paneCurrentCommand().toLowerCase();
  const cmdSaysClaude = cmd === "claude";
  // Fire when we see the input box AND an interaction hint, OR when the box is
  // present and the foreground command is explicitly `claude`.
  return (hasStructural && hasInteraction) || (hasStructural && cmdSaysClaude);
}

// Cheap secret redaction so we don't ship tokens to the API in the spike.
function redact(text) {
  return text
    .replace(/\b(sk-[a-zA-Z0-9_-]{12,})\b/g, "sk-***REDACTED***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, "gh*_***REDACTED***")
    .replace(/(--?(?:password|token|secret|api[-_]?key)[ =])\S+/gi, "$1***REDACTED***");
}

// --- prompt assembly -------------------------------------------------------

const SYSTEM = `You are an "oracle" layered over a developer's terminal. You are given the
developer's recent shell history and current git state. Your job is FORESIGHT:
predict what they are most likely to do next, and the decision branches that will
unfold a few steps after that.

- next_steps: the 2-4 most likely *next* commands, each with a probability (0-1)
  and a one-line rationale grounded in the actual context.
- branches: 1-3 decision forks that are likely to appear soon (e.g. "tests fail",
  "merge conflict", "deploy rejected"). For each, give the trigger and 2-3
  options, each option saying where it leads.
Be concrete and specific to THIS context — reference real branch names, files,
and commands you can see. Do not invent state you weren't given.`;

// Agent mode: the watched pane is an interactive Claude Code session. Re-task the
// SAME schema — next_steps[].command now holds the next natural-language PROMPT
// the developer will type to Claude, and branches describe where the agent
// CONVERSATION forks (e.g. "Claude proposes a refactor", "tool call fails").
const SYSTEM_AGENT = `You are an "oracle" layered over a developer who is pair-programming with Claude
Code (an agentic CLI) in their terminal. You are given their recent shell history,
current git state, and a live snapshot of the Claude Code session on screen. Your
job is FORESIGHT about the AGENT conversation, not raw shell commands.

- next_steps: the 2-4 most likely *next prompts the developer will type to Claude*,
  in natural language (e.g. "run the tests and fix any failures", "now write a
  README for this module"), each with a probability (0-1) and a one-line rationale
  grounded in what Claude just did / what's on screen.
- branches: 1-3 forks the agent conversation is likely to hit soon (e.g. "Claude
  proposes a large diff", "a tool/command Claude runs fails", "Claude asks for
  permission/clarification"). For each, give the trigger and 2-3 options, each
  saying where that path leads the session.
Ground everything in the visible Claude Code transcript: reference the files,
commands, and decisions actually shown. Do not invent state you weren't given.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    situation: { type: "string", description: "One sentence: what is the developer in the middle of?" },
    next_steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          probability: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["command", "probability", "rationale"],
      },
    },
    branches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          trigger: { type: "string" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                leads_to: { type: "string" },
              },
              required: ["path", "leads_to"],
            },
          },
        },
        required: ["trigger", "options"],
      },
    },
  },
  required: ["situation", "next_steps", "branches"],
};

function buildUserContent(history, git, screen, agent) {
  const lines = [];
  lines.push(`Current directory: ${process.cwd()}`);
  if (git.repo) {
    lines.push("", "## Git state");
    lines.push(`branch: ${git.branch || "(detached)"}`);
    if (git.ahead || git.behind) lines.push(`ahead ${git.ahead || 0}, behind ${git.behind || 0} upstream`);
    lines.push("status (short):", git.status || "(clean)");
    lines.push("recent commits:", git.recentLog || "(none)");
  } else {
    lines.push("", "(not inside a git repository)");
  }
  lines.push("", `## Last ${history.commands.length} shell commands (oldest first)`);
  lines.push(history.commands.join("\n") || "(no history found)");

  // The node-pty engine (Phase 6) captures commands straight from keystrokes and
  // passes them in ORACLE_TYPED — more precise & in-order than the history file.
  const typed = (process.env.ORACLE_TYPED || "").trim();
  if (typed) {
    lines.push("", "## Commands you typed this session (most recent last)", typed);
  }

  if (screen) {
    lines.push(
      "",
      agent
        ? "## Live Claude Code session on the watched pane right now"
        : "## What's live on the terminal screen right now",
      screen
    );
  }
  return redact(lines.join("\n"));
}

// --- rendering -------------------------------------------------------------

function render(result, agent) {
  const modeTag = agent
    ? c.magenta("mode: agent")
    : c.green("mode: shell");
  console.log("\n" + c.bold(c.cyan("🔮 Oracle — foresight")) + "  " + c.dim("[") + modeTag + c.dim("]") + "\n");
  console.log(c.dim("situation: ") + result.situation + "\n");

  console.log(c.bold(agent ? "Most likely next prompts to Claude:" : "Most likely next steps:"));
  for (const s of result.next_steps) {
    const pct = Math.round((s.probability ?? 0) * 100);
    console.log(`  ${c.green(String(pct).padStart(3) + "%")}  ${c.bold(s.command)}`);
    console.log(`        ${c.dim(s.rationale)}`);
  }

  if (result.branches?.length) {
    console.log("\n" + c.bold("Decision branches ahead:"));
    for (const b of result.branches) {
      console.log(`  ${c.yellow("⑂ " + b.trigger)}`);
      for (const o of b.options) {
        console.log(`     ${c.magenta("→")} ${o.path} ${c.dim("⟶ " + o.leads_to)}`);
      }
    }
  }
  console.log();
}

// --- session token accounting ----------------------------------------------
// Module-level running total across EVERY backend call this process makes —
// including the Haiku "ghost" calls (askGhost) that produce no rendered output.
// Each backend routes its usage through addUsage() exactly once before returning;
// this is the single place the cumulative total grows.
const sessionUsage = { in: 0, out: 0, calls: 0 };
let lastPredictedAt = null; // Date of the most recent successful prediction

function addUsage(usage) {
  const u = usage || {};
  sessionUsage.in += u.input_tokens ?? 0;
  sessionUsage.out += u.output_tokens ?? 0;
  sessionUsage.calls += 1;
  return u; // convenience: callers can `return { ..., usage: addUsage(u) }`
}

// HH:MM:SS in local time (toTimeString is already zero-padded, no deps).
const hms = (d) => d.toTimeString().slice(0, 8);

// --- oracle call -----------------------------------------------------------

// The CLI backend can't use output_config.format, so we describe the JSON shape
// in-prompt and parse it out of the model's text.
const SHAPE_HINT = `Return ONLY a JSON object (no prose, no markdown fences) of exactly this shape:
{
  "situation": "one sentence",
  "next_steps": [{ "command": "string", "probability": 0.0, "rationale": "string" }],
  "branches": [{ "trigger": "string", "options": [{ "path": "string", "leads_to": "string" }] }]
}`;

// Same shape, but `command` is a natural-language prompt to Claude, not a shell cmd.
const SHAPE_HINT_AGENT = `Return ONLY a JSON object (no prose, no markdown fences) of exactly this shape:
{
  "situation": "one sentence about where the Claude Code session is",
  "next_steps": [{ "command": "natural-language prompt the developer will type to Claude", "probability": 0.0, "rationale": "string" }],
  "branches": [{ "trigger": "string", "options": [{ "path": "string", "leads_to": "string" }] }]
}`;

// Pull a JSON object out of arbitrary model text (handles ```json fences / prose).
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object found in:\n" + text);
  return JSON.parse(candidate.slice(start, end + 1));
}

// Backend A — reuse the local `claude` CLI's session (no API key). Default.
function askViaCli(userContent, agent) {
  const system = (agent ? SYSTEM_AGENT : SYSTEM) + "\n\n" + (agent ? SHAPE_HINT_AGENT : SHAPE_HINT);
  return new Promise((resolve, reject) => {
    let settled = false, watchdog;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn(arg);
    };
    const child = spawn(
      "claude",
      ["-p", "--output-format", "json", "--model", MODEL, "--system-prompt", system],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    watchdog = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, new Error(`claude timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish(reject, new Error(`could not run \`claude\`: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return finish(reject, new Error(`claude exited ${code}: ${err || out}`));
      let envelope;
      try {
        envelope = JSON.parse(out);
      } catch {
        return finish(reject, new Error("could not parse claude --output-format json:\n" + out));
      }
      if (envelope.is_error) return finish(reject, new Error("claude returned an error: " + envelope.result));
      try {
        const result = extractJson(envelope.result || "");
        const u = envelope.usage || {};
        addUsage(u); // count this CLI call toward the session total
        finish(resolve, { result, usage: u, model: MODEL });
      } catch (e) {
        finish(reject, e);
      }
    });
    child.stdin.write(userContent);
    child.stdin.end();
  });
}

// Phase 3 — "ghost text": a fast Haiku call that returns ONLY the single most
// likely next command/prompt as one plain line (no JSON). Reuses the CLI session
// (no api key). Mode-aware so Phase 5 (agent vs shell framing) can layer on; it
// degrades gracefully to shell if agent-mode isn't wired yet.
const GHOST_SYSTEM = (mode) =>
  `You are a fast autocomplete oracle over a developer's terminal. Given their recent
shell history, git state, and live screen, predict the SINGLE most likely next ${
    mode === "agent" ? "prompt the developer will type to their AI agent" : "shell command the developer will run"
  }.
Respond with ONLY that one line — no quotes, no markdown, no explanation, no leading
"$" or "> ". Just the bare ${mode === "agent" ? "prompt" : "command"} on a single line.`;

// Returns the one-line guess (string), or "" if anything goes wrong — callers must
// treat a falsy return as "no ghost, skip it" and never let it break the prediction.
function askGhost(userContent, mode = "shell") {
  return new Promise((resolve) => {
    let settled = false, watchdog;
    const done = (v) => {
      if (!settled) {
        settled = true;
        clearTimeout(watchdog);
        resolve(v);
      }
    };
    let child;
    try {
      child = spawn(
        "claude",
        ["-p", "--output-format", "json", "--model", GHOST_MODEL, "--system-prompt", GHOST_SYSTEM(mode)],
        { stdio: ["pipe", "pipe", "ignore"] }
      );
    } catch {
      return done(""); // spawn threw synchronously — no ghost
    }
    watchdog = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      done(""); // ghost is best-effort — if it's slow, skip it rather than block
    }, GHOST_TIMEOUT_MS);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => done("")); // e.g. `claude` not on PATH
    child.on("close", (code) => {
      if (code !== 0) return done("");
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) return done("");
        addUsage(envelope.usage || {}); // count the ghost call toward the session total
        // Plain text result — take the first non-empty line, strip any stray prompt sigils.
        const line = String(envelope.result || "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.length > 0);
        done((line || "").replace(/^[$>]\s*/, ""));
      } catch {
        done("");
      }
    });
    child.stdin.write(userContent);
    child.stdin.end();
  });
}

// Backend B — direct api.anthropic.com call with ANTHROPIC_API_KEY (`--api`).
async function askViaApi(userContent, apiKey, agent) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: agent ? SYSTEM_AGENT : SYSTEM,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("Request was refused by safety classifiers.");

  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in response: " + JSON.stringify(data));

  let result;
  try {
    result = JSON.parse(textBlock.text);
  } catch {
    throw new Error("Could not parse JSON. Raw output:\n" + textBlock.text);
  }
  const apiUsage = data.usage || {};
  addUsage(apiUsage); // count this direct-API call toward the session total
  return { result, usage: apiUsage, model: data.model };
}

// Collect context, query, render. Returns false if it bailed (dry/error handled).
async function runOnce(apiKey) {
  const history = readShellHistory(HISTORY_N);
  const git = gitState();
  const screen = captureExtra();           // capture the watched pane once
  const agent = detectAgentMode(screen);   // shell mode is the default fallback
  const userContent = buildUserContent(history, git, screen, agent);

  if (DRY) {
    console.log(c.dim("--- context that would be sent ---"));
    console.log(userContent);
    console.log(c.dim("--- end (no API call made) ---"));
    return;
  }

  // Phase 3 ghost text: fire the fast Haiku guess FIRST and print it immediately,
  // so the user sees an instant best-guess before the slower Opus tree fills in.
  // Only on the CLI-session backend (no api key); skipped silently on any error.
  // Mode follows the per-refresh detection so the ghost is framed agent-vs-shell
  // consistently with the full prediction. ORACLE_MODE provides a manual override.
  if (!USE_API) {
    try {
      const ghostMode = agent ? "agent" : GHOST_MODE;
      const ghost = await askGhost(userContent, ghostMode);
      if (ghost) console.log(c.dim(c.bold("▸ next  ")) + c.dim(ghost));
    } catch {
      /* never let the ghost break the real prediction */
    }
  }

  process.stdout.write(c.dim(`…asking the oracle ${USE_API ? "(api)" : "(claude cli session)"}\n`));
  try {
    const { result, usage, model } = USE_API
      ? await askViaApi(userContent, apiKey, agent)
      : await askViaCli(userContent, agent);
    render(result, agent);
    console.log(c.dim(`tokens: in ${usage.input_tokens ?? "?"}, out ${usage.output_tokens ?? "?"} · model ${model}`));
    // --- panel footer: timestamp + cumulative session tokens (incl. ghost calls)
    lastPredictedAt = new Date();
    const total = sessionUsage.in + sessionUsage.out;
    console.log(c.dim(`last predicted at ${hms(lastPredictedAt)}`));
    console.log(
      c.dim(
        `session: ${sessionUsage.calls} call${sessionUsage.calls === 1 ? "" : "s"} · in ${sessionUsage.in}, out ${sessionUsage.out}, total ${total} tokens`
      )
    );
  } catch (e) {
    // In watch mode, keep the loop alive on transient errors instead of exiting.
    console.error(c.yellow("oracle error: ") + e.message);
    if (!WATCH) process.exit(1);
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (USE_API && !apiKey) {
    console.error("--api needs ANTHROPIC_API_KEY:  export ANTHROPIC_API_KEY=sk-ant-...");
    console.error("(or drop --api to reuse the local `claude` CLI session — no key needed)");
    process.exit(1);
  }

  if (AUTO) {
    if (!process.env.ORACLE_PANE) {
      console.error("--auto needs ORACLE_PANE set (run it via oracle/wrap.sh).");
      process.exit(1);
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    console.log(c.dim("auto mode — re-predicts when the watched pane settles after a command. Ctrl+C to quit."));
    console.clear();
    await runOnce(apiKey); // initial prediction
    let lastPredicted = captureExtra();
    let lastSeen = lastPredicted;
    let stableSince = Date.now();
    while (true) {
      await sleep(POLL_MS);
      const now = captureExtra();
      if (now !== lastSeen) {
        lastSeen = now;
        stableSince = Date.now(); // screen still changing — reset the settle timer
        continue;
      }
      // screen has been stable for a while; only fire on a genuinely new state
      if (Date.now() - stableSince >= SETTLE_MS && now.trim() && now !== lastPredicted) {
        lastPredicted = now;
        console.clear();
        await runOnce(apiKey);
        // re-baseline after the (slow) call so we don't immediately re-fire
        lastSeen = captureExtra();
        stableSince = Date.now();
      }
    }
  }

  if (!WATCH) {
    await runOnce(apiKey);
    return;
  }

  // Watch mode: re-predict every time you press Enter. Run a real command in
  // another terminal, come back, hit Enter — the oracle re-reads history + git.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => process.exit(0)); // Ctrl+D / piped EOF
  const ask = (q) => new Promise((res) => rl.question(q, res));
  console.log(c.dim("watch mode — press Enter to (re)predict, Ctrl+C to quit"));
  // First prediction immediately, then loop on Enter.
  await runOnce(apiKey);
  while (true) {
    await ask(c.dim("\n[Enter] refresh ▸ "));
    await runOnce(apiKey);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
