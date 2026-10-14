/**
 * Macro expansion.
 *
 * Papers define their own notation constantly (`\dmodel`, `\softmax`,
 * `\transpose`), and those definitions are shorthand rather than text: an
 * unexpanded `\dmodel` reaches the reader as literal characters, which reads
 * as an error in the paper rather than in the tool. Definitions are recorded
 * as they are met and expanded in maths before it is typeset.
 *
 * Deliberate limits, because a general TeX expander is a project of its own:
 *
 * - Definitions apply document-wide rather than from the point of definition.
 *   Papers essentially never redefine a macro mid-document.
 * - Only brace- and token-argument forms are handled. `\def` bodies with
 *   delimited parameters are read as far as the first brace, which covers the
 *   ordinary `\def\name{body}` and `\def\name#1{body}`.
 * - Expansion is depth-limited, so a self-expanding macro terminates instead
 *   of hanging the build.
 */

const MAX_DEPTH = 8;

/** How many arguments a definition takes. `null` when it takes none. */
function paramCount(parameterText) {
  const m = /^\s*\[(\d+)\]/.exec(parameterText || '');
  return m ? Number(m[1]) : null;
}

/**
 * Reads a definition starting at the command name.
 *
 * @returns {{name:string, params:number, body:string, next:number}|null}
 */
export function readDefinition(src, start, command) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i++;

  // `\newcommand*` and `\DeclareMathOperator*` put the star before the name.
  let starred = false;
  if (src[i] === '*') {
    starred = true;
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
  }

  // The name is either a control sequence (`\def\foo`) or a braced one
  // (`\newcommand{\foo}`); `\newcommand\foo` is also legal.
  let name;
  if (src[i] === '{') {
    const g = readBalanced(src, i);
    if (!g) return null;
    name = g.text.trim();
    i = g.next;
  } else if (src[i] === '\\') {
    const m = /^\\([a-zA-Z@]+|.)/.exec(src.slice(i));
    if (!m) return null;
    name = m[1];
    i += m[0].length;
  } else if (i < src.length) {
    name = src[i];
    i += 1;
  } else {
    return null;
  }

  name = name.trim().replace(/^\\/, '').replace(/\*$/, '');
  if (!name) return null;

  // parameter count: `[2]` for newcommand, or the bare `#1` text for \def
  let params = 0;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === '[') {
    const close = src.indexOf(']', i);
    if (close > 0) {
      params = paramCount(src.slice(i, close + 1)) ?? 0;
      i = close + 1;
    }
  } else if (command === 'def') {
    // `\def\name#1#2{body}` — the parameter text runs up to the body
    let j = i;
    while (j < src.length && src[j] !== '{') j++;
    params = (src.slice(i, j).match(/#\d/g) || []).length;
    i = j;
  }

  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '{') return null;
  const body = readBalanced(src, i);
  if (!body) return null;

  let replacement = body.text;
  if (command === 'DeclareMathOperator') {
    replacement = `\\operatorname${starred ? '*' : ''}{${body.text}}`;
  }

  return { name, params, body: replacement, next: body.next };
}

function readBalanced(s, i) {
  if (s[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0)
      return { text: s.slice(i + 1, j), next: j + 1 };
  }
  return null;
}

/** Reads one argument: a braced group, or a single token. */
function readArgument(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === '{') return readBalanced(s, i);
  if (i >= s.length) return null;
  // a single character, or a control sequence
  if (s[i] === '\\') {
    const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
    return { text: m[0], next: i + m[0].length };
  }
  return { text: s[i], next: i + 1 };
}

/**
 * Expands every known macro in a fragment of maths.
 *
 * @param {string} tex
 * @param {Map<string, {params:number, body:string}>} macros
 */
export function expandMacros(tex, macros, depth = 0) {
  if (!macros || macros.size === 0 || !tex || depth > MAX_DEPTH) return tex;

  let out = '';
  let i = 0;
  let changed = false;

  while (i < tex.length) {
    const c = tex[i];
    if (c !== '\\') { out += c; i++; continue; }

    const m = /^\\([a-zA-Z@]+|.)/.exec(tex.slice(i));
    if (!m) { out += c; i++; continue; }
    const word = m[1];
    const def = macros.get(word);

    if (!def) { out += m[0]; i += m[0].length; continue; }

    // read the arguments this macro takes
    let j = i + m[0].length;
    const args = [];
    for (let a = 0; a < (def.params || 0); a++) {
      const arg = readArgument(tex, j);
      if (!arg) break;
      args.push(arg.text);
      j = arg.next;
    }

    let body = def.body;
    // substitute #1..#9, longest index first so #10 is not read as #1
    body = body.replace(/#(\d)/g, (_, d) => (args[Number(d) - 1] ?? ''));
    out += body;
    changed = true;
    i = j;
  }

  return changed ? expandMacros(out, macros, depth + 1) : out;
}

/**
 * Reads one `\definecolor{name}{model}{spec}`.
 *
 * A colour the document defines travels with any drawing that uses it: the
 * picture is compiled on its own, and `darkred` means nothing without the
 * declaration that gave it a value.
 */
export function readColorDefinition(src, start) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i++;
  const parts = [];
  for (let n = 0; n < 3; n++) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') break;
    const g = readBalanced(src, i);
    if (!g) return null;
    parts.push(g.text);
    i = g.next;
  }
  return parts.length ? { text: parts.join('}{'), next: i } : null;
}

export function collectDefinitions(
  src,
  macros,
  tikzStyles = [],
  colors = [],
  codeEnvs = new Set()
) {
  // Records every definition in a run of source, without producing content.
  // The block reader skips the preamble where notation is defined, so this
  // walks the text purely to collect definitions.
  //
  // `\DefineVerbatimEnvironment{rawsrc}{BVerbatim}` builds a code environment
  // under an arbitrary name carrying no hint that it is one, so the names are
  // read from the preamble rather than guessed from the body. Otherwise the
  // environment falls through to the prose reader and its listing is typeset
  // as paragraphs.
  const verbRe = /\\(?:DefineVerbatimEnvironment|DefineVerbatim)\s*\{\s*([a-zA-Z@]+)\s*\}/g;
  let vm;
  while ((vm = verbRe.exec(src)) !== null) codeEnvs.add(vm[1]);
  // the older spelling: `\newenvironment{rawsrc}{\BVerbatim}{}`
  const envRe = /\\(?:new|renew|provide)environment\s*\{\s*([a-zA-Z@]+)\s*\}\s*\{/g;
  let em;
  while ((em = envRe.exec(src)) !== null) {
    const body = readBalanced(src, em.index + em[0].length - 1);
    if (body && /\\(?:B|L)?Verbatim\b/.test(body.text)) codeEnvs.add(em[1]);
    envRe.lastIndex = body ? body.next : em.index + em[0].length;
  }

  // Colour declarations travel with the drawing for the same reason styles do.
  const colourRe = /\\(definecolor|colorlet|providecolor|pagecolor)\b/g;
  let cm;
  while ((cm = colourRe.exec(src)) !== null) {
    const def = readColorDefinition(src, cm.index + cm[0].length);
    if (!def) { colourRe.lastIndex = cm.index + cm[0].length; continue; }
    // only a three-part form carries a value; a two-part \colorlet is a
    // rename and belongs to the document, not to the picture
    if (def.text.split('}{').length === 3) colors.push(`\\${cm[1]}{${def.text}}`);
    colourRe.lastIndex = def.next;
  }

  const re = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def|tikzset)\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // `\tikzset{...}` declares drawing styles, and a drawing cannot be compiled
    // without them: a node written `[value]` means nothing unless the document
    // also declared `value/.style`, usually in a shared header file.
    if (m[1] === 'tikzset') {
      let j = m.index + m[0].length;
      while (j < src.length && /\s/.test(src[j])) j++;
      const group = src[j] === '{' ? readBalanced(src, j) : null;
      if (group) { tikzStyles.push(group.text); re.lastIndex = group.next; continue; }
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    // skip anything already inside a definition body, so a nested-looking
    // `\def` cannot be mistaken for a real one
    const def = readDefinition(src, m.index + m[0].length, m[1]);
    if (!def) { re.lastIndex = m.index + m[0].length; continue; }
    if (!/environment/.test(m[1]) && def.name) {
      macros.set(def.name, { params: def.params, body: def.body });
    }
    re.lastIndex = def.next;
  }
  return macros;
}
