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
// whichever extreme has more contrast headroom until it clears AA. Distinct 底色
// => distinct text color, and the text stays in the background's color family.
function deriveFromBg(bg) {
  const target = contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg)
    ? [0, 0, 0]
    : [255, 255, 255];
  let k = 0.35;
  let out = blend(bg, target, k);
  for (let i = 0; i < 12 && contrast(out, bg) < 4.6; i++) {
    k = Math.min(1, k + 0.08);
    out = blend(bg, target, k);
  }
  return out.map(Math.round);
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

  // Prefer a theme color that clears AA against 底色 (keeps each theme's flavor);
  // among those, take the highest contrast. Otherwise best theme color, and as a
  // last resort near-black / near-white.
  let pick = null;
  let pickC = 0;
  palette.forEach(c => {
    const ct = contrast(c, bg);
    if (ct >= AA && ct > pickC) {
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
  // If no theme color clears AA, synthesize one from the 底色 (unique per
  // background, same color family) rather than collapsing to flat black/white.
  if (!pick || pickC < AA) {
    const derived = deriveFromBg(bg);
    if (!pick || contrast(derived, bg) > pickC) {
      pick = derived;
      pickC = contrast(derived, bg);
    }
  }

  // Scrim = 底色 over the image. Stronger text contrast -> lighter scrim.
  const t = (Math.max(1, Math.min(7, pickC)) - 1) / 6; // 0 (weak) .. 1 (strong)
  const alpha = (0.68 - 0.23 * t).toFixed(3); // 0.45 (strong) .. 0.68 (weak)
  const scrim = `rgba(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])}, ${alpha})`;

  const fg = toHex(pick);

  // Some TUIs (notably Codex's user-message / attachment block) fill a panel
  // with ANSI black / bright-black -- a "surface" shade they calibrate for a
  // *black* terminal. Our visible backdrop is the pokemon image + 底色 scrim,
  // not the real (transparent) terminal background, so that panel lands as a
  // jarring near-black bar that ignores the theme. Remap the dark surface slots
  // to a gentle elevation of the 底色 (blend toward the text pick) so those
  // opaque fills harmonize with the theme instead of clashing.
  const surface = toHex(blend(bg, pick, 0.14).map(Math.round));
  const colors = Object.assign({}, config.colors, {
    black: surface,
    lightBlack: surface,
  });

  const overlayCSS = `
    /* hyper-readable: adaptive text ${fg} on 底色 ${toHex(bg)} (contrast ${pickC.toFixed(2)}); surface ${surface} */
    .terms_terms {
      box-shadow: inset 0 0 0 100vmax ${scrim} !important;
    }
  `;

  return Object.assign({}, config, {
    foregroundColor: fg,
    cursorColor: fg,
    colors,
    termCSS: config.termCSS || '',
    css: `${config.css || ''}\n${overlayCSS}`
  });
};
