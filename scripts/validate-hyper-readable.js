'use strict';

const fs = require('fs');
const path = require('path');
const {homedir} = require('os');

const repoRoot = path.resolve(__dirname, '..');
const readable = require(path.join(repoRoot, '.hyper_plugins/local/hyper-readable'));
const hyperPokemonRoot = process.env.HYPER_POKEMON_ROOT ||
  path.join(homedir(), '.hyper_plugins/node_modules/hyper-pokemon');
const hyperPokemon = require(path.join(hyperPokemonRoot, 'index.js'));
const yaml = require(require.resolve('js-yaml', {
  paths: [
    path.dirname(hyperPokemonRoot),
    hyperPokemonRoot
  ]
}));

const themeFile = path.join(hyperPokemonRoot, 'themes/pokemon.yml');
const themes = yaml.safeLoad(fs.readFileSync(themeFile, 'utf8')).pokemon;
const rows = [];
const foregrounds = new Set();

for (const name of Object.keys(themes)) {
  const themed = hyperPokemon.decorateConfig({
    pokemon: name,
    poketab: 'true',
    unibody: 'true',
    colors: {}
  });
  const out = readable.decorateConfig(themed);
  foregrounds.add(out.foregroundColor);

  const m = out.css.match(/artwork-aware (#[0-9a-f]+); image .* bg (#[0-9a-f]+), bg-contrast ([0-9.]+), edge-p10 ([0-9.]+), edge-aa ([0-9]+)%, all-aa ([0-9]+)%/i);
  rows.push({
    name,
    foreground: out.foregroundColor,
    parsed: Boolean(m),
    background: m ? m[2] : null,
    bgContrast: m ? Number(m[3]) : 0,
    edgeP10: m ? Number(m[4]) : 0,
    edgeAa: m ? Number(m[5]) : 0,
    allAa: m ? Number(m[6]) : 0
  });
}

const parsed = rows.filter(row => row.parsed).length;
const min = key => Math.min(...rows.map(row => row[key]));
const worst = rows
  .slice()
  .sort((a, b) => a.bgContrast - b.bgContrast || a.edgeP10 - b.edgeP10)
  .slice(0, 12);

const summary = {
  total: rows.length,
  parsed,
  distinctForegrounds: foregrounds.size,
  minBackgroundContrast: min('bgContrast'),
  minEdgeP10: min('edgeP10'),
  minEdgeAaPercent: min('edgeAa'),
  minAllAaPercent: min('allAa'),
  worst
};

console.log(JSON.stringify(summary, null, 2));

if (parsed !== rows.length || summary.minBackgroundContrast < 4.5 || summary.minEdgeAaPercent < 88) {
  process.exitCode = 1;
}
