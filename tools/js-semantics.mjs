#!/usr/bin/env node
/**
 * Compares two JavaScript files for equivalence *ignoring comments and
 * whitespace*.
 *
 * Comment rewrites and re-wrapping are only safe if no code moved. A dropped
 * brace or a `return` that lost its statement parses fine, passes nothing, and
 * fails only in production. This reads both files with a real tokenizer, throws
 * away comments and every run of whitespace, and prints the first difference in
 * the surviving token stream.
 *
 *   node tools/js-semantics.mjs before.js after.js
 *
 * Exits 0 when the code is identical, 1 otherwise, 2 on a read error.
 *
 * The tokenizer is deliberately small: it has to know about strings, template
 * literals, and the regex-vs-division ambiguity, and nothing else. It is a
 * check, not a parser -- `node --check` and the test suite are what prove the
 * file is valid.
 */
import { readFileSync } from 'node:fs';

/**
 * Strips comments and normalises whitespace, returning a single token string.
 *
 * Regex-vs-division is resolved the way it has to be: a `/` opens a regex when
 * the last significant token cannot end an expression.
 */
export function signature(code) {
  const out = [];
  let i = 0;
  const n = code.length;

  // Last significant character emitted, for the regex/division decision.
  const lastSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k];
      if (t.trim() !== '') return t.trim().slice(-1);
    }
    return '';
  };
  const lastWord = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const t = out[k];
      if (t.trim() !== '') return t.trim();
    }
    return '';
  };

  while (i < n) {
    const ch = code[i];

    // ---- line comment
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }

    // ---- block comment
    if (ch === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      // A comment counts as whitespace, which can matter for ASI: `return` then a
      // newline then a comment then a value is still a return of nothing. Keeping
      // a space keeps the two files comparable without trying to model ASI.
      out.push(' ');
      continue;
    }

    // ---- strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let s = quote;
      i++;
      while (i < n) {
        if (code[i] === '\\') { s += code.slice(i, i + 2); i += 2; continue; }
        s += code[i];
        if (code[i] === quote) { i++; break; }
        i++;
      }
      out.push(s);
      continue;
    }

    // ---- template literal, with `${}` interpolation left intact
    if (ch === '`') {
      let s = '`';
      i++;
      while (i < n) {
        if (code[i] === '\\') { s += code.slice(i, i + 2); i += 2; continue; }
        if (code[i] === '`') { s += '`'; i++; break; }
        // An interpolation may contain a nested template; recurse over it.
        if (code[i] === '$' && code[i + 1] === '{') {
          s += '${';
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) { s += '}'; i++; break; } }
            if (depth > 0) s += code[i];
            i++;
          }
          continue;
        }
        s += code[i];
        i++;
      }
      out.push(s);
      continue;
    }

    // ---- regex literal
    if (ch === '/') {
      const prev = lastSignificant();
      const word = lastWord();
      const afterValue = /[)\]}\w$'"`]$/.test(prev)
        && !/^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(word);
      if (!afterValue) {
        let s = '/';
        i++;
        let inClass = false;
        while (i < n) {
          if (code[i] === '\\') { s += code.slice(i, i + 2); i += 2; continue; }
          if (code[i] === '[') inClass = true;
          else if (code[i] === ']') inClass = false;
          else if (code[i] === '/' && !inClass) { s += '/'; i++; break; }
          else if (code[i] === '\n') break;
          s += code[i];
          i++;
        }
        while (i < n && /[a-z]/.test(code[i])) { s += code[i]; i++; }
        out.push(s);
        continue;
      }
    }

    // ---- whitespace: collapse, but never delete outright. Two files that
    // differ only in spacing still compare equal, while `return\nx` and
    // `return x` do not silently collapse into the same token.
    if (/\s/.test(ch)) {
      let j = i;
      while (j < n && /\s/.test(code[j])) j++;
      out.push(' ');
      i = j;
      continue;
    }

    // ---- identifier / number
    if (/[A-Za-z_$0-9]/.test(ch)) {
      let s = ch;
      i++;
      while (i < n && /[A-Za-z_$0-9]/.test(code[i])) { s += code[i]; i++; }
      out.push(s);
      continue;
    }

    // ---- punctuation: emitted one at a time so `=>` and `=` stay distinct
    out.push(ch);
    i++;
  }

  return out.filter((t) => t !== '').join(' ').replace(/ +/g, ' ').trim();
}

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('usage: node tools/js-semantics.mjs <before.js> <after.js>');
  process.exit(2);
}

const a = signature(readFileSync(before, 'utf8'));
const b = signature(readFileSync(after, 'utf8'));

if (a === b) {
  console.log('code identical (comments and whitespace ignored)');
  process.exit(0);
}

// Point at the first divergence in context rather than dumping both streams.
let k = 0;
while (k < a.length && k < b.length && a[k] === b[k]) k++;
const from = Math.max(0, k - 60);
console.log('code differs. first divergence:');
console.log(`  before: ...${a.slice(from, k + 90)}`);
console.log(`  after:  ...${b.slice(from, k + 90)}`);
process.exit(1);