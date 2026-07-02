# oracle — Phase 0 spike

A "預言機 / foresight" layer over the CLI. **Phase 0's only job** is to answer one
question before we build anything expensive: *can Claude usefully predict your next
steps and the decision branches ahead, given just your shell history + git state?*

No PTY wrapper, no UI — one zero-dependency Node script (Node 18+).

## Run

By default the oracle **reuses your local `claude` CLI login** — no API key to
paste. It shells out to `claude -p` (print mode), so whatever auth Claude Code
already uses (OAuth/keychain or a key) is what the oracle uses.

```sh
# preview the context it would send, no model call (free):
node oracle/phase0.mjs --dry

# the real thing — uses your claude CLI session, NO api key needed:
node oracle/phase0.mjs

# force a direct api.anthropic.com call instead (needs the key):
export ANTHROPIC_API_KEY=sk-ant-...
node oracle/phase0.mjs --api

# look further back in history:
node oracle/phase0.mjs --n 60

# watch mode — predicts once, then re-predicts every time you press Enter.
# Run real commands in ANOTHER terminal, come back, hit Enter; each refresh
# re-reads your history + git state. Ctrl+C / Ctrl+D to quit. This is the
# closest Phase 0 gets to the real "live oracle" feel.
node oracle/phase0.mjs --watch
```

> Tip: `--watch` re-collects context on every Enter, so it's the best way to
> stress-test prediction quality across a real working session.

## What it does

1. Reads your recent `~/.zsh_history` (+ `git status` / branch / recent log / ahead-behind).
2. Lightly redacts obvious secrets (`sk-…`, `ghp_…`, `--password …`).
3. Asks `claude-opus-4-8` for:
   - **next_steps** — 2-4 most likely next commands, each with a probability + why.
   - **branches** — decision forks likely to appear soon (tests fail, merge
     conflict, deploy rejected…), each with options and where they lead.
4. Prints it as a foresight panel.

Two backends:
- **default** — shells out to `claude -p --output-format json` (your CLI login;
  no key). JSON shape is requested in-prompt and parsed from the reply.
- **`--api`** — direct `api.anthropic.com` call with `ANTHROPIC_API_KEY`, using
  adaptive thinking + `output_config.format` for schema-guaranteed JSON.

## Phase 1 — the split wrapper (`wrap.sh`)

Splits your terminal into **[ your shell ] │ [ oracle panel ]**. The "PTY
wrapper" layer is **tmux** (a proven PTY multiplexer); the right pane runs the
oracle in `--watch` and reads the **left pane's live screen** as context, so it
reacts to what you're actually doing — not just shell history.

```sh
brew install tmux        # one-time (Node has no built-in PTY)
bash oracle/wrap.sh      # left = your shell, right = oracle
```

The right pane runs `--auto`: it **re-predicts on its own whenever the left pane
settles after a command** (no Enter needed). It samples the pane every ~600ms and
fires once the screen has been unchanged for ~1.2s — i.e. the command finished and
the prompt is back. Long-running, continuously-updating output (htop, `tail -f`)
keeps the screen changing, so it never settles and never spams the model.

Quit by exiting the left shell. A later phase swaps tmux for a self-contained
node-pty engine + a vt compositor; this skeleton exists to validate the UX.

> Detection here is screen-settle heuristics. Phase 2 (OSC 133 shell-integration
> marks) replaces it with exact command-start / command-end / exit-code events.

## Phase 6a — self-contained engine (`engine.mjs`, no tmux)

Runs your shell inside a real PTY via **node-pty** — no tmux. Full passthrough
(vim / htop / less all work), plus two things tmux didn't give cleanly:

- **Direct command capture** — keystrokes are tee'd and assembled into command
  lines, so the oracle gets exactly what you ran, in order (passed to `phase0.mjs`
  via `ORACLE_TYPED`). No screen-scraping, no shell integration needed.
- **Clean overlay** — press **Ctrl-G** to pop the oracle on the terminal's
  *alternate screen*; dismiss it and your shell screen is restored byte-for-byte,
  with no vt compositor.

```sh
cd oracle && npm install     # one-time: builds node-pty (native)
node oracle/engine.mjs       # in a REAL terminal (needs a TTY)
```

Quit by exiting your shell; toggle the oracle with Ctrl-G.

> Phase 6a gives passthrough + an on-demand overlay. **6b** (true side-by-side,
> shell-left / oracle-right at once) needs a headless vt emulator to composite the
> shell into a sub-region — the biggest remaining piece, deliberately separate.

## How to judge it

Run it at a few real moments (mid-rebase, mid-debug, before a deploy). If the
predictions are accurate and genuinely useful → proceed to Phase 1 (PTY wrapper).
If they're generic/wrong → fix the prompt/context here first; don't build the shell.

## Next phases

1. ✅ PTY wrapper — shell left + oracle right, via tmux (`wrap.sh`).
2. Context via OSC 133 shell-integration marks (clean command boundaries),
   instead of scraping the pane screen.
3. ✅ next-1 ghost text — instant Haiku one-liner (`▸ next …`) before the full
   Opus tree; best-effort, skipped on timeout.
4. ✅ Auto-refresh — panel re-predicts when the pane settles after a command
   (`--auto`, screen-settle heuristic).
5. ✅ Agent mode — when the watched pane is a `claude` session, predict the next
   *prompt* you'll give Claude (shows `mode: agent`); falls back to `mode: shell`.
6. 🟡 Self-contained engine — node-pty passthrough + Ctrl-G overlay done (6a,
   `engine.mjs`); true side-by-side compositor pending (6b).

### Env knobs

| Env | Default | Effect |
|-----|---------|--------|
| `ORACLE_PANE` | — | tmux pane to watch (set by `wrap.sh`) |
| `ORACLE_POLL_MS` | 600 | `--auto` pane sample interval |
| `ORACLE_SETTLE_MS` | 1200 | `--auto` quiet time before re-predicting |
| `ORACLE_GHOST_TIMEOUT_MS` | 8000 | watchdog for the Haiku ghost call |
| `ORACLE_CLI_TIMEOUT_MS` | 90000 | watchdog for the full prediction |
| `ORACLE_FORCE_MODE` | — | `agent` / `shell` to override detection |
