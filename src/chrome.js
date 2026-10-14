/**
 * The masthead.
 *
 * One bar, written once: earlier each theme carried its own copy and the
 * copies drifted (three heights and two wordmark sizes for the same bar).
 * Every number in the shared block is a custom property, so a layout that
 * genuinely needs a different bar changes a token and one that does not
 * cannot drift. `stripChrome` removes the per-layout copies.
 */

/** Selectors that belong here and nowhere else. */
const CHROME_SELECTOR = /(^|[\s,>+~])(?:\.masthead(?:-inner)?\b|a\.wordmark\b|\.wordmark-svg\b|\.doc-nav\b|\.doc-link\b|\.icon-link\b|\.drop\b|\.drop-toggle\b|\.drop-menu\b|\.drop-link\b|\.theme-toggle\b)/;

/**
 * Selectors that merely mention a chrome class and are none of its business.
 *
 * The hero draws the same mark large as the subject of the front page (own
 * size, own centring); matching it on the shared class name would strip it.
 * Excluded here so the stripper only removes the bar's own rules.
 */
const NOT_CHROME = /\.hero\b|\.doc-title-mark\b|\.doc-header\b|\.doc-title\b/;

/**
 * The shared bar.
 *
 * Sizing is driven entirely by tokens so that nothing here needs an override:
 *
 * - `--masthead-h`  the bar's height, and the offset every anchored heading
 *                   scrolls to. One value, so the bar and the scroll gap cannot
 *                   disagree.
 * - `--bar-max`     how wide the bar runs, and `--bar-pad` how far in from the edge
 *                   its contents sit. Both are one value for every layout, so the
 *                   wordmark lands in the same place on every page.
 * - `--bar-gap`     the gap between the wordmark and the nav.
 * - `--wordmark-h`  the height of the mark. The hero draws the same mark at its
 *                   own size and scales from the same geometry.
 * - `--bar-type`    the type in the bar. A single size for plain links and
 *                   dropdowns alike.
 */
export const MASTHEAD_CSS = `/* ------------------------------------------------------------------------
   The masthead. Shared by every layout -- see chrome.js.

   One of these because there is one bar: the geometry is tokens and the rest
   is here, once, rather than restated per theme. */

/*
 * The bar's own metrics.
 *
 * A plain \':root\', not \':root:root\', and that is deliberate. The palette and the layout's own tokens are emitted into a \':root\' block *after* this one, at the same specificity, so source order decides -- which is what lets a layout override a single number here by naming a token, without having to know that it has to out-specify this file to do it. Doubling the pseudo-class would win the argument every time and quietly make the tokens decorative.
 */
/*
 * box-sizing for the whole page.
 *
 * This is normally the first line of a layout, and it was the first line of exactly one of them. Everywhere else a max-width measures the CONTENT, so the bar's own padding was added on top of it: with --bar-max at 72rem and 3rem of padding the bar came out 1248px wide on the papers and 1152px on the front page, which put the wordmark at 144 on three pages and 192 on the fourth -- the same bar, 48px out, because one stylesheet had a line the others did not.
 */
*, *::before, *::after { box-sizing: border-box; }

:root {
  --masthead-h: 3.2rem;
  --bar-gap: 1rem;
  --wordmark-h: 1.75rem;
  /*
   * Big enough to read without effort. The bar was carrying 0.85em of its own 0.85em, so the labels came out at about 12px in a 19px face -- the smallest thing on the page, in the place the eye goes first. It is also the size every entry now shares: "Examples" and "Docs" sat next to each other in the same row two pixels apart, because the dropdown trigger had a size of its own and the plain link inherited a different one.
   */
  --bar-type: 0.95rem;
  --bar-bg: 84%;
  /*
   * One width and one inset for the whole site.
   *
   * Neither value is derived from the layout. A navigation bar is chrome. It does not belong to a document, so it does not take the document's measure, and the padding is its own rather than the document's gutter -- otherwise a layout that wants a narrower page moves the site menu sideways.
   */
  --bar-max: 72rem;
  --bar-pad: 3rem;
}

.masthead {
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) var(--bar-bg), transparent);
  backdrop-filter: saturate(180%) blur(12px);
  position: sticky; top: 0; z-index: 20;
}

.masthead-inner {
  max-width: var(--bar-max);
  margin-inline: auto;
  min-width: 0;
  /*
   * No vertical padding on the bar. The bar's height comes from \'masthead-h\', so that the dropdown trigger is exactly as tall as the bar and \'top: 100%\' on its menu is the bar's own lower edge -- the menu hangs from the rule rather than from the middle of the text. The things inside it carry their own vertical padding instead.
   */
  padding-inline: min(var(--bar-pad), 4vw);
  min-height: calc(var(--masthead-h) * 1.18);
  display: flex; align-items: stretch; gap: var(--bar-gap);
}

/*
 * ---- the mark
 *
 * Drawn rather than written, so it has no link colour, no underline and no visited state to fight: it is simply the logo, and the link is invisible. The name is on the \'<a>\' as \'aria-label\' and the SVG is \'aria-hidden\', because an SVG carries no text for a screen reader to read.
 *
 * Both dimensions are set explicitly and the ratio is stated, so it scales from its own geometry rather than from whichever attribute the browser picks. An SVG that carries \'width\' and \'height\' attributes will otherwise come out at the attribute's size no matter what the CSS asks for.
 */
a.wordmark {
  display: inline-flex; align-items: center;
  text-decoration: none; color: inherit; border-radius: var(--radius-sm);
}
a.wordmark:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.masthead-inner > a.wordmark { display: flex; align-items: center; flex: 0 0 auto; }
.wordmark-svg {
  display: block; height: var(--wordmark-h); width: auto; overflow: visible;
}
.wordmark-svg .wordmark-lambda { fill: var(--accent); }
.wordmark-svg .wordmark-rest { fill: var(--ink); }
.wordmark-svg .wordmark-dim { fill: var(--ink-faint); }
a.wordmark:hover .wordmark-rest { fill: var(--accent-ink); }
a.wordmark:hover .wordmark-dim { fill: var(--accent); }

/*
 * ---- the entries
 *
 * One size, one weight, one colour for everything in the bar. "Examples" and "Docs" are two places you can go from the same row, and they were set two pixels and two shades apart, which reads as one of them being switched off.
 */
.doc-nav {
  display: flex; align-items: stretch; gap: var(--sp-4);
  /*
   * Never wraps. The bar grew when the type in it grew, and with \'nowrap\' removed the second entry fell to a line of its own and sat above the bar's own top edge -- a nav item half off the top of the page.
   */
  flex-wrap: nowrap; white-space: nowrap;
  margin-left: auto; min-width: 0;
  font-family: var(--sans); font-size: var(--bar-type);
  line-height: 1.25;
}
/*
 * A plain link in the bar is a flex box, not a block.
 *
 * The bar stretches its children so that a dropdown trigger fills the bar's height. A plain link is not a flex container, so stretched to the same height its text stayed on the first line and "Docs" sat at the top of the bar, half above the page, while the dropdown next to it was centred.
 */
.doc-nav > .doc-link { display: flex; align-items: center; }

.doc-link {
  color: var(--ink-soft); text-decoration: none;
  border-bottom: 1px solid transparent;
}
.doc-link:hover { color: var(--ink); }
.doc-link.is-current { color: var(--ink); border-bottom-color: var(--accent); }

.icon-link {
  color: var(--ink-faint); display: inline-flex; align-items: center;
  padding: 0.2rem; border-radius: var(--radius-sm);
}
/*
 * A colour, and no box.
 *
 * The GitHub mark is the one entry in the bar that is an icon rather than a word, and it is the only one whose shape already says "this goes somewhere". A background plate behind it therefore added a second, rectangular "this goes somewhere" on top of the first -- and a rectangle is the shape every other clickable thing on the page has, so the one item that needed no affordance was the one wearing the loudest. It also made the mark jump: the plate changed the element's box, and the bar lays its entries out with 'align-items: stretch'.
 */
.icon-link:hover { color: var(--ink); }

/*
 * ---- the dropdown
 *
 * The options join the bar instead of hanging below it. They sit in the empty run between the wordmark and the trigger, on the bar's own baseline, separated by rules the way a row of links is, with no border and no shadow because there is no box: the thing that was added to the bar is part of the bar. A masthead is one line high, and a panel under it is a popup -- it covers the page, it has to be dismissed, and its items are lines where the bar has room for one.
 */
.drop { position: relative; display: flex; align-items: stretch; }
.drop-toggle {
  font: inherit; font-family: var(--sans); font-size: var(--bar-type);
  font-weight: inherit; letter-spacing: inherit;
  /*
   * The underline is on both entries and neither states a weight.
   *
   * A plain link carries a 1px transparent underline so it can show one when it
   * is the current page, and that border is part of its box: centred, the box is a
   * pixel taller at the bottom and the text rides half a pixel up. The trigger
   * must state the same font-weight the link inherits, or the two words are not
   * the same width and the bar is visibly out of true.
   */
  /*
   * The trigger gets a box of its own.
   *
   * It is not padding for padding's sake. The menu hangs off this button's right edge, so that edge is where the menu begins, and the two have to read as distinct objects or the menu looks attached to nothing.
   */
  background: none; padding: 0.15rem 0.3rem; margin: 0;
  border: 0; border-bottom: 1px solid transparent;
  cursor: pointer; color: var(--ink-soft);
  line-height: 1.25;
  display: flex; align-items: center;
}
.drop-toggle:hover, .drop:focus-within .drop-toggle { color: var(--ink); }

/*
 * The arrow, on the leading side, pointing where the options are, and it turns.
 *
 * A triangle drawn with 'border-right', so it points left -- which is where the options arrive, in the empty run between the wordmark and the trigger.
 *
 * It turns a half rotation when the menu opens, so it points back the way it came. That is the state a reader is being given: the arrow now faces the way it will take them back, which is the same signal a disclosure triangle gives by turning on every site, and it is the only state change the control needs to carry.
 *
 * The half turn is the correct one here and the quarter is not. A quarter anticlockwise takes the arrow from left to down, which is the reading of a disclosure that expands downwards -- and this one expands sideways, in the same line as the bar.
 *
 * The narrow-screen query below turns it to point *down* instead, because down there the menu really does drop below the bar. It does not flip: a control that reports two states and a control whose glyph reports the geometry are two different jobs, and on a phone where the menu is always below the trigger there is only ever one position to point at.
 */
.drop-toggle::before {
  content: ""; display: inline-block;
  width: 0; height: 0;
  margin-right: 0.45rem;
  border-top: 0.32rem solid transparent;
  border-bottom: 0.32rem solid transparent;
  border-right: 0.44rem solid currentColor;
  opacity: 0.55;
  transition: transform 0.16s ease, opacity 0.16s ease;
}
.drop:hover .drop-toggle::before,
.drop:focus-within .drop-toggle::before,
.drop[data-open="true"] .drop-toggle::before {
  transform: rotate(180deg);
  opacity: 0.9;
}

.drop-menu {
  position: absolute; right: calc(100% + 0.6rem); top: 0; z-index: 30;
  height: 100%;
  display: flex; align-items: center;
  padding-inline: 0.15rem;
  opacity: 0; visibility: hidden; transform: translateX(0.4rem);
  transition: opacity 0.13s ease, transform 0.13s ease, visibility 0.13s;
}
.drop:hover .drop-menu,
.drop:focus-within .drop-menu,
.drop[data-open="true"] .drop-menu {
  opacity: 1; visibility: visible; transform: translateX(0);
}

/*
 * Options in a row, divided the way a row of links is divided. The rule belongs between two options, never before the first.
 *
 * Square, deliberately. A 'border-left' on a box with a 'border-radius' is not a straight line: the browser draws that side along the rounded corner, so the divider between two options came out as a bracket -- a "(" between each pair, curving away from a rule that is meant to be a rule. The corners were squared on the second and third options only, to square the rule where it met the ends of the row, which left the first option's plate rounded and the other two's square: the first entry in the menu looked like a different control from the other two.
 *
 * All three square is the answer to both. The dividers are straight, and the hover plate is the same rectangle on every option, which is what a row of peer controls should be.
 */
.drop-link {
  display: flex; align-items: center;
  padding: 0.35rem 0.7rem;
  border-radius: 0;
  font-family: var(--sans); font-size: var(--bar-type); font-weight: 500;
  line-height: 1.25;
  text-decoration: none; color: var(--ink-soft);
  white-space: nowrap;
}
.drop-link + .drop-link { border-left: 1px solid var(--line); }
.drop-link:hover, .drop-link:focus-visible { background: var(--accent-soft); color: var(--accent-ink); }

@media (prefers-reduced-motion: reduce) {
  .drop-menu, .drop-toggle::before { transition: none; }
}

/*
 * ---- the code block
 *
 * A label, the code, and a mark in the corner. Nothing else.
 *
 * The bar is a label row, not a box: a tinted strip with a border and uppercase
 * letters tells a reader the block is shell, which is not a thing they need to be
 * told. One box for the code, one line of padding.
 *
 * The control is a bare glyph at the bottom right of the code, out of the way of
 * the text and in the corner the eye already goes to look for it. It is not a
 * button until it is wanted: no border, no fill, no radius, nothing that says
 * "widget". Hovering puts a faint white plate behind it, which is the whole
 * affordance -- present on approach, absent otherwise, and never covering code.
 */
.doc .code-block figcaption.code-bar,
.code-block figcaption.code-bar {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 0.1rem var(--sp-3);
  background: none;
  border-bottom: 1px solid var(--line-soft);
  font-family: var(--mono); font-size: 0.6rem; font-weight: 400;
  letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--ink-faint);
}
.code-lang {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.code-block { position: relative; }
.copy {
  position: absolute; right: 0; bottom: 0;
  display: inline-flex; align-items: center;
  padding: 0.22rem;
  font-size: 0.7rem; line-height: 1;
  color: var(--ink-faint);
  background: none;
  border: 0; border-radius: 0;
  cursor: pointer;
  /*
   * No 'opacity: 0'. It used to appear on hover, which is a convention for a
   * control that is a convenience and it is wrong here: on a touch screen there
   * is no hover, so the control that copies the code was simply absent on the
   * machine most readers are on. It is a bare glyph now -- faint, small, and in
   * the corner -- and the plate below is what appears on approach.
   */
  opacity: 1;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.copy:hover,
.copy:focus-visible {
  color: var(--ink);
  background: var(--copy-plate);
}
.copy:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
/*
 * Two squares shut, a tick while it is done, and the colour says so too.
 *
 * Both marks are always in the DOM and the state picks one. The colour is the second signal, not the first: a reader who cannot tell green from grey still sees the glyph change.
 */
.copy svg { display: block; flex: 0 0 auto; }
.copy .icon-check { display: none; }
.copy[data-state="ok"] .icon-copy,
.copy[data-state="bad"] .icon-copy { display: none; }
.copy[data-state="ok"] .icon-check,
.copy[data-state="bad"] .icon-check { display: block; }
.copy[data-state="ok"] { color: var(--emph-green); }
.copy[data-state="bad"] { color: var(--emph-red); }

/* ------------------------------------------------------------------ footer
   The mark and one sentence about what this is on the left, the places there are
   to go in columns, and the colophon kept below a rule at the size of a note. */

.site-footer {
  grid-column: 1 / -1;
  /*
   * No row here on purpose. The row after the article is different in every layout -- the landing page puts the article in row two and everything else in row three -- so each layout states its own, and this block is appended after them all. A row named here would win over every one of them and put the footer back on top of the article.
   */
  margin-top: var(--sp-8);
  padding-top: var(--sp-6);
  border-top: 1px solid var(--line);
  /*
   * Flex, not grid. 'repeat(auto-fit, minmax(8rem, max-content))' after a '1fr' collapses to one track -- auto-fit needs a definite free space to divide, and a '1fr' next to it leaves none -- so all three columns stacked in a single column beside the lead. The lead takes the slack and the columns are as wide as their longest label, which flex does without being told.
   */
  display: flex; flex-wrap: wrap;
  gap: var(--sp-6) var(--sp-7);
  align-items: flex-start;
  font-family: var(--sans);
}
.footer-lead { flex: 1 1 16rem; max-width: 26rem; }
.footer-cols { display: flex; flex-wrap: wrap; gap: var(--sp-6) var(--sp-7); }
.footer-col { flex: 0 0 auto; min-width: 7.5rem; }
/*
 * The mark again, at the masthead's own size. It is the same drawing at a smaller scale, so it links home the same way it does in the bar -- and a footer that used a *different* logo would be a second brand on one page.
 */
.footer-mark { display: inline-flex; text-decoration: none; border-radius: var(--radius-sm); }
.footer-mark:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.footer-mark-svg { display: block; height: 1.5rem; width: auto; overflow: visible; }
.footer-tagline {
  margin: var(--sp-3) 0 0;
  font-size: 0.9em; line-height: 1.55; color: var(--ink-faint);
  text-wrap: pretty;
}
.footer-head {
  font-size: 0.7rem; font-weight: 700;
  letter-spacing: 0.13em; text-transform: uppercase;
  color: var(--ink-faint);
  /*
   * A section heading in the footer is a label, not a section: it must not be numbered, and it must not carry the rule the document's own headings carry.
   */
  padding: 0; border: 0;
  margin: 0 0 var(--sp-3);
}
.footer-links { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-2); }
.footer-links a {
  color: var(--ink-soft); text-decoration: none;
  font-size: 0.9em; line-height: 1.4;
  border-bottom: 1px solid transparent;
}
.footer-links a:hover { color: var(--accent-ink); border-bottom-color: var(--accent); }
.footer-fine {
  flex: 1 0 100%;
  margin: 0; padding-top: var(--sp-4);
  border-top: 1px solid var(--line-soft);
  font-size: 0.82em; color: var(--ink-faint);
}
.footer-fine code {
  font-family: var(--mono); font-size: 0.92em;
  background: var(--bg-sunken); border-radius: 4px; padding: 0.05em 0.3em;
}
.footer-fine .sep { opacity: 0.45; margin-inline: 0.3em; }

@media (max-width: 52rem) {
  /*
   * The lead takes a whole row and the columns go under it.
   *
   * The two sat side by side down to 46rem, which is 49px too wide at 820: the lead's 16rem basis plus three columns at 7.5rem each and two gaps came to more than the shell, and the row did not wrap -- it overflowed, and the page scrolled sideways. 52rem is where the two together stop fitting.
   */
  .footer-lead { flex: 1 0 100%; max-width: none; }
  .footer-cols { flex: 1 0 100%; gap: var(--sp-5) var(--sp-6); }
}
@media (max-width: 46rem) {
  .footer-col { flex: 1 1 8rem; min-width: 0; }
}

/* Printed, a footer is a colophon and nothing else. */
@media print { .site-footer { display: none; } }

/*
 * Its own row, stated per layout -- auto-placement gave it the row the editorial notice occupies on a page that has one, and the two boxes were laid on top of each other with both sets of text legible. See each layout's row rules.
 */
@media (max-width: 40rem) {
  /*
   * No hover on a phone, so the button is the whole mechanism -- it toggles data-open -- and the menu is pinned to the display, because a menu as wide as its longest label is as wide as it needs to be.
   */
  .drop-menu {
    position: fixed; left: var(--gutter); right: var(--gutter);
    top: calc(var(--masthead-h) * 1.18); height: auto;
    flex-wrap: wrap; justify-content: center; gap: var(--sp-1);
    padding: var(--sp-2) 0;
    background: var(--bg); border-top: 1px solid var(--line-soft);
    transform: translateY(-0.3rem);
  }
  /*
   * Down, because down here the menu really does drop below the bar.
   *
   * The wide layout opens sideways and the arrow points left; this one opens downward and the arrow points down. Only the borders change; the margin, the opacity and the absence of a flip stay put, so the label does not move and the control does not report a state the geometry does not have.
   */
  .drop-toggle::before {
    border-top: 0.44rem solid currentColor;
    border-right: 0.32rem solid transparent;
    border-left: 0.32rem solid transparent;
    border-bottom: 0;
  }
  .drop-link { white-space: normal; padding: 0.3rem 0.55rem; }
  .drop-link + .drop-link { border-left: 0; }
  .drop-link + .drop-link::before {
    content: "|"; margin-right: 0.55rem; color: var(--ink-faint); opacity: 0.6;
  }
}
`;

/** Tokens a layout sets when its bar is genuinely not the default one. */

export const CHROME_TOKEN_KEYS = [
  'bar-gap', 'bar-max', 'bar-bg', 'bar-type', 'wordmark-h'
];

/**
 * Joins a selector list that was written one selector per line.
 *
 * `stripChrome` recognises a rule by a single line that opens a block, so a
 * multi-line selector list would leave orphan selector lines behind -- and two
 * such lists in a row can chain into the rule that follows and invalidate it.
 * Coalescing first means CHROME_SELECTOR is tested against the whole list, so
 * the list is removed whole. The test is textual and narrow: two or more
 * comma-terminated lines followed by a line that opens a block. A multi-line
 * *declaration* ends in a semicolon, not a brace, so it is never a candidate.
 */
function coalesceSelectors(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // A comma-terminated run is a selector list; the line the run stops on is
    // its terminator, which opens the block.
    let j = i;
    while (j < lines.length && lines[j].trim().endsWith(',')) j++;
    const terminator = lines[j];
    // The terminator opens a block (a single-line rule still counts).
    const opensABlock = terminator !== undefined && terminator.includes('{');
    if (j > i && opensABlock) {
      out.push(lines.slice(i, j + 1).join(' ').replace(/[ \t]{2,}/g, ' '));
      i = j;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

export function stripChrome(css) {
  const lines = coalesceSelectors(css.split('\n'));
  const out = [];
  /** Comment lines held back, so they can be dropped with the rule they precede. */
  let held = [];

  const flush = () => { out.push(...held); held = []; };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*\/\*/.test(line)) { held.push(line); i++; continue; }
    if (held.length && /^\s*(?:\*|\/\*)/.test(line)) { held.push(line); i++; continue; }
    if (/^\s*\}/.test(line)) { flush(); out.push(line); i++; continue; }

    // `@media print`, `@keyframes` and anything else copied through whole.
    if (/^@(?:media\s+print|keyframes|font-face|supports|page)\b/.test(line)) {
      flush();
      const end = blockEnd(lines, i);
      out.push(...lines.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    if (/^@media\b/.test(line)) {
      const end = blockEnd(lines, i);
      const inner = stripChrome(lines.slice(i + 1, end).join('\n'))
        .split('\n')
        .filter((l) => l.trim());
      // A query left with no rules of its own is dropped with them.
      if (inner.some((l) => l.includes('{'))) {
        flush();
        out.push(line, ...inner, '}');
      }
      i = end + 1;
      continue;
    }

    const isRule = /^[^{}@/*]+\{.*$/.test(line);
    if (isRule) {
      const end = line.includes('}') ? i : blockEnd(lines, i);
      if (CHROME_SELECTOR.test(line) && !NOT_CHROME.test(line)) {
        i = end + 1;
        continue;
      }
      flush();
      out.push(...lines.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    flush();
    out.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

/** The index of the `}` that closes the block opened at `start`. */
function blockEnd(lines, start) {
  let depth = 0;
  for (let k = start; k < lines.length; k++) {
    depth += (lines[k].match(/\{/g) || []).length;
    depth -= (lines[k].match(/\}/g) || []).length;
    if (depth <= 0 && k >= start && lines[k].includes('}')) return k;
  }
  return lines.length - 1;
}
