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
disappears over a busy/dark background image. `hyper-readable` fixes this so
**every background gets its own, different, readable text color**, chosen
adaptively from the background ("底色"):

1. Read the resolved background color (`borderColor` = the theme's
   unibody/primary).
2. Pick the text color with the best [WCAG](https://www.w3.org/TR/WCAG21/#contrast-minimum)
   contrast against it:
   - prefer one of the theme's own palette colors that clears **AA (4.5:1)** —
     keeps each theme's flavor;
   - otherwise synthesize a color **from the background** (same hue, lightness
     pushed to a contrasting extreme) so distinct backgrounds yield distinct,
     color-coordinated, readable text.
3. **Vivify** the chosen color so it reads on its own even with a light scrim
   (`vivify()`): keep its hue, floor the saturation (~0.72 for real hues; true
   greys stay grey — no fake color), and push lightness toward the
   higher-contrast extreme until it clears the target. On dark backdrops this
   lands the text as a **bright, saturated tint** rather than a flat mid-grey,
   so it survives over the Pokémon artwork instead of blending into it.
4. Lay a scrim of the background color over the image (inset `box-shadow` on
   `.terms_terms`, above the image but below the transparent terminal canvas, so
   it works under any renderer). Stronger text contrast → lighter scrim (image
   shows more); weaker → heavier scrim (readability wins).
5. Keep terminal input panels readable by moving black/default TUI surfaces
   toward the same readable background when the chosen foreground would be low
   contrast on black. This fixes Codex-style prompt boxes on light Pokémon
   themes.
6. Give muted text (ANSI bright-black — Claude Code hints, timestamps) a real
   dim-but-legible color targeting up to **4.5:1**, since the light scrim lets
   the image bleed through and lower targets vanish in practice.

Verified across all 153 `hyper-pokemon` themes: **121 distinct text colors, 0
below AA 4.5**.

### Readability vs. artwork

The scrim is deliberately kept light so the Pokémon artwork stays sharp, which
means text must carry its own contrast — that's what the vivify step is for.
Over the *brightest* patches of some artwork, contrast can still dip; the fix is
to make the text brighter/more saturated (steps 2–3) rather than darkening the
whole background.

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
