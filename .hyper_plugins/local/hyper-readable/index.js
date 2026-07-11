'use strict';

const fs = require('fs');
const zlib = require('zlib');

// hyper-readable
// -----------------------------------------------------------------------------
// hyper-pokemon chooses a random theme and paints a full-bleed PNG behind a
// transparent xterm canvas. A global dark overlay makes text readable, but it
// also turns every Pokemon into the same dim backdrop. This plugin instead reads
// the selected PNG, samples the actual artwork, and chooses foreground + ANSI
// colors that score well against the image itself. Opaque surfaces are kept for
// TUI panels, but the artwork is not covered by a terminal-wide mask.

const IMAGE_CACHE = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

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
    if (parts.length >= 3 && parts.every(n => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2]];
    }
  }

  return null;
}

function toHex([r, g, b]) {
  return '#' + [r, g, b]
    .map(x => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0'))
    .join('');
}

function transparentRgb([r, g, b]) {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0)`;
}

function translucentRgb([r, g, b], alpha) {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}

// WCAG relative luminance + contrast ratio.
function channelLin(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relLuminance([r, g, b]) {
  return 0.2126 * channelLin(r) + 0.7152 * channelLin(g) + 0.0722 * channelLin(b);
}

function contrastFromLuminance(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function contrast(a, b) {
  return contrastFromLuminance(relLuminance(a), relLuminance(b));
}

function blend(c, target, k) {
  return c.map((v, i) => v + (target[i] - v) * k);
}

function quantile(sorted, q) {
  if (!sorted.length) {
    return 0;
  }
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {
    return sorted[lo];
  }
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// --- HSL round-trip, so we can move lightness while keeping hue. -------------
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

function toneFrom(seed, lightness, satMin, satMax) {
  let [h, s] = rgbToHsl(seed);
  s = s < 0.06 ? 0 : clamp(s, satMin, satMax);
  return hslToRgb([h, s, lightness]).map(Math.round);
}

function readableExtremeAgainst(color) {
  return contrast([0, 0, 0], color) >= contrast([255, 255, 255], color)
    ? [0, 0, 0]
    : [255, 255, 255];
}

// --- Small PNG luminance sampler -------------------------------------------

function extractBackgroundPath(css) {
  const m = String(css || '').match(/url\(["']?file:\/\/([^"')]+\.png)["']?\)/i);
  if (!m) {
    return null;
  }
  try {
    return decodeURI(m[1]);
  } catch {
    return m[1];
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function parsePngStats(file) {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  const cached = IMAGE_CACHE.get(file);
  if (cached !== undefined) {
    return cached;
  }

  let stats = null;
  try {
    const png = fs.readFileSync(file);
    const signature = '89504e470d0a1a0a';
    if (png.slice(0, 8).toString('hex') !== signature) {
      IMAGE_CACHE.set(file, null);
      return null;
    }

    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette = null;
    let transparency = null;
    const idats = [];

    while (pos + 8 <= png.length) {
      const len = png.readUInt32BE(pos);
      const type = png.slice(pos + 4, pos + 8).toString('ascii');
      const data = png.slice(pos + 8, pos + 8 + len);
      pos += 12 + len;

      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === 'PLTE') {
        palette = data;
      } else if (type === 'tRNS') {
        transparency = data;
      } else if (type === 'IDAT') {
        idats.push(data);
      } else if (type === 'IEND') {
        break;
      }
    }

    if (bitDepth !== 8 || interlace !== 0 || !width || !height || !idats.length) {
      IMAGE_CACHE.set(file, null);
      return null;
    }

    const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colorType];
    if (!channels || (colorType === 3 && !palette)) {
      IMAGE_CACHE.set(file, null);
      return null;
    }

    const inflated = zlib.inflateSync(Buffer.concat(idats));
    const rowLen = width * channels;
    const bpp = channels;
    const strideX = Math.max(1, Math.floor(width / 150));
    const strideY = Math.max(1, Math.floor(height / 90));
    const lums = [];
    const edgeLums = [];
    let src = 0;
    let prev = Buffer.alloc(rowLen);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let edgeR = 0;
    let edgeG = 0;
    let edgeB = 0;
    let samples = 0;
    let edgeSamples = 0;
    const edgeBins = new Map();

    for (let y = 0; y < height; y++) {
      const filter = inflated[src++];
      const row = Buffer.alloc(rowLen);
      for (let x = 0; x < rowLen; x++) {
        const raw = inflated[src++];
        const left = x >= bpp ? row[x - bpp] : 0;
        const up = prev[x] || 0;
        const upLeft = x >= bpp ? prev[x - bpp] : 0;
        let value = raw;
        if (filter === 1) {
          value = raw + left;
        } else if (filter === 2) {
          value = raw + up;
        } else if (filter === 3) {
          value = raw + Math.floor((left + up) / 2);
        } else if (filter === 4) {
          value = raw + paeth(left, up, upLeft);
        } else if (filter !== 0) {
          IMAGE_CACHE.set(file, null);
          return null;
        }
        row[x] = value & 0xff;
      }

      if (y % strideY === 0) {
        for (let x = 0; x < width; x += strideX) {
          let r;
          let g;
          let b;
          let a = 255;
          const i = x * channels;

          if (colorType === 0) {
            r = row[i]; g = row[i]; b = row[i];
          } else if (colorType === 2) {
            r = row[i]; g = row[i + 1]; b = row[i + 2];
          } else if (colorType === 3) {
            const idx = row[i];
            const p = idx * 3;
            r = palette[p]; g = palette[p + 1]; b = palette[p + 2];
            a = transparency && idx < transparency.length ? transparency[idx] : 255;
          } else if (colorType === 4) {
            r = row[i]; g = row[i]; b = row[i]; a = row[i + 1];
          } else if (colorType === 6) {
            r = row[i]; g = row[i + 1]; b = row[i + 2]; a = row[i + 3];
          }

          if (a < 32) {
            continue;
          }
          const lum = relLuminance([r, g, b]);
          lums.push(lum);
          sumR += r;
          sumG += g;
          sumB += b;
          samples++;

          // The Pokemon body is often centered; the corners and outer band are
          // a better estimate of the actual artwork background behind text.
          if (x < width * 0.16 || x > width * 0.84 || y < height * 0.16 || y > height * 0.84) {
            edgeLums.push(lum);
            edgeR += r;
            edgeG += g;
            edgeB += b;
            edgeSamples++;
            const key = `${r >> 4},${g >> 4},${b >> 4}`;
            const bin = edgeBins.get(key) || {count: 0, r: 0, g: 0, b: 0};
            bin.count++;
            bin.r += r;
            bin.g += g;
            bin.b += b;
            edgeBins.set(key, bin);
          }
        }
      }

      prev = row;
    }

    if (!lums.length) {
      IMAGE_CACHE.set(file, null);
      return null;
    }

    lums.sort((a, b) => a - b);
    edgeLums.sort((a, b) => a - b);
    let dominantEdge = null;
    edgeBins.forEach(bin => {
      if (!dominantEdge || bin.count > dominantEdge.count) {
        dominantEdge = bin;
      }
    });
    const edgeAvg = edgeSamples
      ? [edgeR / edgeSamples, edgeG / edgeSamples, edgeB / edgeSamples]
      : [sumR / samples, sumG / samples, sumB / samples];
    const bgRgb = dominantEdge && dominantEdge.count >= edgeSamples * 0.08
      ? [dominantEdge.r / dominantEdge.count, dominantEdge.g / dominantEdge.count, dominantEdge.b / dominantEdge.count]
      : edgeAvg;
    stats = {
      file,
      width,
      height,
      samples,
      edgeSamples,
      lums,
      edgeLums: edgeLums.length ? edgeLums : lums,
      avgRgb: [sumR / samples, sumG / samples, sumB / samples],
      bgRgb,
      edgeAvg,
      p05: quantile(lums, 0.05),
      p25: quantile(lums, 0.25),
      p50: quantile(lums, 0.50),
      p75: quantile(lums, 0.75),
      p95: quantile(lums, 0.95)
    };
  } catch {
    stats = null;
  }

  IMAGE_CACHE.set(file, stats);
  return stats;
}

function contrastStatsForLums(color, lums) {
  const fgLum = relLuminance(color);
  const ratios = new Array(lums.length);
  let aa = 0;
  let sum = 0;

  for (let i = 0; i < lums.length; i++) {
    const ratio = contrastFromLuminance(fgLum, lums[i]);
    ratios[i] = ratio;
    sum += ratio;
    if (ratio >= 4.5) {
      aa++;
    }
  }

  ratios.sort((a, b) => a - b);
  return {
    p05: quantile(ratios, 0.05),
    p10: quantile(ratios, 0.10),
    p25: quantile(ratios, 0.25),
    mean: sum / ratios.length,
    aaRate: aa / ratios.length
  };
}

function scoreColor(color, fallbackBg, image, flavorBonus) {
  if (!image) {
    const bgContrast = contrast(color, fallbackBg);
    return {
      score: bgContrast + flavorBonus,
      bgContrast,
      aaRate: bgContrast >= 4.5 ? 1 : 0,
      p10: bgContrast,
      p25: bgContrast
    };
  }

  const bgContrast = contrast(color, image.bgRgb);
  const edge = contrastStatsForLums(color, image.edgeLums);
  const full = contrastStatsForLums(color, image.lums);
  const bgPenalty = Math.max(0, 4.5 - bgContrast);
  const edgePenalty = Math.max(0, 4.25 - edge.p25);
  return {
    score: edge.p10 * 1.8 +
      edge.p25 * 1.2 +
      edge.aaRate * 4.0 +
      Math.min(bgContrast, 9) * 0.9 +
      full.aaRate * 1.2 +
      Math.min(full.p10, 5) * 0.25 +
      flavorBonus -
      bgPenalty * 18 -
      edgePenalty * 3,
    bgContrast,
    aaRate: edge.aaRate,
    p10: edge.p10,
    p25: edge.p25,
    allAaRate: full.aaRate,
    allP10: full.p10
  };
}

function addCandidate(candidates, seen, rgb, label, bonus) {
  const key = toHex(rgb);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push({rgb, label, bonus});
}

function chooseForeground(bg, palette, image) {
  const candidates = [];
  const seen = new Set();
  const seeds = palette.length ? palette : [bg];
  const lightSteps = [0.72, 0.80, 0.88, 0.94, 0.98];
  const darkSteps = [0.04, 0.08, 0.13, 0.19, 0.26];

  seeds.forEach((seed, index) => {
    addCandidate(candidates, seen, seed.map(Math.round), `theme-${index}`, 0.45);
    lightSteps.forEach(l => {
      addCandidate(candidates, seen, toneFrom(seed, l, 0.58, 0.92), `theme-${index}-light`, 0.35);
    });
    darkSteps.forEach(l => {
      addCandidate(candidates, seen, toneFrom(seed, l, 0.42, 0.82), `theme-${index}-dark`, 0.35);
    });
  });

  // Neutral extremes are allowed, but get no flavor bonus. They should only win
  // when the artwork genuinely demands them.
  [[255, 255, 255], [248, 250, 255], [238, 238, 232], [17, 19, 24], [6, 8, 12], [0, 0, 0]].forEach(rgb => {
    addCandidate(candidates, seen, rgb, 'neutral', 0);
  });

  const scored = candidates
    .map(candidate => Object.assign(candidate, {
      metrics: scoreColor(candidate.rgb, bg, image, candidate.bonus)
    }))
    .sort((a, b) => b.metrics.score - a.metrics.score);

  const themed = scored
    .filter(candidate => candidate.label !== 'neutral')
    .filter(candidate => candidate.metrics.bgContrast >= 4.5)
    .filter(candidate => candidate.metrics.p10 >= 4.45)
    .filter(candidate => candidate.metrics.aaRate >= 0.88)
    .sort((a, b) => b.metrics.score - a.metrics.score);

  return themed[0] || scored[0];
}

function chooseDirection(bg, image) {
  const light = scoreColor([245, 248, 255], bg, image, 0);
  const dark = scoreColor([10, 12, 16], bg, image, 0);
  return light.score >= dark.score ? 'light' : 'dark';
}

function tuneForArtwork(seed, direction, bg, image, bonus) {
  const steps = direction === 'light'
    ? [0.58, 0.66, 0.74, 0.82, 0.90, 0.97]
    : [0.06, 0.10, 0.15, 0.22, 0.30, 0.38];
  return steps
    .map(l => {
      const rgb = toneFrom(seed, l, 0.48, 0.88);
      return {rgb, metrics: scoreColor(rgb, bg, image, bonus)};
    })
    .sort((a, b) => b.metrics.score - a.metrics.score)[0].rgb;
}

function chooseSurface(seed, fg, direction) {
  const lightness = direction === 'light' ? 0.10 : 0.92;
  let surface = toneFrom(seed, lightness, 0.18, 0.45);
  if (contrast(surface, fg) < 4.5) {
    surface = readableExtremeAgainst(fg);
  }
  return surface;
}

function chooseMuted(seed, direction, bg, image, fg) {
  const steps = direction === 'light'
    ? [0.48, 0.56, 0.64, 0.72]
    : [0.24, 0.31, 0.38, 0.45];
  const picked = steps
    .map(l => {
      const rgb = toneFrom(seed, l, 0.08, 0.28);
      return {rgb, metrics: scoreColor(rgb, bg, image, 0)};
    })
    .filter(c => contrast(c.rgb, fg) < 3.8)
    .sort((a, b) => b.metrics.score - a.metrics.score)[0];
  return picked ? picked.rgb : blend(bg, fg, 0.72).map(Math.round);
}

const ANSI_BASE = {
  red: [220, 70, 70],
  green: [60, 190, 105],
  yellow: [218, 164, 44],
  blue: [75, 128, 220],
  magenta: [200, 92, 210],
  cyan: [58, 185, 200],
  white: [218, 222, 230],
  lightRed: [255, 118, 118],
  lightGreen: [110, 230, 145],
  lightYellow: [255, 210, 96],
  lightBlue: [125, 170, 255],
  lightMagenta: [245, 132, 235],
  lightCyan: [110, 230, 240],
  lightWhite: [255, 255, 255],
  limeGreen: [95, 215, 115],
  lightCoral: [255, 138, 138]
};

exports.decorateConfig = config => {
  // hyper-pokemon puts the selected theme background/unibody on borderColor.
  const bg = toRgb(config.borderColor) || toRgb(config.backgroundColor);
  if (!bg) {
    return config;
  }

  // Recover the theme palette from hyper-pokemon's resolved config:
  // foregroundColor = secondary, colors.black = tertiary, selectionColor = primary@0.3.
  const secondary = toRgb(config.foregroundColor);
  const tertiary = config.colors ? toRgb(config.colors.black) : null;
  const primary = toRgb(config.selectionColor);
  const palette = [secondary, tertiary, primary, bg].filter(Boolean);

  const imagePath = extractBackgroundPath(config.css);
  const image = parsePngStats(imagePath);
  const chosen = chooseForeground(bg, palette, image);
  const fg = chosen.rgb.map(Math.round);
  const fgHex = toHex(fg);
  const direction = chooseDirection(bg, image);
  const effectiveBg = image ? image.bgRgb : bg;

  // TUI panels still need a real cell background. This only affects ANSI-black
  // cells/panels, not the Pokemon artwork behind normal transparent cells.
  const surface = chooseSurface(bg, fg, direction);
  const surfaceHex = toHex(surface);
  const dim = chooseMuted(bg, direction, bg, image, fg);
  const dimHex = toHex(dim);

  const colors = Object.assign({}, config.colors || {});
  Object.keys(ANSI_BASE).forEach(name => {
    colors[name] = toHex(tuneForArtwork(ANSI_BASE[name], direction, bg, image, 0.18));
  });
  colors.black = surfaceHex;
  colors.lightBlack = dimHex;

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
      color: ${fgHex} !important;
    }
    .footer_footer {
      background-color: ${surfaceHex} !important;
    }
    .footer_footer .item_icon:before,
    .terms_terms .terms_termGroup .splitpane_panes .splitpane_divider {
      background-color: ${fgHex} !important;
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
    .xterm-rows .xterm-bg-0 {
      background-color: ${surfaceHex} !important;
    }
    .xterm-rows .xterm-fg-0 {
      color: ${fgHex} !important;
    }
  `;

  const diagnostics = image
    ? `image ${image.width}x${image.height}, bg ${toHex(image.bgRgb)}, bg-contrast ${chosen.metrics.bgContrast.toFixed(2)}, edge-p10 ${chosen.metrics.p10.toFixed(2)}, edge-aa ${(chosen.metrics.aaRate * 100).toFixed(0)}%, all-aa ${(chosen.metrics.allAaRate * 100).toFixed(0)}%`
    : `fallback bg contrast ${chosen.metrics.bgContrast.toFixed(2)}`;

  return Object.assign({}, config, {
    backgroundColor: transparentRgb(effectiveBg),
    foregroundColor: fgHex,
    cursorColor: fgHex,
    cursorAccentColor: surfaceHex,
    selectionColor: translucentRgb(fg, 0.28),
    colors,
    termCSS: `${config.termCSS || ''}\n${terminalCSS}`,
    css: `${config.css || ''}\n/* hyper-readable: artwork-aware ${fgHex}; ${diagnostics}; no global scrim */\n${chromeCSS}`
  });
};
