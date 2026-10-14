/**
 * Palette registry: colour-and-type definitions that can be mixed with any layout.
 *
 * Hex values below are the official Catppuccin palette values, embedded as
 * literals so palettes resolve with zero runtime cost and no network access.
 * Source: https://raw.githubusercontent.com/catppuccin/palette/main/palette.json
 * (palette version 1.8.0, fetched October 2026).
 */

import {
  PALETTE_KEYS, SLATE, SLATE_DARK, WARM_PAPER, WARM_PAPER_DARK
} from './tokens.js';
import { deriveContrastTokens, mix } from './contrast.js';

/**
 * Build the token map for one Catppuccin flavour.
 *
 * Colour blends are precomputed sRGB mixes (see `contrast.mix`), not
 * `color-mix()` recipes: the value in the token map is a hex the contrast
 * maths can measure, while a `color-mix()` string is opaque to `parseColor`
 * and could never be checked against its ground. Only `shadow` keeps runtime
 * `color-mix()`: it blends against `transparent`, which has no hex.
 *
 * @param {object} c flavour colours keyed by Catppuccin name, each a hex string.
 * @param {object} opts
 * @param {boolean} opts.dark whether this is a dark flavour.
 * @returns {object} tokens in {@link PALETTE_KEYS} order.
 */

function catppuccinTokens(c, { dark }) {
  // Shadows use color-mix against black (dark flavours) or the flavour's own
  // text colour (Latte) so the shadow tracks the palette instead of baking in
  // an unrelated grey. The two-layer structure mirrors WARM_PAPER's shadow:
  // a tight contact shadow plus a large soft diffuse shadow.
  const shadow = dark
    ? '0 1px 2px color-mix(in srgb, black 40%, transparent), 0 10px 30px -16px color-mix(in srgb, black 80%, transparent)'
    : `0 1px 2px color-mix(in srgb, ${c.text} 12%, transparent), 0 10px 30px -16px color-mix(in srgb, ${c.text} 30%, transparent)`;
  return {
    // surfaces
    bg: c.base,
    'bg-raised': c.mantle,
    'bg-sunken': c.crust,
    'bg-tint': c.surface0,
    // text
    ink: c.text,
    'ink-soft': c.subtext0,
    'ink-faint': c.subtext1,
    // rules
    line: c.surface1,
    'line-soft': c.surface0,
    // The accent: blue on every flavour. Pastel lavender (#7287fd) measures
    // 2.81:1 on Latte's base, below even the 3:1 floor for non-text marks;
    // the light flavours therefore use the flavour blue deepened toward black
    // (~6.9:1 on the base, 6.4 on the raised surface), while the dark flavours
    // keep their blue, which clears comfortably on a dark ground.
    //
    // `mix(a, b, t)` weights `b` at `t`: the call below is 72% blue.
    accent: dark ? c.blue : mix('#000000', c.blue, 0.72),
    'accent-soft': dark ? c.surface1 : mix(c.blue, c.base, 0.12),
    'accent-ink': dark ? c.blue : mix(c.blue, '#000000', 0.55),
    // inline highlight
    mark: c.yellow,
    // The second accent: sapphire by the same rule (2.78:1 unmodified on a
    // light ground, past 5:1 darkened). Two hues keep two kinds of thing
    // separable without a third surface.
    'accent-2': dark ? c.sapphire : mix('#000000', c.sapphire, 0.72),
    'accent-2-soft': dark ? c.surface0 : mix(c.sapphire, c.base, 0.12),
    // The colours an author writes by name: each flavour hue pulled partway
    // toward its own text colour, so `\textcolor{red}` reads as emphasis
    // rather than as an error signal. The dark-ground pull stays small (a
    // quarter) so the hue survives against near-white body text; emphasis
    // gets a second channel besides colour (slightly heavier run, underline
    // on hover for links).
    'emph-red': mix(c.red, c.text, dark ? 0.2 : 0.62),
    'emph-blue': mix(c.blue, c.text, dark ? 0.18 : 0.55),
    'emph-green': mix(c.green, c.text, dark ? 0.16 : 0.5),
    'emph-amber': mix(c.yellow, c.text, dark ? 0.12 : 0.42),
    'emph-violet': mix(c.mauve, c.text, dark ? 0.18 : 0.55),
    'emph-slate': mix(c.subtext1, c.text, dark ? 0.2 : 0.4),
    // elevation
    shadow,
    'copy-plate': dark ? 'rgb(255 255 255 / 0.13)' : 'rgb(255 255 255 / 0.86)',
    'tok-comment': c.overlay2,
    'tok-keyword': c.mauve,
    'tok-builtin': c.blue,
    'tok-function': c.sapphire,
    'tok-type': c.yellow,
    'tok-string': c.green,
    'tok-number': c.peach,
    'tok-tag': c.red,
    'tok-attr': c.pink,
    // type stacks, shared with the built-in palette so every palette carries
    // fonts and can be mixed with any layout.
    serif: WARM_PAPER.serif,
    sans: WARM_PAPER.sans,
    mono: WARM_PAPER.mono,
  };
}

// ---------------------------------------------------------------------------
// Catppuccin Latte (light)
// ---------------------------------------------------------------------------
// Latte's yellow (#df8e1d) is a mid-tone amber, not a pale tint, so it stays
// legible as an inline highlight on the light base and is used directly.
const LATTE = {
  text: '#4c4f69',
  subtext0: '#6c6f85',
  subtext1: '#5c5f77',
  overlay2: '#7c7f93',
  surface0: '#ccd0da',
  surface1: '#bcc0cc',
  base: '#eff1f5',
  mantle: '#e6e9ef',
  crust: '#dce0e8',
  lavender: '#7287fd',
  yellow: '#df8e1d',
  mauve: '#8839ef',
  blue: '#1e66f5',
  sapphire: '#209fb5',
  green: '#40a02b',
  peach: '#fe640b',
  red: '#d20f39',
  pink: '#ea76cb',
};

// ---------------------------------------------------------------------------
// Catppuccin Frappe (dark)
// ---------------------------------------------------------------------------
const FRAPPE = {
  text: '#c6d0f5',
  subtext0: '#a5adce',
  subtext1: '#b5bfe2',
  overlay2: '#949cbb',
  surface0: '#414559',
  surface1: '#51576d',
  base: '#303446',
  mantle: '#292c3c',
  crust: '#232634',
  lavender: '#babbf1',
  yellow: '#e5c890',
  mauve: '#ca9ee6',
  blue: '#8caaee',
  sapphire: '#85c1dc',
  green: '#a6d189',
  peach: '#ef9f76',
  red: '#e78284',
  pink: '#f4b8e4',
};

// ---------------------------------------------------------------------------
// Catppuccin Macchiato (dark)
// ---------------------------------------------------------------------------
const MACCHIATO = {
  text: '#cad3f5',
  subtext0: '#a5adcb',
  subtext1: '#b8c0e0',
  overlay2: '#939ab7',
  surface0: '#363a4f',
  surface1: '#494d64',
  base: '#24273a',
  mantle: '#1e2030',
  crust: '#181926',
  lavender: '#b7bdf8',
  yellow: '#eed49f',
  mauve: '#c6a0f6',
  blue: '#8aadf4',
  sapphire: '#7dc4e4',
  green: '#a6da95',
  peach: '#f5a97f',
  red: '#ed8796',
  pink: '#f5bde6',
};

// ---------------------------------------------------------------------------
// Catppuccin Mocha (dark)
// ---------------------------------------------------------------------------
const MOCHA = {
  text: '#cdd6f4',
  subtext0: '#a6adc8',
  subtext1: '#bac2de',
  overlay2: '#9399b2',
  surface0: '#313244',
  surface1: '#45475a',
  base: '#1e1e2e',
  mantle: '#181825',
  crust: '#11111b',
  lavender: '#b4befe',
  yellow: '#f9e2af',
  mauve: '#cba6f7',
  blue: '#89b4fa',
  sapphire: '#74c7ec',
  green: '#a6e3a1',
  peach: '#fab387',
  red: '#f38ba8',
  pink: '#f5c2e7',
};

/** All built-in palettes keyed by canonical name.
 *
 * Every entry passes through `deriveContrastTokens`, which re-derives the
 * surface and text ramps around the palette's own ground: `bg` itself is
 * never changed, only the levels around it.
 */
export const PALETTES = {
  /*
   * Slate leads the list, and it is the one the layouts default to: a cool
   * white ground, graphite ink, and the blue LaTeX ships in.
   */
  'slate': {
    label: 'Slate',
    dark: false,
    tokens: deriveContrastTokens({ ...SLATE }, { dark: false }),
  },
  'slate-dark': {
    label: 'Slate Dark',
    dark: true,
    tokens: deriveContrastTokens({ ...SLATE_DARK }, { dark: true }),
  },
  'warm-paper': {
    label: 'Warm Paper',
    dark: false,
    tokens: deriveContrastTokens({ ...WARM_PAPER }, { dark: false })
  },
  // WARM_PAPER_DARK carries no font stacks; they are added here so every
  // palette mixes with any layout.
  'warm-paper-dark': {
    label: 'Warm Paper Dark',
    dark: true,
    tokens: deriveContrastTokens({
      ...WARM_PAPER_DARK,
      serif: WARM_PAPER.serif,
      sans: WARM_PAPER.sans,
      mono: WARM_PAPER.mono,
    }, { dark: true }),
  },
  'catppuccin-latte': {
    label: 'Catppuccin Latte',
    dark: false,
    tokens: deriveContrastTokens(
      catppuccinTokens(LATTE, { dark: false }), { dark: false }),
  },
  'catppuccin-frappe': {
    label: 'Catppuccin Frappe',
    dark: true,
    tokens: deriveContrastTokens(
      catppuccinTokens(FRAPPE, { dark: true }), { dark: true }),
  },
  'catppuccin-macchiato': {
    label: 'Catppuccin Macchiato',
    dark: true,
    tokens: deriveContrastTokens(
      catppuccinTokens(MACCHIATO, { dark: true }), { dark: true }),
  },
  'catppuccin-mocha': {
    label: 'Catppuccin Mocha',
    dark: true,
    tokens: deriveContrastTokens(
      catppuccinTokens(MOCHA, { dark: true }), { dark: true }),
  },
};

// Loud failure beats a silently wrong colour: every registered palette must
// supply every token in the contract.
for (const [name, palette] of Object.entries(PALETTES)) {
  const missing = PALETTE_KEYS.filter((key) => palette.tokens[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`Palette "${name}" is missing tokens: ${missing.join(', ')}`);
  }
}

/** Canonical palette names, sorted. */
export const PALETTE_NAMES = Object.keys(PALETTES).sort();

/** Short forms and alternate spellings mapped to canonical names. */
const PALETTE_ALIASES = {
  latte: 'catppuccin-latte',
  frappe: 'catppuccin-frappe',
  macchiato: 'catppuccin-macchiato',
  mocha: 'catppuccin-mocha',
  paper: 'warm-paper',
  'paper-dark': 'warm-paper-dark',
};

/**
 * Resolve a palette name to its registry entry.
 *
 * Accepts the canonical name (`'catppuccin-mocha'`), the bare flavour
 * (`'mocha'`), and slash or dash separators (`'catppuccin/mocha'`).
 * Matching is case-insensitive.
 *
 * @param {string} name palette name or alias.
 * @returns {{label: string, dark: boolean, tokens: object}} the palette entry.
 * @throws {Error} if the name is unknown; the message lists valid names.
 */
export function resolvePalette(name) {
  const key = String(name).trim().toLowerCase().replaceAll('/', '-');
  const canonical = PALETTES[key] ? key : PALETTE_ALIASES[key];
  if (!canonical || !PALETTES[canonical]) {
    throw new Error(
      `Unknown palette "${name}". Valid palettes: ${PALETTE_NAMES.join(', ')}`
    );
  }
  return PALETTES[canonical];
}

/**
 * Check whether a name resolves to a registered palette, aliases included.
 *
 * @param {string} name palette name or alias.
 * @returns {boolean} true when {@link resolvePalette} would succeed.
 */
export function isPalette(name) {
  try {
    resolvePalette(name);
    return true;
  } catch {
    return false;
  }
}
