/**
 * The token contract.
 *
 * A **layout** owns structure and CSS; a **palette** owns colour and type.
 * Separate registries so they can be mixed freely: any layout with any
 * palette. Layout CSS hardcodes nothing a palette supplies. Every value below
 * is a real variable the stylesheets reference, so overriding any of them
 * changes the rendered page without touching the layout.
 */

/** Colour and font tokens a palette must supply. */
export const PALETTE_KEYS = [
  // surfaces
  'bg', 'bg-raised', 'bg-sunken', 'bg-tint',
  // text
  'ink', 'ink-soft', 'ink-faint',
  // rules
  'line', 'line-soft',
  // accent
  'accent', 'accent-soft', 'accent-ink',
  // inline highlight
  'mark',
  // a second accent, for the parts of the page the first one is already carrying
  'accent-2', 'accent-2-soft',
  // the colours an author writes by name
  //
  // What `\textcolor{red}{...}` and friends resolve to. Deliberately muted,
  // not saturated primaries: `red` asks for readable emphasis, not a signal.
  'emph-red', 'emph-blue', 'emph-green', 'emph-amber', 'emph-violet', 'emph-slate',
  // elevation
  'shadow',
  // syntax highlighting
  'tok-comment', 'tok-keyword', 'tok-builtin', 'tok-function', 'tok-type',
  'tok-string', 'tok-number', 'tok-tag', 'tok-attr',
  // the plate behind the copy glyph
  'copy-plate',
  // type stacks
  'serif', 'sans', 'mono',
];

/** Structural tokens a palette may override but normally inherits. */
export const LAYOUT_KEYS = [
  'measure', 'rail', 'gutter', 'bleed', 'masthead-h', 'hero-top', 'fig-zoom', 'eq-fit',
  // the masthead's own metrics (see chrome.js): present so a layout changes
  // the bar by naming a token rather than by copying the bar's rules.
  'bar-max', 'bar-gap', 'bar-bg', 'bar-type', 'wordmark-h',
  'radius', 'radius-sm',
  'step--1', 'step-0', 'step-1', 'step-2', 'step-3', 'step-4',
  'sp-1', 'sp-2', 'sp-3', 'sp-4', 'sp-5', 'sp-6', 'sp-7', 'sp-8',
];

/**
 * The built-in palette: the warm paper colours the `paper` layout shipped with,
 * lifted out of its CSS so it can now be mixed with any layout.
 */
export const WARM_PAPER = {
  bg: '#fbfaf7',
  'bg-raised': '#ffffff',
  'bg-sunken': '#f4f1ea',
  'bg-tint': '#f6f4ee',
  ink: '#1b1a17',
  'ink-soft': '#4a463f',
  // Set in captions, bylines, the current-page marker and figure small print
  // as well as body text, so it clears the WCAG 4.5:1 body-text floor.
  // #6b6558 measures 5.55:1 on this ground.
  'ink-faint': '#6b6558',
  // Quieter than the text but still visible as lines at arm's length.
  line: '#d7d0be',
  'line-soft': '#e3ddcd',
  // Same blue hue carried deep enough that a link in it reads as the accent,
  // not as a cooler grey. Measures past the 4.5:1 text floor.
  accent: '#2750bd',
  'accent-soft': '#e3ebfb',
  'accent-ink': '#1a3d8f',
  mark: '#fdf3c4',
  // A warm second accent against the first one's blue, carried deep for the
  // same reason: two kinds of thing stay separable without a third surface.
  'accent-2': '#8f4423',
  'accent-2-soft': '#f6e7de',
  // Muted rather than pure: emphasis, not an error signal.
  'emph-red': '#a83b33',
  'emph-blue': '#2750bd',
  'emph-green': '#2a6f4a',
  'emph-amber': '#96601c',
  'emph-violet': '#7a3f96',
  'emph-slate': '#5b6472',
  shadow: '0 1px 2px rgb(27 26 23 / 0.05), 0 8px 24px -14px rgb(27 26 23 / 0.28)',

  'copy-plate': 'rgb(255 255 255 / 0.86)',

  'tok-comment': '#8f897c',
  'tok-keyword': '#8f3fa8',
  'tok-builtin': '#2f5fd0',
  'tok-function': '#0f6a70',
  'tok-type': '#6b7a1c',
  'tok-string': '#1c7a52',
  'tok-number': '#b4531f',
  'tok-tag': '#b4531f',
  'tok-attr': '#8f3fa8',

  // Three stacks, each naming the platform's own best face first and then
  // descending by resemblance rather than by name. The serif is a text face
  // (large x-heights, open counters for a long measure); Charter and Source
  // Serif precede Georgia, whose old-style figures and wide sidebearings make
  // it the last resort before Times.
  serif: '"Iowan Old Style", Charter, "Bitstream Charter", "Palatino Linotype", Palatino,'
    + ' "Book Antiqua", "Source Serif 4", "Source Serif Pro", Georgia,'
    + ' "Times New Roman", "Liberation Serif", "Nimbus Roman", ui-serif, serif',
  // The sans is the chrome: masthead, contents, labels. System faces first,
  // already hinted for the display they are on.
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text",'
    + ' "Segoe UI", Inter, Roboto, "Helvetica Neue", "Noto Sans", Cantarell,'
    + ' "Liberation Sans", Arial, ui-sans-serif, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "JetBrains Mono",'
    + ' "Cascadia Code", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
};

/** The built-in dark counterpart, used when `prefers-color-scheme: dark`. */
export const WARM_PAPER_DARK = {
  bg: '#14151a',
  'bg-raised': '#1b1d23',
  'bg-sunken': '#101116',
  'bg-tint': '#1d1f26',
  ink: '#e9e7e3',
  'ink-soft': '#b6b2ab',
  'ink-faint': '#837e76',
  line: '#2b2e36',
  'line-soft': '#23252c',
  accent: '#7aa5ff',
  'accent-soft': '#1b2740',
  'accent-ink': '#a9c4ff',
  mark: '#403a1c',
  'accent-2': '#e0a07a',
  'accent-2-soft': '#2f2a2c',
  // Lighter and less saturated than the light palette's: on a dark ground the
  // same hue at the same strength reads as brighter, not as softer.
  'emph-red': '#e08b84',
  'emph-blue': '#8fb2f5',
  'emph-green': '#86c9a3',
  'emph-amber': '#dcb26a',
  'emph-violet': '#c4a0dc',
  'emph-slate': '#a7b0be',
  shadow: '0 1px 2px rgb(0 0 0 / 0.4), 0 10px 30px -16px rgb(0 0 0 / 0.8)',

  'copy-plate': 'rgb(255 255 255 / 0.13)',

  'tok-comment': '#6f6a60',
  'tok-keyword': '#d08ae0',
  'tok-builtin': '#7aa5ff',
  'tok-function': '#5fd0cf',
  'tok-type': '#b9d16a',
  'tok-string': '#7fd6a2',
  'tok-number': '#f0a97a',
  'tok-tag': '#f0a97a',
  'tok-attr': '#d08ae0',
};

/*
 * ---------------------------------------------------------------------------
 * Slate: the default. A cool ground, graphite ink, and the deep blue of a
 * LaTeX distribution. The second accent is a red: the complement of the blue
 * would blend toward olive wherever the two sit near each other, while a red
 * sits next to a blue and does nothing.
 *
 * Only the character is chosen here. `deriveContrastTokens` derives the
 * surfaces, walks each text level to its floor, and repairs the rules against
 * every surface they can land on.
 */

/** The three font stacks, shared by every built-in palette. */
export const FONT_STACKS = {
  serif: '"Iowan Old Style", Charter, "Bitstream Charter", "Palatino Linotype", Palatino,'
    + ' "Book Antiqua", "Source Serif 4", "Source Serif Pro", Georgia,'
    + ' "Times New Roman", "Liberation Serif", "Nimbus Roman", ui-serif, serif',
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text",'
    + ' "Segoe UI", Inter, Roboto, "Helvetica Neue", "Noto Sans", Cantarell,'
    + ' "Liberation Sans", Arial, ui-sans-serif, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "JetBrains Mono",'
    + ' "Cascadia Code", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
};

export const SLATE = {
  ...FONT_STACKS,
  bg: '#f6f6f6',
  'bg-raised': '#ffffff',
  'bg-sunken': '#ebebeb',
  'bg-tint': '#f1f1f1',
  ink: '#141414',
  'ink-soft': '#3f3f3f',
  'ink-faint': '#636363',
  line: '#c6c6c6',
  'line-soft': '#dedede',
  accent: '#0b4f9e',
  'accent-soft': '#e0eaf7',
  'accent-ink': '#073b7c',
  mark: '#e6effb',
  'accent-2': '#5a3fa8',
  'accent-2-soft': '#ece8f8',
  'emph-red': '#a4372f',
  'emph-blue': '#0b4f9e',
  'emph-green': '#256b4b',
  'emph-amber': '#8a5a12',
  'emph-violet': '#6d3b8c',
  'emph-slate': '#525c69',
  shadow: '0 1px 2px rgb(17 21 27 / 0.05), 0 8px 24px -14px rgb(17 21 27 / 0.26)',

  // The plate that appears behind the copy glyph on hover: white, and nearly so,
  // because the affordance should be felt before it is read.
  'copy-plate': 'rgb(255 255 255 / 0.86)',

  'tok-comment': '#767676',
  'tok-keyword': '#7c3aa0',
  'tok-builtin': '#0b4f9e',
  'tok-function': '#0d6a72',
  'tok-type': '#0b4f9e',
  'tok-string': '#1a6b4c',
  'tok-number': '#a8501c',
  'tok-tag': '#a8501c',
  'tok-attr': '#7c3aa0',
};

/** Slate on a dark ground: the same identity, at the other end of the ramp. */
export const SLATE_DARK = {
  ...FONT_STACKS,
  bg: '#1c1c1e',
  'bg-raised': '#181818',
  'bg-sunken': '#0a0a0a',
  'bg-tint': '#1c1c1c',
  ink: '#ededed',
  'ink-soft': '#b0b0b0',
  'ink-faint': '#858585',
  line: '#2e2e2e',
  'line-soft': '#242424',
  accent: '#79b0f0',
  'accent-soft': '#132640',
  'accent-ink': '#a3c8f6',
  mark: '#122a44',
  'accent-2': '#b0a2e8',
  'accent-2-soft': '#252238',
  'emph-red': '#e08b84',
  'emph-blue': '#79b0f0',
  'emph-green': '#7fc9a2',
  'emph-amber': '#d8b26c',
  'emph-violet': '#c4a0dc',
  'emph-slate': '#9aa5b1',
  shadow: '0 1px 2px rgb(0 0 0 / 0.4), 0 10px 30px -16px rgb(0 0 0 / 0.8)',

  'copy-plate': 'rgb(255 255 255 / 0.13)',

  'tok-comment': '#767676',
  'tok-keyword': '#d3a2e0',
  'tok-builtin': '#79b0f0',
  'tok-function': '#5fcfd0',
  'tok-type': '#79b0f0',
  'tok-string': '#7ed3a3',
  'tok-number': '#eda878',
  'tok-tag': '#eda878',
  'tok-attr': '#d3a2e0',
};

/** Structural defaults, shared by every layout unless it overrides them. */
export const BASE_LAYOUT = {
  // A fixed measure: the type scale steps at breakpoints (see below), so
  // nothing re-wraps while the window is dragged.
  measure: '36rem',
  rail: 'clamp(13rem, 13vw, 18rem)',
  gutter: 'clamp(1.1rem, 4vw, 3rem)',
  // How far a figure, table or listing may reach past the measure: the
  // leftover of a wide monitor, given to things limited by the measure rather
  // than helped by it. Zero until 64rem and growing continuously, so no width
  // rearranges the page; the subtraction keeps it at zero on a phone, where
  // any bleed would overflow the gutter into a horizontal scroll.
  bleed: 'clamp(0rem, calc((100vw - 64rem) * 0.19), 7rem)',
  // The masthead's height. The narrow-screen contents strip sticks directly
  // below the bar, so the two must agree: this is kept equal to the shared
  // bar's own height (the fallback when that block is absent).
  'masthead-h': '3.2rem',
  // A figure's own `scale=`, published per figure so the stylesheet can bound
  // what the reader sees rather than what the box measures. See render.js.
  'fig-zoom': '1',
  // The factor a display equation was shrunk by to fit the column. Written per
  // equation by the fitter in `fit-equations.js`; declared here so a stylesheet
  // that reads it is reading something that exists.
  'eq-fit': '1',
  // How far down its first screen a landing page sets its wordmark. See
  // themes/landing.css for why it is not zero.
  'hero-top': '0rem',
  radius: '10px',
  'radius-sm': '6px',
  // A type scale in fixed steps, not a fluid one: with a `vw` term every
  // window-edge drag would re-wrap the whole document each frame. The scale
  // steps at breakpoints instead, and between them nothing moves. Ratios are
  // a minor third rounded to sixteenths of a rem, landing on whole pixels at
  // the default size.
  'step--1': '0.8125rem',
  'step-0': '1.0625rem',
  'step-1': '1.1875rem',
  'step-2': '1.4375rem',
  'step-3': '1.8125rem',
  'step-4': '2.375rem',
  'sp-1': '0.25rem',
  'sp-2': '0.5rem',
  'sp-3': '0.75rem',
  'sp-4': '1rem',
  'sp-5': '1.5rem',
  'sp-6': '2rem',
  'sp-7': '3rem',
  'sp-8': '4.5rem',
};

/** Deep merge that treats plain objects only; arrays and scalars replace. */
export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

export const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Renders a token map as CSS custom properties. Values containing `;` or `}`
 * are still emitted verbatim because `shadow` legitimately does, so the caller
 * is responsible for not putting hostile content in a config.
 */
export function tokensToCss(tokens, indent = '  ') {
  return Object.entries(tokens)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${indent}--${k}: ${v};`)
    .join('\n');
}

/** Reports unknown token keys so typos surface instead of being ignored. */
export function unknownTokens(tokens, known = PALETTE_KEYS) {
  return Object.keys(tokens || {}).filter((k) => !known.includes(k));
}
