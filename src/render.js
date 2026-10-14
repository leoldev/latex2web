/**
 * AST -> HTML.
 *
 * Math is rendered at build time with KaTeX when it is installed, so the
 * emitted pages need no JavaScript and print correctly. Without KaTeX the
 * renderer degrades to marked-up source rather than losing the formula.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

import { highlight, normalizeLang } from './highlight.js';
import { expandMacros } from './macros.js';
import { parseInlineText } from './parse.js';

let katexModule = null;
let katexTried = false;
let mhchemTried = false;

function getKatex() {
  if (katexTried) return katexModule;
  katexTried = true;
  try {
    katexModule = require('katex');
  } catch {
    katexModule = null;
  }
  return katexModule;
}

/**
 * KaTeX ships chemistry as an opt-in extension that registers `\ce` and `\pu`
 * as macros when it is loaded. Requiring it costs a few hundred kB of parse
 * time, so it is loaded only if the document actually mentions chemistry.
 */
function loadMhchem(katex) {
  if (!katex || mhchemTried) return katex;
  mhchemTried = true;
  try {
    require('katex/dist/contrib/mhchem.js');
  } catch {
    // an older or trimmed KaTeX: chemistry simply stays unsupported
  }
  return katex;
}

const USES_MHCHEM = /\\(?:ce|pu)\s*\{/;

export function katexAssets() {
  const katex = getKatex();
  if (!katex) return null;
  const pkg = require('katex/package.json');
  const dist = path.join(path.dirname(require.resolve('katex/package.json')), 'dist');
  return {
    version: pkg.version,
    css: path.join(dist, 'katex.min.css'),
    fonts: path.join(dist, 'fonts'),
    fontCss: path.join(dist, 'katex.min.css'),
  };
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);

/** Applies LaTeX's typographic conventions to a run of plain text. */
function smartText(value) {
  return value
    .replace(/---/g, '\u2014')
    .replace(/--/g, '\u2013')
    .replace(/``/g, '\u201c')
    .replace(/''/g, '\u201d')
    .replace(/~/g, '&nbsp;');
}

function renderText(raw) {
  return smartText(escapeHtml(raw));
}

// ------------------------------------------------------------------ renderer

export function renderInline(nodes, ctx = {}) {
  let out = '';
  for (const node of nodes || []) out += renderInlineNode(node, ctx);
  return out;
}

function renderInlineNode(node, ctx) {
  switch (node.type) {
    case 'text': return renderText(node.value);
    case 'strong': return `<strong>${renderInline(node.nodes, ctx)}</strong>`;
    case 'em': return `<em>${renderInline(node.nodes, ctx)}</em>`;
    case 'u': return `<u>${renderInline(node.nodes, ctx)}</u>`;
    case 'span': {
      if (!node.color) return `<span>${renderInline(node.nodes, ctx)}</span>`;
      return `<span style="color:${escapeHtml(colourValue(node.color))}">`
        + `${renderInline(node.nodes, ctx)}</span>`;
    }
    case 'smallcaps': return `<span class="sc">${renderInline(node.nodes, ctx)}</span>`;
    case 'code':
      // `\verb` content is literal; `\texttt{...}` content is markup
      return node.verbatim !== undefined
        ? `<code>${escapeHtml(node.verbatim)}</code>`
        : `<code>${renderInline(node.nodes, ctx)}</code>`;
    case 'break': return '<br>';
    case 'cite': return `<span class="cite">${escapeHtml(node.text ?? '')}</span>`;
    case 'citeref': {
      // A citation marker sits above the line, as in print. The separator
      // joins markers rather than trailing each one.
      const sep = node.textual ? ' ' : ', ';
      const parts = node.nodes.map((n) => renderInlineNode(n, ctx));
      return `<span class="citeref">${parts.join(sep)}</span>`;
    }
    case 'link': {
      if (node.tooltip) {
        // Not an `<a>`: a tooltip goes nowhere, and an anchor with no href is
        // not focusable. A focusable span with `title` reaches keyboard
        // readers and still gets the bubble from the theme.
        return `<span class="tooltip" tabindex="0" role="note" title="${escapeHtml(node.tooltip)}">`
          + `${renderInline(node.nodes, ctx)}<span class="tip-bubble" aria-hidden="true">${
            escapeHtml(node.tooltip)}</span></span>`;
      }
      const cls = `link${node.external ? ' link-external' : ''}${node.broken ? ' link-broken' : ''}`;
      const attrs = node.external
        ? ` href="${escapeHtml(node.href)}" target="_blank" rel="noopener noreferrer"`
        : ` href="${escapeHtml(node.href || '#')}"`;
      return `<a class="${cls}"${attrs}>${renderInline(node.nodes, ctx)}</a>`;
    }
    case 'footnote': {
      ctx.footnotes = ctx.footnotes || [];
      const n = ctx.footnotes.push(renderInline(node.nodes, ctx)) ;
      return `<sup class="fnref"><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
    }
    case 'image': {
      const src = ctx.assetUrl ? ctx.assetUrl(node.src) : node.src;
      if (ctx.missingImages?.has(node.src)) {
        return `<span class="missing-asset" role="img" aria-label="missing image">`
          + `<span class="missing-asset-name">${escapeHtml(node.src)}</span></span>`;
      }
      const o = node.srcOpts || {};
      const width = latexLengthToCss(o.width);
      // `scale` multiplies the picture's natural size; it is not a width (see
      // renderImage). Inside a multi-column figure the size is the column's
      // business, so nothing is emitted and the columns match.
      const inColumn = ctx.inFloatColumn;
      const style = [
        width && !inColumn ? `width:${width}` : null,
        o.scale && !width && !inColumn ? `zoom:${Number(o.scale)};--fig-zoom:${Number(o.scale)}` : null,
        inColumn ? 'width:auto;max-width:100%' : null,
      ].filter(Boolean).join(';');
      return `<img class="inline-img" src="${escapeHtml(src)}" alt="${escapeHtml(node.src)}"`
        + ` loading="lazy" decoding="async"${style ? ` style="${escapeHtml(style)}"` : ''}>`;
    }
    case 'math': return renderMath(node.tex, node.display, ctx);
    case 'codeblock': return `<code>${escapeHtml(node.tex)}</code>`;
    default: return node.nodes ? renderInline(node.nodes, ctx) : '';
  }
}

/** The braced group starting at `j`, or null if there is not one. */
function groupIn(s, j) {
  if (s[j] !== '{') return null;
  let depth = 1;
  let k = j + 1;
  while (k < s.length && depth > 0) {
    if (s[k] === '\\') { k += 2; continue; }
    if (s[k] === '{') depth++;
    else if (s[k] === '}') depth--;
    k++;
  }
  return { text: s.slice(j + 1, k - 1), next: k };
}

/**
 * A colour as CSS.
 *
 * Named colours go through the palette (a theme retunes `red` without the
 * converter second-guessing the author); anything else passes through as
 * written.
 */
function colourValue(c) {
  const name = String(c || '').trim();
  // `grey`, `gray` and `color` are names no author means literally here;
  // they map onto the one token that is about being muted.
  const alias = { grey: 'slate', gray: 'slate' };
  const key = alias[name.toLowerCase()] || name.toLowerCase();
  return /^[a-z]+$/i.test(name) ? `var(--emph-${key}, ${name})` : name;
}

/**
 * The handful of maths idioms KaTeX spells differently from LaTeX.
 *
 * A single left-to-right pass, dispatched on the argument's *shape* (a
 * one-character argument, or a brace holding one character) rather than a
 * chain of substitutions: chained patterns fire in order (so each depends on
 * the ones before it), miss nested groups, and match accent letter-forms by
 * name alone -- but `\v` is a vector, `\t` a tie and `\b` a bold accent, so
 * name-matching rewrites mathematics.
 */
function normaliseMath(tex) {
  const src = String(tex);
  let out = '';
  let i = 0;

  /** The LaTeX accent KaTeX has, or the character where it has none. */
  const accented = (name, letter) => {
    const macro = ACCENT_MACROS[name];
    if (macro && (macro[1] || true)) return `${macro[0]}{${letter}}`;
    return ACCENT_CHARS[name]?.[letter] || letter;
  };

  /**
   * A word in roman type, with any accents taken *outside* the text run.
   *
   * `\text{}` is text mode, where `\ddot` does not exist; and KaTeX normalises
   * a precomposed `ä` to `a` plus a combining mark. So `Kähler` becomes
   * `\text{K}\ddot{a}\text{hler}`: letters in the text font, the umlaut as an
   * accent the maths font has.
   */
  const romanRun = (text) => {
    let out = '';
    let plain = '';
    const flush = () => {
      if (plain) { out += `\\text{${plain}}`; plain = ''; }
    };
    let i = 0;
    while (i < text.length) {
      if (text[i] !== '\\') { plain += text[i]; i++; continue; }
      const cmd = /^\\([a-zA-Z]+)/.exec(text.slice(i));
      const name = cmd ? cmd[1] : text[i + 1];
      const after = cmd ? i + cmd[0].length : i + 2;
      const macro = ACCENT_MACROS[name];
      const known = macro || ACCENT_CHARS[name];
      if (known) {
        let j = after;
        while (j < text.length && /[ \t]/.test(text[j])) j++;
        let letter = null;
        let next = j;
        if (text[j] === '{') {
          const g = groupIn(text, j);
          if (g && g.text.length === 1) { letter = g.text; next = g.next; }
        } else if (text[j] && text[j] !== '{' && text[j] !== '\\') {
          // a bare letter is the normal LaTeX form: `\"ahler` accents the `a`
          letter = text[j]; next = j + 1;
        }
        // Only when the letter form carries that letter: `\v{x}` is a vector,
        // and swallowing the `\v` would silently delete an arrow.
        if (letter && ACCENT_CHARS[name]?.[letter]) {
          flush();
          out += accented(name, letter);
          i = next;
          continue;
        }
      }
      plain += cmd ? cmd[0] : '\\' + name;
      i = after;
    }
    flush();
    return out || '\\text{}';
  };

  const groupAt = (j) => (src[j] === '{' ? groupIn(src, j) : null);

  while (i < src.length) {
    if (src[i] !== '\\') { out += src[i]; i++; continue; }

    // Symbol accents first, before any command name is read: `\'{a}` is a
    // backslash and a quote, which no `[a-zA-Z]+` scan after the backslash
    // finds, so without this it falls through as literal text.
    const next = src[i + 1];
    // Symbol accents only: `\v` is an accent *letter* (`\v{x}` is a vector),
    // and catching it here would delete the arrow.
    if (next && !LETTER_ACCENT_FORMS.has(next)
      && (ACCENT_CHARS[next] || ACCENT_MACROS[next])) {
      let j = i + 2;
      while (j < src.length && /[ \t]/.test(src[j])) j++;
      const g = groupAt(j);
      const letter = g ? g.text : (src[j] && src[j] !== '{' && src[j] !== '\\' ? src[j] : null);
      if (letter && letter.length === 1) {
        out += accented(next, letter);
        i = g ? g.next : j + 1;
        continue;
      }
    }

    const cmd = /^\\([a-zA-Z]+)/.exec(src.slice(i));
    if (!cmd) { out += src[i]; i++; continue; }
    const name = cmd[1];
    let after = i + cmd[0].length;

    // a word in roman type: \mbox, \hbox, \textnormal, \textrm
    if (WORD_IN_ROMAN.has(name)) {
      const g = groupAt(after);
      if (g) { out += romanRun(g.text); i = g.next; continue; }
      out += cmd[0]; i = after; continue;
    }

    // an accent, letter form: \c{c}, \v{s}, \H{o}
    if (ACCENT_CHARS[name] || ACCENT_MACROS[name]) {
      let j = after;
      while (j < src.length && /[ \t]/.test(src[j])) j++;
      const g = groupAt(j);
      const letter = g ? g.text : (src[j] && src[j] !== '{' ? src[j] : null);
      // `\v`, `\t`, `\b` and `\d` are real macros as well as accent letters,
      // so only a letter the table carries is treated as an accent.
      if (letter && letter.length === 1 && ACCENT_CHARS[name]?.[letter]) {
        out += accented(name, letter);
        i = g ? g.next : j + 1;
        continue;
      }
      out += cmd[0]; i = after; continue;
    }

    // an accent, symbol form: \"{a} or \"a
    const sym = src[after];
    if (sym && ACCENT_CHARS[sym]) {
      let j = after + 1;
      while (j < src.length && /[ \t]/.test(src[j])) j++;
      const g = groupAt(j);
      if (g && g.text.length === 1) {
        out += ACCENT_CHARS[sym][g.text] || g.text;
        i = g.next; continue;
      }
      if (!g && src[j] && src[j] !== '{' && !/[a-zA-Z\\]/.test(src[j])) {
        out += ACCENT_CHARS[sym][src[j]] || src[j];
        i = j + 1; continue;
      }
    }

    // the short forms of the font-selection macros
    if (name === 'rm' || name === 'mathrm') { out += '\\mathrm'; i = after; continue; }
    if (name === 'bf' || name === 'mathbf') { out += '\\mathbf'; i = after; continue; }
    if (name === 'it' || name === 'mathit') { out += '\\mathit'; i = after; continue; }
    if (name === 'cal' || name === 'mathcal') {
      out += '\\mathcal';
      i = after;
      continue;
    }
    const cX = /^\\c([A-Z])/.exec(src.slice(i));
    if (cX) { out += `\\mathcal{${cX[1]}}`; i += cX[0].length; continue; }

    out += cmd[0];
    i = after;
  }
  return balanceDelimiters(stripOverlays(out));
}

/**
 * Pairs `\left` with `\right`, and drops the ones that have no partner.
 *
 * KaTeX refuses an unpaired one, and refuses the whole equation with it --
 * and sources in the wild carry them (a `\right|` whose `\left` closed on an
 * earlier display). A stack, not a count: counting cannot tell a `\right)`
 * closing a `\left(` from one closing nothing. Matching is on the command
 * (`\left` not followed by a letter), so `\leftarrow` is not a delimiter.
 * Arguments that are *text* are skipped, not scanned: a `\left` inside
 * `\text{}` is a character the reader typed.
 */
const DELIM_ARG = /^(?:text|textrm|texttt|mbox|hbox|operatorname|label|tag|href|url|textcolor)\b/;

function balanceDelimiters(tex) {
  const src = String(tex);
  let out = '';
  // Where each unclosed opening delimiter sits in the *output*, for removal
  // without disturbing the indices of the earlier ones.
  const unclosed = [];
  let i = 0;
  let depth = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '{') { depth++; out += ch; i++; continue; }
    if (ch === '}') { depth--; out += ch; i++; continue; }

    if (ch !== '\\') { out += ch; i++; continue; }

    const cmd = /^\\([a-zA-Z]+|\\|.)/.exec(src.slice(i));
    if (!cmd) { out += ch; i++; continue; }
    const name = cmd[1];
    // `\\` is a line break in maths; it is not a command name.
    const isBreak = name === '\\';

    // Arguments that are *text* are copied through whole, not scanned.
    if (!isBreak && depth === 0 && DELIM_ARG.test(name)) {
      const j = skipBracedArg(src, i + cmd[0].length);
      out += src.slice(i, j);
      i = j;
      continue;
    }

    if (!isBreak && depth === 0 && name === 'left'
        && !/^[a-zA-Z]/.test(src.slice(i + 5, i + 6))) {
      unclosed.push(out.length);
      out += cmd[0];
      i += cmd[0].length;
      continue;
    }

    if (!isBreak && depth === 0 && name === 'right'
        && !/^[a-zA-Z]/.test(src.slice(i + 6, i + 7))) {
      i += cmd[0].length;
      // whatever was attached to it goes with it
      while (i < src.length && (src[i] === '^' || src[i] === '_')) {
        const sub = src[i] === '^' ? /^\^\s*(?:\{[^{}]*\}?|.)/
          : /^_\s*(?:\{[^{}]*\}?|.)/;
        i += sub.exec(src.slice(i))[0].length;
      }
      if (unclosed.length) {
        out += cmd[0];
        unclosed.pop();
      }
      // An opening delimiter that never closed keeps its text; only the
      // `\left` itself is removed.
      else out += '';
      continue;
    }

    out += cmd[0];
    i += cmd[0].length;
  }

  if (!unclosed.length) return out;
  // Remove the leftovers last-first, so the earlier indices hold.
  let result = out;
  for (const at of unclosed.reverse())
    result = result.slice(0, at) + result.slice(at + '\\left'.length);
  return result;
}

/** The end of a `{...}` argument starting at `from`, or `from` if there is none. */
function skipBracedArg(src, from) {
  let j = from;
  while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] !== '{') return from;
  let depth = 0;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return j + 1; }
    j++;
  }
  return from;
}

/**
 * Overlay specifications, removed from a body of maths.
 *
 * A display equation in a beamer frame is routinely wrapped in
 * `\uncover<2,4>{...}` ("show this on the second and fourth click"). On a page
 * there are no clicks: the content is always shown and the command is not part
 * of the equation. It cannot go through the inline parser (a display body goes
 * to KaTeX as written, where an unknown macro draws in red), so it is stripped
 * here. `\alt<2>{a}{b}` is a real choice: the first alternative is kept.
 */
const OVERLAY_MACROS = /\\(uncover|onslide|only|visible|invisible|unskippable|alt)\s*(?=<)/;

function stripOverlays(tex) {
  let out = String(tex);
  let guard = 0;
  while (guard++ < 64) {
    const m = OVERLAY_MACROS.exec(out);
    if (!m) break;
    // The spec may nest (`<1-3| handout:1>` carries a bar), and the scan
    // starts past the opening angle (`m[0]` ends at it).
    let i = m.index + m[0].length + 1; // past the `<`
    let depth = 0;
    while (i < out.length) {
      if (out[i] === '<') depth++;
      else if (out[i] === '>') { if (!depth) break; depth--; }
      i++;
    }
    i++; // past the `>`
    const isAlt = m[1] === 'alt';
    // the arguments: one, or two for `\alt`
    let n = isAlt ? 2 : 1;
    while (n > 0 && i < out.length) {
      while (i < out.length && /\s/.test(out[i])) i++;
      if (out[i] !== '{') break;
      let d = 0;
      const start = i;
      while (i < out.length) {
        if (out[i] === '\\') { i += 2; continue; }
        if (out[i] === '{') d++;
        else if (out[i] === '}') { d--; if (!d) { i++; break; } }
        i++;
      }
      const arg = out.slice(start, i);
      if (n === (isAlt ? 2 : 1)) out = out.slice(0, m.index) + arg + out.slice(i);
      n--;
    }
    if (n > 0) { out = out.slice(0, m.index) + out.slice(i); }
  }
  return out;
}

/** Commands whose argument is a word set in roman type. */
const WORD_IN_ROMAN = new Set(['mbox', 'hbox', 'textnormal', 'textrm', 'text']);

/** The accent commands whose name is a letter rather than a symbol. */
const LETTER_ACCENT_FORMS = new Set(['c', 'v', 'H', 'k', 'u', 'd', 't', 'b']);

/**
 * The accent commands, symbol and letter forms alike.
 *
 * The value is the LaTeX macro KaTeX has for that accent, where it has one.
 * A precomposed character is no substitute: KaTeX normalises `ä` to `a` plus
 * a combining mark and draws it floating above the letter, while `\ddot{a}`
 * is one glyph in the right place. Letter forms with no KaTeX equivalent
 * fall back to the character (and `\v` only for a single letter, since `\v`
 * is otherwise a vector).
 */
const ACCENT_MACROS = {
  '"': ['\\ddot', true],
  "'": ['\\acute', true],
  '`': ['\\grave', true],
  '^': ['\\hat', true],
  '~': ['\\tilde', true],
  '=': ['\\bar', true],
  '.': ['\\dot', true],
  u: ['\\breve', false],
};

const ACCENT_CHARS = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', s: 'ś', z: 'ź', n: 'ń', l: 'ĺ' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', c: 'ĉ', s: 'ŝ', g: 'ĝ', h: 'ĥ', j: 'ĵ', w: 'ŵ', y: 'ŷ' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ' },
  '~': { a: 'ã', n: 'ñ', o: 'õ' },
  '=': { a: 'ā', e: 'ē', o: 'ō', u: 'ū' },
  '.': { z: 'ż', e: 'ė' },
  c: { c: 'ç', s: 'ş', g: 'ğ', t: 'ţ' },
  v: { c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě' },
  H: { o: 'ő', u: 'ű' },
  k: { a: 'ą', e: 'ę' },
  u: { a: 'ă', g: 'ğ' },
  d: { c: 'ď', e: 'ě' },
  t: { c: 'ť' },
};

function renderMath(tex, display, ctx) {
  // The paper's own notation first: an unexpanded macro reaches the reader as
  // literal characters instead of mathematics.
  if (ctx.macros?.size) tex = expandMacros(tex, ctx.macros);
  tex = normaliseMath(tex);

  // `katex: null` means "no math engine", not "ask the module again": test for
  // undefined rather than nullish.
  let katex = ctx.katex === undefined ? getKatex() : ctx.katex;
  if (katex && USES_MHCHEM.test(tex)) katex = loadMhchem(katex);
  if (katex) {
    try {
      const html = katex.renderToString(tex, {
        displayMode: !!display,
        throwOnError: false,
        output: 'html',
        strict: 'ignore',
        trust: false,
        macros: { '\\': '\\' },
      });
      return display
        ? `<span class="math-block">${html}</span>`
        : `<span class="math-inline">${html}</span>`;
    } catch (err) {
      return `<code class="math-fallback" title="${escapeHtml(err.message)}">${escapeHtml(tex)}</code>`;
    }
  }
  const cls = display ? 'math-block math-fallback' : 'math-inline math-fallback';
  return `<code class="${cls}">${escapeHtml(display ? `\\[${tex}\\]` : `$${tex}$`)}</code>`;
}

// -------------------------------------------------------------------- blocks

export function renderBlocks(blocks, ctx = {}) {
  let out = '';
  const list = blocks || [];
  for (let i = 0; i < list.length; i++) {
    const block = list[i];
    // A heading owns what follows it, up to the next heading of the same or a
    // higher level: layouts that style a section as a unit need the content
    // inside it, not spilled out below as siblings.
    if (block.type === 'section' && !block.untitled && !(block.blocks?.length)) {
      const owned = [block];
      let j = i + 1;
      while (j < list.length) {
        const next = list[j];
        if (next.type === 'section' && next.level <= block.level) break;
        owned.push(next);
        j++;
      }
      if (owned.length > 1) {
        out += renderSection({ ...block, blocks: owned.slice(1) }, ctx);
        i = j - 1;
        continue;
      }
    }
    out += renderBlock(block, ctx);
  }
  return out;
}

function renderBlock(block, ctx) {
  switch (block.type) {
    case 'section': return renderSection(block, ctx);
    case 'numbered-para':
      // Print convention: a paragraph boundary marked by indentation, not by a
      // blank line. A web column that blank-lines every paragraph doubles the
      // vertical space and breaks the run of a proof.
      return `<div class="indent">${renderBlocks(block.blocks, ctx)}</div>`;
    case 'para': {
      const body = renderInline(block.nodes, ctx);
      // A paragraph with nothing in it is not a paragraph (beamer's
      // `\vspace` separators each leave one behind).
      // ...but an element that *is* content counts as content: a paragraph
      // whose whole body is one `<img>` is a figure, not an empty paragraph.
      const carries = /<(?:img|svg|picture|canvas|video|audio|iframe|object|embed|table)\b/i;
      if (!body.replace(/<[^>]*>/g, '').trim() && !carries.test(body)) return '';
      return `<p>${body}</p>`;
    }
    case 'maketitle': return ctx.titleRendered ? '' : renderTitleBlock(ctx);
    case 'math': {
      const body = renderMath(block.tex, true, ctx);
      const label = block.numbered ? `<span class="eqno">(${escapeHtml(block.shown ?? block.number)})</span>` : '';
      return `<div class="equation${block.numbered ? ' numbered' : ''}"${block.id ? ` id="${escapeHtml(block.id)}"` : ''}>${body}${label}</div>`;
    }
    case 'references': return renderReferences(block, ctx);
    case 'list': return renderList(block, ctx);
    case 'abstract': {
      const inner = renderBlocks(block.blocks, ctx);
      return `<aside class="abstract"><h2 class="abstract-title">Abstract</h2>${inner}</aside>`;
    }
    case 'blockquote': return `<blockquote>${renderBlocks(block.blocks, ctx)}</blockquote>`;
    case 'center': {
      // The author's colour, and nothing else: no box, no label. The emphasis
      // is the author's, not a callout.
      const style = block.color ? ` style="color:${escapeHtml(colourValue(block.color))}"` : '';
      return `<div class="centered"${style}>${renderBlocks(block.blocks, ctx)}</div>`;
    }
    case 'callout': return renderCallout(block, ctx);
    case 'code': return renderCode(block);
    case 'tikz': return renderTikz(block);
    case 'figure': return renderFigure(block, ctx);
    case 'table': return renderTable(block, ctx);
    default: return block.blocks ? renderBlocks(block.blocks, ctx) : '';
  }
}

/**
 * The wordmark, as a drawing.
 *
 * One drawing, used in the masthead and as the title of a page whose subject
 * is the tool. An SVG rather than text: text inside a link reads as a link
 * (underline, hover colour, visited state), and a logo must do none of those.
 * The name rides on the surrounding element as `aria-label`, since an SVG
 * carries no text for a screen reader.
 */
export function wordmarkSvg(label, className = '') {
  // Weight 400, stated not inherited: at display size a serif's stems read
  // heavy whatever the context lends, and a wordmark must not shout its name.
  //
  // `text-anchor="middle"` with the runs in one text element and no whitespace
  // between the tspans, so the *glyphs* centre in the box. The viewBox is
  // fitted to what the text draws (98 units from -37, height 26): the box is
  // the mark, so centring the box centres the name.
  const body = '<text x="12" y="21" text-anchor="middle" font-family="Georgia, \'Times New Roman\', serif"'
    + ' font-weight="400"><tspan class="wordmark-lambda" font-size="24" font-style="italic">\u03bb</tspan>'
    + '<tspan class="wordmark-rest" font-size="22" letter-spacing="-0.2">tex<tspan class="wordmark-dim">2</tspan>web</tspan></text>';
  // viewBox fitted to the drawn text (see above); height 26 keeps the render
  // scale identical to the masthead's mark.
  return `<svg class="wordmark-svg ${className}" viewBox="-37 0 98 26" width="98" height="26"`
    + ` role="img" aria-hidden="true" focusable="false">${body}</svg>`;
}

function renderTitleBlock(ctx) {
  ctx.titleRendered = true;
  const { title, author, date } = ctx.meta || {};
  if (!title && !author && !date) return '';
  const parts = [];
  // A page whose subject is the tool itself draws its title as the wordmark:
  // set as type it would read as a second, different product next to the
  // masthead's mark.
  if (title) {
    parts.push(ctx.wordmarkHero
      ? `<h1 class="doc-title doc-title-mark">${wordmarkSvg(escapeHtml(title))}</h1>`
      : `<h1 class="doc-title">${escapeHtml(title)}</h1>`);
  }
  const byline = [];
  const authors = ctx.meta?.authors;
  if (authors?.authors?.length) {
    byline.push(renderAuthors(authors, ctx));
  } else if (author) {
    byline.push(`<span class="doc-author">${escapeHtml(author)}</span>`);
  }
  if (date) byline.push(`<span class="doc-date">${escapeHtml(date)}</span>`);
  if (byline.length) parts.push(`<p class="doc-byline">${byline.join('<span class="sep"> · </span>')}</p>`);
  return `<header class="doc-header">${parts.join('')}</header>`;
}

/**
 * The author block.
 *
 * One author is a name followed by its lines (affiliation, address), with the
 * `\thanks` / `\footnotemark` marks on the name. The marks show as the symbols
 * LaTeX uses (`*`, `†`, `‡`): a printed `[1]` where the paper prints `*` reads
 * as a link to a reference that is not there. Each symbol tooltips its note,
 * so the mark says what it means without a trip to the foot of the page.
 */
function renderAuthors(authors, ctx) {
  const notes = authors.notes || [];
  // The mark carries a *label*, not the note: a long note (the
  // equal-contribution paragraph runs to a hundred words) has no business in
  // a `title` tooltip, so the mark names the symbol and links to the note.
  const mark = (m) => {
    const text = notes[m.n - 1] || '';
    const symbol = escapeHtml(m.symbol);
    if (!text) return `<sup class="author-mark">${symbol}</sup>`;
    return `<sup class="author-mark">`
      + `<a href="#author-note-${m.n}" role="doc-noteref" `
      + `aria-label="${escapeHtml(text.slice(0, 120))}">${symbol}</a></sup>`;
  };
  const list = authors.authors.map((a) => {
    const marks = a.marks.map(mark).join('');
    const detail = a.detail.length
      ? `<span class="author-detail">${a.detail.map(escapeHtml).join('<br>')}</span>`
      : '';
    return '<span class="author">'
      + `<span class="author-name">${escapeHtml(a.name)}${marks}</span>${detail}</span>`;
  }).join('');
  void ctx;
  // The notes themselves, once, below the byline. Reachable from the mark, and
  // numbered to match it.
  const printed = notes
    .map((text, i) => text ? `<li id="author-note-${i + 1}"><span class="ref-num">${
      escapeHtml(['*', '\u2020', '\u2021'][i] || String(i + 1))}</span>`
      + `<span class="ref-body">${escapeHtml(text)}</span></li>` : '')
    .filter(Boolean)
    .join('');
  const noteList = printed ? `<ol class="author-notes">${printed}</ol>` : '';
  return `<span class="doc-authors">${list}</span>${noteList}`;
}

/**
 * The reference list.
 *
 * When the document ships its references -- an inline `thebibliography`, a
 * `.bbl`, or a `.bib` database -- the entries are the real ones and are
 * numbered as the paper numbers them. When it does not, the keys it cited are
 * listed instead, with a note saying why: an invented title would misattribute
 * the work, which is worse than an admitted gap.
 */
function renderReferences(block, ctx) {
  const entries = block.entries || (block.cited || []).map((k) => ({
    key: typeof k === 'string' ? k : k.key,
    id: typeof k === 'string' ? `ref-${slug(k)}` : k.id,
    text: null,
  }));
  if (!entries.length) return '';

  const items = entries.map((e, i) => {
    const body = e.text
      ? renderInline(parseInlineText(e.text), ctx)
      : `<code class="ref-key">${escapeHtml(e.key)}</code>`;
    const mark = e.text ? `<span class="ref-num">${i + 1}</span>` : '';
    return `<li id="${escapeHtml(e.id)}" class="ref-entry">${mark}`
      + `<span class="ref-body">${body}</span></li>`;
  }).join('');

  const note = block.resolved ? '' : '<p class="ref-note">'
    + 'Listed by key. This document ships no bibliography, so no titles, '
    + 'authors or numbers can be resolved without running BibTeX &mdash; and '
    + 'inventing them would misattribute the work.</p>';

  // The heading is omitted when the document wrote its own (see parse.js):
  // the list sits under the author's heading rather than a second one.
  const head = block.headed === false ? '' : '<h2>References</h2>\n';

  return '<section class="references" id="references">\n'
    + head + note
    + `<ol class="ref-list">${items}</ol>\n</section>`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function renderSection(block, ctx) {
  // A numbered beamer frame badges its slide (`Slide 6 of 30`), using the
  // parser's document-level count rather than any stylesheet counter.
  const badge = block.kind === 'frame' && typeof block.slide === 'number'
    ? `<p class="slide-num">Slide ${escapeHtml(String(block.slide))}`
      + ` of ${escapeHtml(String(block.slideTotal ?? block.slide))}</p>`
    : '';
  const inner = block.blocks?.length ? `\n${renderBlocks(block.blocks, ctx)}` : '';
  // A frame may carry no \frametitle: no heading then (an empty heading is
  // worse than none), but still a container and anchor. Its contents entry
  // names it by slide number instead (see buildToc).
  if (block.untitled) {
    return `<section class="level-${block.level} frame untitled" id="${escapeHtml(block.id)}">${badge}${inner}\n</section>`;
  }
  const tag = `h${Math.min(block.level + 1, 6)}`;
  const num = block.number ? `<span class="sec-num">${escapeHtml(block.number)}</span>` : '';
  return `<section class="level-${block.level}${block.kind === 'frame' ? ' frame' : ''}">\n<${tag} id="${escapeHtml(block.id)}">${num}${renderInline(block.nodes)}<a class="anchor" href="#${escapeHtml(block.id)}" aria-label="Link to this section">#</a></${tag}>${badge}${inner}\n</section>`;
}

function renderList(block, ctx) {
  const items = block.items
    .map((item) => {
      const body = item.blocks.some((b) => b.type === 'para')
        ? renderBlocks(item.blocks, ctx)
        : `<p>${renderInline(item.blocks.flatMap((b) => b.nodes || []), ctx)}</p>`;
      if (block.kind === 'description') {
        return `<dt>${renderInline(item.label, ctx)}</dt><dd>${body}</dd>`;
      }
      const custom = item.label?.length && block.kind === 'enumerate'
        ? `<span class="item-label">${renderInline(item.label, ctx)}</span>`
        : '';
      return `<li>${custom}${body}</li>`;
    })
    .join('\n');
  if (block.kind === 'description') return `<dl class="descriptions">${items}</dl>`;
  return `<${block.kind === 'enumerate' ? 'ol' : 'ul'} class="itemize">${items}</${block.kind === 'enumerate' ? 'ol' : 'ul'}>`;
}

const CALLOUT_TITLES = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition',
  corollary: 'Corollary', definition: 'Definition', remark: 'Remark',
  example: 'Example', proof: 'Proof', observation: 'Observation',
  conjecture: 'Conjecture', axiom: 'Axiom', exercise: 'Exercise',
};

function renderCallout(block, ctx) {
  const isProof = block.kind === 'proof';
  const title = block.unnumbered
    ? (block.title || block.note || CALLOUT_TITLES[block.kind] || block.kind)
    : (CALLOUT_TITLES[block.kind] || block.kind);
  const body = renderBlocks(block.blocks, ctx);
  const inner = isProof
    ? body.replace(/<\/p>$/, '<span class="qed">∎</span></p>')
    : body;
  const tone = block.tone ? ` callout-tone-${block.tone}` : '';
  // An unnumbered callout shows its title as a heading: a parenthesised
  // `(Warning)` reads as a cross-reference, and nothing refers to these.
  const label = block.unnumbered
    ? `<p class="callout-kind">${escapeHtml(title)}</p>`
    : `<p class="callout-kind">${escapeHtml(title)}${
      block.note ? ` <span class="callout-note">(${escapeHtml(block.note)})</span>` : ''
    }</p>`;
  return `<aside class="callout callout-${escapeHtml(block.kind)}${tone}"${
    block.id ? ` id="${escapeHtml(block.id)}"` : ''
  }>${isProof ? '' : label}${inner}</aside>`;
}

function renderCode(block) {
  const raw = block.lang || '';
  const lang = normalizeLang(raw);
  const cls = raw ? ` class="language-${escapeHtml(raw)}"` : '';
  // unknown languages fall through as escaped plain text inside highlight()
  const body = lang ? highlight(block.tex, lang) : escapeHtml(block.tex);

  // Two boxes: a bar across the top (label left, copy control right) and the
  // code untouched beneath. The label falls back to "text", so the bar never
  // appears half-built.
  const label = escapeHtml(raw || 'text');
  return `<figure class="code-block">`
    + `<figcaption class="code-bar"><span class="code-lang">${label}</span>`
    // Two squares, not the word: the copy glyph editors already use. Both
    // marks are in the DOM and the state picks one, so confirmation is a
    // change of picture, not only of colour. The button keeps an accessible
    // name for screen readers.
    + `<button class="copy" type="button" aria-label="Copy code" title="Copy">`
    + '<svg class="icon-copy" width="15" height="15" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<rect x="9.2" y="9.2" width="11.6" height="11.6" rx="2.1"/>'
    + '<path d="M14.8 5.4V4.6a2 2 0 0 0-2-2H4.6a2 2 0 0 0-2 2v8.2a2 2 0 0 0 2 2h.8"/>'
    + '</svg>'
    + '<svg class="icon-check" width="15" height="15" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="2.4" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M20.5 6.6 9.6 17.5 4 11.9"/>'
    + '</svg>'
    + '</button>'
    + '</figcaption>'
    + `<pre><code${cls}>${body}</code></pre>`
    + '</figure>';
}

function renderTikz(block) {
  const dialect = block.dialect || 'TikZ';
  const lines = block.tex.split('\n').length;
  return `<figure class="tikz-block"><p class="tikz-note">${escapeHtml(dialect)} drawing `
    + `<span class="tikz-count">${lines} line${lines === 1 ? '' : 's'}</span> — source shown, not rendered to SVG. `
    + 'Compile with a LaTeX toolchain and embed the SVG for the real thing.</p>'
    + `<pre class="tikz-src">${escapeHtml(block.tex)}</pre></figure>`;
}

/** Converts a LaTeX length into something CSS understands. */
function latexLengthToCss(value) {
  if (!value) return null;
  const v = value.trim().replace(/^\{|\}$/g, '').trim();

  // a bare relative unit: 0.5\linewidth, \textwidth, 1.0\hsize
  const rel = /^([\d.]*)\\?(?:linewidth|textwidth|columnwidth|hsize|paperwidth|marginparwidth|marginlinewidth)$/.exec(v);
  if (rel) {
    // the capture may be just the command, so read the numeric prefix only
    const num = /^([\d.]*)/.exec(rel[1])[1];
    const fraction = num === '' ? 1 : Number(num);
    return Number.isFinite(fraction) ? `${Math.round(fraction * 1000) / 10}%` : null;
  }

  // explicit units CSS also understands
  const unit = /^([\d.]+)\s*(cm|mm|in|pt|pc|px|em|rem|ex)$/.exec(v);
  if (unit) return `${Number(unit[1])}${unit[2]}`;

  // a bare number means "multiple of natural size" only when it came from scale
  const bare = /^([\d.]+)$/.exec(v);
  return bare ? `${Number(bare[1]) * 100}%` : null;
}

function renderImage(block, ctx, name = block.image, imageOpts = block.imageOpts) {
  const src = ctx.assetUrl ? ctx.assetUrl(name) : name;
  const alt = escapeHtml(block.caption?.map((c) => c.value).join('') || name);
  // a missing asset must not become a broken-image icon on the page
  if (ctx.missingImages?.has(name)) {
    return `<p class="missing-asset" role="img" aria-label="missing image ${alt}">`
      + `<span class="missing-asset-name">${escapeHtml(name)}</span>`
      + `<span class="missing-asset-note">image not found</span></p>`;
  }

  const opts = imageOpts || {};
  const width = latexLengthToCss(opts.width);
  const height = latexLengthToCss(opts.height);
  // `scale=0.6` multiplies the picture's natural size; it is not a width, and
  // inside a multi-column figure the size is the column's business anyway.
  // Published as a variable rather than applied as `zoom`: `zoom` scales the
  // used values, so a `max-height` beside it is checked before the zoom and
  // the reader gets limit times scale. The stylesheet divides its limit by
  // this instead.
  const scaled = !width && !height && opts.scale
    ? `zoom:${Number(opts.scale)};--fig-zoom:${Number(opts.scale)}`
    : null;
  const style = [
    width ? `width:${width}` : null,
    height ? `height:${height}` : null,
    scaled,
    block.columns ? 'width:auto;max-width:100%' : null,
  ].filter(Boolean).join(';');

  const attrs = [
    `src="${escapeHtml(src)}"`,
    `alt="${alt}"`,
    'loading="lazy"',
    'decoding="async"',
    style ? `style="${escapeHtml(style)}"` : null,
  ].filter(Boolean).join(' ');
  return `<img ${attrs}>`;
}

function renderFigure(block, ctx) {
  const caption = block.caption?.length
    ? `<figcaption>${renderInline(block.caption, ctx)}</figcaption>`
    : '';
  // A float can hold several pictures (two columns of a `figure*`, one per
  // `minipage`), shown side by side. Each column keeps its own heading with
  // its own picture: side-by-side pictures are only comparable when labelled.
  const columns = block.columns?.length;
  const many = !columns && block.images?.length > 1;
  let image = '';
  if (columns) {
    // The flag reaches an `\includegraphics` in running text inside a
    // minipage: the picture is a line in a column, not a float of its own.
    const wasInColumn = ctx.inFloatColumn;
    ctx.inFloatColumn = true;
    image = `<div class="float-grid float-cols">${block.columns
      .map((col) => `<div class="float-col">${renderBlocks(col, ctx)}</div>`)
      .join('')}</div>`;
    ctx.inFloatColumn = wasInColumn;
  } else if (many) {
    image = `<div class="float-grid">${block.images
      .map((img) => renderImage(block, ctx, img.name, img.opts))
      .join('')}</div>`;
  } else if (block.image) {
    image = renderImage(block, ctx);
  }
  const body = columns ? '' : renderBlocks(block.blocks, ctx);
  if (!image && !body) return caption ? `<p class="caption-only">${caption}</p>` : '';
  return `<figure class="float"${block.id ? ` id="${escapeHtml(block.id)}"` : ''}>${image}${body}${caption}</figure>`;
}

function renderTable(block, ctx) {
  if (!block.rows?.length) {
    return block.caption?.length ? `<p class="caption-only">${renderInline(block.caption, ctx)}</p>` : '';
  }
  const [head, ...rows] = block.rows;
  // How many columns the table really has. The header's *cell count* misleads
  // the moment it spans (three cells over six columns with `\multicolumn`),
  // so the widest row decides -- but the table's own declaration wins when it
  // has one, since one malformed row must not widen the whole table.
  const spanOf = (r) => r.reduce((n, c) => n + (c?.colspan > 1 ? c.colspan : 1), 0);
  const declared = specColumns(block.columnSpec) || 0;
  const widest = Math.max(0, ...block.rows.map(spanOf));
  const width = declared || widest || head.length;

  // A row claiming more columns than the table has is over-spanned; the
  // surplus is empty padding, since content would have set the table's width.
  const fit = (r) => {
    const out = r.slice();
    while (out.length > 1 && spanOf(out) > width) out.pop();
    // Still over: the surplus sits inside a `\multicolumn`, whose declared
    // span counts columns the row does not carry. Shrink the widest span
    // rather than letting the row overflow past the right-hand rule.
    let over = spanOf(out) - width;
    while (over > 0) {
      let widest = -1;
      out.forEach((c, i) => {
        const v = c?.colspan || 1;
        if (v > 1 && v > (widest < 0 ? 1 : out[widest].colspan || 1)) widest = i;
      });
      if (widest < 0) break;
      const take = Math.min(over, (out[widest].colspan || 1) - 1);
      out[widest] = { ...out[widest], colspan: out[widest].colspan - take };
      over -= take;
    }
    return out;
  };
  const thead = `<thead><tr>${head.map((c) => `<th${span(c)}>${renderCell(c, ctx)}</th>`).join('')}</tr></thead>`;
  // Row cells are emitted by *span*, not by index: the loop stops once the
  // row's spans have covered the width, so a `\multicolumn` is never padded
  // with phantom cells.
  const renderRow = (raw) => {
    const cells = fit(raw);
    const out = [];
    let placed = 0;
    for (const cell of cells) {
      if (placed >= width) break;
      out.push(`<td${span(cell)}>${renderCell(cell, ctx)}</td>`);
      placed += cell?.colspan > 1 ? cell.colspan : 1;
    }
    while (placed++ < width) out.push('<td></td>');
    return out.join('');
  };
  const tbody = `<tbody>${rows.map((r) => `<tr>${renderRow(r)}</tr>`).join('')}</tbody>`;
  const caption = block.caption?.length ? `<figcaption>${renderInline(block.caption, ctx)}</figcaption>` : '';
  // The head row is dropped when it holds no text: a table beginning with a
  // rule would otherwise show an empty row above the real headings.
  const cls = ['float', 'table'];
  if (block.grouped) cls.push('table-grouped');
  if (head.filter((c) => cellText(c)).length === 0 && rows.length) {
    const [, ...rest] = [head, ...rows];
    return renderTable({ ...block, rows: rest }, ctx);
  }
  return `<figure class="${cls.join(' ')}"${block.id ? ` id="${escapeHtml(block.id)}"` : ''}><table>${thead}${tbody}</table>${caption}</figure>`;
}

/** A cell's text with the markup stripped, for deciding whether it is empty. */
function cellText(cell) {
  return String(cell?.text ?? '').replace(/\s+/g, '').length > 0;
}

function renderCell(cell, ctx) {
  // resolved nodes when references have been through the tree, source otherwise
  const nodes = cell?.nodes
    ?? (ctx.parseCell
      ? ctx.parseCell(cell?.text ?? '')
      : [{ type: 'text', value: cell?.text ?? '' }]);
  return renderInline(nodes, ctx);
}

/** `colspan` for a cell that asked to span, `''` otherwise. */
function span(cell) {
  return cell?.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
}

const columns = (n) => Array.from({ length: n }, (_, i) => i);

/**
 * The column count a `tabular` preamble declares, for when the header row cannot
 * be trusted to say. `{lccccc}` is six. `p{3cm}` counts once, not twice.
 */
function specColumns(spec) {
  const body = String(spec || '').replace(/^[^{]*\{/, '').replace(/\}$/, '');
  if (!body) return 0;
  const letters = body.replace(/[@!][^{}]*(?:\{[^{}]*\}[^{}]*)*/g, '')
    .match(/[lcrpmb]/g);
  return letters?.length || 0;
}

// ----------------------------------------------------------------------- toc

/**
 * The target of a heading that is a single link.
 *
 * `\section{\href{demo.html}{Attention}}` reads as "this section *is* that
 * page", so the contents entry belongs there too. Anything more complicated than
 * one link — text plus a link, several links — has no single target and yields
 * none.
 */
function headingHref(nodes) {
  const meaningful = (nodes || []).filter(
    (n) => n.type !== 'break' && !(n.type === 'text' && !n.value.trim()));
  if (meaningful.length !== 1) return null;
  const only = meaningful[0];
  return only.type === 'link' && only.href ? only.href : null;
}

/**
 * Builds the contents tree.
 *
 * `maxLevel` stops the descent: at full depth a paper with `\paragraph`
 * headings yields sixty entries, a list of the document rather than a way
 * into it. Three is section through subsubsection.
 */
export function buildToc(blocks, maxLevel = 3) {
  // The deck's slide total: the highest numbered slide. Frames are numbered
  // once in document order at parse time, so this total cannot reset partway.
  let total = 0;
  const highest = (list) => {
    for (const b of list || []) {
      if (typeof b.slide === 'number' && b.slide > total) total = b.slide;
      if (b.blocks) highest(b.blocks);
      if (b.items) for (const item of b.items) highest(item.blocks);
    }
  };
  highest(blocks);
  const flat = [];
  // Every numbered frame is an entry, titled or not: untitled decks would
  // otherwise yield a contents of nothing. Each is listed as the slide it is
  // (`Slide 6 of 30`), with its title when it has one. Unnumbered frames are
  // not in beamer's numbered sequence, so neither are they here.
  const walk = (list) => {
    for (const block of list || []) {
      if (block.kind === 'frame') {
        if (typeof block.slide === 'number') {
          const name = `Slide ${block.slide} of ${block.slideTotal ?? total}`;
          flat.push({
            // No separate number: the title already says which slide this is.
            level: 1, id: block.id, number: '',
            title: block.title ? `${name} — ${block.title}` : name,
            href: headingHref(block.nodes), frame: true,
          });
        }
        if (block.blocks) walk(block.blocks);
        continue;
      }
      if (block.type === 'section' && block.level >= 1 && block.level <= maxLevel) {
        // A heading that is itself a link points elsewhere: the contents
        // follows it there rather than to an anchor that only scrolls.
        if (block.title) {
          flat.push({
            level: block.level, id: block.id, number: block.number,
            title: block.title, href: headingHref(block.nodes),
          });
        }
        if (block.blocks) walk(block.blocks);
      } else if (block.blocks) {
        walk(block.blocks);
      } else if (block.items) {
        for (const item of block.items) walk(item.blocks);
      }
    }
  };
  walk(blocks);
  // fold the flat list into a tree keyed on heading depth
  const root = [];
  const stack = [{ level: 0, children: root }];
  for (const item of flat) {
    const node = { ...item, children: [] };
    while (stack.length > 1 && stack.at(-1).level >= item.level) stack.pop();
    stack.at(-1).children.push(node);
    stack.push(node);
  }
  return root;
}

export function renderToc(tree, options = {}) {
  if (!tree?.length) return '';
  const label = options.label ?? 'Contents';
  const renderLevel = (nodes, level) => {
    if (!nodes.length) return '';
    const inner = nodes
      .map((n) => {
        const num = n.number ? `<span class="toc-num">${escapeHtml(n.number)}</span>` : '';
        // A heading pointing at another page keeps its own target rather than
        // pretending to be an anchor on this one.
        const away = !!n.href && n.href !== `#${n.id}`;
        const href = away ? n.href : `#${n.id}`;
        const attrs = away ? ' class="toc-away"' : '';
        return `<li><a href="${escapeHtml(href)}"${attrs}>${num}${escapeHtml(n.title)}</a>${renderLevel(n.children, level + 1)}</li>`;
      })
      .join('');
    return `<ul class="toc-list toc-level-${level}">${inner}</ul>`;
  };
  return `<nav class="toc" aria-label="${escapeHtml(label)}"><p class="toc-title">${escapeHtml(label)}</p>${renderLevel(tree, 1)}</nav>`;
}

/**
 * The notes a document accumulates, as one block at the end of it.
 *
 * `inside` is the references section's own markup, when the document has one.
 * The notes go *into* it rather than after it: a reader following a
 * superscript arrives at "References", and a second "Notes" heading for what
 * are also references is one heading too many. Without a bibliography to
 * join, the notes keep their own section.
 */
export function renderFootnotes(ctx, inside = '') {
  const items = (ctx.footnotes || [])
    .map((html, i) => `<li id="fn-${i + 1}">${html}<a class="fn-back" href="#fnref-${i + 1}">↩</a></li>`)
    .join('');

  if (!inside) {
    if (!items) return '';
    return `<section class="footnotes"><h2>Notes</h2><ol>${items}</ol></section>`;
  }

  // `inside` arrives with its closing tag, and is re-emitted either way. The
  // notes go in just before that tag, inside the section the superscript sent
  // the reader to.
  const notes = items
    ? `<div class="footnotes footnotes-inline"><h3>Notes</h3><ol>${items}</ol></div>`
    : '';
  return inside.replace(/<\/section>\s*$/, `${notes}</section>`);
}

export { projectRoot };