'use strict';

// hyper-readable
// -----------------------------------------------------------------------------
// hyper-pokemon picks a RANDOM theme each launch: a small palette
// (primary / secondary / tertiary / unibody) over a full-bleed background image.
// It hard-wires the terminal text to the theme's `secondary`, and many themes
// have a LIGHT/mid `unibody` (底色). That is the root readability bug:
//
//   Terminal apps -- Codex, Starship, Claude Code, git, ls -- pick their colors
//   assuming a DARK background (bright orange version numbers, cyan accents,
//   grey "muted" hints). On a light 底色 those wash out, and most of them emit
//   256-color / truecolor that BYPASSES the 16-slot ANSI palette entirely, so no
//   amount of palette remapping can recolor them. This Hyper's bundled xterm is
//   also too old to expose `minimumContrastRatio`, so there is no renderer-level
//   contrast lift either.
//
// So instead of adapting text to each (often light) 底色, we make the effective
// backdrop DARK for every theme -- the environment those apps expect -- while
// KEEPING each theme's hue so the flavor survives:
//   1. Take the theme 底色 (borderColor = unibody), keep its hue, and force it
//      dark. That dark tint is the effective backdrop.
//   2. Render bright, light text (a light tint of the same hue) plus a full
//      bright-on-dark ANSI palette. Now ANSI *and* app truecolor both read,
//      because everything was designed for a dark background.
//   3. Lay a heavy scrim of the DARK 底色 over the image (readability-first) so
//      the visible backdrop converges on that dark tint. The artwork still shows
//      through, dimmed. The scrim is an inset box-shadow on `.terms_terms`,
//      painted above the image but below the (transparent) terminal canvas, so
//      it works under the canvas renderer Hyper falls back to for transparent
//      backgrounds.

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

function transparentRgb([r, g, b]) {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0)`;
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
  // The stepped blend can exit an epsilon short of the extreme (float rounding
  // on k), leaving colored text just below AA. If we still haven't cleared min,
  // snap to the target extreme -- the most contrast this 底色 can offer.
  if (contrast(out, bg) < min) {
    out = target;
  }
  return out.map(Math.round);
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

// Keep a color's hue but pin it to a target lightness (and clamp saturation),
// then guarantee it clears `min` contrast vs the (dark) backdrop by pushing
// lightness up. Used to build the light text + bright ANSI palette.
function toLight(color, bg, targetL, satCap, min) {
  let [h, s] = rgbToHsl(color);
  s = Math.min(s, satCap);
  let l = targetL;
  let out = hslToRgb([h, s, l]).map(Math.round);
  for (let i = 0; i < 24 && contrast(out, bg) < min; i++) {
    l = Math.min(1, l + 0.03);
    if (l > 0.9) {
      s = Math.max(0, s - 0.06); // ease toward white so pure light stays reachable
    }
    out = hslToRgb([h, s, l]).map(Math.round);
  }
  return out;
}

exports.decorateConfig = config => {
  // 底色: hyper-pokemon puts the theme background (unibody/primary) on borderColor.
  const rawBg = toRgb(config.borderColor) || toRgb(config.backgroundColor);
  if (!rawBg) {
    return config;
  }

  const AA = 4.5;
  const TARGET = 7;

  // --- Effective backdrop: the theme's hue, forced DARK. --------------------
  // Terminal apps assume a dark background; keep the flavor (hue) but drop the
  // lightness so every theme lands in the environment those apps expect. Floor
  // the saturation a little so the hue is still visible at low lightness (a
  // near-grey 底色 stays a neutral near-black).
  const [bgHue, bgSatRaw] = rgbToHsl(rawBg);
  const bgSat = bgSatRaw < 0.06 ? bgSatRaw : Math.min(0.55, Math.max(bgSatRaw, 0.30));
  const bg = hslToRgb([bgHue, bgSat, 0.13]).map(Math.round);

  // --- Text: a bright, light tint of the same hue. --------------------------
  const pick = toLight(rawBg, bg, 0.92, 0.42, TARGET);
  const pickC = contrast(pick, bg);
  const fg = toHex(pick);

  // --- Scrim = the dark 底色 over the image (readability-first). -------------
  // Heavy enough that even the bright regions of the artwork (a white Lugia
  // body) stay dark behind text, but not opaque -- the art still ghosts through.
  const alpha = '0.760';
  const scrim = `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${alpha})`;

  // Surface for ANSI-black-background panels (Codex's message/attachment block):
  // the dark 底色, a hair elevated so the panel reads as a raised card, not a
  // hole. Light text keeps clearing AA against it.
  const tuiSurface = blend(bg, [255, 255, 255], 0.07).map(Math.round);
  const tuiSurfaceHex = toHex(tuiSurface);

  // Muted / dim foreground text (ANSI bright-black -- chalk.gray hints,
  // timestamps): a soft light-grey tint of the hue. Legible but clearly quieter
  // than the main text. Clamp to a real AA floor so it never washes out.
  const dim = toLight(rawBg, bg, 0.66, 0.20, Math.min(AA, TARGET - 1));
  const dimHex = toHex(dim);

  // A full bright-on-dark ANSI palette, tinted toward each hue and guaranteed
  // >= AA against the dark backdrop. Replaces hyper-pokemon's collapsed palette
  // (which mapped most slots onto the theme's dark `secondary` -- invisible on a
  // dark backdrop). Base hues are standard "designed for dark terminal" values.
  const BRIGHT = {
    red: [255, 107, 107],
    green: [95, 245, 145],
    yellow: [255, 214, 107],
    blue: [107, 168, 255],
    magenta: [255, 123, 230],
    cyan: [95, 240, 245],
    white: [230, 230, 238],
    lightRed: [255, 143, 143],
    lightGreen: [141, 255, 176],
    lightYellow: [255, 229, 143],
    lightBlue: [147, 192, 255],
    lightMagenta: [255, 159, 238],
    lightCyan: [143, 246, 250],
    lightWhite: [255, 255, 255],
    limeGreen: [120, 240, 130],
    lightCoral: [255, 150, 150]
  };
  const baseColors = config.colors || {};
  const colors = Object.assign({}, baseColors);
  Object.keys(BRIGHT).forEach(name => {
    colors[name] = toHex(ensureContrast(BRIGHT[name], bg, AA));
  });
  colors.black = tuiSurfaceHex;
  colors.lightBlack = dimHex;

  // hyper-pokemon and hyper-statusline color the CHROME (tab bar, statusline,
  // window title, split dividers) from the theme's raw `secondary`, captured
  // before this plugin runs -- so on low-contrast themes the tabs/footer sit at
  // the same ~3.6:1 the terminal text used to. Re-drive that chrome text to the
  // adapted `fg` (AA vs 底色), and back the statusline with a real surface so it
  // reads as a panel instead of raw image bleed.
  const chromeCSS = `
    .header_shape, .header_appTitle,
    .tabs_nav .tabs_title,
    .tabs_nav .tabs_list .tab_tab,
    .tab_shape,
    .tab_shape:hover,
    .footer_footer,
    .footer_footer .footer_group,
    .footer_footer .component_item,
    .footer_footer .item_cwd,
    .footer_footer .item_branch {
      color: ${fg} !important;
    }
    .footer_footer {
      background-color: ${tuiSurfaceHex} !important;
    }
    .footer_footer .item_icon:before,
    .terms_terms .terms_termGroup .splitpane_panes .splitpane_divider {
      background-color: ${fg} !important;
    }
  `;

  const overlayCSS = `
    /* hyper-readable: adaptive text ${fg} on 底色 ${toHex(bg)} (contrast ${pickC.toFixed(2)}); surface ${tuiSurfaceHex} */
    .terms_terms {
      box-shadow: inset 0 0 0 100vmax ${scrim} !important;
    }
    ${chromeCSS}
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
    /*
     * We keep the xterm background transparent (alpha 0) so the artwork shows,
     * but set its RGB to the real dark 底色 so apps that probe OSC 10/11 for the
     * default background infer a DARK terminal and pick colors accordingly.
     * These DOM rules only bite under the (unused) DOM renderer; they map an
     * app's ANSI-black default cell onto the dark surface as a harmless fallback.
     */
    .xterm-rows .xterm-bg-0 {
      background-color: ${tuiSurfaceHex} !important;
    }
    .xterm-rows .xterm-fg-0 {
      color: ${fg} !important;
    }
  `;

  return Object.assign({}, config, {
    backgroundColor: transparentRgb(bg),
    foregroundColor: fg,
    cursorColor: fg,
    cursorAccentColor: toHex(bg),
    colors,
    termCSS: `${config.termCSS || ''}\n${terminalCSS}`,
    css: `${config.css || ''}\n${overlayCSS}`
  });
};
