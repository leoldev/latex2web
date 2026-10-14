import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHROME_TOKEN_KEYS, MASTHEAD_CSS, stripChrome } from '../src/chrome.js';

// The bar is written once, here, and appended to every layout. What a layout says
// about the bar is removed first, so that the shared block is last and wins. These
// tests are about that removal, because it is the part that fails silently: a
// selector left behind in a stylesheet is not an error a reader sees, it is a rule
// that quietly acquires a body it was never given.

/** Every selector line in `css` that is not followed by a block of its own. */
function orphanedSelectorLines(css) {
  // Significant lines only: comments and blank lines are not selectors, and prose
  // inside a comment ends in commas often enough to be a false positive on every
  // count. Block depth matters too -- a wrapped declaration (a font stack, a long
  // `grid-template-columns`) has lines ending in commas and is not a selector.
  const lines = [];
  let inComment = false;
  let ruleDepth = 0;   // >0 while inside a rule's declaration block
  let atRuleDepth = 0; // >0 while inside an at-rule block
  for (const raw of css.split('\n')) {
    const t = raw.trim();
    if (inComment) { if (t.endsWith('*/')) inComment = false; continue; }
    if (t.startsWith('/*')) { if (!t.endsWith('*/')) inComment = true; continue; }
    if (!t) continue;
    lines.push({ t, atSelectorLevel: ruleDepth === 0 });
    // Update the level *after* recording the line, so a line that opens a block
    // is still judged from the level it was written at.
    const closes = (t.match(/\}/g) || []).length;
    const opens = (t.match(/\{/g) || []).length;
    if (/^\s*@\w/.test(t)) { atRuleDepth += opens - closes; ruleDepth = 0; }
    else if (opens > 0 && closes === 0) { ruleDepth += 1; }
    else if (closes > 0 && opens === 0) { ruleDepth = Math.max(0, ruleDepth - 1); }
    else if (opens > 0 && closes > 0) { /* one-line rule: no change */ }
  }

  const orphans = [];
  for (let i = 0; i < lines.length; i++) {
    const { t } = lines[i];
    if (!lines[i].atSelectorLevel) continue;
    if (t.includes('{') || t.includes('}') || !t.endsWith(',')) continue;
    // A selector list is legitimate: two or more lines each ending in a comma,
    // then the line that opens the block. Walk the whole run before calling
    // anything an orphan.
    let j = i;
    while (j < lines.length && lines[j].t.endsWith(',') && lines[j].atSelectorLevel) j++;
    const terminator = lines[j];
    if (j > i && terminator !== undefined && terminator.t.includes('{')) { i = j; continue; }
    orphans.push(t);
  }
  return orphans;
}

test('the shared block is a template literal that parses, and says so plainly', () => {
  // A backtick inside a CSS comment terminates MASTHEAD_CSS, so every module
  // that imports it fails to parse far from the cause. Stylesheet comments
  // conventionally quote `property` in backticks, so the literal is guarded
  // here rather than by discipline.
  const src = fs.readFileSync(
    fileURLToPath(new URL('../src/chrome.js', import.meta.url)), 'utf8');
  const start = src.indexOf('export const MASTHEAD_CSS = `');
  const body = start + 'export const MASTHEAD_CSS = `'.length;
  const end = src.indexOf('\n`;', body);
  assert.ok(start >= 0 && end > body, 'could not find the MASTHEAD_CSS literal');
  const inside = src.slice(body, end);
  const backticks = (inside.match(/`/g) || []).length;
  assert.equal(backticks, 0,
    `MASTHEAD_CSS contains ${backticks} backtick(s) inside its template literal.\n`
    + 'A backtick closes the string, so a comment mentioning `a-property` silently\n'
    + 'truncates the stylesheet and every module that imports this file stops\n'
    + 'parsing. Use single quotes in the comments in this block.');

  // The block itself has to be well-formed CSS, or the truncation above is only
  // the first of the ways it can go wrong.
  let depth = 0;
  for (const ch of inside) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  assert.equal(depth, 0, `MASTHEAD_CSS has ${depth} unclosed brace(s)`);
  assert.ok(inside.includes('.drop-toggle::before'), 'the literal is missing the arrow');
});

test('a selector list written one per line is removed whole, not half', () => {
  // stripChrome must remove a multi-line selector list whole. A leftover
  // selector line with no body grafts onto whatever block comes next and
  // inherits its declarations; an orphaned `@media` line invalidates the
  // rule that follows it. Neither failure reports an error.
  const css = stripChrome([
    '/* the arrow turns */',
    '.drop:hover .drop-toggle::before,',
    '.drop:focus-within .drop-toggle::before,',
    '.drop[data-open="true"] .drop-toggle::before {',
    '  transform: rotate(-90deg);',
    '  opacity: 0.85;',
    '}',
    '',
    '.doc p { margin: 0 0 var(--sp-4); }',
  ].join('\n'));

  assert.ok(!css.includes('drop-toggle::before'), 'the bar rule survived stripChrome');
  assert.ok(!css.includes('rotate(-90deg)'), 'its declarations survived stripChrome');
  assert.deepEqual(orphanedSelectorLines(css), [], 'a selector was left without a body');
  // The layout's own rule is untouched, and is the only thing the orphan could
  // have been read as.
  assert.match(css, /\.doc p \{ margin: 0 0 var\(--sp-4\); \}/);
});

test('two orphaning lists in a row do not swallow what follows them', () => {
  // The landing shape: two multi-line bar lists, comments, then an at-rule.
  // Each contributes orphans, and the at-rule must not be read as a selector.
  const css = stripChrome([
    '.drop:hover .drop-toggle::before,',
    '.drop:focus-within .drop-toggle::before,',
    '.drop[data-open="true"] .drop-toggle::before { transform: rotate(-90deg); }',
    '',
    '/* the menu is the bar, opened */',
    '.drop:hover .drop-menu,',
    '.drop:focus-within .drop-menu,',
    '.drop[data-open="true"] .drop-menu { opacity: 1; visibility: visible; }',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  .drop-menu, .drop-toggle::before { transition: none; }',
    '}',
    '',
    '.doc p { margin: 0; }',
  ].join('\n'));

  assert.deepEqual(orphanedSelectorLines(css), [], 'a selector was left without a body');
  assert.ok(!css.includes('@media'), 'an at-rule was read as a selector');
  assert.match(css, /\.doc p \{ margin: 0; \}/);
});

test('no layout stylesheet ships a selector without a body', () => {
  // The general guard, over the real files rather than a fixture. Every orphan in
  // a shipped stylesheet is a selector that has quietly acquired whatever block
  // came next: a rule the author never wrote and cannot see.
  const dir = fileURLToPath(new URL('../themes/', import.meta.url));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    const stripped = stripChrome(fs.readFileSync(path.join(dir, file), 'utf8'));
    const orphans = orphanedSelectorLines(stripped);
    assert.deepEqual(orphans, [],
      `${file}: ${orphans.length} selector(s) left without a body:\n  ${orphans.join('\n  ')}`);
  }
});

test('the shared bar keeps its own multi-line selector lists', () => {
  // The coalescing must not eat the shared block's own lists, which are written
  // the same way. If it did, the open state would silently stop being reported.
  assert.match(MASTHEAD_CSS, /\.drop:hover \.drop-toggle::before,\s*\n\s*\.drop:focus-within \.drop-toggle::before,\s*\n\s*\.drop\[data-open="true"\] \.drop-toggle::before \{/);
});

test('a single-line bar rule is removed and takes its comment with it', () => {
  const css = stripChrome([
    '/* the icon wears no plate */',
    '.icon-link:hover { color: var(--ink); background: var(--bg-tint); }',
    '',
    '.doc p { margin: 0; }',
  ].join('\n'));
  assert.ok(!css.includes('.icon-link:hover'), 'the bar rule survived');
  assert.ok(!css.includes('a plate'), 'the comment outlived the rule it explained');
  assert.match(css, /\.doc p \{ margin: 0; \}/);
});

test('a layout rule that only mentions a bar class is left alone', () => {
  // The hero shares class names with the bar mark but is not the bar:
  // stripChrome matches bar rules, never bare class names.
  const css = stripChrome('.hero .doc-title-mark .wordmark-svg { width: 26rem; }');
  assert.match(css, /\.hero \.doc-title-mark \.wordmark-svg \{ width: 26rem; \}/);
});

test('declarations are never mistaken for selectors', () => {
  // The coalescing keys on "no brace, no semicolon", and a declaration always
  // ends in a semicolon. The whole test rests on that, so it is asserted
  // rather than assumed.
  const css = stripChrome([
    '.shell {',
    '  grid-template-columns: var(--rail) minmax(0, 1fr),',
    '                     minmax(0, 1fr);',
    '  gap: var(--sp-7);',
    '}',
    '.drop-toggle { padding: 0.15rem 0.3rem; }',
  ].join('\n'));
  assert.match(css, /grid-template-columns: var\(--rail\) minmax\(0, 1fr\),\s+minmax\(0, 1fr\);/);
  assert.ok(!css.includes('.drop-toggle'), 'the bar rule survived');
  assert.deepEqual(orphanedSelectorLines(css), []);
});

test('every rule a layout is allowed to keep is still balanced', () => {
  // Balanced braces prove nothing on their own: a selector can sit on the
  // wrong block with every brace matched. Check for orphans as well.
  for (const css of [
    '.a,\n.b { color: red; }',
    '.a,\n.b,\n.c { color: red; }',
    '.a { color: red; }\n.b,\n.c { color: blue; }',
    '@media (max-width: 40rem) {\n  .drop-toggle::before { border-top: 1px solid; }\n}',
  ]) {
    const out = stripChrome(css);
    let depth = 0;
    for (const ch of out) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    assert.equal(depth, 0, `unbalanced output from: ${css}`);
    assert.deepEqual(orphanedSelectorLines(out), [], `orphan from: ${css}`);
  }
});

test('the tokens a layout may set are the ones the bar reads', () => {
  // A layout setting a bar token is how a layout changes the bar. A token the bar
  // does not read is a silent no-op, and the layout that set it would look broken.
  const block = MASTHEAD_CSS.slice(0, MASTHEAD_CSS.indexOf('*/'));
  for (const key of CHROME_TOKEN_KEYS) {
    assert.ok(block.includes(`--${key}:`) || MASTHEAD_CSS.includes(`var(--${key}`),
      `bar token --${key} is settable but never read`);
  }
});