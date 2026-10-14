/**
 * Configuration.
 *
 * Three layers, later wins:
 *
 *   1. built-in defaults
 *   2. the config file (`latex2web.config.js`, or `.json`)
 *   3. command-line flags
 *
 * Within the file, the same precedence idea applies to appearance, so a user can
 * change one colour without restating a theme:
 *
 *   layout palette  ->  `tokens`  ->  `css`  ->  `template`
 *
 * A config file may export an object, a function of the resolved CLI args, or a
 * promise of either. It may also `extends` a preset — a preset is just another
 * config object, which is how themes and future plugins distribute without
 * needing a plugin API: ship a package that exports a partial config.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

import {
  BASE_LAYOUT, LAYOUT_KEYS, PALETTE_KEYS, deepMerge, isPlainObject,
  unknownTokens
} from './tokens.js';
import { deriveContrastTokens } from './contrast.js';

export const CONFIG_NAMES = [
  'latex2web.config.js',
  'latex2web.config.mjs',
  'latex2web.config.json',
  '.latex2webrc',
];

/** The baseline. Every key here is documented in the README. */
export const DEFAULTS = {
  // --- what to build
  out: 'dist',
  includeDir: [],
  maxIncludeDepth: 16,

  // --- appearance
  theme: 'paper',        // a layout name, or a path to a CSS file
  palette: null,         // a palette name, or a token object
  tokens: {},            // token overrides, win over the palette
  css: [],               // extra CSS: strings, {inline}, or {path}
  template: null,        // path to an HTML shell, or (ctx) => string
  head: null,            // (ctx) => extra <head> markup
  scripts: null,         // (ctx) => extra <script> markup
  motion: 'off',         // off | on -- animation is opt-in, see the theme
  nav: null,             // [{label, href} | {label, items:[…]}] -- a dropdown per group
  // The footer: false for a single line of small print, true (the default)
  // for the mark, a tagline and the navigation as columns. Built from `nav`.
  footer: true,
  footerTagline: null,   // one line under the mark; there is a default
  footerPagesLabel: null, // heading for links that are not part of a group
  github: null,          // "owner/repo" -- puts the mark in the masthead
  // The date on the title page, for a document that carries none. A converter
  // is told things the source does not say.
  date: null,
  // A note about the document itself, shown above its content: what was changed,
  // what was dropped, what is not in the source. For a conversion, this is where
  // an editorial change is declared.
  notice: null,
  // Where a cross-reference to a sibling document resolves to. Supplied here
  // rather than invented in the parser; an absent entry prints nothing and is
  // reported, rather than printing the macro's argument at the reader.
  xrefs: null,
  // `front-matter` lifts the title and everything before the first heading into a
  // hero of its own, above the contents, for a front page. The default keeps the
  // header where it was written: at the top of the reading column.
  hero: null,
  // Draw the title as the wordmark rather than as a heading, for a page whose
  // subject is the tool.
  wordmarkHero: false,
  home: null,            // where the wordmark links; defaults to the current dir
  wordmark: null,        // the name the wordmark spells, for assistive tech
  scrollCue: false,      // '#main' or true -- a "scroll down" link, for a landing page

  // --- content
  engine: 'katex',       // katex | plain
  singleFile: false,
  emit: 'full',          // full | html-only — html-only assumes --base serves the assets
  base: '',
  title: null,
  lang: null,            // defaults to 'en'
  numbering: { sections: true, equations: true, figures: true, tables: true },
  highlights: [],        // extra languages for listings
  toc: { enabled: true, label: 'Contents' },

  // --- assets and figures
  assets: { copy: true, dir: 'assets', missing: 'placeholder' },
  // Delegation is on: with no engine installed `detect` reports it, the page
  // says so, and the drawing is shown as source. A config file can still set
  // `delegate: false` for a build that must not shell out.
  figures: { delegate: true, engine: 'auto', dpi: 200, timeout: 30000, width: '100%' },

  // --- behaviour
  quiet: false,
  watch: false,
  // Deletes the compiled-figure cache in `out` before building. Resolved
  // into the build config (not CLI-only) so the build can act on it.
  clearCache: false,
  transforms: [],        // [{ match(node), render(node, ctx) }]
  hooks: {},             // { 'beforeParse', 'afterParse', 'beforeRender', 'afterRender', 'beforeWrite', 'afterBuild' }
  extends: null,
};

/** Flags that are CLI-only and never read from a config file. */
const CLI_ONLY = new Set([
  'input', 'inputs', 'config', 'positional', 'help', 'version', 'extra',
  'explicit'
]);

export async function loadConfig({ configPath, cwd = process.cwd(), cli = {} } = {}) {
  const found = resolveConfigFile(configPath, cwd);
  let fileConfig = {};

  if (found) {
    fileConfig = await importConfig(found);
    fileConfig = await normaliseExtends(fileConfig, found);
  }

  const explicit = new Set(cli.explicit || []);
  const fromCli = {};
  for (const [key, value] of Object.entries(cli)) {
    if (CLI_ONLY.has(key) || value === undefined) continue;
    fromCli[key] = value;
  }

  const merged = deepMerge(deepMerge(DEFAULTS, fileConfig), fromCli);
  if (merged.figureEngine)
    merged.figures = { ...merged.figures, engine: merged.figureEngine };
  // `figures: false` means "do not shell out", not "reset to defaults": the
  // remaining fields keep their values.
  if (merged.figures === false)
    merged.figures = { ...DEFAULTS.figures, delegate: false };
  else if (merged.figures === true) merged.figures = { ...DEFAULTS.figures };
  else if (merged.figures && typeof merged.figures === 'object'
    && merged.figures.delegate === undefined) {
    merged.figures = { ...DEFAULTS.figures, ...merged.figures };
  }
  merged.__configFile = found;
  merged.__explicit = explicit;
  // Paths resolve against the config file's directory, or the cwd when there
  // is no config file.
  merged.__root = found ? path.dirname(found) : cwd;
  return merged;
}

function resolveConfigFile(configPath, cwd) {
  if (configPath) {
    const abs = path.resolve(cwd, configPath);
    if (!existsSync(abs)) throw new Error(`config file not found: ${configPath}`);
    return abs;
  }
  // walk up from cwd, like most tools do
  let dir = cwd;
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function importConfig(file) {
  if (file.endsWith('.json')) {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
    }
  }

  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  let value = mod.default ?? mod.config ?? mod;
  if (typeof value === 'function') value = await value();
  value = await value;
  if (!isPlainObject(value)) {
    throw new Error(
      `${path.basename(file)} must export a config object (got ${typeof value})`);
  }
  return value;
}

/** Resolves `extends` against presets first, then relative paths. */
async function normaliseExtends(config, fromFile) {
  if (!config.extends) return config;
  const chain = Array.isArray(config.extends) ? config.extends : [config.extends];
  let base = {};
  for (const entry of chain) {
    base = deepMerge(base, await loadPreset(entry, fromFile));
  }
  const { extends: _drop, ...rest } = config;
  return deepMerge(base, rest);
}

async function loadPreset(spec, fromFile) {
  if (isPlainObject(spec)) return spec; // inline preset
  const asPath = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(asPath) && /\.(json|js|mjs)$/.test(asPath))
    return importConfig(asPath);
  // otherwise treat it as a package name
  const mod = await import(spec);
  const value = mod.default ?? mod.config ?? mod;
  return typeof value === 'function' ? await value() : value;
}

/**
 * Resolves appearance into something `build()` can consume: a CSS string, a
 * token map, and any warnings.
 */
export async function resolveAppearance(config, layouts) {
  const warnings = [];

  // --- layout
  const layout = await resolveLayout(config.theme, layouts, warnings);

  // --- palette: explicit, else the layout's own, else the built-in default.
  const requested = config.palette ?? layout.palette ?? 'warm-paper';
  const scheme = await resolvePalettePair(requested);

  // --- merge: palette < layout defaults < the user's own tokens
  //
  // The contrast repair runs over palette and layout *before* user tokens merge
  // in: a repair leaves alone what the author stated on purpose, so an explicit
  // token is the last word on its own value.
  const compose = (paletteTokens) => {
    const base = deriveContrastTokens(deepMerge(paletteTokens, layout.tokens || {}));
    return withDerivedTokens(deepMerge(base, config.tokens || {}));
  };

  const light = compose(scheme.light);
  const dark = scheme.adaptive ? compose(scheme.dark) : light;

  const stray = unknownTokens(
    { ...light, ...dark }, [...PALETTE_KEYS, ...LAYOUT_KEYS, ...DERIVED_KEYS]);
  if (stray.length) {
    warnings.push(`unknown token${stray.length > 1 ? 's' : ''}: ${stray.join(', ')} (ignored by the stylesheets)`);
  }

  // --- extra CSS, appended after the layout so it always wins
  const extra = await collectCss(config.css);
  const css = [layout.css, schemeCss(light, dark), ...extra].filter(Boolean)
    .join('\n\n');

  return {
    css,
    tokens: light,
    darkTokens: dark,
    palette: scheme.name,
    adaptive: !!scheme.adaptive,
    warnings,
    layoutName: layout.name,
  };
}

/**
 * Tokens the stylesheets reference but no palette is expected to supply,
 * because they are derived from the ones it does supply. Emitting them keeps a
 * layout free to use `--tok-operator` without every palette defining it.
 */
export const DERIVED_KEYS = ['tok-operator', 'tok-punct', 'tok-variable'];

function withDerivedTokens(tokens) {
  const out = { ...tokens };
  // Copied from the text levels, inheriting their contrast. Derived here (not
  // in the palette) so an explicit user token is never overwritten.
  if (out['tok-operator'] === undefined && out['ink-soft'])
    out['tok-operator'] = out['ink-soft'];
  if (out['tok-punct'] === undefined && out['ink-faint'])
    out['tok-punct'] = out['ink-faint'];
  if (out['tok-variable'] === undefined && out.ink) out['tok-variable'] = out.ink;
  return out;
}

/**
 * Turns a palette name (or `{light, dark}` pair) into a light and a dark token
 * map. A single palette pins both schemes: choosing Mocha means always dark,
 * which is what picking a dark palette is asking for.
 */
async function resolvePalettePair(requested) {
  const { resolvePalette, isPalette } = await import('./palettes.js');

  if (isPlainObject(requested) && (requested.light || requested.dark)) {
    const pick = (key, fallback) => {
      const value = requested[key];
      if (value === undefined) return resolvePalette(fallback);
      if (typeof value === 'string') {
        if (!isPalette(value)) throw unknownPalette(value);
        return resolvePalette(value);
      }
      if (isPlainObject(value)) return { label: `inline ${key}`, tokens: value };
      throw new Error('a palette entry must be a name or an object of tokens');
    };
    const light = pick('light', 'warm-paper');
    const dark = pick('dark', 'warm-paper-dark');
    return {
      light: light.tokens,
      dark: dark.tokens,
      name: `${light.label}/${dark.label}`,
      adaptive: true,
    };
  }

  if (typeof requested === 'string') {
    if (!isPalette(requested)) throw unknownPalette(requested);
    const palette = resolvePalette(requested);
    // a single palette is pinned: it applies in every colour mode, which is
    // what choosing "Mocha" is asking for
    return {
      light: palette.tokens,
      dark: palette.tokens,
      name: palette.label,
      adaptive: false,
    };
  }

  if (isPlainObject(requested)) {
    return { light: requested, dark: requested, name: 'inline', adaptive: false };
  }
  throw new Error('`palette` must be a name, an object of tokens, or {light, dark}');
}

const unknownPalette = (name) => new Error(
  `unknown palette "${name}". Use a registered name, an object of tokens, or {light, dark}.`,
);

/**
 * Emits the tokens for all three colour modes.
 *
 * The layout CSS carries no colour, so the palette states both schemes. `auto`
 * follows the OS; an explicit toggle always wins.
 */
function schemeCss(light, dark) {
  const same = JSON.stringify(light) === JSON.stringify(dark);
  const block = (tokens, scheme) =>
    `:root, html[data-theme="${scheme}"] {\n${tokensToBlock(tokens)}\n  color-scheme: ${scheme};\n}`;

  const parts = [];
  if (same) {
    // one pinned palette: it applies whatever the scheme claims to be
    parts.push(block(light, lightSchemeHint(light)));
    parts.push(`html[data-theme="dark"] {\n${tokensToBlock(dark)}\n  color-scheme: dark;\n}`);
    parts.push(
      `@media (prefers-color-scheme: dark) {\n  html[data-theme="auto"] {\n`
      + `${indent(tokensToBlock(dark), 4)}\n    color-scheme: dark;\n  }\n}`,
    );
    return parts.join('\n');
  }

  parts.push(block(light, 'light'));
  parts.push(`html[data-theme="dark"] {\n${tokensToBlock(dark)}\n  color-scheme: dark;\n}`);
  parts.push(
    `@media (prefers-color-scheme: dark) {\n  html[data-theme="auto"] {\n`
    + `${indent(tokensToBlock(dark), 4)}\n    color-scheme: dark;\n  }\n}`,
  );
  return parts.join('\n');
}

/** Guesses a pinned palette's polarity from its own background luminance. */
function lightSchemeHint(tokens) {
  const hex = String(tokens?.bg || '');
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'light';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? 'light' : 'dark';
}

function tokensToBlock(tokens) {
  return Object.entries(tokens)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n');
}

const indent = (text, spaces) =>
  text.split('\n').map((l) => ' '.repeat(spaces) + l).join('\n');

async function resolveLayout(theme, layouts, warnings) {
  if (typeof theme === 'object' && theme !== null) {
    // an inline layout: { name, css, tokens }
    return {
      name: theme.name || 'inline', css: theme.css || '', tokens: theme.tokens || {}
    };
  }
  if (typeof theme === 'string' && (theme.endsWith('.css') || theme.includes('/'))) {
    const file = theme;
    const { readFile } = await import('node:fs/promises');
    return {
      name: path.basename(file).replace(/\.css$/, ''),
      css: await readFile(file, 'utf8'),
      tokens: {}
    };
  }
  const layout = layouts?.[theme];
  if (!layout) {
    throw new Error(
      `unknown theme "${theme}". Available: ${Object.keys(layouts || {}).join(', ')}. `
      + 'A path to a .css file also works.',
    );
  }
  if (!layout.tokens) warnings.push(`layout "${theme}" declares no tokens; palette overrides may not apply`);
  // The name travels with the layout: the stylesheet is named after it, so two
  // layouts can share an output directory without overwriting each other's CSS.
  return { ...layout, name: layout.name || theme };
}

function tokensToOverrideCss(tokens) {
  const entries = Object.entries(tokens).filter(
    ([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `:root {\n${entries.map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}`;
}

/** Accepts a string, an array of strings/objects, or a function returning either. */
async function collectCss(css) {
  if (!css) return [];
  const { readFile } = await import('node:fs/promises');
  const resolved = typeof css === 'function' ? await css() : css;
  const list = Array.isArray(resolved) ? resolved : [resolved];

  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      out.push(item.includes('\n') || item.includes('{')
        ? item
        : await readFile(item, 'utf8'));
      continue;
    }
    if (isPlainObject(item)) {
      if (item.inline) out.push(item.inline);
      else if (item.path) out.push(await readFile(item.path, 'utf8'));
      else throw new Error('a css entry must be a string, {inline}, or {path}');
      continue;
    }
    throw new Error(`unsupported css entry: ${typeof item}`);
  }
  return out;
}

/** Structural defaults, applied underneath whatever a layout declares. */
export const layoutDefaults = () => deepMerge({}, BASE_LAYOUT);

/**
 * Checks a config for keys we do not recognise, so a typo is reported rather
 * than silently ignored. Deliberately a warning: a config written for a newer
 * version should still work.
 */
export function checkConfigKeys(config) {
  const known = new Set([...Object.keys(DEFAULTS), ...CLI_ONLY]);
  return Object.keys(config || {}).filter((k) => !known.has(k) && !k.startsWith('__'));
}
