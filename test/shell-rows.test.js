import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The shell is a grid with its children placed by row. A row number holds only
// for the layout with that many rows in that order, so one number written once
// and inherited everywhere collides silently: invisible in a build, obvious in
// a browser. Hence these checks read the stylesheet, not a screenshot.

const dir = fileURLToPath(new URL('../themes/', import.meta.url));
const LAYOUTS = ['notes.css', 'paper.css', 'landing.css', 'docs.css', 'slides.css'];

/** Every `@media (min-width: 62rem) { ... }` block, with where it starts and ends. */
function wideQueries(css) {
  const text = [];
  const spans = [];
  const re = /@media \(min-width: 62rem\)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 0;
    for (let i = css.indexOf('{', m.index); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          text.push(css.slice(m.index, i + 1));
          spans.push([m.index, i + 1]);
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  // Narrow is the file with the wide blocks removed *by position*. Removing by
  // string silently leaves the file whole, and every check below runs twice on
  // the same half.
  let narrow = '';
  let at = 0;
  for (const [s, e] of spans) { narrow += css.slice(at, s); at = e; }
  narrow += css.slice(at);
  return { wide: text.join('\n'), narrow };
}

function rowOf(text, selector) {
  const m = new RegExp(`(?:>\\s*)?\\.${selector}\\b[^{}]*\\{[^}]*grid-row:\\s*(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * Strip the rules that only fire when the shell has a hero, so the two cases can
 * be read separately.
 *
 * Hero and plain rules name different rows for the same selectors. Taking the
 * first match of each in the file mixes two shapes that are never active at the
 * same time, and the footer appears to share the article's row in neither.
 */
function withoutHeroRules(text) {
  return text
    .split('\n')
    .filter((line) => !line.includes(':has(> .hero)'))
    .join('\n');
}

function heroRules(text) {
  return text
    .split('\n')
    .filter((line) => line.includes(':has(> .hero)'))
    .join('\n');
}

function check(label, text) {
  const rail = rowOf(text, 'toc-rail');
  const main = rowOf(text, 'main');
  const footer = rowOf(text, 'site-footer');
  const where = `rail=${rail} main=${main} footer=${footer}`;
  if (footer === null) {
    // Left to auto-placement. Sound only if nothing else is placed either,
    // and it is: the children come in document order and the footer is last.
    assert.ok(rail === null && main === null,
      `${label}: footer auto-placed while ${where} are named -- it can land in either`);
    return;
  }
  if (rail !== null) {
    assert.ok(footer > rail, `${label}: footer is not below the rail (${where})`);
  }
  if (main !== null) {
    assert.ok(footer > main, `${label}: footer is not below the article (${where})`);
  }
}

test('no layout puts the footer in a row with the rail or the article', () => {
  for (const file of LAYOUTS) {
    const { wide, narrow } = wideQueries(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const [at, text] of [['wide', wide], ['narrow', narrow]]) {
      // The plain case, and the case where the shell also carries a hero. Both
      // have to hold: a hero is a real shape the shell can have, and the row it
      // pushes everything into is a different set of numbers.
      check(`${file} @ ${at}`, withoutHeroRules(text));
      if (heroRules(text).includes('grid-row')) {
        // With a hero, the hero's own row is row one and everything else follows.
        const hero = rowOf(text, 'hero');
        const rest = rowOf(heroRules(text), 'site-footer');
        assert.ok(hero === 1, `${file} @ ${at}: a hero is given row ${hero}, not row 1`);
        assert.ok(rest !== null && rest > 1, `${file} @ ${at}: with a hero the footer is in row ${rest}`);
      }
    }
  }
});

test('the rail and the article share a row, which is the two-column layout', () => {
  // The inverse of the test above, and the reason it is not a blanket "nothing
  // shares a row": rail in column one, article in column two, same row.
  for (const file of LAYOUTS) {
    const { wide } = wideQueries(fs.readFileSync(path.join(dir, file), 'utf8'));
    const text = withoutHeroRules(wide);
    const rail = rowOf(text, 'toc-rail');
    const main = rowOf(text, 'main');
    if (rail === null || main === null) continue;
    assert.equal(rail, main, `${file}: rail is in row ${rail}, article in row ${main}`);
  }
});

test('no unconditional row rule sits outside the query whose layout it belongs to', () => {
  // A footer row written for the wide layout must live inside the wide query.
  // Outside it the rule applies at every width, where the narrow layout has a
  // different number of rows in a different order.
  //
  // `:has()`-gated rules are exempt: they describe the hero shape, not the
  // narrow rows, and the first test checks that shape on its own.
  for (const file of LAYOUTS) {
    const css = fs.readFileSync(path.join(dir, file), 'utf8');
    const { wide } = wideQueries(css);
    // Match from the whole selector: matching from `.site-footer` onwards
    // misses the `:has(` that decides the exemption.
    const re = /(?:^|[{}])\s*([^{}]*\.(?:site-footer|main|toc-rail|toc-sheet)\b[^{}]*\{[^}]*grid-row)/g;
    const outside = [...css.matchAll(re)]
      .map((m) => m[1].trim())
      .filter((sel) => !sel.includes(':has(') && !wide.includes(sel));
    assert.deepEqual(outside, [],
      `${file}: a shell child is given a row outside the query that defines it`);
  }
});
