/**
 * A focused LaTeX reader.
 *
 * This is deliberately not a TeX engine: no package resolution, no
 * typesetting. It recognises the constructs that show up in ordinary documents
 * and hands the renderer a small tree. Anything it does not recognise is passed
 * through as literal text, so unknown input degrades quietly instead of
 * throwing.
 *
 * The one piece of TeX evaluation it does do is macro expansion, because a
 * paper's own notation is not optional reading: `\dmodel` has to arrive at the
 * maths typesetter as `d_{model}`, not as the eight characters on the page. See
 * macros.js for what that does and does not cover.
 */

import { collectDefinitions, readColorDefinition, readDefinition } from './macros.js';
import {
  formatEntry, liftAdhocReferences, parseBibFile, parseThebibliography
} from './bibliography.js';
import { normalizeLang } from './highlight.js';

const MATH_ENVS = new Set([
  'equation', 'align', 'alignat', 'gather', 'multline', 'displaymath',
  'eqnarray', 'flalign', 'split', 'array', 'cases', 'matrix',
]);

const LIST_ENVS = new Set(['itemize', 'enumerate', 'description']);

const CODE_ENVS = new Set([
  'verbatim', 'lstlisting', 'minted', 'alltt', 'Verbatim', 'BVerbatim',
  'LVerbatim', 'pycode', 'jlisting', 'haskell', 'ocaml',
  // fancyvrb builds a code environment under any name, so custom names are
  // matched by shape (anything ending in `verbatim`) rather than enumerated.
]);

/**
 * Removes the blank line a verbatim environment is written with.
 *
 * LaTeX puts the body of `verbatim` on the line after `\begin{verbatim}`, so
 * every one opens with a newline that is not part of what the author wrote.
 * Only one line is removed at each end, and only when *empty*: trimming all
 * surrounding whitespace would eat meaningful indentation of the first and
 * last lines, and a deliberate blank line inside the block. Left in place,
 * the newline renders as a real empty line at the top of the `<pre>`.
 */
const trimVerbatimEdges = (text) => String(text)
  .replace(/^[ \t]*\r?\n/, '')
  .replace(/\r?\n[ \t]*$/, '');

/** True for a verbatim-family environment, including a fancyvrb custom name. */
const isCodeEnvName = (name, custom) => {
  const bare = name.replace(/\*$/, '');
  return CODE_ENVS.has(bare) || /verbatim$/i.test(bare)
    || (custom ? custom.has(bare) : false);
};

/** Environments that carry no content of their own and are simply not there. */
const DROPPED_ENVS = new Set(['comment']);

/**
 * Math environments KaTeX only understands with their wrapper intact —
 * `&` column markers mean nothing to bare display mode.
 *
 * A few LaTeX environments have no KaTeX equivalent and are mapped to the
 * closest shape that still shows every row. `multline` sets its first line left
 * and its last right; `gather` centres them all. Nothing is dropped, which is
 * what matters: an unreadable environment would take the equation with it.
 * `alignat` is passed through as itself because its column-count argument is
 * part of the syntax.
 */
const ALIGN_MATH_ENVS = {
  align: 'align',
  alignat: 'alignat',
  gather: 'gather',
  split: 'aligned',
  multline: 'gather',
  flalign: 'align',
  eqnarray: 'align',
};

const CALLOUT_ENVS = new Set([
  'theorem', 'lemma', 'proposition', 'corollary', 'definition', 'remark',
  'example', 'proof', 'observation', 'conjecture', 'axiom', 'exercise',
]);

/**
 * Admonitions: banners rather than propositions.
 *
 * The map value is the tone the theme paints it with, which is deliberately
 * separate from the name -- `warning` and `caution` are both yellow, `danger` is
 * red, and a theme can change any of that without the parser knowing.
 *
 * These are not numbered and are not in `CALLOUT_ENVS`, because a warning is not
 * a theorem and must not consume a number from the shared theorem counter.
 */
const ADMONITION_ENVS = {
  notice: 'info',
  note: 'info',
  important: 'info',
  tip: 'tip',
  hint: 'tip',
  warning: 'warn',
  caution: 'warn',
  attention: 'warn',
  danger: 'danger',
};

/** The heading each banner wears when the author does not give it one. */
const ADMONITION_LABELS = {
  notice: 'Note',
  note: 'Note',
  important: 'Important',
  tip: 'Tip',
  hint: 'Hint',
  warning: 'Warning',
  caution: 'Caution',
  attention: 'Attention',
  danger: 'Danger',
};

/**
 * Math environments that may sit inside a running paragraph. Everything else —
 * including `equation`, `align` and friends — ends the paragraph, because
 * LaTeX lets a display start on the very next line after running text.
 */
const INLINE_MATH_ENVS = new Set(['array', 'cases', 'matrix', 'split']);

const PASS_THROUGH_ENVS = new Set([
  'center', 'flushleft', 'flushright', 'quote', 'quotation', 'minipage',
  'figure', 'table', 'sidewaystable',
]);

/** Pass-through environments whose body opens with `[...]` and/or `{...}`. */
const ENV_TAKES_ARGUMENTS = new Set(['minipage', 'center', 'quote', 'quotation']);

/** Drops a leading run of `[...]` and `{...}` arguments from an env body. */
function stripEnvArguments(inner) {
  let at = 0;
  while (at < inner.length) {
    while (at < inner.length && /\s/.test(inner[at])) at++;
    const ch = inner[at];
    if (ch !== '[' && ch !== '{') break;
    let depth = 0;
    let end = -1;
    for (let k = at; k < inner.length; k++) {
      if (inner[k] === ch) depth++;
      else if (inner[k] === (ch === '[' ? ']' : '}') && --depth === 0) {
        end = k + 1;
        break;
      }
    }
    if (end === -1) break;
    at = end;
  }
  return inner.slice(at);
}

const IGNORED_BLOCK_COMMANDS = new Set([
  'noindent', 'centering', 'raggedright', 'raggedleft', 'bigskip', 'medskip',
  'smallskip', 'vspace', 'hspace', 'hrule', 'newpage', 'clearpage',
  'pagebreak', 'linebreak', 'noindent', 'protect', 'pagestyle',
  'setlength', 'addtolength', 'vspace*', 'normalindent',
  // an index entry points at a word; the word is already in the text
  'index', 'glossary', 'labelindex',
  // Beamer's own plumbing: a template or an option set, none of which is content.
  //
  // `\setbeamertemplate{footline}{\sffamily ... \beamercolorbox{...}{footline} ...}`
  // is a definition of a decoration. Reading it as prose printed the lot -- the
  // words "beamer", "footline", "background canvasbg=black", and the author's own
  // name from `\theauthor` -- on the last slide of Fleuret's deck.
  'setbeamertemplate', 'setbeamerfont', 'setbeamercolor', 'setbeamersize',
  'setbeamertemplateoptions', 'addtobeamertemplate', 'setbeamertemplatecolor',
  'newif', 'newtheorem', 'AtBeginDocument', 'AtEndDocument',
  // `\bibliography{dlc}` loads a database; it is not a statement about the
  // document. Read as prose it printed the word "dlc" where the reader expects a
  // list of works, which is the worst place for a stray token on a slide that is
  // supposed to be the references.
  'bibliography', 'bibliographystyle', 'printbibliography', 'nobibliography',
  // `\note[0]{...}` is beamer's speaker note: a note for whoever is presenting,
  // keyed to a slide number. Read as prose it printed the `[0]` and then the note
  // itself on the very slide the note was about, which is notes-to-self set in the
  // middle of the lecture.
  'note',
]);

/**
 * Commands that take two braced arguments, and so print their second one.
 *
 * `\setlength{\headsep}{0.6cm}` reads as "ignore the first group": consuming
 * one group leaves `0.6cm` to be read as the next paragraph.
 */
const TWO_GROUP_COMMANDS = new Set([
  'setlength', 'addtolength', 'setcounter', 'addtocounter',
  'settowidth', 'settoheight', 'newenvironment', 'renewenvironment',
  // Every beamer `set*` command is `\setX{what}{value}`, so one group leaves
  // the value as running text.
  'setbeamercolor', 'setbeamerfont', 'setbeamertemplate', 'setbeamertemplatecolor',
  'setbeamersize', 'addtobeamertemplate',
]);

/**
 * Whether a frame's own text is nothing but a references heading.
 *
 * Beamer's `\bibliographyframe`, and the `\begin{frame}{References}` people write
 * by hand instead, put the word on the slide and let `thebibliography` print the
 * works under it. The bibliography is lifted out of the source and rendered as a
 * section of its own, so all that is left of such a frame is the word itself.
 */
const isReferencesHeading = (text) => /^(references?|bibliography|works\s+cited|literature\s+cited)$/i
  .test(String(text || '').replace(/[\s:.]+$/, '').trim());

/**
 * Whether a frame's body is nothing but a references heading.
 *
 * The bibliography is lifted out and rendered as a section of its own, so a
 * frame holding only the word is empty. The word arrives in the frame's *body*
 * (both title braces empty, heading as one paragraph among the blocks), which
 * is where it is looked for. Exactly one non-empty block; a frame with prose
 * beside the word is a slide somebody wrote, and is left alone.
 */
const isBareReferencesFrame = (blocks) => {
  const said = (blocks || [])
    .filter((b) => b.type !== 'para' || plainText(b.nodes).trim());
  if (said.length !== 1 || said[0].type !== 'para') return false;
  return isReferencesHeading(plainText(said[0].nodes));
};

/**
 * Commands that never produce reader-visible output, and how much to consume.
 *
 * The general principle: a command known never to print is dropped BEFORE its
 * macro body is expanded. Expansion happens first, so a dropped command that
 * expands into unknown commands leaks their arguments as running text; dropping
 * first means the body is never read at all.
 *
 * Three categories, by why they never print:
 * - Markers: `\index`, `\label`, `\dlclabel`, `\hypertarget` and friends name a
 *   position or file an entry; the word they annotate is already in the text.
 *   `\checknbdrafts` is a build-time lint that warns on the console when the
 *   deck holds draft notes — likewise nothing for the reader. (One braced
 *   group each, except `\checknbdrafts` which takes none.)
 * - TeX I/O: `\newwrite` … `\closein` and `\InputIfFileExists` /
 *   `\InputIfExists` / `\IfFileExists` talk to the filesystem at build time.
 *   A file-existence branch cannot be evaluated statically, so all of its
 *   branches are dropped rather than printing both halves of a choice.
 * - Allocation and mode switches: `\newcount`, `\newdimen`, `\newlength`,
 *   `\makeatletter` / `\makeatother`, and the `\immediate` / `\global` /
 *   `\long` / `\protected` prefixes change TeX state and print nothing.
 */
const SILENT_GROUPS = new Map([
  ['index', 1], ['idx', 1], ['label', 1], ['hypertarget', 1],
  ['dlclabel', 1], ['pageref', 1], ['nameref', 1],
  ['varioref', 1], ['VARIoref', 1],
  ['InputIfFileExists', 3], ['InputIfExists', 3], ['IfFileExists', 3],
]);
const SILENT_PREFIXES = new Set([
  'immediate', 'global', 'long', 'protected',
  'makeatletter', 'makeatother', 'checknbdrafts',
]);
const SILENT_ALLOCATIONS = new Set([
  'newwrite', 'newread', 'newcount', 'newdimen', 'newlength',
  'closeout', 'closein',
]);

const isSilentCommand = (name) =>
  SILENT_GROUPS.has(name) || SILENT_PREFIXES.has(name)
  || SILENT_ALLOCATIONS.has(name) || name === 'openout'
  || name === 'openin' || name === 'write';

/**
 * Moves past a never-printing command and everything it consumes, returning
 * the new cursor. `i` sits just past the command name.
 */
function skipSilentCommand(s, i, name) {
  let j = i;
  const skipSpaces = () => { while (j < s.length && /\s/.test(s[j])) j++; };
  const controlSequence = () => {
    skipSpaces();
    const m = /^\\([a-zA-Z@]+|.)/.exec(s.slice(j));
    if (m) j += m[0].length;
  };
  if (SILENT_PREFIXES.has(name)) return j;
  if (SILENT_ALLOCATIONS.has(name)) {
    // `\newwrite\file`: the stream register that follows is state, not text.
    controlSequence();
    return j;
  }
  if (name === 'openout' || name === 'openin') {
    // `\openout\file=name.dlcref`: the register, the `=`, and the filename.
    controlSequence();
    skipSpaces();
    if (s[j] === '=') j++;
    skipSpaces();
    if (s[j] === '{') j = readBalanced(s, j).next;
    else while (j < s.length && !/[\s{}]/.test(s[j])) j++;
    return j;
  }
  if (name === 'write') {
    // `\write\file{...}`: the register, then the one group being written.
    controlSequence();
    skipSpaces();
    if (s[j] === '{') j = readBalanced(s, j).next;
    return j;
  }
  let n = SILENT_GROUPS.get(name) ?? 1;
  while (n-- > 0) {
    skipSpaces();
    if (s[j] !== '{') break;
    j = readBalanced(s, j).next;
  }
  return j;
}

const SECTION_LEVELS = {
  part: 0, chapter: 1, section: 1, subsection: 2, subsubsection: 3,
  paragraph: 4, subparagraph: 5,
};

/** Parses a standalone fragment (a table cell, a caption) as inline content. */
export function parseInlineText(raw) {
  return new Parser(String(raw)).parseInline(String(raw));
}

/**
 * Mutable state that must be shared across every file in one document.
 *
 * Section numbering, equation numbers, float numbers and the label table are
 * all document-global in LaTeX: an `\input` continues the parent document
 * rather than starting a new one. Handing the same object to each parser is
 * what makes `\input` behave.
 */
export function createParseState() {
  return {
    labels: new Map(),
    macros: new Map(),
    // Code environments the preamble declared through fancyvrb, by name. The
    // package makes one out of any name the author likes, so the name has to be
    // read rather than guessed.
    codeEnvs: new Set(),
    tikzStyles: [],
    colors: [],
    bibliography: null,
    equations: 0,
    // Which section we are in, for `(3.1)`-style equation numbers, and whether
    // the document asked for them at all.
    section: 0,
    sectionedEquations: false,
    numberedParas: new Set(),
    floats: 0,
    callouts: 0,
    // environments named by `\newtheorem`, which are callouts rather than prose
    calloutEnvs: new Set(),
    unnumbered: 0,
    sections: [0, 0, 0, 0, 0, 0],
    warnings: [],
    // Beamer slides, numbered 1..N in document order at parse time (see the
    // frame case in parseBlock). One counter for the whole document, so an
    // `\input` continues the sequence rather than restarting it.
    slides: 0,
    // Sibling-deck cross-references for `\dlcref`: ref key -> display string
    // (e.g. `{ 'einstein-summations': '1.5. ``High dimension tensors''' }`),
    // supplied by the caller through the build config. Null means unknown.
    xrefs: null,
  };
}

/**
 * Removes commands that only make sense in a preamble. They are metadata, so
 * a fragment that declares them should contribute them without also printing
 * them as prose.
 */
function stripPreambleCommands(body) {
  return body
    .replace(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '')
    .replace(/\\(?:title|author|date)\s*(?:\[[^\]]*\])?\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
}

/**
 * Commands that define rather than print.
 *
 * A paper that keeps its macros in a header file and pulls it in with `\input`
 * would otherwise print the body of every `\newcommand` — often raw TikZ — into
 * the middle of the text. A definition is not content.
 */
const DEFINITION_CMDS = new Set([
  'newcommand', 'renewcommand', 'providecommand',
  'newenvironment', 'renewenvironment', 'provideenvironment',
  'DeclareMathOperator', 'DeclarePairedDelimiter', 'def', 'let', 'newtoks',
  // The LaTeX3 and etoolbox definitions. An unrecognised `\pretocmd` prints
  // its `#1` body onto the page, so these are consumed as definitions.
  'pretocmd', 'NewDocumentCommand', 'RenewDocumentCommand',
  'ProvideDocumentCommand', 'DeclareDocumentCommand', 'DeclareDocumentEnvironment',
  'NewExpandableDocumentCommand',
]);

/**
 * Swallows a definition command, recording what it defines.
 *
 * A definition is not content: printing the body of every `\newcommand` puts
 * raw TeX in the middle of a sentence. But it is not nothing either — it is how
 * a paper writes its own notation, and the maths typesetter needs to know. So
 * the definition is recorded and expanded later rather than dropped.
 */
function skipDefinition(src, start, name, macros) {
  const def = readDefinition(src, start, name);
  if (!def) return skipToLineEnd(src, start);

  // an environment has no inline form, so there is nothing to record
  const isEnvironment = /environment$/.test(name);
  // The body has its comments stripped on the way in: a stored body keeps its
  // `%` lines otherwise, and they resurface as text when the macro expands.
  if (!isEnvironment && def.name) {
    macros.set(def.name, { params: def.params, body: stripTexComments(def.body) });
  }
  return def.next;
}

/** Forgiving fallback: consume the rest of the line when a definition is odd. */
/** Records a `\tikzset{...}` body and returns the position after it. */
function collectTikzSet(src, i, styles) {
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') return i;
  const g = readBalanced(src, i);
  if (!g) return src.length;
  styles.push(g.text);
  return g.next;
}

/** The command name at `i`, or '' when there is not one. */
function cmdName(src, i) {
  const m = /^\\([a-zA-Z@]+)/.exec(src.slice(i));
  return m ? m[1] : '';
}

function skipToLineEnd(src, i) {
  while (i < src.length && src[i] !== '\n') i++;
  return i;
}


/**
 * Parses one file.
 *
 * With no `state` this is a standalone document and references resolve
 * immediately. A multi-file build passes a shared `state` and resolution is
 * deferred to `resolveAll`, once every file is assembled.
 */
export function parseDocument(
  src, resolveIncludes = null, state = null, readIncludeText = null) {
  const p = new Parser(src, state);
  p.resolveIncludes = resolveIncludes;
  p.readIncludeText = readIncludeText;
  const blocks = p.run();
  if (!state) {
    resolveAll(blocks, p.state.labels, p.state.bibliography);
  }
  return {
    meta: p.meta, labels: p.state.labels, macros: p.state.macros,
    tikzStyles: p.state.tikzStyles, colors: p.state.colors,
    bibliography: p.state.bibliography,
    authorNotes: p.state.authorNotes,
    blocks, warnings: p.state.warnings,
  };
}

/**
 * Resolves every `\ref`/`\cite` in a fully assembled block list, and appends the
 * reference list when the document cites without shipping one.
 *
 * This is the path a multi-file build takes, where labels accumulate across
 * `\input` before anything is resolved; `parseDocument` calls the same code for
 * a standalone file.
 */
export function resolveAll(blocks, labels, bibliography = null) {
  // A document that lists its own references gets numbers; one that only cites
  // gets an honest list of the keys it used.
  const known = new Map();
  for (const entry of bibliography || []) known.set(entry.key, entry);

  // Read *and removed*: these are the paper's own references, written as prose,
  // and they are rendered again as a list. See bibliography.js.
  const adhoc = known.size ? [] : liftAdhocReferences(blocks);
  for (const entry of adhoc) known.set(entry.key, entry);

  // Which entries the list holds, and what number each gets, depends on what the
  // source is -- see orderEntries. It has to be settled before the citations are
  // resolved, because the number a marker shows is decided here.
  const source = bibliography?.length ? bibliography : adhoc;
  const ordered = source.length
    ? orderEntries(source, resolveCitedKeys(blocks, labels))
    : [];
  const numbers = new Map(ordered.map(({ entry, number }) => [entry.key, number]));

  const cited = resolveReferences(blocks, labels, known, numbers);
  if (known.size) linkPlainCitations(blocks, known, numbers, cited);

  // Every numbered frame carries its `Slide N of total` denominator. The total
  // is only known once the whole document — every `\input` — has been seen,
  // so it is stamped here rather than when each frame is parsed.
  assignSlideTotals(blocks);

  if (!blocks.some((b) => b.type === 'references')) {
    const entries = ordered.length
      ? ordered.map(({ entry }) => ({
        key: entry.key, id: `ref-${slugify(entry.key)}`, text: formatEntry(entry),
      }))
      : cited.map((key) => ({ key, id: `ref-${slugify(key)}`, text: null }));
    // Whether the list carries a heading of its own. An inline
    // `thebibliography` is lifted to the end, which can orphan the author's
    // own `References` section as an empty heading -- so the document's own
    // heading wins when it exists, and the list joins it headingless.
    const headed = !blocks.some((b) => b.type === 'section'
      && /^(references?|bibliography|works\s+cited|literature\s+cited|notes)$/i
        .test(String(b.title || '').trim()));
    if (entries.length)
      blocks.push({
        type: 'references', entries, headed,
        resolved: entries.some((e) => e.text)
      });
  }
  return cited;
}

/** Stamps every numbered frame with the document's slide total. */
function assignSlideTotals(blocks) {
  let total = 0;
  const walk = (list, visit) => {
    for (const b of list || []) {
      visit(b);
      if (b.blocks) walk(b.blocks, visit);
      if (b.items) for (const item of b.items) walk(item.blocks, visit);
    }
  };
  walk(blocks, (b) => {
    if (typeof b.slide === 'number' && b.slide > total) total = b.slide;
  });
  if (!total) return;
  walk(blocks, (b) => {
    if (b.kind === 'frame' && typeof b.slide === 'number') b.slideTotal = total;
  });
}

/** Every citation key in the document, in the order it is first cited. */
function resolveCitedKeys(blocks, labels) {
  const order = [];
  const walk = (list) => {
    for (const b of list || []) {
      if (b.type === 'cite') {
        for (const k of b.keys || []) if (!order.includes(k)) order.push(k);
      }
      if (b.nodes) collect(b.nodes, order);
      if (b.blocks) walk(b.blocks);
    }
  };
  const collect = (nodes, into) => {
    for (const n of nodes || []) {
      if (n.type === 'cite')
        for (const k of n.keys || []) if (!into.includes(k)) into.push(k);
      if (n.nodes) collect(n.nodes, into);
    }
  };
  void labels;
  walk(blocks);
  return order;
}

/**
 * Which entries the reference list holds, and in what order.
 *
 * A `thebibliography` is the paper's own finished list: every entry, in the order
 * the paper put them in, numbered the way the paper numbers them. Reading it any
 * other way silently disagrees with the paper's own `[7]`.
 *
 * A `.bib` is a database, so the list has to be derived: the works this document
 * cites, in the order it first cites them. Rendering the whole database is not a
 * long list, it is the wrong list -- the repository behind one lecture of a
 * course holds nine hundred entries, and most of them are about other lectures.
 */
/**
 * The T1 accent commands, as the characters they produce.
 *
 * Authors reach for these constantly in names -- `Fran\c{c}ois`, `Erd\H{o}s`,
 * `\'e` -- and a converter that drops them does not merely lose a diacritic, it
 * spells somebody's name wrong on the page that credits their lecture.
 */
const ACCENTS = {
  "'": (l) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', s: 'ś', z: 'ź', n: 'ń', l: 'ĺ', r: 'ŕ', d: 'ď', t: 'ť' }[l] || l),
  '`': (l) => ({ a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù' }[l] || l),
  '^': (l) => ({ a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', c: 'ĉ', s: 'ŝ', g: 'ĝ', h: 'ĥ', j: 'ĵ', w: 'ŵ', y: 'ŷ' }[l] || l),
  '"': (l) => ({ a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ' }[l] || l),
  '~': (l) => ({ a: 'ã', n: 'ñ', o: 'õ' }[l] || l),
  c: (l) => ({ c: 'ç', s: 'ş', g: 'ğ' }[l] || l),
  v: (l) => ({ c: 'č', s: 'š', z: 'ž', r: 'ř', e: 'ě' }[l] || l),
  H: (l) => ({ o: 'ő', u: 'ű' }[l] || l),
  k: (l) => ({ a: 'ą', e: 'ę' }[l] || l),
  b: (l) => ({ o: 'ő' }[l] || l),
  d: (l) => ({ c: 'ď', e: 'ě' }[l] || l),
  t: (l) => ({ c: 'ť' }[l] || l),
  '.': (l) => ({ z: 'ż', e: 'ė' }[l] || l),
  '=': (l) => ({ a: 'ā', e: 'ē', o: 'ō', u: 'ū' }[l] || l),
  u: (l) => ({ a: 'ă', g: 'ğ' }[l] || l),
};

/**
 * Joins display mathematics the author wrapped across several pieces.
 *
 * A long equation continued in a second `$$ ... $$` straight after the first
 * reads as several disconnected equations when set separately. Nothing but
 * whitespace between two displays is the tell. Both levels join: adjacent
 * display nodes, and adjacent paragraphs holding only displays. Inline maths
 * is left alone.
 */
/**
 * Append a piece to a display, inside a `gathered` once there is more than one.
 *
 * The pieces go inside a `gathered` rather than joined with `\\`: a line break
 * is only legal inside an alignment, so `$$ ... \\ ... $$` is rejected whole
 * by KaTeX, while `gathered` needs no column markers and centres each piece on
 * its own row. Appending into the existing `gathered` matters: three pieces
 * must not nest.
 */
function appendToGathered(block, piece) {
  const part = String(piece).replace(/^\\\s*/, '');
  if (/\\begin\{gathered\}/.test(block.tex)) {
    block.tex = block.tex.replace(/\\end\{gathered\}\s*$/, `\\\\ ${part}\\end{gathered}`);
    return;
  }
  block.tex = `\\begin{gathered}${String(block.tex).replace(/\\\s*$/, '')}`
    + `\\\\ ${part}\\end{gathered}`;
}

export function joinSplitMath(blocks) {
  const isDisplay = (x) => x && x.type === 'math' && x.display;
  // A paragraph holding nothing but displays (blank text nodes between them
  // are the source's line breaks, not content).
  const isBlank = (n) => n && n.type === 'text' && !String(n.value ?? '').trim();
  const onlyDisplay = (b) => {
    if (!b || b.type !== 'para' || !Array.isArray(b.nodes)) return false;
    const real = b.nodes.filter((n) => !isBlank(n));
    return real.length > 0 && real.every(isDisplay);
  };

  const joinNodes = (nodes) => {
    const blank = (n) => n && n.type === 'text' && !String(n.value ?? '').trim();
    const out = [];
    for (const n of nodes) {
      const prev = out.at(-1);
      // Whitespace between two displays is the source's line break, not a
      // paragraph: transparent here, or nothing ever joins.
      if (blank(n)) {
        const after = nodes[nodes.indexOf(n) + 1];
        if (isDisplay(prev) && isDisplay(after)) continue;
        out.push(n);
        continue;
      }
      if (isDisplay(prev) && isDisplay(n) && !prev.numbered && !n.numbered) {
        appendToGathered(prev, n.tex);
        continue;
      }
      out.push(n);
    }
    nodes.length = 0;
    nodes.push(...out);
    return nodes;
  };

  const walk = (list) => {
    for (const b of list) {
      if (Array.isArray(b.nodes)) joinNodes(b.nodes);
      if (Array.isArray(b.blocks)) walk(b.blocks);
      if (Array.isArray(b.items)) for (const it of b.items) walk(it.blocks);
    }
    const out = [];
    for (const b of list) {
      const prev = out.at(-1);
      // Two unnumbered displays, one after the other, are two halves of one
      // equation. This is the shape a split display actually arrives in: a
      // `$$ ... $$` is parsed as a `math` block of its own, so the paragraph merge
      // below -- which only ever looked at paragraphs -- had nothing to match.
      const joinable = (x) => isDisplay(x) && !x.numbered;
      if (joinable(prev) && joinable(b)) {
        appendToGathered(prev, b.tex);
        continue;
      }
      if (onlyDisplay(prev) && onlyDisplay(b)) {
        prev.nodes.push(...b.nodes);
        joinNodes(prev.nodes);
        continue;
      }
      out.push(b);
    }
    list.length = 0;
    list.push(...out);
    return list;
  };

  return walk(blocks || []);
}

function orderEntries(source, cited) {
  if (source.some((e) => e.kind === 'list')) {
    return source.map((entry, i) => ({ entry, number: i + 1 }));
  }
  const wanted = new Set(cited);
  return source
    .filter((entry) => wanted.has(entry.key))
    .map((entry) => ({ entry, number: cited.indexOf(entry.key) + 1 }))
    .sort((a, b) => a.number - b.number);
}

/** Flattens blocks so that `\input` placeholders can be spliced in place. */
export function flattenBlocks(blocks) {
  const out = [];
  const walk = (list) => {
    for (const b of list || []) {
      if (b.type === 'include') {
        if (b.blocks?.length) walk(b.blocks);
        else out.push({ type: 'para', nodes: [{ type: 'text', value: b.notice }] });
      } else out.push(b);
    }
  };
  walk(blocks);
  return out;
}

// ---------------------------------------------------------------- utilities

/**
 * Pulls the `\label{...}` that belongs to an environment out of its body.
 *
 * The label sits inside the body rather than after the closing `\end{...}`, so
 * it has to be found by hand. It must be anchored to the *start* of the body
 * (past any `[optional argument]`): searching loosely would let a theorem claim
 * the `\label{eq:x}` belonging to the equation nested inside it.
 */
function takeLeadingLabel(text) {
  const m = new RegExp(String.raw`^\s*\\label\s*\{`).exec(text);
  if (!m) return { label: null, text };
  const { text: inner, next } = readBalanced(text, m.index + m[0].length - 1);
  return { label: inner.trim(), text: text.slice(next) };
}

/**
 * Fallback for display maths, where `\label{eq:x}` on the last line is just as
 * idiomatic as one right after `\begin{equation}`. Only labels at brace depth
 * zero count, so an `align` will not claim a label from inside a nested
 * `\begin{cases}`.
 */
function takeLastDepthZeroLabel(text) {
  let depth = 0;
  let found = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (depth === 0 && text.startsWith('\\label', i)) {
        let brace = i + 6;
        while (text[brace] === ' ') brace++;
        if (text[brace] === '{') {
          const read = readBalanced(text, brace);
          found = { label: read.text.trim(), at: i, end: read.next };
          i = read.next - 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  if (!found) return { label: null, text };
  return { label: found.label, text: text.slice(0, found.at) + text.slice(found.end) };
}

/** Floats put their label after `\caption`, so look for it from there. */
function takeCaptionLabel(text) {
  const captionAt = text.indexOf(String.raw`\caption`);
  if (captionAt < 0) return { label: null, text };
  const rest = text.slice(captionAt);
  const m = /\\label\s*\{/.exec(rest);
  if (!m) return { label: null, text };
  const at = captionAt + m.index;
  const { text: inner, next } = readBalanced(text, at + m[0].length - 1);
  return { label: inner.trim(), text: text.slice(0, at) + text.slice(next) };
}

/**
 * Splits one table row into cells, understanding `\multicolumn{n}{align}{text}`
 * (which spans n columns) and discarding `\multirow{n}{width}{text}`'s span
 * arguments, which have no HTML meaning.
 */
function splitTableRow(row) {
  const cells = [];
  let i = 0;

  while (i < row.length) {
    while (i < row.length && /\s/.test(row[i])) i++;
    if (i >= row.length) break;

    const mc = /^\\(?:multicolumn)\s*\{(\d+)\}\s*\{[^{}]*\}\s*\{/.exec(row.slice(i));
    if (mc) {
      const { text, next } = readBalanced(row, i + mc[0].length - 1);
      cells.push({ text: text.trim(), colspan: Math.max(1, Number(mc[1])) });
      i = next;
      // Exactly one `&`, the one that ended this cell. Skipping the run of them
      // swallows the empty cells in between, so `& & \multicolumn{2}` loses the gap
      // column the author left and every cell after it sits one place left.
      while (i < row.length && /\s/.test(row[i])) i++;
      if (row[i] === '&') i++;
      continue;
    }

    const mr = /^\\multirow\s*\{[^}]*\}\s*\{[^}]*\}\s*\{/.exec(row.slice(i));
    if (mr) {
      const { text, next } = readBalanced(row, i + mr[0].length - 1);
      cells.push({ text: text.trim() });
      i = next;
      while (i < row.length && /\s/.test(row[i])) i++;
      if (row[i] === '&') i++;
      continue;
    }

    let j = i;
    let depth = 0;
    while (j < row.length) {
      if (row[j] === '\\') { j += 2; continue; }
      if (row[j] === '{') depth++;
      else if (row[j] === '}') depth--;
      else if (row[j] === '&' && depth === 0) break;
      j++;
    }
    cells.push({ text: row.slice(i, j).trim() });
    i = j + 1;
  }
  return cells;
}

/**
 * Removes LaTeX comments from a fragment.
 *
 * `%` comments the rest of the line and never reach the typesetter. KaTeX does
 * honour them, but a commented-out row inside an alignment still reads as an
 * empty final row and takes the whole environment down with it. `\%` is a
 * literal percent and is left alone.
 */
export function stripTexComments(tex) {
  return tex.replace(/(?<!\\)%[^\n]*/g, '');
}

/**
 * Pulls sizing out of a `\includegraphics[...]` option list. Only the keys
 * that map onto CSS are kept.
 *
 * `trim` is the exception: it is kept because a figure exported from a drawing
 * tool usually carries a wide margin of blank space, and trimming it is the
 * difference between a diagram that reads and one that floats in white. The
 * units are TeX's `bp`, one seventy-second of an inch, in left/bottom/right/top
 * order.
 */
function parseGraphicsOptions(optionText) {
  const pick = (key) => {
    const m = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*\\{?([^,}\\]]+)`).exec(optionText);
    return m ? m[1].trim() : null;
  };
  const opts = {};
  for (const key of ['width', 'height', 'scale']) {
    const v = pick(key);
    if (v) opts[key] = v.replace(/^\\textwidth$/, '\\linewidth');
  }
  const totalHeight = pick('totalheight');
  if (totalHeight && !opts.height) opts.height = totalHeight;

  const trim = pick('trim');
  if (trim) {
    const nums = trim.split(/[\s,{}]+/).filter(Boolean).map((n) => {
      // `0 0 0 36` is bp; anything with a unit is left to the browser
      const v = parseFloat(n);
      return Number.isFinite(v) && /^[\d.]+$/.test(n) ? v : null;
    });
    if (nums.length === 4 && nums.every((n) => n !== null)) {
      opts.trim = nums;
      if (/clip/.test(optionText)) opts.clip = true;
    }
  }
  return Object.keys(opts).length ? opts : null;
}

/** Like the cursor-based `readUntilEnd`, but over a plain string. */
function extractEnv(text, name) {
  const re = new RegExp(`\\\\(begin|end)\\s*\\{\\s*${name.replace(/\*/g, '\\*')}\\s*\\}`, 'g');
  let depth = 0;
  let start = -1;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (start < 0) {
      if (m[1] === 'begin') { depth = 1; start = re.lastIndex; }
      continue;
    }
    depth += m[1] === 'begin' ? 1 : -1;
    if (depth === 0) return { inner: text.slice(start, m.index), next: re.lastIndex };
  }
  return { inner: text.slice(start < 0 ? 0 : start), next: text.length };
}

/** Reads a `{...}` group starting at `i`, honouring `\{` and `\}` escapes. */
/**
 * Reads a `[...]` optional argument.
 *
 * `readBalanced` only knows braces, and an optional argument is in brackets.
 * Brackets nest inside it (`[c]` is inside `[t]`'s sibling, and a `\makebox` can
 * carry both), so the depth is tracked the same way.
 */
function readOptional(s, i) {
  if (s[i] !== '[') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0)
      return { text: s.slice(i + 1, j), next: j + 1 };
  }
  return { text: s.slice(i + 1), next: s.length };
}

function readBalanced(s, i) {
  if (s[i] !== '{') return { text: '', next: i };
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0)
      return { text: s.slice(i + 1, j), next: j + 1 };
  }
  return { text: s.slice(i + 1), next: s.length };
}

function slugify(text) {
  return String(text)
    // keep the command name: `\alpha` and `\beta` must not both vanish and
    // collide into the same anchor
    .replace(/\\([a-zA-Z]+)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'section';
}

/**
 * A readable form of a maths fragment, for places that cannot render maths:
 * section titles, the table of contents, `aria-label`s.
 *
 * `\alpha_i` becomes `αᵢ` rather than the raw source, which is what a reader
 * expects to see in a navigation list.
 */
const MATH_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓',
  leq: '≤', geq: '≥', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
  rightarrow: '→', to: '→', leftarrow: '←', mapsto: '↦', iff: '⟺',
  implies: '⟹', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆',
  cup: '∪', cap: '∩', forall: '∀', exists: '∃', neg: '¬', ell: 'ℓ',
  degree: '°', angle: '∠', therefore: '∴', ldots: '…', dots: '…',
};

const SUPERSCRIPTS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', 'n': 'ⁿ', 'i': 'ⁱ' };
const SUBSCRIPTS = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', 'i': 'ᵢ', 'j': 'ⱼ', 'n': 'ₙ', 'a': 'ₐ' };

/** Turns a TeX fragment into text a navigation list can show. */
export function latexToPlain(tex) {
  let out = String(tex);

  // \frac{a}{b} -> a/b before the generic pass flattens the braces
  for (let i = 0; i < 4 && /\\[dt]?frac/.test(out); i++) {
    out = out.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2');
  }

  // \command -> symbol, longest names first so \partial beats \part
  out = out.replace(/\\([a-zA-Z]+)/g, (match, name) => {
    if (MATH_SYMBOLS[name]) return MATH_SYMBOLS[name];
    if (name === 'sqrt') return '√';
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') return '/';
    if (name === 'left' || name === 'right' || name === 'big'
      || name === 'displaystyle') return '';
    // an unknown macro contributes nothing rather than its source
    return '';
  });

  // sub/superscripts, braced or single
  out = out.replace(/_\{([^{}]*)\}/g, (_, b) => [...b].map((c) => SUBSCRIPTS[c] ?? c).join(''));
  out = out.replace(/\^\{([^{}]*)\}/g, (_, b) => [...b].map((c) => SUPERSCRIPTS[c] ?? c).join(''));
  out = out.replace(/_(\w)/g, (_, c) => SUBSCRIPTS[c] ?? c);
  out = out.replace(/\^(\w)/g, (_, c) => SUPERSCRIPTS[c] ?? c);

  return out.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** Like `plainText` but leaves maths as its TeX source. */
function rawPlainText(nodes) {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.value;
      if (n.nodes) return rawPlainText(n.nodes);
      if (n.type === 'math') return n.tex;
      if (n.type === 'code' && n.verbatim !== undefined) return n.verbatim;
      return '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function plainText(nodes) {
  return nodes
    .map((n) => {
      if (n.type === 'text') return n.value;
      if (n.nodes) return plainText(n.nodes);
      if (n.type === 'math') return latexToPlain(n.tex);
      if (n.type === 'code' && n.verbatim !== undefined) return n.verbatim;
      return '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * LaTeX's escaped punctuation, in plain form. Nothing here is HTML-escaped:
 * the renderer does that once, so escaping here would double it.
 */
const ESCAPES = {
  '&': '&', '%': '%', '$': '$', '_': '_', '#': '#', '{': '{', '}': '}',
  '~': ' ', '^': '^', '\\': '\\',
};

// ------------------------------------------------------------------- parser

class Parser {
  constructor(src, state = null) {
    this.s = String(src).replace(/\r\n?/g, '\n');
    this.i = 0;
    this.meta = {};
    this.state = state ?? createParseState();
    this.resolveIncludes = null;  // (target) -> { blocks, meta } | null
    this.readIncludeText = null;  // (target) -> string | null
  }

  run() {
    const beginDoc = /\\begin\s*\{\s*document\s*\}/.exec(this.s);
    // Everything before `\begin{document}` is preamble; the rest is body. A file
    // with no `\begin{document}` at all — a fragment pulled in by `\input`, or a
    // snippet — is all body, but its `\title` and friends are still read.
    const preamble = beginDoc ? this.s.slice(0, beginDoc.index) : this.s;
    // `\bibliography{...}` normally sits at the *end* of a document, after the
    // body, so the whole source is scanned rather than the preamble
    this.loadBibliography(this.s);
    if (beginDoc) this.s = this.s.slice(beginDoc.index + beginDoc[0].length);

    // The preamble is skipped by the block reader, but it is where a paper
    // defines its own notation, its TikZ styles and its colour names. Papers
    // also keep those in files pulled in with `\input`, so the preamble's
    // inputs are expanded first -- otherwise a header full of definitions is
    // invisible, and every macro it declares reaches the page as text.
    const expanded = this.readIncludeText
      ? this.expandPreambleInputs(preamble)
      : preamble;
    collectDefinitions(
      expanded, this.state.macros, this.state.tikzStyles, this.state.colors,
      this.state.codeEnvs);
    // The preamble is skipped by the block reader, but it is where a paper
    // defines its own notation. Without this, every macro defined up there
    // reaches the typesetter as literal characters.
    collectDefinitions(
      preamble, this.state.macros, this.state.tikzStyles, undefined,
      this.state.codeEnvs);

    this.i = 0;
    // `\thanks` on an author name is a footnote, and the NIPS classes use it for
    // equal contribution and listing order. Collected here so the byline can
    // carry a marker and the note can go to the bottom with the rest.
    this.state.authorNotes = [];
    // `\title`, `\author` and `\date` are read from the whole document, not
    // just the preamble: LaTeX does not require them there, and a document
    // declaring them after `\begin{document}` would otherwise publish with no
    // title or author at all.
    // `\newtheorem{Name}[counter]{}` in the preamble declares a numbered paragraph.
  //
  // Read from the preamble text rather than from `parseBlock`, because a
  // `\newtheorem` in the preamble is removed as a preamble command before any
  // block is parsed -- so the case in `parseBlock` never sees it, and the
  // environments it names were treated as unknown and taken apart.
  for (const m of preamble.matchAll(/\\(?:new|renew|provide)theorem\*?\s*\{([^{}]*)\}(?:\s*\[[^\]]*\])?\s*\{\s*\}/g)) {
    const name = m[1].trim();
    if (name) this.state.numberedParas.add(name);
  }
  if (/\\(?:numberwithin|numberwithin\*|setcounter\s*\{\s*equation\s*\})/.test(preamble)
      || /\\numberwithin\s*\{\s*equation\s*\}/.test(this.s)) {
    this.state.sectionedEquations = true;
  }
  const beforeMaketitle = this.s
      .slice(0, (/\\maketitle/.exec(this.s) || { index: this.s.length }).index);
    const fields = `${preamble}\n${beforeMaketitle}`;

    const authorRaw = /\\author\s*(?:\[[^\]]*\])?\s*\{/.exec(fields);
    let authors = null;
    if (authorRaw) {
      const read = readBalanced(fields, authorRaw.index + authorRaw[0].length - 1);
      if (read) authors = this.authorEntries(read.text);
    }
    this.meta = {
      title: this.preambleField(fields, 'title'),
      author: authors
        ? authors.authors.map((a) => [a.name, ...a.detail].join(' / ')).join('; ')
        : this.preambleField(fields, 'author', this.state.authorNotes),
      authors,
      date: this.preambleField(fields, 'date'),
      documentclass: (/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*([^}]*)/.exec(preamble) || [, ''])[1].trim(),
    };
    // in a fragment those commands would otherwise appear as body text
    this.s = stripPreambleCommands(this.s);

    // an inline `thebibliography` (this is what a .bbl file contains)
    const bib = parseThebibliography(this.s);
    if (bib.length) {
      this.state.bibliography = bib;
      this.s = this.s.replace(/\\begin\s*\{\s*thebibliography\s*\}[\s\S]*?\\end\s*\{\s*thebibliography\s*\}/, '');
    }
    const blocks = this.parseBlocks(
      () => this.atEnd() || this.match('\\end{document}') || this.match('\\end {document}'),
    );
    // A long equation is often written as several `$$ ... $$` in a row. Set
    // separately they read as several equations.
    joinSplitMath(blocks);
    return blocks;
  }

  /**
   * Splices `\input` files into the preamble so their definitions are seen.
   *
   * Only the preamble, and only for reading definitions -- the body is handled
   * properly by the block reader, which splices includes in place.
   */
  expandPreambleInputs(preamble) {
    let text = preamble;
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      text = text.replace(/\\(?:input|include)\s*\{([^}]*)\}/g, (whole, target) => {
        if (whole.trimStart().startsWith('%')) return whole;
        let body;
        try { body = this.readIncludeText(target.trim()); } catch { body = null; }
        if (body == null) return whole;
        changed = true;
        // `\bibliography{refs}` usually sits in an included file (class,
        // header, style sheet) rather than the main source, which is also
        // scanned for it.
        this.loadBibliography(body);
        return `
${body}
`;
      });
      if (!changed) break;
    }
    return text;
  }

  /**
   * Reads the bibliography a document points at.
   *
   * `\bibliography{refs}` names a BibTeX database that sits beside the source.
   * Finding it is what turns `[hochreiter1997]` into a number and a link.
   */
  loadBibliography(text) {
    const m = /\\bibliography\s*\{([^}]*)\}/.exec(text);
    if (!m) return;
    if (!this.readIncludeText) return;
    const entries = [];
    for (const name of m[1].split(',').map((n) => n.trim()).filter(Boolean)) {
      const stem = name.replace(/\.bib$/, '');
      let raw = null;
      // BibTeX resolves a database relative to the file that names it, but a
      // paper's style package usually sits in a subdirectory while the database
      // sits beside the document. Both are tried.
      for (const candidate of [`${stem}.bib`, stem]) {
        try { raw = this.readIncludeText(candidate); } catch { raw = null; }
        if (raw && raw.includes('@')) break;
        raw = null;
      }
      if (raw) entries.push(...parseBibFile(raw));
      else this.state.warnings.push(`bibliography database "${name}" was not found beside the document`);
    }
    if (entries.length)
      this.state.bibliography = [...(this.state.bibliography || []), ...entries];
  }

  /**
   * Reads `\author{...}` as the list of authors it is.
   *
   * One entry per author -- name, affiliation, address -- separated by `\\`
   * and by `\And`, with `\thanks` / `\footnotemark` on the names. Notes are
   * collected in footnote order, which decides each mark's symbol:
   * `\footnotemark[1]` is the first note, `\thanks` the next one.
   */
  authorEntries(text) {
    const SYMBOLS = ['*', '\u2020', '\u2021'];
    const notes = [];
    let last = 0;

    // `\thanks{X}` claims the next footnote number; `\footnotemark[n]` names
    // one. The block is walked in order, so numbering comes out right.
    const notesIn = (chunk) => {
      const marks = [];
      const re = /\\thanks\s*\{|\\footnotemark\s*(?:\[\s*(\d+)\s*\])?/g;
      let m;
      while ((m = re.exec(chunk)) !== null) {
        if (m[0].startsWith('\\thanks')) {
          const read = readBalanced(chunk, m.index + m[0].length - 1);
          if (!read) break;
          notes.push(plainText(this.parseInline(read.text)).trim());
          last = notes.length;
          marks.push({ n: last, symbol: SYMBOLS[last - 1] || String(last) });
          re.lastIndex = read.next;
        } else {
          const n = m[1] ? Number(m[1]) : last;
          if (n) marks.push({ n, symbol: SYMBOLS[n - 1] || String(n) });
        }
      }
      return marks;
    };

    // Authors are separated by `\And`, not by `\\`: `\\` ends a *line*
    // within one author (name, affiliation, address).
    const chunks = text
      .split(/\\(?:AND|And|and)\b|\{\s*\\(?:AND|And|and)\s*\}/)
      .map((c) => c.trim())
      .filter(Boolean);

    const tidy = (t) => plainText(this.parseInline(
      t.replace(/\\(?:hspace|vspace)\s*\{[^{}]*\}/g, ' ').replace(/\\L\b/g, '\u0141'),
    )).replace(/\s+/g, ' ').trim();

    return {
      notes,
      authors: chunks.map((chunk) => {
        const marks = notesIn(chunk);
        // The marks come off the name, and `\thanks` takes its whole braced
        // body with it: dropping only the command name leaves the note's text
        // in the middle of the author's name.
        let bare = '';
        let at = 0;
        for (const mm of [...chunk.matchAll(/\\thanks\s*\{|\\footnotemark\s*(?:\[\s*\d+\s*\])?/g)]) {
          bare += chunk.slice(at, mm.index);
          at = mm.index + mm[0].length;
          if (mm[0].startsWith('\\thanks')) {
            const read = readBalanced(chunk, at - 1);
            if (read) at = read.next;
          }
        }
        bare += chunk.slice(at);
        const lines = bare.split(/\\\\/).map(tidy).filter(Boolean);
        const name = lines.shift() || '';
        return { name, detail: lines, marks };
      }).filter((a) => a.name || a.detail.length),
    };
  }

  /**
   * Reads `\title`, `\author` or `\date` as plain text.
   *
   * `collect` receives any footnote found on the way: classes put `\thanks`
   * inside `\author`, and flattening that text into the byline turns the
   * author line into one long run-on, so footnotes are taken out and kept.
   */
  preambleField(preamble, field, collect = null) {
    const m = new RegExp(`\\\\${field}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`).exec(preamble);
    if (!m) return '';
    const { text } = readBalanced(preamble, m.index + m[0].length - 1);
    const nodes = this.parseInline(text);
    // `\\` in an author block is a line the author asked for: a name, then an
    // affiliation, then an address. Flattened to spaces, a NIPS byline becomes
    // one long run-on sentence with four authors, four affiliations and four
    // addresses in a row. The break is kept as a newline so the byline can put
    // it back.
    const flat = (list) => plainText(list)
      .replace(/\\\\(?:\s*\[\s*[^\]]*\s*\])?/g, '\n')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    if (!collect) return flat(nodes);
    return flat(nodes.filter((n) => {
      if (n.type !== 'footnote') return true;
      collect.push(plainText(n.nodes));
      return false;
    }));
  }

  atEnd() { return this.i >= this.s.length; }

  match(literal) {
    if (this.s.startsWith(literal, this.i)) { this.i += literal.length; return true; }
    return false;
  }

  /** Skip whitespace, blank lines and `%` comments. */
  skipTrivia() {
    for (;;) {
      const before = this.i;
      while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
      if (this.s[this.i] === '%') {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      }
      if (this.i === before) return;
    }
  }

  // ------------------------------------------------------------------ blocks

  parseBlocks(stop) {
    const blocks = [];
    for (;;) {
      this.skipTrivia();
      if (stop()) break;
      const before = this.i;
      const block = this.parseBlock(stop);
      if (block) blocks.push(...[].concat(block));
      if (this.i === before) this.i++; // guarantee progress
    }
    return blocks;
  }

  parseBlock(stop) {
    if (this.match('\\maketitle')) return { type: 'maketitle' };

    // `\input` / `\include` — replaced later by the builder, which knows the
    // file layout; the parser only records what was asked for.
    const include = /^\\(input|include)(?![a-zA-Z])\s*/.exec(this.s.slice(this.i));
    if (include) {
      // stop before the brace: readGroupText consumes the group itself
      this.i += include[0].length;
      const target = this.readGroupText().trim();
      if (this.resolveIncludes) {
        const result = this.resolveIncludes(target);
        if (result) {
          // an included file may supply title/author/date; fill only gaps. Done
          // before the block check, because a file holding nothing but
          // `\title{...}` parses to zero blocks yet still has something to say.
          for (const key of ['title', 'author', 'date']) {
            if (!this.meta[key] && result.meta?.[key])
              this.meta[key] = result.meta[key];
          }
          if (result.blocks?.length)
            return { type: 'include', target, blocks: result.blocks };
        }
        return {
          type: 'include',
          target,
          notice: `[latex2web: \\${include[1]}{${target}} was not resolved]`,
        };
      }
      return { type: 'include', target, notice: `[latex2web: \\${include[1]}{${target}} skipped]` };
    }

    // A beamer frame is a structural unit, not prose: the deck's equivalent
    // of a section. Beamer's shape is `\begin{frame}[<overlay spec>]...`: the
    // optional argument follows the environment name, so the pattern reads it
    // there rather than inside the braces.
    const frame = /^\\begin\s*\{\s*(frame|slide)\s*\}\s*(?:\[([^\]]*)\])?/.exec(this.s.slice(this.i));
    if (frame) {
      // step past `\begin{frame}[opts]` first: `readUntilEnd` counts from the
      // cursor, so leaving it on the opening tag would count that tag as a
      // nesting level and never find the end
      this.i += frame[0].length;
      let nodes = [];
      // beamer's frame takes its title as a mandatory argument, so
      // `\begin{frame}{Attention}` is a titled slide. A second argument is the
      // subtitle and is dropped.
      for (let arg = 0; arg < 2; arg++) {
        let j = this.i;
        while (j < this.s.length && /\s/.test(this.s[j])) j++;
        if (this.s[j] !== '{') break;
        const g = readBalanced(this.s, j);
        if (!g) break;
        if (arg === 0 && g.text.trim()) nodes = this.parseInline(g.text);
        this.i = g.next;
      }
      const { inner: frameBody, next } = this.readUntilEnd(frame[1]);
      this.i = next;
      // Beamer numbers all but `[plain]` frames and frames printing the
      // bibliography; those take no slide number. Every other frame counts
      // exactly once in document order (overlays share their frame's number).
      const plain = /(^|[\s,])plain($|[\s,])/.test(frame[2] || '');
      const bibliography = /\\bibliography\s*\{/.test(frameBody);
      const slide = (!plain && !bibliography)
        ? (this.state.slides = (this.state.slides ?? 0) + 1)
        : null;
      const taken = takeLeadingLabel(frameBody);
      let body = taken.text;
      // `\frametitle{...}` is the other spelling of the same thing
      if (!nodes.length) {
        const titleMatch = /\\frametitle\s*(?:\[[^\]]*\])?\s*\{/.exec(body);
        if (titleMatch) {
          const g = readBalanced(body, titleMatch.index + titleMatch[0].length - 1);
          if (g) {
            nodes = this.parseInline(g.text);
            body = body.slice(0, titleMatch.index) + body.slice(g.next);
          }
        }
      }
      const title = plainText(nodes);
      const id = slugify(`frame-${title || this.state.floats + 1}`);
      this.state.floats++;
      this.registerLabel(taken.label, { id, kind: 'frame' });
      const blocks = this.parseSub(body);
      // Beamer's own references slide, dropped rather than rendered: the
      // bibliography is lifted out and rendered as a section of its own, so
      // this frame holds only the word. Dropped only when the frame says
      // nothing else.
      if (isBareReferencesFrame(blocks)) return null;
      return {
        type: 'section',
        level: 1,
        kind: 'frame',
        number: '',
        id,
        nodes,
        title,
        // a frameless frame is still a container: it keeps its figures and text
        // together under one anchor instead of merging into the previous slide
        blocks,
        untitled: !title,
        // Whether beamer numbers this frame, and which number it carries.
        // `null` keeps it out of the numbered sequence (and the contents).
        plain,
        slide,
      };
    }

    // A macro whose body holds an environment is a figure, not shorthand for
    // words: the body is spliced into the source at the point of use so it
    // parses as the environment it is.
    const macro = this.state.macros.get(cmdName(this.s, this.i));
    if (macro && /\\begin\s*\{/.test(macro.body) && (this.state.splices ?? 0) < 6) {
      // A heading inside a spliced body is the macro's *argument*, not its
      // own: the `\section` is stripped (a divider must not renumber the
      // document) but its text is kept as the divider's title, substituted
      // with the call's arguments below.
      const rawBody = stripTexComments(macro.body);
      let dividerRaw = null;
      const dividerMatch = /\\section\*?\s*\{/.exec(rawBody);
      if (dividerMatch) {
        const g = readBalanced(rawBody, dividerMatch.index + dividerMatch[0].length - 1);
        if (g) dividerRaw = g.text;
      }
      const body = rawBody.replace(
        /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{[^{}]*\}/g,
        '',
      );
      const head = /^\\[a-zA-Z@]+\*?/.exec(this.s.slice(this.i))[0];
      // The call's own arguments, substituted for #1..#n: the call site's
      // groups are consumed here, so they never parse as stray paragraphs.
      let at = this.i + head.length;
      const args = [];
      for (let a = 0; a < (macro.params || 0); a++) {
        while (at < this.s.length && /\s/.test(this.s[at])) at++;
        if (this.s[at] !== '{') break;
        const g = readBalanced(this.s, at);
        args.push(g.text);
        at = g.next;
      }
      // The divider title, with the same substitution -- and only when every
      // parameter resolved, so a stray `#2` never becomes a heading.
      let dividerTitle = dividerRaw
        ? dividerRaw.replace(/#(\d)/g, (_, d) => (args[Number(d) - 1] ?? '')) : null;
      if (dividerTitle && (/#\d/.test(dividerTitle) || !dividerTitle.trim())) dividerTitle = null;
      // The copy the frame body prints substitutes to nothing when it is the
      // divider's own parameter, so the title shows once as the heading.
      const dividerArg = dividerTitle
        ? (/\\section\*?\s*\{#(\d)\}/.exec(rawBody) || [])[1] : null;
      const spliced = body.replace(/#(\d)/g, (_, d) =>
        (dividerArg && d === dividerArg ? '' : (args[Number(d) - 1] ?? '')));
      this.s = this.s.slice(0, this.i) + spliced + this.s.slice(at);
      this.state.splices = (this.state.splices ?? 0) + 1;
      try {
        // The spliced body may open with whitespace before its `\begin{frame}`;
        // without this the first parse returns nothing and the frame — and the
        // divider title meant for it — is missed.
        this.skipTrivia();
        const splicedBlock = this.parseBlock(stop);
        if (dividerTitle) {
          for (const candidate of [].concat(splicedBlock || [])) {
            if (candidate && candidate.kind === 'frame') {
              candidate.nodes = this.parseInline(dividerTitle.trim());
              candidate.title = plainText(candidate.nodes);
              candidate.untitled = false;
              candidate.divider = true;
            }
          }
        }
        return splicedBlock;
      } finally { this.state.splices -= 1; }
    }

    // sectioning
    const sec = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?/.exec(this.s.slice(this.i));
    if (sec) {
      this.i += sec[0].length;
      this.skipTrivia();
      const level = SECTION_LEVELS[sec[1]];
      // A star means no number and no counter step.
      const starred = sec[0].endsWith('*');
      if (!starred) {
        this.state.sections[level]++;
        for (let l = level + 1; l < this.state.sections.length; l++) this.state.sections[l] = 0;
      }
      const number = starred
        ? ''
        : this.state.sections.slice(0, level + 1).filter((n) => n > 0).join('.');
      // The top-level section in force, for `(3.1)`-style equation numbers. A
      // starred section leaves the counter where the last real one put it, and
      // `\numberwithin{equation}{section}` resets the equation counter on each
      // new section.
      if (level === 1 && !starred) {
        if (this.state.sectionedEquations && this.state.sections[1] !== this.state.section) {
          this.state.equations = 0;
        }
        this.state.section = this.state.sections[1];
      }
      const titleRaw = this.readGroupText();
      const nodes = this.parseInline(titleRaw);
      const title = plainText(nodes);
      // the anchor comes from the raw source, so `#section-...` spells the
      // heading the way it was written rather than as prettified symbols
      const id = slugify(`${sec[1]}-${rawPlainText(nodes)}`); if (0) {}
      void id;
      this.registerLabel(this.readTrailingLabel(), { id, number, title, kind: 'section' });
      return { type: 'section', level, kind: sec[1], number, id, nodes, title };
    }

    // environments
    const env = /^\\begin\s*\{\s*([a-zA-Z*]+)\s*\}/.exec(this.s.slice(this.i));
    if (env) {
      this.i += env[0].length;
      return this.parseEnv(env[1]);
    }

    if (this.match('\\[')) {
      const end = this.s.indexOf('\\]', this.i);
      const tex = (end < 0 ? this.s.slice(this.i) : this.s.slice(this.i, end)).trim();
      this.i = end < 0 ? this.s.length : end + 2;
      return this.mathBlock(tex, false); // `\[ \]` is unnumbered in LaTeX
    }

    // block-level commands that produce nothing
    const cmd = /^\\([a-zA-Z@]+)\*?/.exec(this.s.slice(this.i));
    if (cmd && DEFINITION_CMDS.has(cmd[1])) {
      if (cmd[1] === 'tikzset') {
        this.i = collectTikzSet(this.s, this.i + cmd[0].length, this.state.tikzStyles);
        return null;
      }
      this.i = skipDefinition(this.s, this.i + cmd[0].length, cmd[1], this.state.macros);
      return null;
    }
    if (cmd && /^(?:definecolor|colorlet|providecolor|pagecolor)$/.test(cmd[1])) {
      const def = readColorDefinition(this.s, this.i + cmd[0].length);
      if (def && def.text.split('}{').length === 3) {
        this.state.colors.push(`\\${cmd[1]}{${def.text}}`);
        this.i = def.next;
        return null;
      }
      this.i = def ? def.next : this.i + cmd[0].length;
      return null;
    }

    // `\mode<...>{...}` -- beamer's own condition, and the angle list is not
    // text. `\mode` is a plain TeX primitive, not something expandable, so it
    // is read here. `all`, `presentation` and `beamer` show; `handout` and
    // bare frame-number lists do not. A mixed list is a union: any hit shows.
    if (cmd && cmd[1] === 'mode') {
      this.i += cmd[0].length;
      while (/^\s/.test(this.s.slice(this.i))) this.i++;
      const conds = /^<([^>]*)>/.exec(this.s.slice(this.i));
      if (conds) this.i += conds[0].length;
      // Beamer joins conditions with `|` (union) and `,` (intersection): both
      // split, any hit shows.
      const show = !conds
        || conds[1].split(/[|,]/).some((c) => /^(all|presentation|beamer)$/.test(c.trim()));
      const body = this.readGroupText();
      if (show && body.trim()) {
        const blocks = this.parseSub(body);
        return blocks.length === 1 ? blocks[0] : { type: 'group', blocks };
      }
      return null;
    }

    // `\rawsrcexcerpt{file}{start}{end}` on a line of its own is a block of
    // code, not a paragraph: claimed here before the paragraph reader takes
    // the line.
    if (cmd && cmd[1] === 'rawsrcexcerpt') {
      this.i += cmd[0].length;
      this.skipTrivia();
      const file = this.readGroupText();
      const startMark = this.readGroupText();
      const endMark = this.readGroupText();
      // Two trailing optionals (indent and width), not content.
      this.skipTrivia();
      if (this.s[this.i] === '[') this.i = this.skipOptionalArg(this.i);
      this.skipTrivia();
      if (this.s[this.i] === '[') this.i = this.skipOptionalArg(this.i);
      // `sourceExcerpt` answers in the *inline* shape; a block position needs
      // the `code` shape (the `<pre>` in a bar), which has a renderer case.
      const block = this.sourceExcerpt(file, startMark, endMark);
      return { type: 'code', tex: block.tex, lang: block.lang || 'text' };
    }

    if (cmd && IGNORED_BLOCK_COMMANDS.has(cmd[1])) {
      this.i += cmd[0].length;
      const opt = /^\s*\[/.test(this.s.slice(this.i));
      if (opt) this.i = this.skipOptionalArg(this.i);
      this.readGroupText();
      // ...and a second one, for the commands that have two.
      if (TWO_GROUP_COMMANDS.has(cmd[1])) this.readGroupText();
      return null;
    }

    return this.parseParagraph(stop);
  }

  mathBlock(tex, numbered, label) {
    const number = numbered ? ++this.state.equations : 0;
    // `(3.1)` rather than `7`, when the document asked for it
    // (`\numberwithin{equation}{section}`). `number` stays the plain counter
    // (what `\ref` resolves to); `shown` is what the reader sees.
    const shown = this.state.sectionedEquations && this.state.section > 0
      ? `${this.state.section}.${number}`
      : String(number);
    const id = numbered ? `eq-${shown.replace('.', '-')}` : `eq-u${++this.state.unnumbered}`;
    if (label === undefined) label = this.readTrailingLabel();
    if (label) this.registerLabel(label, { id, number, kind: 'equation' });
    return { type: 'math', display: true, tex, numbered, number, shown, id };
  }

  parseParagraph(stop) {
    const start = this.i;
    let j = this.i;
    let depth = 0;
    let inMath = false;
    let mathDelim = '';

    while (j < this.s.length) {
      const c = this.s[j];

      if (c === '\\') {
        const rest = this.s.slice(j);

        // `\verb|...|` may contain anything at all, including something that
        // looks like `\input` or `\begin`. Skip the whole run.
        const verb = /^\\verb\*?([^A-Za-z\s])/.exec(rest);
        if (verb) {
          const delim = verb[1];
          const close = rest.indexOf(delim, verb[0].length);
          j += close < 0 ? rest.length : close + 1;
          continue;
        }

        // An environment ends the paragraph at any brace depth: a bare brace
        // group does not contain it (a claim set as `{\bf ...}` still breaks
        // for its display). The depth guard stays for genuinely inline
        // constructs such as sectioning inside `{\bf ...}`.
        if (!inMath && /^\\begin\s*\{/.test(rest)) {
          const e = /^\\begin\s*\{\s*([a-zA-Z*]+)/.exec(rest);
          if (e) {
            const name = e[1];
            if (!INLINE_MATH_ENVS.has(name.replace(/\*$/, '')) && !isCodeEnvName(name, this.state.codeEnvs)) break;
          }
        }
        // stop before a block-level construct
        if (!inMath && depth === 0) {
          if (/^\\[a-zA-Z*]+\s*\{/.test(rest) && /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|maketitle|item)\b/.test(rest)) break;
          if (/^\\(input|include)(?![a-zA-Z])\s*\{/.test(rest)) break;
          if (/^\\\[/.test(rest)) break;
          if (/^\\end\s*\{document\}/.test(rest)) break;
        }
        j += 2;
        continue;
      }

      if (c === '$') {
        if (!inMath) { inMath = true; mathDelim = this.s.startsWith('$$', j) ? '$$' : '$'; j += mathDelim.length; }
        else if (this.s.startsWith(mathDelim, j)) { inMath = false; j += mathDelim.length; }
        else j++;
        continue;
      }

      if (depth === 0 && !inMath) {
        // blank line ends the paragraph
        if (c === '\n') {
          const after = this.s.slice(j + 1);
          const nl = /^\n/.test(after);
          if (nl) break;
        }
      }

      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
      j++;
    }

    const raw = this.s.slice(start, j);
    this.i = j;
    let trimmed = raw.trim();
    if (!trimmed) return null;
    // A paragraph cannot begin with a closing brace: the group was opened in
    // an earlier block (before a display the reader stopped at), so the brace
    // shutting it strands at the start of whatever comes next. Only the
    // leading run is removed and only when nothing else is left; a brace
    // mid-sentence is the author's own grouping and stays.
    //
    // A run of nothing but braces and space is not a paragraph either: it is
    // the closing punctuation of groups already shown (a spliced diagram's
    // `\makebox{...}` leaves `}\n}` behind once taken out).
    if (/^[\s~{}]*$/.test(trimmed)) return null;

    // A leading run of closers shuts groups opened before the display: taken
    // off before the count below, which would otherwise remove the wrong one.
    trimmed = trimmed.replace(/^\}+[\s~]*/, '');
    if (!trimmed) return null;

    // Unbalanced braces in a paragraph are not the author's grouping: the
    // group enclosing a display was opened in an earlier block, so its closer
    // sits mid-paragraph with nothing to match. Count the braces the paragraph
    // did not open and take that many out; a `}` with a `{` in the same
    // paragraph stays, as does an escaped `\}`.
    //
    // Braces inside `$...$` are excluded from the count: removing one breaks
    // the expression for KaTeX, which rejects the whole display.
    const inMaths = new Array(trimmed.length).fill(false);
    {
      let openAt = -1;
      for (let k = 0; k < trimmed.length; k++) {
        if (trimmed[k] !== '$' || (k > 0 && trimmed[k - 1] === '\\')) continue;
        if (openAt < 0) { openAt = k; inMaths[k] = true; continue; }
        for (let j = k; j >= openAt; j--) inMaths[j] = true;
        openAt = -1;
      }
    }
    // Which closers are surplus is decided by matching, not counting: left to
    // right, a `}` with an open `{` behind it is that group's own and stays; a
    // `}` with nothing open closes a group from a previous block, and goes.
    const open = [];
    const stray = [];
    for (let k = 0; k < trimmed.length; k++) {
      if (inMaths[k]) continue;
      if (trimmed[k] !== '{' && trimmed[k] !== '}') continue;
      // an escaped brace is a literal, and `\{` in prose is a set brace
      if (k > 0 && trimmed[k - 1] === '\\') continue;
      if (trimmed[k] === '{') open.push(k);
      else if (open.length) open.pop();
      else stray.push(k);
    }
    // Dropped from the back, so the indices collected above stay valid.
    let body = trimmed;
    for (let n = stray.length - 1; n >= 0; n--) {
      body = body.slice(0, stray[n]) + body.slice(stray[n] + 1);
    }
    body = body.trim();
    if (!body) return null;
    return { type: 'para', nodes: this.parseInline(body) };
  }

  // ------------------------------------------------------------ environments

  /** Consumes the current environment body and dispatches on the name. */
  parseEnv(name) {
    const bare = name.replace(/\*$/, '');
    const starred = name.endsWith('*');

    // A numbered paragraph is prose, not a callout: `\newtheorem{parag}[thm]{}`
    // declares an environment with a blank heading for the running text of a
    // proof. Set as a callout it becomes a titled box around an argument.
    if (this.state.numberedParas.has(bare)) {
      if (this.s[this.i] === '[') this.i = this.skipOptionalArg(this.i);
      const { inner, next } = this.readUntilEnd(name);
      this.i = next;
      return { type: 'numbered-para', blocks: this.parseSub(inner) };
    }

    if (isCodeEnvName(bare, this.state.codeEnvs)) {
      // `minted`/`lstlisting` take `[options]` that carry the language
      const argStart = this.i;
      if (this.s[this.i] === '[') this.i = this.skipOptionalArg(this.i);
      const { inner, next } = this.readUntilEnd(name);
      const lang = /\bl(?:anguage|ang)\s*=\s*"?([A-Za-z0-9+#-]+)"?/.exec(this.s.slice(argStart, next));
      this.i = next;
      return { type: 'code', tex: trimVerbatimEdges(inner), lang: lang ? lang[1] : '' };
    }

    // `\begin{comment}...\end{comment}` is not in the document: anything else
    // lets its hidden paragraph print.
    if (DROPPED_ENVS.has(bare)) {
      const skip = this.readUntilEnd(name);
      this.i = skip.next;
      return null;
    }

    const { inner, next } = this.readUntilEnd(name);
    this.i = next;

    if (MATH_ENVS.has(bare) && bare !== 'array' && bare !== 'cases') {
      const taken = takeLeadingLabel(inner);
      const fallback = taken.label ? null : takeLastDepthZeroLabel(taken.text);
      const label = taken.label ?? fallback?.label ?? null;
      const body = stripTexComments(fallback ? fallback.text : taken.text).trim();
      const wrapper = ALIGN_MATH_ENVS[bare];
      // LaTeX lets the last alignment row omit `\\`; KaTeX rejects the whole
      // environment without it, so the terminator is added (a no-op when
      // already present -- a trailing `%`-comment counts as terminated, and a
      // second `\\` would add an empty final row).
      // the test looks at the body with trailing whitespace and comments
      // removed, so `Y & = z, \\ %` counts as already terminated; appending a
      // second `\\` there would add an empty final row, which is the parse error
      const bare$ = body.replace(/(?:\s|%[^\n]*)*$/, '');
      const rows = wrapper && bare$ && !/\\\\$/.test(bare$) ? `${body} \\\\` : body;
      const tex = wrapper ? `\\begin{${wrapper}${starred ? '*' : ''}}${rows}\\end{${wrapper}${starred ? '*' : ''}}` : body;
      // every display environment sets its own display style; `equation` and
      // `displaymath` are the unstarred ones, exactly as in LaTeX
      const display = !starred && (bare === 'equation' || bare === 'displaymath');
      return this.mathBlock(tex, display, label);
    }
    if (bare === 'array' || bare === 'cases' || bare === 'matrix') {
      return { type: 'math', display: true, tex: `\\begin{${name}}${inner}\\end{${name}}`, numbered: false };
    }
    if (LIST_ENVS.has(bare)) return this.parseList(bare, inner);
    if (bare === 'abstract') return { type: 'abstract', blocks: this.parseSub(inner) };
    if (CALLOUT_ENVS.has(bare) || this.state.calloutEnvs.has(bare)) {
      // `\begin{theorem}[Name]` — the optional argument is a note, not content,
      // and sits before the label, so peel it off before looking for the label
      const optMatch = /^\s*\[([^\]]*)\]/.exec(inner);
      const note = optMatch ? optMatch[1].trim() : '';
      const afterNote = optMatch ? inner.slice(optMatch[0].length) : inner;
      const taken = takeLeadingLabel(afterNote);
      // amsthm numbers all theorem-like environments from one shared counter
      const number = ++this.state.callouts;
      const id = `${bare}-${number}`;
      this.registerLabel(taken.label, { id, number, kind: bare });
      return { type: 'callout', kind: bare, id, note, blocks: this.parseSub(taken.text) };
    }
    if (ADMONITION_ENVS[bare]) {
      // An admonition is not a proposition: unnumbered, unreferred, and kept
      // off the shared amsthm counter, or the theorems' numbering shifts.
      const optMatch = /^\s*\[([^\]]*)\]/.exec(inner);
      const title = optMatch ? optMatch[1].trim() : '';
      const body = optMatch ? inner.slice(optMatch[0].length) : inner;
      return {
        type: 'callout',
        kind: bare,
        tone: ADMONITION_ENVS[bare],
        unnumbered: true,
        title: title || ADMONITION_LABELS[bare] || bare,
        note: title,
        blocks: this.parseSub(body),
      };
    }
    if (bare === 'tikzpicture' || bare === 'tikzcd' || bare === 'asy') {
      // `\begin{tikzpicture}[scale=0.9]` — the options belong to the picture
      // wrapper, which is re-created when the figure is compiled, so they must
      // not be left at the top of the body
      const opts = /^\s*\[([^\]]*)\]/.exec(inner);
      const body = opts ? inner.slice(opts[0].length) : inner;
      return {
        type: 'tikz',
        tex: body.trim(),
        options: opts ? opts[1].trim() : '',
        dialect: bare === 'asy' ? 'Asymptote' : 'TikZ',
      };
    }
    if (bare === 'tabular' || bare === 'tabularx' || bare === 'array'
      || bare === 'longtable' || bare === 'xltabular' || bare === 'longtabu') {
      return this.parseTabular(bare, inner);
    }
    if (bare === 'table' || bare === 'figure') return this.parseFloat(bare, inner);
    if (bare === 'quote' || bare === 'quotation') {
      return { type: 'blockquote', blocks: this.parseSub(inner) };
    }
    if (bare === 'center') {
      // Centred, and centred is all: an author's `\color{red}` travels as
      // colour, never as a banner. `\color` is a switch colouring the rest of
      // its group, so the colour is lifted off the front of the body.
      const tint = /^\s*\\color\s*\{\s*([a-zA-Z]+)\s*\}/.exec(inner);
      const body = tint ? inner.slice(tint[0].length) : inner;
      return {
        type: 'center',
        ...(tint ? { color: tint[1] } : {}),
        blocks: this.parseSub(body),
      };
    }
    if (PASS_THROUGH_ENVS.has(bare)) {
      // A pass-through environment may carry arguments before its content
      // (`\begin{minipage}[c]{0.3\textwidth}`); they are consumed, not parsed
      // as paragraphs.
      return this.parseSub(ENV_TAKES_ARGUMENTS.has(bare)
        ? stripEnvArguments(inner)
        : inner);
    }
    return this.parseSub(inner);
  }

  /** Scans forward to the matching `\end{name}`, tracking nesting. */
  readUntilEnd(name) {
    // The name is matched exactly as written, so `align*` looks for
    // `\end{align*}` and not for `\end{align}`. Matching on a star-stripped
    // name misses the closing tag and swallows the rest of the document.
    const re = new RegExp(`\\\\(begin|end)\\s*\\{\\s*${name.replace(/\*/g, '\\*')}\\s*\\}`, 'g');
    re.lastIndex = this.i;
    let depth = 1;
    let m;
    while ((m = re.exec(this.s)) !== null) {
      depth += m[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        const inner = this.s.slice(this.i, m.index);
        return { inner, next: re.lastIndex };
      }
    }
    // Unterminated. Silently treating the remainder of the file as the body
    // loses content without any sign, so it is recorded and surfaced.
    this.state.warnings.push(`unterminated \\begin{${name}} — the rest of the file was read as its body`);
    const inner = this.s.slice(this.i);
    return { inner, next: this.s.length };
  }

  /**
   * Parses a fragment in isolation from the cursor but sharing the document
   * state, so a `\begin{equation}` inside a proof keeps the document's
   * numbering rather than restarting the count.
   */
  parseSub(raw) {
    const sub = new Parser(raw, this.state);
    // The resolvers come along: a fragment is part of a document, so `\input`
    // or `\bibliography` inside it must still reach outside for files.
    sub.readIncludeText = this.readIncludeText;
    sub.resolveIncludes = this.resolveIncludes;
    return sub.parseBlocks(() => sub.atEnd());
  }

  parseList(kind, inner) {
    const items = [];
    const re = /\\item\s*(\[[^\]]*\])?/g;
    const marks = [];
    let m;
    while ((m = re.exec(inner)) !== null) {
      marks.push({
        index: m.index,
        length: m[0].length,
        label: m[1] ? this.parseInline(m[1].slice(1, -1).trim()) : '',
      });
    }

    if (marks.length === 0) {
      return { type: 'list', kind, items: [{ label: '', blocks: this.parseSub(inner) }] };
    }
    if (marks[0].index > 0 && inner.slice(0, marks[0].index).trim()) {
      items.push({ label: '', blocks: this.parseSub(inner.slice(0, marks[0].index)) });
    }
    for (let k = 0; k < marks.length; k++) {
      const from = marks[k].index + marks[k].length;
      const to = k + 1 < marks.length ? marks[k + 1].index : inner.length;
      items.push({ label: marks[k].label, blocks: this.parseSub(inner.slice(from, to)) });
    }
    return { type: 'list', kind, items };
  }

  parseTabular(kind, inner) {
    // A booktabs table is mostly rules. Each is removed with its arguments
    // before rows split: a stray `\rule{0pt}{2.0ex}` contributes two cells and
    // shifts the row's values a column right.
    const cmid = /\\cmidrule/.test(inner);
    const cleaned = inner
      // A comment whose line ends inside the tabular. `%` on its own was reaching
      // a cell as a literal character.
      .replace(/(^|[^\\\\])%[^\n]*/g, '$1')
      .replace(/\\(toprule|midrule|bottomrule|hline|hdashline|endhead|endfoot|endlastfoot|endfirsthead)\b/g, '')
      // every rule that carries brace arguments, with all of them
      .replace(/\\(?:specialrule|rule|cline|cmidrule|morecmidrules)\s*(?:\([^)]*\))?\s*\{[^{}]*\}(?:\s*\{[^{}]*\})*/g, '')
      .replace(/\\addlinespace\s*(?:\[[^\]]*\])?/g, '')
      .replace(/\\rowcolor(?:\[[^\]]*\])?\{[^}]*\}/g, '')
      .replace(/\\arrayrulecolor\{[^}]*\}/g, '')
      .replace(/\\(?:noalign|rowcolors)\s*(?:\([^)]*\))?\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')
      .replace(/\\(?:vspace|hspace)\s*\{[^{}]*\}/g, '')
      .replace(/&+ /g, '&')
      .trim();

    // The column preamble, read as a balanced brace group: the first group
    // after an optional `[...]`, two for the tabularx family (the second is
    // the width). Character matching misses real preambles (`@{...}`, `|l|l|`),
    // which then print inside the first cell.
    const balancedGroup = (text, from) => {
      const open = text.indexOf('{', from);
      if (open === -1) return null;
      let depth = 0;
      for (let k = open; k < text.length; k++) {
        if (text[k] === '{') depth++;
        else if (text[k] === '}' && --depth === 0) {
          return { end: k + 1, text: text.slice(open, k + 1) };
        }
      }
      return null;
    };
    const groupsWanted = (kind === 'tabularx' || kind === 'xltabular') ? 2 : 1;
    let cursor = cleaned.search(/\S/);
    if (cursor === -1) cursor = 0;
    const optional = /^\s*\[/.exec(cleaned.slice(cursor));
    if (optional) {
      const close = cleaned.indexOf(']', cursor);
      if (close !== -1) cursor = close + 1;
    }
    let spec = null;
    for (let n = 0; n < groupsWanted; n++) {
      const group = balancedGroup(cleaned, cursor);
      if (!group) break;
      spec = group;
      cursor = group.end;
    }
    const body = cleaned.slice(spec ? spec.end : 0);
    const columnSpec = spec ? spec.text : '';

    const rows = body
      .split(/\\\\(?:\s*\[[^\]]*\])?/)
      .map((r) => r.trim())
      .filter((r) => r.length)
      .map(splitTableRow)
      // Trailing empty cells are the author's padding, not a column: the width
      // comes from what the rows hold, so an over-declaring preamble costs
      // nothing and an under-declaring one still fits.
      .map((cells) => {
        let end = cells.length;
        while (end > 1 && !String(cells[end - 1]?.text ?? '').trim()) end--;
        return cells.slice(0, end);
      });

    // `grouped` remembers rules drawn under column groups: the one vertical
    // rule a booktabs table may carry, reproducing a division the author drew.
    return { type: 'table', columnSpec, rows, caption: '', id: '', grouped: cmid };
  }

  parseFloat(bare, inner) {
    // take the label first: a float's `\label` follows `\caption`, so it has
    // to be found before the caption is cut out of the body
    const taken = takeCaptionLabel(inner);
    inner = taken.text;

    const captionMatch = /\\caption\s*(\[[^\]]*\])?\s*\{/.exec(inner);
    let captionNodes = [];
    if (captionMatch) {
      const start = captionMatch.index + captionMatch[0].length;
      const { text, next } = readBalanced(inner, start - 1);
      captionNodes = this.parseInline(text);
      inner = inner.slice(0, captionMatch.index) + inner.slice(next);
    }
    // A float may hold more than one picture: a two-column `figure*`, or one
    // per `minipage`. All are collected in order. Minipage columns are taken
    // whole (contents included): collecting bare pictures would orphan each
    // column's heading as a stray paragraph and print its arguments as text.
    const columns = [];
    for (;;) {
      const col = /\\begin\s*\{\s*minipage\s*\}(?:\s*\[[^\]]*\])?\s*\{/.exec(inner);
      if (!col) break;
      const body = extractEnv(inner, 'minipage');
      // The optional position and the width are the minipage's, not content
      const bodyInner = body.inner.replace(/^\s*\[[^\]]*\]\s*\{[^{}]*\}\s*/, '');
      columns.push(this.parseSub(bodyInner));
      inner = inner.slice(0, col.index) + inner.slice(body.next);
    }

    const images = [];
    for (;;) {
      const imgMatch = /\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{/.exec(inner);
      if (!imgMatch) break;
      const { text, next } = readBalanced(inner, imgMatch.index + imgMatch[0].length - 1);
      images.push({ name: text.trim(), opts: parseGraphicsOptions(imgMatch[1] || '') });
      inner = inner.slice(0, imgMatch.index) + inner.slice(next);
    }
    const image = images.length ? images[0].name : null;
    const imageOpts = images.length ? images[0].opts : null;
    this.state.floats++;
    const id = `${bare}-${this.state.floats}`;
    this.registerLabel(taken.label, { id, number: this.state.floats, kind: bare });

    if (bare === 'figure') {
      return {
        type: 'figure', id, image, imageOpts, caption: captionNodes,
        blocks: this.parseSub(inner),
        ...(columns.length ? { columns } : {}),
        ...(columns.length ? {} : images.length > 1 ? { images } : {}),
      };
    }

    // table: pull a tabular out of the float body
    const tab = /\\begin\s*\{\s*(tabularx?|array)\s*\}/.exec(inner);
    if (tab) {
      const name = tab[1];
      const parsed = this.parseTabular(name, extractEnv(inner, name).inner);
      parsed.id = id;
      parsed.caption = captionNodes;
      return parsed;
    }
    return { type: 'table', id, rows: [], caption: captionNodes, columnSpec: '' };
  }

  // ------------------------------------------------------------------ inline

  /**
   * A verbatim excerpt of a named region of another file.
   *
   * `\rawsrcexcerpt{attention.py}{START_EINSTEIN}{END_EINSTEIN}` quotes the lines
   * between two markers out of a source file, as `bverb` does. The file is read
   * through the same include resolver as `\input`, so it is found relative to
   * the document rather than relative to whatever directory the build happened
   * to run in.
   *
   * When the file or the markers are missing, the failure is said as a
   * warning, not printed as prose.
   */
  sourceExcerpt(file, startMark, endMark) {
    const lang = String(file || '').split('.').pop() || '';
    const wanted = lang.replace(/[^a-z0-9+#]/gi, '') || 'text';
    if (!file || !startMark) {
      this.state.warnings.push(`\\rawsrcexcerpt was used without a file to read`);
      return { type: 'text', value: '' };
    }
    let text = null;
    try { text = this.readIncludeText?.(file); } catch { text = null; }
    if (text == null || !startMark || !text.includes(startMark)) {
      this.state.warnings.push(
        `source excerpt "${file}" ${text == null ? 'was not found' : `has no "${startMark}" marker`}`);
      return {
        type: 'codeblock', tex: `[${file}: ${text == null ? 'not found' : `no "${startMark}" marker`}]`,
        lang: 'text',
      };
    }
    // Markers match line-anchored, as a prefix of the line's body (a comment
    // line counts whole): substring matching cuts inside longer words, and
    // exact-line matching misses prefixed markers. `HIDE_IN_SLIDE` lines are
    // dropped, and the excerpt is dedented by its smallest indent.
    const lines = text.split('\n');
    const lineHas = (mark, from) => {
      for (let n = from; n < lines.length; n++) {
        const m = /^\s*(#+\s*|\/\/\s*|;\s*|--\s*)?/.exec(lines[n]);
        const body = lines[n].slice(m[0].length);
        if (body.startsWith(mark)) return { at: n, rest: m[1] ? '' : body.slice(mark.length) };
      }
      return null;
    };
    const start = lineHas(startMark, 0);
    if (!start) {
      this.state.warnings.push(`source excerpt "${file}" has no "${startMark}" marker`);
      return { type: 'codeblock', tex: `[${file}: no "${startMark}" marker]`, lang: 'text' };
    }
    const end = endMark ? lineHas(endMark, start.at + 1) : null;
    const kept = lines
      .slice(start.at + 1, end ? end.at : lines.length)
      // `HIDE_IN_SLIDE` is this deck's own convention for "not on the slide".
      .filter((line) => !/HIDE_IN_SLIDE/.test(line));
    // Dedent by the smallest indent the excerpt actually has, so the listing is
    // flush left the way the shared header's fixed `substr` made it.
    const indents = kept
      .filter((l) => l.trim())
      .map((l) => (/^\s*/.exec(l)[0]).length);
    const by = indents.length ? Math.min(...indents) : 0;
    const parts = start.rest ? [start.rest] : [];
    if (end && end.rest) parts.push(end.rest);
    const body = [...parts, ...kept.map((l) => l.slice(by))]
      .join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    return {
      type: 'codeblock',
      tex: body,
      lang: normalizeLang(wanted),
    };
  }

  readGroupText() {
    this.skipTrivia();
    if (this.s[this.i] !== '{') return '';
    const { text, next } = readBalanced(this.s, this.i);
    this.i = next;
    return text;
  }

  /**
   * Reads a `\label` that immediately follows the construct just parsed.
   * Deliberately anchored: a label belongs to whatever precedes it, and an
   * unanchored search would run past the next heading and swallow it.
   */
  readTrailingLabel() {
    const save = this.i;
    this.skipTrivia();
    const m = /^\\label\s*\{/.exec(this.s.slice(this.i));
    if (!m) { this.i = save; return null; }
    const { text, next } = readBalanced(this.s, this.i + m[0].length - 1);
    this.i = next;
    return text.trim();
  }

  registerLabel(label, info) {
    if (label) this.state.labels.set(label, { id: info.id, number: info.number, title: info.title || '', kind: info.kind });
  }

  skipOptionalArg(i) {
    if (this.s[i] !== '[') return i;
    let depth = 0;
    for (let j = i; j < this.s.length; j++) {
      if (this.s[j] === '[') depth++;
      else if (this.s[j] === ']' && --depth === 0) return j + 1;
    }
    return i;
  }

  parseInline(raw) {
    const nodes = [];
    let buf = '';
    let i = 0;
    const flush = () => {
      if (buf) {
        nodes.push({ type: 'text', value: buf });
        buf = '';
      }
    };
    const src = raw;

    // Reads the next `{...}` argument, on the inline cursor: the block
    // parser's `this` cursor is not where the inline parser stands.
    const group = () => {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== '{') return '';
      const { text, next } = readBalanced(src, j);
      i = next;
      return text;
    };
    // The same for a `[...]` argument, on the same cursor.
    const opt = () => {
      let j = i;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== '[') return null;
      const r = readOptional(src, j);
      i = r.next;
      return r.text;
    };

    while (i < src.length) {
      const c = src[i];

      // A `%` comments out the rest of the line. Code environments and
      // `\verb` are consumed before this loop, so a literal percent in them
      // is safe.
      if (c === '%') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }

      if (c === '$') {
        const delim = src.startsWith('$$', i) ? '$$' : '$';
        const from = i + delim.length;
        const end = src.indexOf(delim, from);
        if (end > 0) {
          flush();
          nodes.push({
            type: 'math', display: delim === '$$', tex: src.slice(from, end).trim()
          });
          i = end + delim.length;
          continue;
        }
        buf += c; i++; continue;
      }

      if (src.startsWith('\\[', i)) {
        const end = src.indexOf('\\]', i + 2);
        if (end > 0) {
          flush();
          nodes.push({ type: 'math', display: true, tex: src.slice(i + 2, end).trim() });
          i = end + 2;
          continue;
        }
      }

      if (c === '{') {
        flush();
        const { text, next } = readBalanced(src, i);
        nodes.push(...this.parseInline(text));
        i = next;
        continue;
      }

      if (c !== '\\') {
        buf += c; i++; continue;
      }

      // --- control sequences from here on
      if (src[i + 1] === '\\') {
        // `\\[0.25em]` -- the optional space is layout, not text.
        flush();
        nodes.push({ type: 'break' });
        i += 2;
        while (i < src.length && /\s/.test(src[i])) i++;
        if (src[i] === '[') { const r = readOptional(src, i); i = r.next; }
        continue;
      }

      const sym = src[i + 1];
      if (sym && !/[a-zA-Z@]/.test(sym)) {
        // The symbol accents: `\'e`, `\"o`, `\~n`, `\^a`. The letter is the next
        // character, or a braced group.
        if (ACCENTS[sym]) {
          let j = i + 2;
          while (j < src.length && /\s/.test(src[j])) j++;
          let letter = src[j] || '';
          if (src[j] === '{') {
            const r = readBalanced(src, j);
            letter = r.text.trim();
            j = r.next;
          } else {
            j += 1;
          }
          if (letter.length === 1) {
            flush();
            nodes.push({ type: 'text', value: ACCENTS[sym](letter) });
            i = j;
            continue;
          }
        }
        if (sym === ' ' || sym === ',' || sym === ';' || sym === ':' || sym === '!' || sym === '/') {
          buf += ' '; i += 2; continue;
        }
        if (ESCAPES[sym]) { buf += ESCAPES[sym]; i += 2; continue; }
        if (sym === "'") { buf += '’'; i += 2; continue; }
        if (sym === '"') { buf += '“'; i += 2; continue; }
        if (sym === '`') { buf += '‘'; i += 2; continue; }
        buf += sym; i += 2; continue;
      }

      const cmd = /^\\([a-zA-Z@]+)\*?/.exec(src.slice(i));
      if (!cmd) { buf += c; i++; continue; }
      const name = cmd[1];

      // Never-printing commands are dropped BEFORE macro expansion (see
      // SILENT_GROUPS above): both `\dlclabel` and `\index` are *defined*
      // macros, and expanding first prints their bodies as prose.
      if (isSilentCommand(name)) {
        i = skipSilentCommand(src, i + cmd[0].length, name);
        continue;
      }

      // `\dlcref{X}` reads `X.dlcref`, a file another deck wrote at its own
      // build time -- not beside this document, so resolved through the
      // `xrefs` config map instead. Resolved, the display string is typeset in
      // place; unresolved, nothing prints and the gap is warned about.
      // Inventing a title would misattribute the lecture.
      if (name === 'dlcref') {
        let k = i + cmd[0].length;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === '{') {
          const g = readBalanced(src, k);
          const key = g.text.trim();
          const table = this.state.xrefs;
          const display = table instanceof Map ? table.get(key) : table?.[key];
          if (display) {
            flush();
            nodes.push(...this.parseInline(String(display)));
          } else {
            this.state.warnings.push(
              `\\dlcref{${key}} is not defined (no xrefs entry), so nothing was printed`);
          }
          i = g.next;
        } else {
          i += cmd[0].length;
        }
        continue;
      }

      // A macro used in the text, expanded where it stands. Plain-text bodies
      // splice the same way as environments (read as though typed there), on
      // the shared splice budget so self-reference terminates.
      // A macro naming itself, directly or through a cycle, is dropped: the
      // budget is the second line of defence, not the first.
      const inFlight = this.state.expanding || (this.state.expanding = new Set());
      const inlineMacro = this.state.macros.get(name);
      if (inlineMacro && inlineMacro.body && !/^\s*$/.test(inlineMacro.body)
          && !inFlight.has(name) && (this.state.splices ?? 0) < 6) {
        inFlight.add(name);
        try {
          // The call's own arguments, read and consumed here for `#1..#n`
          // substitution below (a macro with and without parameters share no
          // code path).
          let argAt = i + cmd[0].length;
          const args = [];
          for (let a = 0; a < (inlineMacro.params || 0); a++) {
            while (argAt < src.length && /\s/.test(src[argAt])) argAt++;
            if (src[argAt] !== '{') break;
            const g = readBalanced(src, argAt);
            args.push(g.text);
            argAt = g.next;
          }
          const body = inlineMacro.body.replace(/#(\d)/g, (_, d) => (args[Number(d) - 1] ?? ''));
          if (/\\begin\s*\{/.test(body)) {
            // An environment has to be spliced into the whole source: it may open
            // and close across the macro's own braces, and it may refer to labels
            // declared elsewhere in the document.
            const src2 = src.slice(0, i) + body + src.slice(argAt);
            this.state.splices = (this.state.splices ?? 0) + 1;
            const inner = this.parseInline(src2);
            this.state.splices -= 1;
            nodes.push(...inner);
            return nodes;
          }
          // A body of text is read on its own (not spliced into the source,
          // which would re-read and double-emit the text before the macro).
          // The pending buffer flushes first, so literal text before the macro
          // stays before it.
          flush();
          nodes.push(...this.parseInline(body));
          i = argAt;
          continue;
        } catch { this.state.splices -= 1; }
        finally { inFlight.delete(name); }
      }
      // `\setlength`-shaped commands, read inline. Only the two-group commands
      // are handled here: each takes exactly two braced groups, and nothing
      // else is touched.
      if (TWO_GROUP_COMMANDS.has(name)) {
        let k = i + cmd[0].length;
        while (k < src.length && /\s/.test(src[k])) k++;
        if (src[k] === '[') {
          const close = src.indexOf(']', k);
          if (close > 0) { k = close + 1; while (k < src.length && /\s/.test(src[k])) k++; }
        }
        let groups = 0;
        while (groups < 2 && k < src.length && src[k] === '{') {
          let depth = 1;
          k++;
          while (k < src.length && depth > 0) {
            if (src[k] === '{' && src[k - 1] !== '\\') depth++;
            else if (src[k] === '}' && src[k - 1] !== '\\') depth--;
            k++;
          }
          groups++;
          while (k < src.length && /\s/.test(src[k])) k++;
        }
        if (groups) { i = k; continue; }
      }

      i += cmd[0].length;

      switch (name) {
        case 'newcommand': case 'renewcommand': case 'providecommand':
        case 'newenvironment': case 'renewenvironment': case 'provideenvironment':
        case 'DeclareMathOperator': case 'DeclarePairedDelimiter':
        case 'def': case 'let': case 'newtoks': {
          // a definition prints nothing; without this its body — often raw
          // TikZ from a shared header — lands in the middle of a sentence
          i = skipDefinition(src, i, name, this.state.macros);
          continue;
        }
        case 'newtheorem': {
          // `\newtheorem{theorem}{Theorem}[section]` names a callout
          // environment; only the name is needed (heading word and counter
          // sharing are layout).
          let j = i;
          const starred = /^\*/.test(src.slice(j));
          if (starred) j++;
          const arg = (from) => {
            let k = from;
            while (k < src.length && /\s/.test(src[k])) k++;
            if (src[k] !== '{') return { text: '', next: from };
            return readBalanced(src, k);
          };
          const nameRead = arg(j);
          const env = nameRead.text.trim();
          const headRead = arg(nameRead.next);
          // An empty heading declares a *numbered paragraph* (running proof
          // prose), not a theorem: kept out of the callout set.
          if (env && !headRead.text.trim()) this.state.numberedParas.add(env);
          // the counter argument, if any, is layout
          let after = headRead.next;
          if (headRead.text.trim()) after = arg(after).next;
          if (env) this.state.calloutEnvs.add(env);
          i = after;
          continue;
        }
        case 'textbf': case 'bf': case 'textnormal': {
          const inner = group();
          flush();
          nodes.push(name === 'textnormal' ? { type: 'text', value: plainText(this.parseInline(inner)) } : { type: 'strong', nodes: this.parseInline(inner) });
          continue;
        }
        case 'emph': case 'textit': case 'it': {
          flush();
          nodes.push({ type: 'em', nodes: this.parseInline(group()) });
          continue;
        }
        case 'verb': {
          // `\verb<delim>text<delim>` — the delimiter is arbitrary and the
          // content is literal, so it must never be parsed as markup.
          const delim = src[i];
          if (!delim || /\s/.test(delim)) { i++; continue; }
          const end = src.indexOf(delim, i + 1);
          if (end < 0) { i = src.length; continue; }
          flush();
          nodes.push({ type: 'code', verbatim: src.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
        case 'texttt': case 'textmono': {
          flush();
          nodes.push({ type: 'code', nodes: this.parseInline(group()) });
          continue;
        }
        case 'textsf': case 'textrm': case 'mbox': case 'text': case 'textsc': {
          const inner = group();
          flush();
          nodes.push({ type: name === 'textsc' ? 'smallcaps' : 'span', nodes: this.parseInline(inner) });
          continue;
        }
        case 'underline': case 'u': case 'emphbox': {
          flush();
          nodes.push({ type: 'u', nodes: this.parseInline(group()) });
          continue;
        }
        case 'url': case 'nolinkurl': case 'href': case 'hyperref': {
          let target = group();
          let labelNodes = null;
          if (name === 'href' || name === 'hyperref') labelNodes = this.parseInline(group());
          flush();
          const href = target.trim();
          nodes.push({
            type: 'link',
            href,
            // Only a link that leaves the site is external: same-site targets
            // (figures, bibliography, sibling documents) stay in place.
            external: /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href),
            nodes: labelNodes || [{ type: 'text', value: href }],
          });
          continue;
        }
        case 'tooltip': case 'tooltiptext': {
          // `\tooltip{hint}{text}`. The hint becomes the accessible name and
          // the visible bubble is progressive: with no CSS, or on a touch
          // screen where there is no hover, the `title` still carries it and
          // the reader loses nothing.
          const hint = group();
          const shown = this.parseInline(group());
          flush();
          nodes.push({
            type: 'link', href: null, external: false, broken: false,
            tooltip: hint.trim(), nodes: shown,
          });
          continue;
        }
        case 'rawsrcexcerpt': case 'srcexcerpt': case 'sourceexcerpt': {
          // A verbatim excerpt of a named region of a source file; handled
          // inline, the arguments would print as prose.
          const g = [group().trim(), group().trim(), group().trim()];
          opt(); opt();
          flush();
          nodes.push(this.sourceExcerpt(g[0], g[1], g[2]));
          continue;
        }
        case 'raisebox': case 'raisebox*': {
          // A vertical shift, then the content: the shift (first group) goes
          // and the picture (second) stays. The starred form carries the
          // content's height and depth ahead of the lift.
          if (cmd[0].endsWith('*')) { opt(); opt(); }
          group();
          const content = group();
          flush();
          if (/\\begin\s*\{/.test(content)) {
            nodes.push({ type: 'group', nodes: [], blocks: this.parseSub(content) });
          } else {
            nodes.push(...this.parseInline(content));
          }
          continue;
        }
        case 'makebox': case 'framebox': case 'parbox': case 'colorbox':
        case 'fcolorbox': case 'minipage': {
          // A width, a position, then the content: the optionals are layout,
          // not content.
          opt(); opt();
          flush();
          nodes.push(...this.parseInline(group()));
          continue;
        }
        case 'setcounter': case 'addtocounter': case 'stepcounter':
        case 'refstepcounter': case 'value': case 'the': case 'arabic':
        case 'roman': case 'alph': case 'Alph': {
          // Counters are layout, not prose: both groups consumed, nothing
          // printed.
          flush();
          group(); group();
          continue;
        }
        case 'footnote': case 'marginnote': case 'footnotetext':
        case 'thanks': case 'email': {
          flush();
          nodes.push({ type: 'footnote', nodes: this.parseInline(group()) });
          continue;
        }
        case 'ref': case 'eqref': case 'autoref': case 'cref': case 'Cref': case 'pageref': {
          const target = group().trim();
          flush();
          nodes.push({ type: 'ref', label: target, parenthetical: name === 'eqref' || name === 'autoref' });
          continue;
        }
        case 'cite': case 'citep': case 'citet': case 'citeauthor': case 'nocite': {
          flush();
          nodes.push({ type: 'cite', keys: group().split(',').map((k) => k.trim()).filter(Boolean), textual: name === 'citet' || name === 'citeauthor' });
          continue;
        }
        case 'SI': case 'si': case 'SIrange': {
          // siunitx: `\SI{9.81}{m/s^2}` -> number and unit as inline math, so
          // the unit's own superscripts typeset properly
          const value = group().trim();
          const unit = group().trim();
          if (!value || !unit) continue;
          flush();
          nodes.push({ type: 'math', display: false, tex: `${value}\\,${unit}` });
          continue;
        }
        case 'num': {
          const value = group().trim();
          if (!value) continue;
          flush();
          nodes.push({ type: 'math', display: false, tex: value });
          continue;
        }
        case 'label': { group(); continue; }
        case 'S': flush(); nodes.push({ type: 'text', value: '§' }); continue;
        case 'P': flush(); nodes.push({ type: 'text', value: '¶' }); continue;
        case 'copyright': flush(); nodes.push({ type: 'text', value: '©' }); continue;
        // The T1 accents: `\c{c}` is ç, `\'e` is é. A name like `Fran\c{c}ois`
        // was reaching the page as `Francois`, which is a different name to the
        // one on the lecture it credits. The braced group is only one spelling:
        // `\c c` — the accent command followed by a space and a bare letter, as
        // in `\def\theauthor{Fran\c cois Fleuret}` — is legal TeX and means the
        // same, so a bare single letter is accepted too.
        case 'c': case 'v': case 'H': case 'k': case 'b': case 'd': case 't':
        case 'u': {
          const acc = ACCENTS[name];
          let j = i;
          while (j < src.length && /\s/.test(src[j])) j++;
          let letter = '';
          if (src[j] === '{') {
            const r = readBalanced(src, j);
            letter = r.text.trim();
            i = r.next;
          } else if (src[j] && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}') {
            letter = src[j];
            i = j + 1;
          } else {
            continue;
          }
          if (!letter || letter.length !== 1) continue;
          flush();
          nodes.push({ type: 'text', value: acc(letter) });
          continue;
        }
        case 'pounds': case 'textsterling':
          flush();
          nodes.push({ type: 'text', value: '£' });
          continue;
        case 'textbackslash':
          flush();
          nodes.push({ type: 'text', value: '\\' });
          continue;
        case 'today':
          flush();
          nodes.push({ type: 'text', value: new Date().toDateString() });
          continue;
        case 'ldots': case 'dots': case 'textellipsis':
          flush();
          nodes.push({ type: 'text', value: '…' });
          continue;
        case 'LaTeX':
          flush();
          nodes.push({ type: 'text', value: 'LaTeX' });
          continue;
        case 'TeX':
          flush();
          nodes.push({ type: 'text', value: 'TeX' });
          continue;
        case 'newline': case 'linebreak':
          flush();
          nodes.push({ type: 'break' });
          continue;
        case 'noindent': case 'protect': case 'nobreak': case 'allowbreak': case 'small': case 'normalsize': case 'footnotesize': case 'scriptsize': case 'tiny': case 'large': case 'Large': case 'huge': case 'Huge':
          continue;
        // Colour commands set a colour; they do not print one.
        // hyperref's idiom: the first argument is what a reader sees, the
        // second feeds a PDF bookmark, so only the first renders.
        case 'texorpdfstring': case 'pdfstring': case 'texorpdfstringdef': {
          flush();
          const shown = group();
          nodes.push(...this.parseInline(shown));
          group();
          continue;
        }
        case 'textcolor': {
          // The author's own emphasis, kept as emphasis: unlike the `\color`
          // switch, `\textcolor` carries the text as its second argument.
          const colour = group().trim();
          flush();
          nodes.push({ type: 'span', color: colour, nodes: this.parseInline(group()) });
          continue;
        }
        case 'color': case 'pagecolor': case 'colorbox':
        case 'normalcolor': case 'arrayrulecolor': case 'rowcolor':
          if (src[i] === '[') { const c = src.indexOf(']', i); if (c > 0) i = c + 1; }
          { const g = this.consumeOptionalBraced(src, i); if (g) i = g.next; }
          continue;
        case 'index': case 'idx': case 'label': case 'hypertarget':
        case 'dlclabel': case 'pageref': case 'nameref': case 'cref': case 'Cref':
        case 'varioref': case 'VARIoref': case 'autoref': case 'eqref': case 'ref':
          // A marker, not a word: named by suffix (`label`, `index`,
          // `target`, `tag`, `ref`), since every package brings its own and
          // none of them has anything to print.
          { const g = this.consumeOptionalBraced(src, i); if (g) i = g.next; }
          continue;
        case 'hspace': case 'vspace': case 'kern': case 'phantom': case 'hphantom':
          if (src[i] === '{') { group(); }
          if (src[i] === '*') i++;
          continue;
        case 'uncover': case 'onslide': case 'only': case 'visible':
        case 'invisible': case 'unskippable': case 'alt': {
          // Overlay specifications: a page has no clicks, so every overlay is
          // *on* -- content kept, command dropped. `\alt<2>{a}{b}` is the
          // exception: a real choice, of which the first alternative is kept.
          if (src[i] === '<') {
            // The spec may carry a `>` of its own; match by depth, starting
            // *after* the opening angle.
            i++;
            let depth = 0;
            while (i < src.length) {
              if (src[i] === '<') depth++;
              else if (src[i] === '>') { if (!depth) break; depth--; }
              i++;
            }
            i++;
          }
          let first = true;
          while (src[i] === '{' || /\s/.test(src[i])) {
            while (i < src.length && /\s/.test(src[i])) i++;
            if (src[i] !== '{') break;
            const g = this.consumeOptionalBraced(src, i);
            if (!g) break;
            flush();
            if (first) {
              // An overlay often wraps a *picture*; an argument holding an
              // environment parses as blocks so it reaches the drawing pass.
              if (/\\begin\s*\{/.test(g.text)) {
                nodes.push({ type: 'group', nodes: [], blocks: this.parseSub(g.text) });
              } else {
                nodes.push(...this.parseInline(g.text));
              }
            }
            // a second alternative is dropped, not the first one
            first = false;
            i = g.next;
          }
          continue;
        }
        case 'includegraphics': {
          // In prose rather than in a float: still a picture, so it is kept as
          // one. Losing it would silently drop a figure from the document.
          let optsText = '';
          if (src[i] === '[') {
            const close = src.indexOf(']', i);
            if (close > 0) { optsText = src.slice(i + 1, close); i = close + 1; }
          }
          while (i < src.length && /\s/.test(src[i])) i++;
          if (src[i] !== '{') continue;
          const arg = readBalanced(src, i);
          if (!arg) continue;
          flush();
          nodes.push({
            type: 'image',
            src: arg.text.trim(),
            srcOpts: parseGraphicsOptions(optsText),
          });
          i = arg.next;
          continue;
        }
        case 'begin': case 'end': {
          // rewind over the command word itself so the scanner sees the
          // backslash; nothing has consumed an argument at this point
          const envStart = i - cmd[0].length;
          i = this.skipInlineEnv(envStart, src, nodes, flush);
          continue;
        }
        default: {
          // unknown macro: try to consume one braced argument, else drop just
          // the command. `i` already sits past the name, so advancing again
          // here would eat the first few characters of the following word.
          const inner = this.consumeOptionalBraced(src, i);
          if (inner === null) { continue; }
          i = inner.next;
          flush();
          if (inner.text.trim()) nodes.push(...this.parseInline(inner.text));
          continue;
        }
      }
    }
    flush();
    return nodes;
  }

  consumeOptionalBraced(src, i) {
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '{') return null;
    return readBalanced(src, j);
  }

  /** Handles `\begin{...}` appearing inside a paragraph (tikz, arrays, ...). */
  skipInlineEnv(start, src, nodes, flush) {
    const open = /^\\begin\s*\{\s*([a-zA-Z*]+)\s*\}/.exec(src.slice(start));
    if (!open) {
      const close = /^\\end\s*\{\s*[a-zA-Z*]+\s*\}/.exec(src.slice(start));
      return start + (close ? close[0].length : 7);
    }
    const bare = open[1].replace(/\*$/, '');
    const bodyStart = start + open[0].length;
    // match the closing tag exactly as the opening one was written, so
    // `align*` does not go looking for `\end{align}`
    const re = new RegExp(`\\\\(begin|end)\\s*\\{\\s*${open[1].replace(/\*/g, '\\*')}\\s*\\}`, 'g');
    re.lastIndex = bodyStart;
    let depth = 1;
    let m;
    while ((m = re.exec(src)) !== null) {
      depth += m[1] === 'begin' ? 1 : -1;
      if (depth === 0) {
        const inner = src.slice(bodyStart, m.index);
        flush();
        if (MATH_ENVS.has(bare)) nodes.push({ type: 'math', display: bare !== 'inline', tex: inner.trim() });
        else if (isCodeEnvName(bare, this.state.codeEnvs)) nodes.push({ type: 'code', tex: trimVerbatimEdges(inner), lang: '' });
        else if (bare === 'tikzpicture' || bare === 'tikzcd') nodes.push({ type: 'tikz', tex: inner.trim() });
        else nodes.push(...this.parseInline(inner));
        return re.lastIndex;
      }
    }
    flush();
    nodes.push({ type: 'tikz', tex: src.slice(bodyStart).trim() });
    return src.length;
  }
}

// ----------------------------------------------------------------- resolving

const REF_KIND_LABEL = {
  section: 'Section',
  subsection: 'Section',
  equation: 'Equation',
  figure: 'Figure',
  table: 'Table',
  theorem: 'Theorem',
  lemma: 'Lemma',
  proposition: 'Proposition',
  corollary: 'Corollary',
  definition: 'Definition',
  remark: 'Remark',
  example: 'Example',
  proof: 'Proof',
  observation: 'Observation',
  conjecture: 'Conjecture',
  axiom: 'Axiom',
  exercise: 'Exercise',
};

/**
 * Citations written as plain text rather than as `\cite`.
 *
 * Typed citations (`[B-Em]`) are indistinguishable at a glance from numbered
 * part references (`[H 4]`) and ordinary maths (`[0,T)`), so only a
 * digit-free group whose every part matches a bibliography key becomes a
 * citation. Anything less certain stays as written: a wrong link sends the
 * reader to the wrong paper.
 */
function linkPlainCitations(blocks, known, numbers, cited) {
  const inReferences = (block, inside) => {
    if (block.type === 'section') {
      return /^(references|bibliography|works cited|literature cited)$/i
        .test((block.title || '').trim())
        || inside;
    }
    return inside || block.type === 'references';
  };

  const rewrite = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodes) { rewrite(node.nodes); continue; }
      if (node.type !== 'text' || typeof node.value !== 'string') continue;
      if (!node.value.includes('[')) continue;

      const out = [];
      let rest = node.value;
      while (rest.length) {
        const m = /^([\s\S]*?)\[([^\]\n]{1,60})\]/.exec(rest);
        if (!m) { out.push({ type: 'text', value: rest }); break; }
        if (m[1]) out.push({ type: 'text', value: m[1] });
        const parts = m[2].split(',').map((p) => p.trim());
        const usable = parts.length > 0 && parts.length <= 3
          && parts.every((p) => p.length > 0 && known.has(p) && !/\d/.test(p));
        // `m[0]` is prefix *and* bracket; only the bracket half is pushed,
        // or the prefix prints twice.
        if (!usable) out.push({ type: 'text', value: m[0].slice(m[1].length) });
        else {
          for (const [n, key] of parts.entries()) {
            if (n) out.push({ type: 'text', value: ',' });
            if (!cited.includes(key)) cited.push(key);
            const num = numbers.get(key);
            out.push({
              type: 'link', href: `#ref-${slugify(key)}`, external: false,
              broken: false, cite: true, resolved: num != null,
              nodes: [{ type: 'text', value: `[${num != null ? num : key}]` }],
            });
          }
        }
        rest = rest.slice(m[0].length);
      }
      nodes.splice(i, 1, ...out);
      i += out.length - 1;
    }
  };

  const walk = (list, inside = false) => {
    for (const block of list || []) {
      if (block.nodes && !inReferences(block, inside)) rewrite(block.nodes);
      if (block.blocks) walk(block.blocks, inReferences(block, inside));
    }
  };
  walk(blocks);
}

/** Turns `ref`/`cite` placeholders into real links once labels are known. */
function resolveReferences(blocks, labels, known = new Map(), numbers = new Map()) {
  const cited = new Map(); // key -> anchor
  const order = [];        // keys, in order of first citation

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }

    if (node.type === 'ref') {
      const target = labels.get(node.label);
      const kindLabel = REF_KIND_LABEL[target?.kind] || 'Section';
      const numbered = target && target.number !== undefined && target.number !== '' && target.number !== 0;
      // LaTeX's \ref yields the number alone; the surrounding prose supplies
      // "Section", "\S" or "Theorem". A target with no number falls back to
      // its kind, which is all `\ref` can honestly say.
      const text = !target ? '??' : (numbered ? String(target.number) : kindLabel);
      Object.assign(node, {
        type: 'link',
        href: target ? `#${target.id}` : '#',
        external: false,
        broken: !target,
        nodes: [{ type: 'text', value: node.parenthetical ? `(${text})` : text }],
      });
      delete node.label;
      return;
    }

    // Table cells keep source until render time (after this pass): parse them
    // here instead, or cell citations render as empty brackets.
    if (node.type === 'table' && node.rows) {
      for (const row of node.rows) {
        for (const cell of row) {
          if (!cell || cell.nodes || typeof cell.text !== 'string') continue;
          cell.nodes = parseInlineText(cell.text);
          walk(cell.nodes);
        }
      }
      return;
    }

    if (node.type === 'cite') {
      // A citation links the entry it names. With no bibliography the key
      // shows and links rather than inventing a number.
      const parts = node.keys.map((key) => {
        if (!cited.has(key)) {
          cited.set(key, `ref-${slugify(key)}`);
          order.push(key);
        }
        // A resolved citation shows the paper's own number; an unresolved one
        // shows its key, which is honest rather than a guess.
        const n = numbers.get(key);
        const label = n != null ? String(n) : key;
        return {
          type: 'link', href: `#${cited.get(key)}`, external: false,
          broken: false, cite: true, resolved: n != null,
          nodes: [{ type: 'text', value: `[${label}]` }],
        };
      });
      node.type = 'citeref';
      node.nodes = parts;
      delete node.keys;
      return;
    }

    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(blocks);
  return order;
}