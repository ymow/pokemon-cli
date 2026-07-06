'use strict';

// hyper-readable
// -----------------------------------------------------------------------------
// hyper-pokemon picks a RANDOM theme each launch. Each theme is a small palette
// (primary / secondary / tertiary) over a full-bleed background image, and the
// plugin hard-wires the terminal text to the theme's `secondary` color. Many
// secondaries are near-black or mid-tone, so over a busy/dark image they're
// hard to read -- and a single fixed text-shadow halo can't fix every theme and
// is ignored under the WebGL/canvas renderers anyway.
//
// Instead, ADAPT to each theme's own background ("底色") so every background
// gets its OWN, different, readable text color:
//   1. Read the resolved background color (hyper-pokemon sets it on
//      `borderColor` = the theme's unibody/primary).
//   2. From the theme's own palette (primary / secondary / tertiary) pick the
//      color with the best WCAG contrast against that background; prefer one
//      that clears AA (4.5:1), and fall back to near-black / near-white only if
//      none of the theme colors do. -> different background => different text.
//   3. Lay a scrim of the BACKGROUND color over the image so the effective
//      backdrop converges on 底色 (making the contrast pick valid regardless of
//      the image). Stronger text contrast -> lighter scrim (image shows more);
//      weaker -> heavier scrim (readability wins). The scrim is an inset
//      box-shadow on `.terms_terms`, painted above the image but below the
//      (transparent) terminal canvas, so it works under any renderer.

// Parse '#rgb' / '#rrggbb' / 'rgb()' / 'rgba()' into [r, g, b] (0-255).
function toRgb(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const str = input.trim();

  let m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const h = m[1];
    return [h[0], h[1], h[2]].map(c => parseInt(c + c, 16));
  }

  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const h = m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }

  m = str.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map(p => parseFloat(p));
    if (parts.length >= 3 && parts.every(n => !Number.isNaN(n))) {
      return [parts[0], parts[1], parts[2]];
    }
  }

  return null;
}

function toHex([r, g, b]) {
  return '#' + [r, g, b]
    .map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
    .join('');
}

// WCAG relative luminance + contrast ratio.
function channelLin(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relLuminance([r, g, b]) {
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}

function contrast(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function blend(c, target, k) {
  return c.map((v, i) => v + (target[i] - v) * k);
}

// Synthesize a readable text color FROM the 底色: keep its hue, push lightness to
// whichever extreme has more contrast headroom until it clears `min`. Distinct
// 底色 => distinct text color, and the text stays in the background's family.
function deriveFromBg(bg, min) {
  const target = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg)
    ? [0, 0, 0]
    : [255, 255, 255];
  let k = 0.35;
  let out = blend(bg, target, k);
  for (let i = 0; i < 16 && contrast(out, bg) < min; i++) {
    k = Math.min(1, k + 0.06);
    out = blend(bg, target, k);
  }
  return out.map(Math.round);
}

// Keep a color's hue but push its lightness away from the 底色 until it clears
// `min` contrast (or hits an extreme). Used to lift murky ANSI palette entries
// (e.g. dark blue table borders on a mid purple backdrop) into legibility.
function ensureContrast(color, bg, min) {
  if (contrast(color, bg) >= min) {
    return color;
  }
  const target = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg)
    ? [0, 0, 0]
    : [255, 255, 255];
  let out = color;
  for (let k = 0.1; k <= 1 && contrast(out, bg) < min; k += 0.06) {
    out = blend(color, target, k);
  }
  return out.map(Math.round);
}

function readableExtremeAgainst(color) {
  return contrast([0, 0, 0], color) >= contrast([255, 255, 255], color)
    ? [0, 0, 0]
    : [255, 255, 255];
}

function readableSurfaceFor(fg, bg) {
  if (contrast(bg, fg) >= 4.5) {
    return bg;
  }
  return readableExtremeAgainst(fg);
}

// --- HSL round-trip, so we can lift lightness/saturation while keeping hue. ---
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    return [l * 255, l * 255, l * 255];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255
  ];
}

// Make the picked text color bright AND saturated instead of a flat mid-grey:
// keep its hue, floor the saturation so real hues stay vivid (true greys are
// left grey), and push lightness toward whichever extreme has more headroom
// vs the 底色 until it clears `min`. Only if a vivid tone still can't reach
// `min` do we bleed saturation out toward the white/black extreme -- so on
// dark backdrops the text lands as a bright, colorful tint rather than plain
// white, matching "更亮更飽和" while staying legible.
function vivify(color, bg, min) {
  let [h, s, l] = rgbToHsl(color);
  const goLight = contrast([255, 255, 255], bg) >= contrast([0, 0, 0], bg);
  const hasHue = s > 0.08;
  if (hasHue) {
    s = Math.min(1, Math.max(s, 0.72));
  }
  l = goLight ? Math.max(l, 0.66) : Math.min(l, 0.34);
  let out = hslToRgb([h, s, l]).map(Math.round);
  for (let i = 0; i < 24 && contrast(out, bg) < min; i++) {
    l = goLight ? Math.min(1, l + 0.03) : Math.max(0, l - 0.03);
    // Near the extreme, ease saturation down so pure white/black stays reachable.
    if ((goLight && l > 0.82) || (!goLight && l < 0.18)) {
      s = Math.max(0, s - 0.08);
    }
    out = hslToRgb([h, s, l]).map(Math.round);
  }
  return out;
}

exports.decorateConfig = config => {
  // 底色: hyper-pokemon puts the theme background (unibody/primary) on borderColor.
  const bg = toRgb(config.borderColor) || toRgb(config.backgroundColor);
  if (!bg) {
    return config;
  }

  // Recover the theme's own palette from what hyper-pokemon wrote:
  //   foregroundColor = secondary, colors.black = tertiary, selectionColor = primary@0.3
  const secondary = toRgb(config.foregroundColor);
  const tertiary = config.colors ? toRgb(config.colors.black) : null;
  const primary = toRgb(config.selectionColor);
  const palette = [secondary, tertiary, primary].filter(Boolean);

  const AA = 4.5;

  // The visible backdrop is the pokemon image under a partial 底色 scrim, NOT
  // pure 底色, so a pick that lands exactly on AA-vs-底色 measures well below
  // AA in practice (observed ~3.1:1). Aim well past AA instead. Mid-tone 底色
  // caps how much contrast ANY text color can reach (a 50%-lightness backdrop
  // tops out near 4.7:1 even against pure white), so the target is "7:1 or
  // just shy of the best this 底色 allows, whichever is lower".
  const maxExtreme = Math.max(contrast([0, 0, 0], bg), contrast([255, 255, 255], bg));
  const TARGET = Math.min(7, maxExtreme - 0.15);

  // Prefer a theme color that clears TARGET against 底色 (keeps each theme's
  // flavor); among those, take the highest contrast. Otherwise best theme
  // color, and as a last resort near-black / near-white.
  let pick = null;
  let pickC = 0;
  palette.forEach(c => {
    const ct = contrast(c, bg);
    if (ct >= TARGET && ct > pickC) {
      pick = c;
      pickC = ct;
    }
  });
  if (!pick) {
    palette.forEach(c => {
      const ct = contrast(c, bg);
      if (ct > pickC) {
        pick = c;
        pickC = ct;
      }
    });
  }
  // If no theme color clears TARGET, synthesize one from the 底色 (unique per
  // background, same color family) rather than collapsing to flat black/white.
  if (!pick || pickC < TARGET) {
    const derived = deriveFromBg(bg, TARGET);
    if (!pick || contrast(derived, bg) > pickC) {
      pick = derived;
      pickC = contrast(derived, bg);
    }
  }

  // Scrim = 底色 over the image. Keep it light enough that the Pokemon artwork
  // remains visible, but key its strength on the 底色's contrast HEADROOM: a
  // mid-tone 底色 caps text contrast, so it needs a heavier scrim to pull the
  // busy image toward 底色; a very light/dark 底色 can afford a lighter one.
  const headroom = Math.max(0, Math.min(1, (maxExtreme - 4.5) / 2.5)); // 0 (mid-tone) .. 1 (extreme)
  const alpha = (0.45 - 0.17 * headroom).toFixed(3); // 0.45 (mid-tone) .. 0.28 (extreme)
  const scrim = `rgba(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])}, ${alpha})`;

  // Scrim stays light (artwork kept sharp), so the picked color must carry
  // readability on its own: make it a bright, saturated tint of its hue.
  pick = vivify(pick, bg, TARGET);
  pickC = contrast(pick, bg);

  const fg = toHex(pick);
  const readableSurface = readableSurfaceFor(pick, bg);

  // Some TUIs (notably Codex's user-message / attachment block) fill a panel
  // with ANSI black -- a "surface" shade they calibrate for a *black*
  // terminal. Our visible backdrop is the pokemon image + 底色 scrim, not the
  // real (transparent) terminal background, so that panel lands as a jarring
  // near-black bar that ignores the theme. Prefer a gentle elevation of the
  // 底色 (nudged AWAY from the text color so light text gets a slightly darker
  // panel and vice versa), falling back to a contrast-safe surface.
  const awayFromPick = readableExtremeAgainst(pick);
  const elevatedSurface = blend(bg, awayFromPick, 0.12).map(Math.round);
  const tuiSurface = contrast(elevatedSurface, pick) >= AA ? elevatedSurface : readableSurface;
  const tuiSurfaceHex = toHex(tuiSurface);

  // ANSI bright-black, however, is overwhelmingly used as muted FOREGROUND
  // text (chalk.gray -- Claude Code's tips, timestamps, "Press up to edit..."
  // hints). Mapping it to a surface shade made all of that text ~1.1:1 vs the
  // backdrop, i.e. invisible. Give it a real dim-text color instead: 底色
  // pushed toward the picked foreground until it reads as "muted but legible".
  // Light scrim => the image bleeds through, so muted text needs a higher
  // nominal target than a black terminal would to survive in practice.
  const DIM_TARGET = Math.min(4.5, TARGET - 1);
  let dim = blend(bg, pick, 0.5);
  for (let k = 0.5; k <= 1 && contrast(dim, bg) < DIM_TARGET; k += 0.05) {
    dim = blend(bg, pick, k);
  }
  const dimHex = toHex(dim.map(Math.round));

  // The stock ANSI palette (dark blue #0A2FC4, dark red, ...) was tuned for a
  // black terminal; on a mid-tone scrim those hues turn to mud (table borders,
  // spinners, accent text). Keep each hue but lift it to at least 3:1.
  const baseColors = config.colors || {};
  const colors = Object.assign({}, baseColors);
  Object.keys(baseColors).forEach(name => {
    if (name === 'black' || name === 'lightBlack') {
      return;
    }
    const rgb = toRgb(baseColors[name]);
    if (rgb) {
      colors[name] = toHex(ensureContrast(rgb, bg, 3.0));
    }
  });
  colors.black = tuiSurfaceHex;
  colors.lightBlack = dimHex;

  const overlayCSS = `
    /* hyper-readable: adaptive text ${fg} on 底色 ${toHex(bg)} (contrast ${pickC.toFixed(2)}); surface ${tuiSurfaceHex} */
    .terms_terms {
      box-shadow: inset 0 0 0 100vmax ${scrim} !important;
    }
  `;
  const terminalCSS = `
    /* Avoid theme/plugin text shadows double-painting CJK glyphs. */
    .xterm,
    .xterm-screen,
    .xterm-rows,
    .xterm-rows span,
    .xterm-screen canvas {
      text-shadow: none !important;
      -webkit-text-stroke-width: 0 !important;
      filter: none !important;
    }
  `;

  return Object.assign({}, config, {
    foregroundColor: fg,
    cursorColor: fg,
    cursorAccentColor: toHex(readableExtremeAgainst(pick)),
    colors,
    termCSS: `${config.termCSS || ''}\n${terminalCSS}`,
    css: `${config.css || ''}\n${overlayCSS}`
  });
};
