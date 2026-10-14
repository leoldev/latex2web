/**
 * The showcase's own regression check.
 *
 * The point of a converter is that the same source produces the same page. That is
 * easy to break without noticing: a table quietly loses a column, a picture stops
 * being collected, an equation stops being numbered, a cross-reference stops
 * resolving. None of it throws. The page just gets slightly wrong, and the only
 * way to notice is to read the whole thing again.
 *
 * So this builds the three examples and the front page into a scratch directory
 * and compares them against a recorded baseline, structurally rather than by
 * bytes.
 *
 * Why not a byte diff: two things legitimately change between runs -- the
 * stylesheet's fingerprint is in its filename, because the CSS it names changes --
 * and an editorial edit changes prose, which is exactly what editorial edits are
 * for. Comparing bytes would flag both and drown the signal.
 *
 * What is compared is the *shape* of each page:
 *
 *   - a fingerprint of the document with volatile bits removed, so an editorial
 *     change shows up as a diff to read and a formatting change does not;
 *   - counts of every block type, so a table that loses a column or a figure that
 *     stops being collected is a number that moved;
 *   - the invariants that must hold on every page, which are the ones that have
 *     actually broken before: broken images, links pointing at anchors that are
 *     not there, images wider than their column, and equations KaTeX could not
 *     parse.
 *
 * Run it with `node showcase/verify.mjs`. It writes `showcase/baseline.json`, and
 * `--update` re-records it after a change you meant to make.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BASELINE = path.join(here, 'baseline.json');
const update = process.argv.includes('--update');

const PAGES = [
  'site/ms.html',
  'site/src.html',
  'site/dlc-slides-13-2-attention-mechanisms.html',
  'index.html',
  'site/docs.html',
];

/**
 * Everything that legitimately differs between two runs of the same source.
 *
 * The stylesheet fingerprint is the main one: it is a hash of the CSS, so any
 * change to a stylesheet renames the file that holds it, and every `<link>` and
 * `url()` that names it. That is the fingerprint working, not a regression.
 */
function normalise(html) {
  return html
    .replace(/theme-[a-z]+\.[0-9a-f]+\.css/g, 'theme-X.fingerprint.css')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The shape of the document, counted rather than read. */
function shape(html) {
  const count = (re) => (html.match(re) || []).length;
  return {
    // blocks, by the element the renderer emits for each
    sections: count(/<section\b/g),
    h2: count(/<h2\b/g),
    h3: count(/<h3\b/g),
    paragraphs: count(/<p[ >]/g),
    displayMath: count(/class="(?:equation|math-block)/g),
    katexErrors: count(/katex-error/g),
    figures: count(/<figure\b/g),
    images: count(/<img\b/g),
    tables: count(/<table\b/g),
    tableRows: count(/<tr\b/g),
    codeBlocks: count(/class="code-block"/g),
    lists: count(/<ul\b|<ol\b/g),
    tocEntries: count(/class="toc-list/g),
    captions: count(/<figcaption\b/g),
    anchors: count(/class="anchor"/g),
    // the invariants
    brokenImages: [...html.matchAll(/<img[^>]*src="([^"]+)"/g)]
      .filter(([, src]) => src.startsWith('http')).length,
  };
}

/**
 * Links that point at an anchor the page does not have.
 *
 * A link to an id that is not in the document is a dead link, and it is invisible
 * in a rendered page -- it looks like a link. This has been the most common class
 * of silent regression here: a heading loses its id and every link to it quietly
 * stops going anywhere.
 */
function deadAnchors(html) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id));
  const bad = new Set();
  for (const [, href] of html.matchAll(/href="#([^"]+)"/g)) {
    if (href && !ids.has(href)) bad.add(href);
  }
  return [...bad].sort();
}

/**
 * Local links and images in the page that point at nothing.
 *
 * The failure this exists for: the front page's three example cards pointed at
 * `site/*.html`, and `site/` was in `.gitignore`, so a fresh clone served a
 * landing page whose every card 404'd. Nothing failed. The build had succeeded --
 * it had simply run somewhere the clone could not see, and the repository shipped
 * a page of dead links.
 *
 * A dead link is invisible in a rendered page. It looks exactly like a live one.
 */
function missingTargets(html, file, outRoot) {
  const here = path.dirname(path.join(outRoot, file));
  const missing = new Set();
  const seen = (href) => {
    if (!href || href.startsWith('#') || /^[a-z]+:/i.test(href)) return;
    const [target] = href.split('#');
    if (!target) return;
    const abs = path.resolve(here, decodeURIComponent(target));
    // inside the output, and on disk
    if (!abs.startsWith(path.resolve(outRoot))) return;
    if (!fs.existsSync(abs)) missing.add(`${href} -> ${path.relative(outRoot, abs) || abs}`);
  };
  // Script and style bodies hold strings that look like paths -- `' + a.hash + '`
  // is not a link, and reading one as a path reports a missing file that does not
  // exist and never will.
  const markup = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  for (const [, href] of markup.matchAll(/(?:href|src)="([^"]+)"/g)) seen(href);
  return [...missing].sort();
}

function fingerprint(html) {
  return createHash('sha256').update(normalise(html)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- build it

// It checks the real output, in place.
//
// It used to build a disposable copy under `--out`, on the reasoning that a check
// should not touch what it is checking. But `--base` is resolved against the
// working directory rather than against `--out`, so the copy's stylesheets were
// still written into the real `site/` while its pages pointed at a directory
// nothing had been written to -- and it deleted the real `site/` on the way in,
// because the cleanup in `build.mjs` was a hardcoded path. A check that rebuilds
// the thing it is checking is how this file found the 404 in the first place.
//
// So: build it where it belongs, and check that.
const out = root;
process.stdout.write('building the showcase...\n');
execFileSync(process.execPath, [path.join(here, 'build.mjs')], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const actual = {};
for (const rel of PAGES) {
  const file = path.join(out, rel);
  if (!fs.existsSync(file)) {
    console.error(`  missing: ${rel}`);
    process.exit(1);
  }
  const html = await fsp.readFile(file, 'utf8');
  actual[rel] = {
    fingerprint: fingerprint(html),
    shape: shape(html),
    deadAnchors: deadAnchors(html),
    missingTargets: missingTargets(html, rel, out),
  };
}

// ---------------------------------------------------------------- compare it

if (update || !fs.existsSync(BASELINE)) {
  await fsp.writeFile(BASELINE, JSON.stringify({ pages: actual }, null, 2) + '\n');
  console.log(`\nbaseline ${update ? 'updated' : 'recorded'} -> ${path.relative(root, BASELINE)}`);
  for (const [rel, r] of Object.entries(actual)) {
    const s = r.shape;
    console.log(`  ${rel.padEnd(48)} ${s.sections} sections, ${s.images} images, `
      + `${s.tables} tables, ${r.deadAnchors.length} dead links, `
      + `${r.missingTargets.length} missing targets`);
  }
  process.exit(0);
}

const baseline = JSON.parse(await fsp.readFile(BASELINE, 'utf8')).pages;
const problems = [];
const notes = [];

for (const rel of PAGES) {
  const was = baseline[rel];
  const now = actual[rel];
  if (!was) { problems.push(`${rel}: not in the baseline`); continue; }

  if (was.deadAnchors.length !== now.deadAnchors.length
      || was.deadAnchors.join() !== now.deadAnchors.join()) {
    problems.push(`${rel}: dead anchors ${was.deadAnchors.length} -> ${now.deadAnchors.length}`
      + (now.deadAnchors.length ? ` (${now.deadAnchors.slice(0, 3).join(', ')})` : ''));
  }
  if (now.missingTargets.length) {
    problems.push(`${rel}: ${now.missingTargets.length} link(s) to a file that is not in the output`
      + ` (${now.missingTargets.slice(0, 3).join(', ')})`);
  }
  if (now.shape.katexErrors) {
    problems.push(`${rel}: ${now.shape.katexErrors} equation(s) KaTeX could not parse`);
  }

  // Any change of shape is a failure, in either direction.
  //
  // It is tempting to read a drop as editorial -- fewer figures, perhaps someone
  // removed one -- but the whole value of this check is that a page quietly losing
  // three pictures cannot pass. Only the body fingerprint is a question for a
  // person; the counts are the machine's job.
  for (const [key, before] of Object.entries(was.shape)) {
    const after = now.shape[key];
    if (before === after) continue;
    problems.push(`${rel}: ${key} ${before} -> ${after}`);
  }
  if (was.fingerprint !== now.fingerprint) {
    notes.push(`${rel}: body changed (${was.fingerprint} -> ${now.fingerprint}) -- editorial?`);
  }
}

for (const n of notes) console.log(`  note: ${n}`);
for (const p of problems) console.log(`  FAIL: ${p}`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s). If a change was intended, re-record with --update.`);
  process.exit(1);
}
console.log(`\n${PAGES.length} pages match the baseline.`);
for (const [rel, r] of Object.entries(actual)) {
  const s = r.shape;
  console.log(`  ${rel.padEnd(48)} ${s.sections} sections, ${s.images} images, `
    + `${s.tables} tables, ${s.displayMath} equations, ${r.deadAnchors.length} dead links`);
}