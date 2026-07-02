#!/usr/bin/env node
// oracle/engine.mjs — Phase 6a: self-contained PTY engine (no tmux).
// ----------------------------------------------------------------------------
// Runs your shell inside a real pseudo-terminal via node-pty. Full passthrough
// (vim / htop / less all work). Two things tmux didn't give us cleanly:
//
//   1. Direct command capture — we tee your keystrokes and assemble each command
//      line as you type it, so the oracle gets exactly what you ran, in order,
//      without screen-scraping or shell integration.
//   2. A clean overlay — press Ctrl-G to pop the oracle on the terminal's
//      ALTERNATE screen. Dismiss it and the alt screen is torn down, restoring
//      your shell's screen byte-for-byte — no vt compositor needed.
//
// True side-by-side (shell left + oracle right at the same time) is Phase 6b and
// needs a headless vt emulator to composite the shell into a sub-region.
//
// Run in a REAL terminal (needs a TTY):  node oracle/engine.mjs
// Quit: exit your shell as usual.  Toggle the oracle: Ctrl-G.
// ----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pty from "node-pty";

const HERE = dirname(fileURLToPath(import.meta.url));
const PHASE0 = join(HERE, "phase0.mjs");
const SHELL = process.env.SHELL || "/bin/zsh";
const TOGGLE = 0x07; // Ctrl-G
const MAX_CMDS = 40;

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("oracle/engine.mjs needs a real terminal (TTY). Run it directly,");
  console.error("not through a pipe or Claude Code's `!` prefix.");
  process.exit(1);
}

const out = (s) => process.stdout.write(s);
const cols = () => process.stdout.columns || 80;
const rows = () => process.stdout.rows || 24;

// --- the shell, in a PTY ---------------------------------------------------
const shell = pty.spawn(SHELL, [], {
  name: "xterm-256color",
  cols: cols(),
  rows: rows(),
  cwd: process.cwd(),
  env: process.env,
});

// --- direct command capture ------------------------------------------------
const recent = []; // ring buffer of full command lines you typed
let line = ""; // the line currently being typed
function feedKeystrokes(buf) {
  for (const ch of buf.toString("utf8")) {
    const code = ch.charCodeAt(0);
    if (code === 13 || code === 10) {
      // Enter — commit the line
      const cmd = line.trim();
      if (cmd) {
        recent.push(cmd);
        if (recent.length > MAX_CMDS) recent.shift();
      }
      line = "";
    } else if (code === 127 || code === 8) {
      line = line.slice(0, -1); // backspace
    } else if (code === 3 || code === 21) {
      line = ""; // Ctrl-C / Ctrl-U abandon the line
    } else if (code >= 32) {
      line += ch; // printable
    }
  }
}

// --- state machine: shell | predicting | dismiss ---------------------------
let state = "shell";

function openOverlay() {
  state = "predicting";
  out("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l"); // alt screen, home, clear, hide cursor
  out("\x1b[36m\x1b[1m🔮 oracle\x1b[0m — predicting…\r\n\r\n");
  const child = spawn("node", [PHASE0], {
    env: { ...process.env, ORACLE_TYPED: recent.join("\n") },
  });
  const pipe = (d) => out(d.toString().replace(/\r?\n/g, "\r\n")); // CRLF for raw mode
  child.stdout.on("data", pipe);
  child.stderr.on("data", pipe);
  child.on("error", () => {
    out("\r\n\x1b[31mcould not run the oracle\x1b[0m");
    awaitDismiss();
  });
  child.on("close", awaitDismiss);
}
function awaitDismiss() {
  out("\r\n\r\n\x1b[2m— press any key to return —\x1b[0m");
  state = "dismiss";
}
function closeOverlay() {
  out("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen → shell screen restored
  state = "shell";
}

// --- stdin routing ---------------------------------------------------------
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (buf) => {
  if (state === "shell") {
    if (buf.length === 1 && buf[0] === TOGGLE) return openOverlay(); // Ctrl-G
    feedKeystrokes(buf);
    shell.write(buf.toString("utf8"));
  } else if (state === "dismiss") {
    closeOverlay();
  }
  // state === "predicting": swallow input until the oracle finishes
});

// --- shell output + lifecycle ----------------------------------------------
shell.onData((d) => {
  if (state === "shell") out(d); // don't corrupt the overlay's alt screen
});
process.stdout.on("resize", () => shell.resize(cols(), rows()));
shell.onExit(({ exitCode }) => {
  if (state !== "shell") out("\x1b[?25h\x1b[?1049l");
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  process.exit(exitCode || 0);
});
