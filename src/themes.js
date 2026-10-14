/**
 * Layout registry.
 *
 * A layout owns structure and CSS. Colour and type come from a palette
 * (see `palettes.js`), so any layout can be paired with any palette.
 *
 * Each entry may declare `tokens` for structural defaults; a palette then
 * overrides only the colour and font keys it actually supplies, and the user's
 * `tokens` override both.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BASE_LAYOUT, deepMerge } from './tokens.js';
import { MASTHEAD_CSS, stripChrome } from './chrome.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const themeDir = path.resolve(here, '..', 'themes');

/** Structural defaults each layout starts from. */
const LAYOUT_DEFAULTS = deepMerge({}, BASE_LAYOUT);

const REGISTRY = {
  paper: {
    file: 'paper.css',
    // slate is the default; any palette may be substituted
    palette: 'slate',
    description: 'Serif, print-inspired, generous measure. Sticky contents rail.',
  },
  slides: {
    file: 'slides.css',
    palette: 'slate',
    description: 'Scroll-snap deck. Sections become dividers; frames become slides.',
  },
  notes: {
    file: 'notes.css',
    palette: 'slate',
    description: 'Sans-serif technical reading notes, wide measure, skimmable.',
  },
  docs: {
    file: 'docs.css',
    palette: 'slate',
    description: 'Reference pages: sections in cards, no contents rail.',
  },
  landing: {
    file: 'landing.css',
    palette: 'slate',
    description: 'Front page for a project: a hero, a ruled list of examples, then a contents rail.',
  },
};

let cache = null;

/**
 * Structural metrics per layout.
 *
 * These live here rather than in each layout's `:root` because the token
 * blocks in a layout's CSS are stripped on load (see below): the palette is
 * the single source of colour and the metrics are emitted from one resolved
 * set. A layout that wants a different measure declares it here.
 */
const LAYOUT_TOKENS = {
  paper: {},
  slides: { radius: '12px', 'radius-sm': '7px' },
  notes: {
    measure: 'clamp(36rem, 60vw, 50rem)',
    rail: 'clamp(13rem, 14vw, 17rem)',
    gutter: 'clamp(1rem, 4vw, 2.5rem)',
    'sp-5': '1.5rem', 'sp-6': '2rem', 'sp-7': '3rem', 'sp-8': '4.5rem',
  },
  docs: {
    // A landing page wants room for cards, not a reading measure, and it has no
    // contents rail at all.
    measure: 'clamp(44rem, 88vw, 66rem)',
    rail: '0rem',
    radius: '14px', 'radius-sm': '8px',
    'sp-5': '1.5rem', 'sp-6': '2rem', 'sp-7': '3rem', 'sp-8': '4.5rem',
  },
  landing: {
    // Wide enough for a row of three example buttons, narrow enough that the text
    // below the fold is still a reading measure. The rail is back: the contents
    // below the fold is in standard formatting, which means a sidebar.
    measure: 'clamp(44rem, 86vw, 62rem)',
    rail: 'clamp(13rem, 13vw, 17rem)',
    radius: '14px', 'radius-sm': '8px',
    // How far down its first screen the hero sets the wordmark: far enough
    // for air above the name, and a fixed step so the mark does not move
    // while the window is dragged.
    'hero-top': '4rem',
    'sp-5': '1.5rem', 'sp-6': '2rem', 'sp-7': '3rem', 'sp-8': '4rem',
  },
};

/**
 * The layouts whose stylesheet is actually on disk.
 *
 * The registry above is the full set the project has; the package ships the
 * subset whose CSS is present. An entry without its file is skipped, not an
 * error: it is a layout this installation does not carry, and it must appear
 * neither in `--help` nor as a buildable theme.
 */
function availableEntries() {
  return Object.entries(REGISTRY).filter(([, meta]) =>
    existsSync(path.join(themeDir, meta.file)));
}

/**
 * Loads every layout. `tokenBlocks` names the CSS custom-property blocks to
 * strip from the file, so the same rules cannot exist twice with different
 * values — the palette is now the single source of colour.
 */
export async function loadLayouts() {
  if (cache) return cache;
  const out = {};
  for (const [name, meta] of availableEntries()) {
    let css = await fs.readFile(path.join(themeDir, meta.file), 'utf8');
    css = stripTokenBlocks(css);
    // The bar is shared (chrome.js): rules for it in the layout file are
    // removed and the shared block appended last so it wins. A layout changes
    // the bar by naming a token, not by position in the stylesheet.
    css = stripChrome(css) + '\n' + MASTHEAD_CSS;
    out[name] = {
      name,
      description: meta.description,
      palette: meta.palette,
      // `deepMerge` takes a base and one override: no third argument.
      tokens: deepMerge(LAYOUT_DEFAULTS, LAYOUT_TOKENS[name] || {}),
      css,
    };
  }
  cache = out;
  return out;
}

export function layoutNames() {
  return availableEntries().map(([name]) => name);
}

/** Lists the layouts for `--help` without loading their CSS. */
export function layoutSummary() {
  return availableEntries().map(([name, m]) => `${name} — ${m.description}`);
}

/**
 * Colour and font custom properties. These are owned by the palette from now
 * on, so any hardcoded copy in a layout would be a second source of truth.
 */
const COLOUR_LINE = /^\s*--(?:bg|bg-raised|bg-sunken|bg-tint|ink|ink-soft|ink-faint|line|line-soft|accent(?:-soft|-ink)?|mark|shadow|tok-[a-z]+|serif|sans|mono)\s*:/;

const COLOUR_SELECTOR = /^\s*html\s*\[data-theme[^{]*\{\s*$/;
const ROOT_SELECTOR = /^\s*:root\s*\{\s*$/;

/**
 * Removes colour and font declarations from a layout so the palette is the
 * only place they are defined.
 *
 * - an `html[data-theme=...]` block is colour-only, so it goes entirely
 * - a `:root` block also holds structural defaults (measure, spacing, type
 *   scale), so only its colour lines are dropped
 * - an `@media` left empty by the removal goes too
 */
export function stripTokenBlocks(css) {
  const lines = css.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (COLOUR_SELECTOR.test(line)) {
      i = skipBlock(lines, i);
      continue;
    }

    if (ROOT_SELECTOR.test(line)) {
      const { body, next } = readBlock(lines, i);
      const kept = body.filter(
        (b) => !COLOUR_LINE.test(b) && !/^\s*color-scheme\s*:/.test(b));
      // the opener was dropped along with the token lines, so drop the closer too
      while (kept.length && /^\s*\}\s*$/.test(kept.at(-1))) kept.pop();
      out.push(...kept);
      i = next;
      continue;
    }

    out.push(line);
    i++;
  }

  return tidy(out.join('\n'));
}

/** Index just past the block opened at `start`, plus its body lines. */
function readBlock(lines, start) {
  const body = [];
  let depth = braceDelta(lines[start]);
  let j = start + 1;
  while (j < lines.length && depth > 0) {
    const delta = braceDelta(lines[j]);
    if (depth + delta <= 0) {
      body.push(lines[j]);
      return { body, next: j + 1 };
    }
    depth += delta;
    body.push(lines[j]);
    j++;
  }
  return { body, next: j };
}

function skipBlock(lines, start) {
  return readBlock(lines, start).next;
}

const braceDelta = (line) =>
  (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

/** Drops media queries left with nothing inside, and collapses blank runs. */
function tidy(css) {
  let out = css;
  for (let guard = 0; guard < 8; guard++) {
    const before = out;
    out = out.replace(/@media[^{]+\{\s*\n(\s*\n)*\}/g, '');
    if (out === before) break;
  }
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}
