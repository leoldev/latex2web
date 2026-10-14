/**
 * Syntax highlighting for fenced/listing code blocks.
 *
 * The renderer emits code as escaped text; this module produces the inner
 * HTML with token spans so `renderCode` can drop it in without changing its
 * escaping contract. Output is always fully escaped first and spans are
 * added afterwards, so source text can never break out of the markup.
 *
 * Each language family shares one small hand-written scanner instead of a
 * pile of regular expressions: linear scans cannot catastrophically
 * backtrack and they degrade gracefully on truncated input (an unterminated
 * string or comment simply runs to the end of the source).
 */

export const SUPPORTED = [
  'javascript', 'js', 'ts', 'typescript',
  'python', 'py',
  'bash', 'sh', 'shell',
  'json',
  'c', 'cpp', 'rust', 'go', 'java',
  'sql', 'html', 'css',
];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** Escape the four characters the renderer treats as dangerous. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

// Aliases collapse to one canonical id per family so the scanners below
// only ever see a small set of names.
const ALIASES = {
  javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript',
  python: 'python', py: 'python',
  bash: 'bash', sh: 'bash', shell: 'bash',
  json: 'json',
  c: 'c', cpp: 'cpp', 'c++': 'cpp',
  rust: 'rust', go: 'go', java: 'java',
  sql: 'sql', html: 'html', css: 'css',
};

/**
 * Normalise a user-supplied language label to its canonical id.
 *
 * Matching is case-insensitive and trims whitespace; known aliases collapse
 * (`JS` -> `javascript`, `py` -> `python`, `sh` -> `bash`).
 * @param {unknown} lang language label from e.g. `lstlisting[language=...]`
 * @returns {string} canonical id, or `''` for empty/unknown input
 */
export function normalizeLang(lang) {
  if (typeof lang !== 'string') return '';
  const key = lang.trim().toLowerCase();
  if (!key) return '';
  return ALIASES[key] || '';
}

/**
 * Report whether a language label maps to a supported highlighter.
 * @param {unknown} lang language label to test
 * @returns {boolean} true when `highlight` would emit token spans
 */
export function isSupported(lang) {
  return normalizeLang(lang) !== '';
}

/** Map a canonical id to the scanner family that handles it. */
function familyOf(norm) {
  switch (norm) {
    case 'javascript':
    case 'typescript':
    case 'c':
    case 'cpp':
    case 'rust':
    case 'go':
    case 'java':
      return 'c';
    case 'python': return 'python';
    case 'bash': return 'shell';
    case 'json': return 'json';
    case 'sql': return 'sql';
    case 'html': return 'html';
    case 'css': return 'css';
    default: return null;
  }
}

/**
 * Highlight source code to safe HTML.
 *
 * Recognised languages get `<span class="tok tok-KIND">` wrappers; unknown
 * or empty languages return plain escaped text. Never throws: every scan
 * advances at least one character, so malformed input just ends the token.
 * @param {unknown} code raw source text
 * @param {unknown} lang language label (case-insensitive, aliases allowed)
 * @returns {string} escaped HTML with optional token spans
 */
export function highlight(code, lang) {
  const src = code == null ? '' : String(code);
  if (!src) return '';
  const norm = normalizeLang(lang);
  if (!norm) return escapeHtml(src);
  switch (familyOf(norm)) {
    case 'c': return renderTokens(tokenizeGeneric(src, cConfig()));
    case 'python': return renderTokens(tokenizeGeneric(src, pythonConfig()));
    case 'shell': return renderTokens(tokenizeGeneric(src, shellConfig()));
    case 'json': return renderTokens(tokenizeGeneric(src, jsonConfig()));
    case 'sql': return renderTokens(tokenizeGeneric(src, sqlConfig()));
    case 'html': return highlightHtml(src);
    case 'css': return highlightCss(src);
    default: return escapeHtml(src);
  }
}

/** Wrap tokens in spans, escaping text before the markup is added. */
function renderTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    const esc = escapeHtml(t.text);
    out += t.kind ? `<span class="tok tok-${t.kind}">${esc}</span>` : esc;
  }
  return out;
}

// ------------------------------------------------------- character helpers
// Single-character tests only: no multi-char regex, so no backtracking risk.

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isHex(ch) {
  return isDigit(ch) || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isAsciiLetter(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

// Non-ASCII code points are treated as identifier parts so unicode words stay
// whole instead of shattering into one span per character.
function isIdentStart(ch) {
  return ch === '_' || ch === '$' || isAsciiLetter(ch) || (ch !== undefined && ch.charCodeAt(0) > 127);
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

function isOpChar(ch) {
  return ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' ||
    ch === '=' || ch === '<' || ch === '>' || ch === '!' || ch === '&' ||
    ch === '|' || ch === '^' || ch === '~' || ch === '?' || ch === ':' || ch === '@';
}

function isPunctChar(ch) {
  return ch === '(' || ch === ')' || ch === '[' || ch === ']' ||
    ch === '{' || ch === '}' || ch === ',' || ch === ';' || ch === '.';
}

// Two- and three-character operators, longest first. Lookup is a Set test on
// a fixed-width slice, so matching is O(1) with no backtracking.
const OP3 = new Set(['===', '!==', '>>>', '<<=', '>>=', '...', '**=', '&&=', '||=', '??=']);
const OP2 = new Set([
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '<<', '>>', '**', '=>', '->', '::', '..', '??',
  '?.', '|>',
]);

// ------------------------------------------------------------- word tables
// One shared C-like table keeps the scanner small; the union covers JS/TS,
// C/C++, Java, Go and Rust keywords that actually appear in listings.

const C_KEYWORDS = new Set(
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return switch throw try typeof var void while with yield async await static get set of from as null undefined true false enum implements interface package private protected public super throws fn func let mut match struct trait type where loop crate mod pub ref self use go chan defer select fallthrough nil int long short char float double signed unsigned sizeof typedef namespace template typename virtual friend constexpr noexcept override final abstract assert synchronized volatile transient native strictfp'.split(' '),
);

const C_VARIABLES = new Set(['this', 'self', 'super']);

const C_TYPES = new Set(
  'void int char short long float double bool boolean byte string number object symbol bigint i8 i16 i32 i64 u8 u16 u32 u64 isize usize f32 f64 str String Vec Option Result Box Self'.split(' '),
);

const C_BUILTINS = new Set(
  'console Math JSON Object Array String Number Boolean Date RegExp Promise Map Set WeakMap WeakSet Symbol Error Proxy Reflect parseInt parseFloat isNaN isFinite require module exports print println printf scanf malloc free exit memcpy fmt Spring System out println size_t stderr stdin stdout'.split(' '),
);

const PYTHON_KEYWORDS = new Set(
  'def class return if elif else for while in is not and or lambda import from as with try except finally raise yield pass global nonlocal assert del async await None True False'.split(' '),
);

const PYTHON_TYPES = new Set(
  'int float str bool bytes list dict set tuple NoneType object type'.split(' '),
);

const PYTHON_BUILTINS = new Set(
  'print len range str int float bool list dict set tuple open input abs min max sum any all enumerate zip map filter sorted reversed isinstance issubclass getattr setattr hasattr super'.split(' '),
);

const PYTHON_VARIABLES = new Set(['self', 'cls']);

const SHELL_KEYWORDS = new Set(
  'if then else elif fi for while until do done case esac in function select time coproc export local readonly return exit break continue declare typeset'.split(' '),
);

const SHELL_BUILTINS = new Set(
  'echo cd ls grep awk sed cat printf test true false pwd mkdir rm cp mv chmod chown source alias unalias trap wait read eval exec shift getopts command builtin'.split(' '),
);

// SQL is case-insensitive, so the table is uppercase and lookups fold.
const SQL_KEYWORDS = new Set(
  'SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET JOIN LEFT RIGHT FULL INNER OUTER CROSS ON AS AND OR NOT NULL INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD INDEX DISTINCT COUNT SUM AVG MIN MAX UNION ALL CASE WHEN THEN ELSE END LIKE ILIKE IN IS BETWEEN EXISTS PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE CHECK CONSTRAINT VIEW ORDER BY GROUP'.split(' '),
);

const JSON_LITERALS = new Set(['true', 'false', 'null']);

// Tags that may appear as bare selectors in CSS, highlighted as `tag`.
const CSS_TAGS = new Set(
  'a abbr body code div em h1 h2 h3 h4 h5 h6 header footer main nav section article aside p span ul ol li table tr td th thead tbody pre blockquote img input button form html'.split(' '),
);

// ------------------------------------------------------------ family configs

function cConfig() {
  return {
    line: ['//'], block: [['/*', '*/']], strings: ['"', "'", '`'],
    triple: false, doubling: false, dollarVars: false,
    keywords: C_KEYWORDS, builtins: C_BUILTINS, types: C_TYPES,
    variables: C_VARIABLES, caseFold: false,
  };
}

function pythonConfig() {
  return {
    line: ['#'], block: [], strings: ['"', "'"],
    triple: true, doubling: false, dollarVars: false,
    keywords: PYTHON_KEYWORDS, builtins: PYTHON_BUILTINS, types: PYTHON_TYPES,
    variables: PYTHON_VARIABLES, caseFold: false,
  };
}

function shellConfig() {
  return {
    line: ['#'], block: [], strings: ['"', "'"],
    triple: false, doubling: false, dollarVars: true,
    keywords: SHELL_KEYWORDS, builtins: SHELL_BUILTINS, types: new Set(),
    variables: new Set(), caseFold: false,
  };
}

function jsonConfig() {
  // Line/block comments are not strict JSON but tolerate JSONC listings.
  return {
    line: ['//'], block: [['/*', '*/']], strings: ['"'],
    triple: false, doubling: false, dollarVars: false,
    keywords: JSON_LITERALS, builtins: new Set(), types: new Set(),
    variables: new Set(), caseFold: false,
  };
}

function sqlConfig() {
  return {
    line: ['--', '#'], block: [['/*', '*/']], strings: ["'", '"', '`'],
    triple: false, doubling: true, dollarVars: false,
    keywords: SQL_KEYWORDS, builtins: new Set(), types: new Set(),
    variables: new Set(), caseFold: true,
  };
}

// -------------------------------------------------------- generic tokenizer
// Shared by every brace-or-line-comment language; HTML and CSS scan below.

function tokenizeGeneric(src, cfg) {
  const tokens = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      tokens.push({ text: buf, kind: null });
      buf = '';
    }
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];

    // Block comments first: `/*` with no terminator runs to end of input.
    let matched = null;
    for (const [open, close] of cfg.block) {
      if (src.startsWith(open, i)) {
        matched = [open, close];
        break;
      }
    }
    if (matched) {
      const end = src.indexOf(matched[1], i + matched[0].length);
      const stop = end === -1 ? n : end + matched[1].length;
      flush();
      tokens.push({ text: src.slice(i, stop), kind: 'comment' });
      i = stop;
      continue;
    }

    // Line comments run to (not including) the newline.
    let isLine = false;
    for (const marker of cfg.line) {
      if (src.startsWith(marker, i)) {
        isLine = true;
        break;
      }
    }
    if (isLine) {
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      flush();
      tokens.push({ text: src.slice(i, j), kind: 'comment' });
      i = j;
      continue;
    }

    // Triple-quoted strings (Python) may span lines; a missing terminator
    // consumes the rest of the input rather than throwing.
    if (cfg.triple && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      const q = src.slice(i, i + 3);
      let j = i + 3;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src.startsWith(q, j)) {
          j += 3;
          break;
        }
        j++;
      }
      flush();
      tokens.push({ text: src.slice(i, j), kind: 'string' });
      i = j;
      continue;
    }

    // Single-quoted strings honour backslash escapes. Only the backtick form
    // may span lines (JS template literals); the rest end at a newline so
    // one stray quote cannot swallow the whole listing.
    if (cfg.strings.includes(ch)) {
      const multiline = ch === '`';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === ch) {
          j++;
          closed = true;
          break;
        }
        // SQL doubles a quote to escape it ('it''s'); the backslash pass
        // above would otherwise end the string early.
        if (cfg.doubling && c === ch && src[j + 1] === ch) {
          j += 2;
          continue;
        }
        if (!multiline && (c === '\n' || c === '\r')) break;
        j++;
      }
      void closed;
      flush();
      tokens.push({ text: src.slice(i, j), kind: 'string' });
      i = j;
      continue;
    }

    // Numbers: hex/binary/octal prefixes, fractions and exponents. A lone
    // `.` never reaches here (the next char must be a digit).
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      let j = scanNumber(src, i);
      flush();
      tokens.push({ text: src.slice(i, j), kind: 'number' });
      i = j;
      continue;
    }

    // Shell variables: $NAME, $1, ${...}. `$` before anything else is left
    // to the operator pass so `$(cmd)` still highlights its parens.
    if (cfg.dollarVars && ch === '$') {
      const next = src[i + 1];
      if (next === '{') {
        const end = src.indexOf('}', i + 2);
        const stop = end === -1 ? n : end + 1;
        flush();
        tokens.push({ text: src.slice(i, stop), kind: 'variable' });
        i = stop;
        continue;
      }
      if (next !== undefined && (isIdentPart(next))) {
        let j = i + 1;
        while (j < n && (isIdentPart(src[j]))) j++;
        flush();
        tokens.push({ text: src.slice(i, j), kind: 'variable' });
        i = j;
        continue;
      }
    }

    // Words: keywords, builtins, types, variables, or a call `name(` which
    // marks a function. Anything else stays plain to keep output compact.
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      const key = cfg.caseFold ? word.toUpperCase() : word;
      let kind = null;
      if (cfg.keywords.has(key)) kind = 'keyword';
      else if (cfg.builtins.has(key)) kind = 'builtin';
      else if (cfg.types.has(key)) kind = 'type';
      else if (cfg.variables.has(key)) kind = 'variable';
      else {
        let k = j;
        while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
        if (src[k] === '(') kind = 'function';
      }
      if (kind) {
        flush();
        tokens.push({ text: word, kind });
      } else {
        buf += word;
      }
      i = j;
      continue;
    }

    // Operators, longest match first on a fixed-width slice.
    if (isOpChar(ch)) {
      let op = ch;
      if (i + 3 <= n && OP3.has(src.slice(i, i + 3))) op = src.slice(i, i + 3);
      else if (i + 2 <= n && OP2.has(src.slice(i, i + 2))) op = src.slice(i, i + 2);
      flush();
      tokens.push({ text: op, kind: 'operator' });
      i += op.length;
      continue;
    }

    if (isPunctChar(ch)) {
      flush();
      tokens.push({ text: ch, kind: 'punct' });
      i++;
      continue;
    }

    // Whitespace and anything unrecognised accumulates as plain text.
    buf += ch;
    i++;
  }
  flush();
  return tokens;
}

/** Scan a numeric literal starting at `i`; the first char is known good. */
function scanNumber(src, i) {
  const n = src.length;
  let j = i;
  // 0x/0b/0o prefixes take only their own digit class.
  if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
    j += 2;
    while (j < n && isHex(src[j])) j++;
    return j;
  }
  if (src[j] === '0' && (src[j + 1] === 'b' || src[j + 1] === 'B')) {
    j += 2;
    while (j < n && (src[j] === '0' || src[j] === '1')) j++;
    return j;
  }
  if (src[j] === '0' && (src[j + 1] === 'o' || src[j + 1] === 'O')) {
    j += 2;
    while (j < n && src[j] >= '0' && src[j] <= '7') j++;
    return j;
  }
  while (j < n && isDigit(src[j])) j++;
  if (src[j] === '.' && isDigit(src[j + 1])) {
    j++;
    while (j < n && isDigit(src[j])) j++;
  }
  if ((src[j] === 'e' || src[j] === 'E') && (isDigit(src[j + 1]) || ((src[j + 1] === '+' || src[j + 1] === '-') && isDigit(src[j + 2])))) {
    j += (src[j + 1] === '+' || src[j + 1] === '-') ? 2 : 1;
    while (j < n && isDigit(src[j])) j++;
  }
  return j;
}

// ------------------------------------------------------------------- HTML
// Markup needs its own scan: text nodes stay plain while tag internals get
// tag/attr/string/number spans.

/** True when a `<` at `j` opens a tag, comment, or declaration. */
function isTagOpen(src, j) {
  if (src[j] !== '<' || j + 1 >= src.length) return false;
  const c = src[j + 1];
  return isAsciiLetter(c) || c === '/' || c === '!' || c === '?';
}

function highlightHtml(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      tokens.push({ text: src.slice(i, stop), kind: 'comment' });
      i = stop;
      continue;
    }
    if (isTagOpen(src, i)) {
      // A quote inside the tag suspends `>` detection so `>` inside an
      // attribute value cannot end the tag early.
      let j = i + 1;
      let q = null;
      while (j < n) {
        const c = src[j];
        if (q) {
          if (c === q) q = null;
          j++;
          continue;
        }
        if (c === '"' || c === "'") {
          q = c;
          j++;
          continue;
        }
        if (c === '>') break;
        j++;
      }
      const stop = j < n ? j + 1 : n;
      for (const t of splitTag(src.slice(i, stop))) tokens.push(t);
      i = stop;
      continue;
    }
    let j = i;
    while (j < n && !src.startsWith('<!--', j) && !isTagOpen(src, j)) j++;
    tokens.push({ text: src.slice(i, j), kind: null });
    i = j;
  }
  return renderTokens(tokens);
}

/** Split one `<...>` span into punct/tag/attr/string/number tokens. */
function splitTag(tag) {
  const out = [{ text: '<', kind: 'punct' }];
  const n = tag.length;
  let i = 1;
  if (tag[i] === '/') {
    out.push({ text: '/', kind: 'punct' });
    i++;
  }
  // Element name: letters, digits and hyphens (custom elements).
  let j = i;
  while (j < n && (isAsciiLetter(tag[j]) || isDigit(tag[j]) || tag[j] === '-' || tag[j] === '_')) j++;
  if (j > i) out.push({ text: tag.slice(i, j), kind: 'tag' });
  i = j;
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ text: buf, kind: null });
      buf = '';
    }
  };
  while (i < n) {
    const c = tag[i];
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && tag[k] !== c) {
        if (tag[k] === '\\') k++;
        k++;
      }
      flush();
      out.push({ text: tag.slice(i, k < n ? k + 1 : n), kind: 'string' });
      i = k < n ? k + 1 : n;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(tag[i + 1]))) {
      const k = scanNumber(tag, i);
      flush();
      out.push({ text: tag.slice(i, k), kind: 'number' });
      i = k;
      continue;
    }
    // Attribute names may contain `:`, `-`, `_`, `.`; a bare word without
    // `=` is still an attribute (boolean attributes like `disabled`).
    if (isAsciiLetter(c) || c === '_' || c === ':') {
      let k = i + 1;
      while (k < n && (isAsciiLetter(tag[k]) || isDigit(tag[k]) || tag[k] === '-' || tag[k] === '_' || tag[k] === ':' || tag[k] === '.')) k++;
      flush();
      out.push({ text: tag.slice(i, k), kind: 'attr' });
      i = k;
      continue;
    }
    if (c === '=') {
      flush();
      out.push({ text: '=', kind: 'operator' });
      i++;
      continue;
    }
    if (c === '/' || c === '>') {
      flush();
      out.push({ text: c, kind: 'punct' });
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// -------------------------------------------------------------------- CSS
// Selectors and declarations share one scan; an identifier's role comes
// from what follows it (`(` call, `:` declaration, known tag name).

function highlightCss(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  const flushBuf = { text: '' };
  const emit = (text, kind) => {
    if (flushBuf.text) {
      tokens.push({ text: flushBuf.text, kind: null });
      flushBuf.text = '';
    }
    if (text) tokens.push({ text, kind });
  };
  while (i < n) {
    const ch = src[i];
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      emit(src.slice(i, stop), 'comment');
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // CSS strings cannot hold a raw newline; stop there so one stray
      // quote does not stringify the rest of the stylesheet.
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n' && src[j] !== '\r') {
        if (src[j] === '\\') j++;
        j++;
      }
      emit(src.slice(i, j < n && src[j] === ch ? j + 1 : j), 'string');
      i = j < n && src[j] === ch ? j + 1 : j;
      continue;
    }
    // At-rules (@media, @import) behave like keywords.
    if (ch === '@' && (isAsciiLetter(src[i + 1]) || src[i + 1] === '_' || src[i + 1] === '-')) {
      let j = i + 1;
      while (j < n && (isAsciiLetter(src[j]) || isDigit(src[j]) || src[j] === '-' || src[j] === '_')) j++;
      emit(src.slice(i, j), 'keyword');
      i = j;
      continue;
    }
    // `#fff` is a colour literal; anything else hashed is an id selector.
    if (ch === '#' && (isAsciiLetter(src[i + 1]) || isDigit(src[i + 1]) || src[i + 1] === '_' || src[i + 1] === '-')) {
      let j = i + 1;
      while (j < n && (isAsciiLetter(src[j]) || isDigit(src[j]) || src[j] === '-' || src[j] === '_')) j++;
      const word = src.slice(i + 1, j);
      const isColor = (word.length === 3 || word.length === 4 || word.length === 6 || word.length === 8) &&
        [...word].every((c) => isHex(c));
      emit(src.slice(i, j), isColor ? 'number' : 'variable');
      i = j;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      let j = scanNumber(src, i);
      // Fold the unit into the number so `12px` and `75%` stay one token.
      while (j < n && (isAsciiLetter(src[j]) || src[j] === '%')) j++;
      emit(src.slice(i, j), 'number');
      i = j;
      continue;
    }
    // `.name` after a non-digit is a class selector, not a number.
    if (ch === '.' && (isAsciiLetter(src[i + 1]) || src[i + 1] === '_' || src[i + 1] === '-')) {
      let j = i + 1;
      while (j < n && (isAsciiLetter(src[j]) || isDigit(src[j]) || src[j] === '-' || src[j] === '_')) j++;
      emit(src.slice(i, j), 'type');
      i = j;
      continue;
    }
    if (ch === '-' && src[i + 1] === '-' && isIdentStart(src[i + 2])) {
      let j = i + 2;
      while (j < n && (isIdentPart(src[j]) || src[j] === '-')) j++;
      emit(src.slice(i, j), 'variable');
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && (isIdentPart(src[j]) || src[j] === '-')) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k++;
      if (src[k] === '(') emit(word, 'function');
      else if (src[k] === ':') emit(word, 'attr');
      else if (CSS_TAGS.has(word.toLowerCase())) emit(word, 'tag');
      else {
        flushBuf.text += word;
      }
      i = j;
      continue;
    }
    if (isOpChar(ch) && ch !== ':') {
      let op = ch;
      if (i + 2 <= n && OP2.has(src.slice(i, i + 2))) op = src.slice(i, i + 2);
      emit(op, 'operator');
      i += op.length;
      continue;
    }
    if (isPunctChar(ch) || ch === ':' || ch === '#') {
      emit(ch, 'punct');
      i++;
      continue;
    }
    flushBuf.text += ch;
    i++;
  }
  if (flushBuf.text) tokens.push({ text: flushBuf.text, kind: null });
  return renderTokens(tokens);
}
