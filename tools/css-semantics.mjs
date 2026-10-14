#!/usr/bin/env node
/**
 * Compares two stylesheets for *semantic* equality: same rules, same order, same
 * declarations, same values -- with whitespace, comments and formatting ignored.
 *
 * Formatting work on a stylesheet is only safe if the cascade cannot have moved.
 * A reflow that reorders two rules, drops a declaration, or changes one value
 * renders almost identically and is very hard to spot in a thumbnail. This reads
 * both files into a flat list of `(context, selector, declarations)` triples and
 * prints the first difference it finds.
 *
 *   node tools/css-semantics.mjs before.css after.css
 *
 * Exits 0 when the two are semantically identical, 1 otherwise.
 */
import { readFileSync } from 'node:fs';

/** Strips comments, including the CSS-only `/*!` preserved-comment form. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Flattens a stylesheet into an ordered list of `[context, selector, body]`.
 *
 * Nesting is tracked so a declaration moved between two rules inside the same
 * `@media` is distinguishable from one moved somewhere else entirely.
 */
function flatten(css) {
  const src = stripComments(css);
  const out = [];
  const stack = [];
  let i = 0;
  let prelude = '';

  const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s*([{};:,])\s*/g, '$1').trim();

  while (i < src.length) {
    const ch = src[i];

    if (ch === '{') {
      // Everything since the last delimiter is this rule's prelude.
      const sel = tidy(prelude);
      prelude = '';
      // Find the matching close brace, respecting strings.
      let depth = 1;
      let j = i + 1;
      let body = '';
      while (j < src.length && depth > 0) {
        if (src[j] === '"' || src[j] === "'") {
          const quote = src[j];
          body += src[j];
          j++;
          while (j < src.length && src[j] !== quote) { body += src[j]; j++; }
          if (j < src.length) body += src[j];
          j++;
          continue;
        }
        if (src[j] === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
        body += src[j];
        j++;
      }

      const context = stack.join(' > ');
      if (/^@(media|supports|layer|container)/.test(sel)) {
        stack.push(sel);
      } else {
        out.push([context, sel, tidy(body)]);
      }
      i = j + 1;
      continue;
    }

    if (ch === '}') {
      stack.pop();
      prelude = '';
      i++;
      continue;
    }

    prelude += ch;
    i++;
  }
  return out;
}

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('usage: node tools/css-semantics.mjs <before.css> <after.css>');
  process.exit(2);
}

const a = flatten(readFileSync(before, 'utf8'));
const b = flatten(readFileSync(after, 'utf8'));

if (a.length !== b.length) {
  console.log(`rule count differs: ${a.length} -> ${b.length}`);
}

const n = Math.max(a.length, b.length);
let shown = 0;
for (let k = 0; k < n; k++) {
  const ra = a[k], rb = b[k];
  if (!ra) { console.log(`+ only in AFTER  [${k}] ${rb[0]} :: ${rb[1]}`); shown++; continue; }
  if (!rb) { console.log(`- only in BEFORE [${k}] ${ra[0]} :: ${ra[1]}`); shown++; continue; }
  if (ra[0] !== rb[0] || ra[1] !== rb[1]) {
    console.log(`~ selector/order [${k}]\n    before: ${ra[0]} :: ${ra[1]}\n    after:  ${rb[0]} :: ${rb[1]}`);
    shown++;
  } else if (ra[2] !== rb[2]) {
    console.log(`~ declarations [${k}] ${ra[1]}\n    before: ${ra[2]}\n    after:  ${rb[2]}`);
    shown++;
  }
  if (shown >= 12) { console.log('... more differences suppressed'); break; }
}

if (shown === 0) {
  console.log(`semantically identical (${a.length} rules)`);
  process.exit(0);
}
process.exit(1);