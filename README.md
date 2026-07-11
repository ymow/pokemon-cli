# pokemon-cli

My [Hyper](https://hyper.is) terminal setup — a random Pokémon theme on every
launch, kept **readable** by an adaptive plugin that picks a fitting text color
for each theme's background.

## What's inside

| File | What it is |
|------|------------|
| `.hyper.js` | Hyper config — `scrollback`, fonts, `webGLRenderer`, and the plugin list (`hyper-pokemon`, `hyper-statusline`, `hyper-tabs-enhanced` + the local `hyper-readable`). Pokémon theme is set to `random`. |
| `.hyper_plugins/local/hyper-readable/` | Local plugin that makes the random themes readable (see below). |

`hyper-pokemon`, `hyper-statusline`, and `hyper-tabs-enhanced` are installed from
npm automatically by Hyper from the `plugins` array — they are not vendored here.

## hyper-readable

`hyper-pokemon` picks a random theme each launch and hard-wires the terminal
text to the theme's `secondary` color, which is often near-black or mid-tone and
disappears over the artwork. `hyper-readable` fixes this by analyzing the
selected background PNG instead of covering it with a global mask:

1. Read the `file://.../backgrounds/<pokemon>.png` that `hyper-pokemon` injected
   into `.terms_terms`.
2. Decode and sample the PNG directly. The outer band/corners are treated as the
   real artwork background, and the dominant edge color becomes the contrast
   target.
3. Pick a foreground from theme-tinted candidates first; fall back to pure
   black/white only when the image is too close to the AA limit for tinted text.
4. Rebuild the ANSI palette in the same light/dark direction so TUI colors,
   Claude/Codex hints, tables, and status text stay readable.
5. Keep opaque surfaces only where terminal apps explicitly ask for ANSI black
   cells or chrome panels. The Pokémon artwork itself is not darkened by a
   full-window scrim.

Validate it against the installed `hyper-pokemon` package:

```sh
node scripts/validate-hyper-readable.js
```

Current validation across all 153 PNG backgrounds: **153 parsed, 90 distinct
foreground colors, minimum dominant-background contrast 4.54:1**.

### Readability vs. artwork

The plugin now optimizes for the actual artwork background instead of forcing
the whole terminal into a dark or light overlay. Some images contain both very
bright and very dark regions, so no single transparent text color can be AA over
every pixel; in those cases the dominant background remains readable and TUI
panels get real surfaces.

## Install

Copy (or symlink) the files into your home directory, then fully reload Hyper
(`Cmd+Shift+R`) or restart it:

```sh
git clone https://github.com/ymow/pokemon-cli.git
cd pokemon-cli

# symlink so the repo stays the source of truth
ln -sf "$PWD/.hyper.js" ~/.hyper.js
mkdir -p ~/.hyper_plugins/local
ln -sf "$PWD/.hyper_plugins/local/hyper-readable" ~/.hyper_plugins/local/hyper-readable
```

Hyper will `npm install` the npm plugins listed in `.hyper.js` on next launch.
Open new tabs/windows to roll a new random Pokémon — the readable text color is
applied automatically.

## License

MIT
