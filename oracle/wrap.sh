#!/usr/bin/env bash
# oracle/wrap.sh — Phase 1 skeleton.
# ----------------------------------------------------------------------------
# Splits your terminal into:  [ your shell ]  │  [ oracle foresight panel ]
# The wrapper is tmux (a battle-tested PTY multiplexer) — that's the "PTY
# wrapper" layer. The right pane runs the oracle in --auto mode: it re-predicts
# on its own whenever the LEFT pane settles after a command (no Enter needed),
# reading the left pane's live screen as context.
#
# A later phase replaces tmux with a self-contained node-pty engine + a vt
# compositor; this skeleton exists to validate the UX (and it already works).
#
# Usage:   bash oracle/wrap.sh
#          (run a shell on the left; click the right pane + Enter to re-predict)
# Quit:    exit the left shell, or  tmux kill-session
# ----------------------------------------------------------------------------
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required for the Phase 1 skeleton. Install it:"
  echo "    brew install tmux"
  exit 1
fi

# tmux needs a real controlling terminal to attach to. Running this through a
# non-interactive context (e.g. Claude Code's `!` prefix, a pipe, or cron) fails
# with tmux's cryptic "open terminal failed: not a terminal".
if [ ! -t 0 ] || [ ! -t 1 ]; then
  echo "oracle/wrap.sh must run in a real terminal window."
  echo "Open Terminal / iTerm / Ghostty and run:  bash oracle/wrap.sh"
  echo "(don't run it through Claude Code's \`!\` prefix — that has no TTY.)"
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # …/oracle
SESSION="oracle-$$"
SHELL_BIN="${SHELL:-/bin/zsh}"
PANEL_WIDTH="${ORACLE_PANEL_WIDTH:-48}"

# Left pane: your shell, started detached so we can wire up the split first.
tmux new-session -d -s "$SESSION" "$SHELL_BIN"
LEFT="$(tmux list-panes -t "$SESSION" -F '#{pane_id}' | head -1)"

# Right pane: oracle --auto, told (via ORACLE_PANE) to read the left pane live.
tmux split-window -h -t "$SESSION" -l "$PANEL_WIDTH" \
  "ORACLE_PANE='$LEFT' exec node '$DIR/phase0.mjs' --auto"

tmux set-option -t "$SESSION" mouse on >/dev/null 2>&1 || true
tmux select-pane -t "$LEFT"          # focus your shell
tmux attach -t "$SESSION"
