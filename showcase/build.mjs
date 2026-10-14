#!/usr/bin/env node
/**
 * Builds the showcase.
 *
 *   node showcase/build.mjs
 *
 * Three passes, all through λtex2web itself:
 *
 *   1. the sources -> site/   (one layout and palette per document)
 *   2. the index   -> ./index.html  (docs layout, --base site/)
 *
 * Every document is the original author source, unmodified; see
 * showcase/papers/PROVENANCE.md. Nothing here is hand-written HTML: the landing
 * page is written in LaTeX like everything else.
 *
 * Figures are delegated to a real LaTeX engine when one is installed, and shown
 * as source when one is not. Vector artwork is rasterised at build time, since
 * a PDF in an <img> displays nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cli = path.join(root, 'src', 'cli.js');
// Where the pages go. Overridable so `verify.mjs` can build a copy somewhere
// disposable and compare it against a baseline, without touching what is checked
// in at the repository root.
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : process.cwd();
})();

const scratch = path.join('/private/var/folders/5b/pv0r505j6012mz0ns8437tpc0000gn/T/opencode', 'showcase-check');

const PAPERS = [
  {
    file: 'showcase/papers/attention-2017/ms.tex',
    theme: 'paper',
    palette: { light: 'slate', dark: 'slate-dark' },
    // The source carries no `\date` -- it is the NeurIPS 2017 final template,
    // with `nips_2017` loaded in final mode and a bibliography of 2017 entries --
    // so the year is taken from the template rather than from a date the file
    // states. That is the same bargain as the Perelman entry below: a converter
    // may be told something the source implies, but it is not told something the
    // source contradicts.
    date: '2017',
    label: 'Attention Is All You Need — computer science',
  },
  {
    file: 'showcase/papers/perelman-2002/src.tex',
    theme: 'paper',
    palette: { light: 'slate', dark: 'slate-dark' },
    // Supplied in full rather than as a bare year, because the year alone under a
    // title reads as a decade rather than as a date, and the day is the part that
    // tells three papers in the same month apart. The source carries no date of its
    // own, so it is given here rather than invented into it.
    //
    // This was carrying a November 2024 date, which was presumably the day the
    // file was fetched, and it was printed under the title as though it were the
    // date of the work: a twenty-two-year-old paper attributed to last year.
    date: 'November 11, 2002',
    label: 'Perelman, Ricci flow — mathematics',
  },
  {
    file: 'showcase/papers/fleuret-attention/dlc-slides-13-2-attention-mechanisms.tex',
    theme: 'notes',
    palette: { light: 'slate', dark: 'slate-dark' },
    // This deck is not the file Fleuret published. It is converted from a copy
    // whose sources were edited to get through the converter -- unsupported
    // packages, beamer-only macros, diagrams that cannot be compiled -- so some
    // material is missing and some is arranged differently.
    //
    // No `notice`: a caveat outliving its reason reads as a warning about a page
    // that is in fact fine. The numbering is checked against the published PDF
    // instead, and the sources carry provenance at
    // showcase/papers/fleuret-attention.
    //
    // `\dlcref{einstein-summations}` (source line 920) refers to a sibling deck
    // of the same course, resolved here from the published PDF itself: slide
    // 18/30 (p33) renders it as lecture 1.5 "High dimension tensors" -- see
    // .opencode/research/fleuret-13-2-groundtruth.md section 6.
    xrefs: { 'einstein-summations': '1.5. ``High dimension tensors\'\'' },
    label: "Fleuret's lecture — a real beamer deck",
  },
];

const run = (args, label) => {
  process.stdout.write(`  ${label}\n`);
  execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
};

/**
 * The masthead, built from the same list the papers are built from.
 *
 * Every page carries it, not just the front page: a reader who has followed a
 * link from the landing page needs a way back, and the wordmark is only a link
 * if it goes somewhere sensible.
 */
const NAV = [
  {
    // Examples first: this is a page about what it makes, so what it makes is the
    // first thing in the bar.
    label: 'Examples',
    items: [
      { label: 'Math', note: 'Perelman, the entropy formula for the Ricci flow', href: 'site/src.html' },
      { label: 'CompSci', note: 'Vaswani et al., Attention Is All You Need', href: 'site/ms.html' },
      { label: 'Lecture', note: 'A course on attention, by Fran\u00e7ois Fleuret', href: 'site/dlc-slides-13-2-attention-mechanisms.html' },
    ],
  },
  {
    // One place, not three: a real documentation page, written in LaTeX and
    // converted like everything else here. The menu entry earns its place by
    // going somewhere; an anchor three lines down the page you are already on
    // would not.
    label: 'Docs',
    href: 'site/docs.html',
  },
];
const GITHUB = 'leoldev/latex2web';

/**
 * The navigation, with its hrefs rebased.
 *
 * `NAV` is written once, for the page at the root of the site, where `site/ms.html`
 * is right. A page one directory down needs `../site/ms.html` -- or, since the
 * target is a sibling, simply the file name. Rebasing keeps one list of links for
 * the whole site, which is the only way the bar on the front page and the bar on
 * the documentation page can be the same bar.
 */
const rebase = (nav, prefix) => nav.map((entry) => ({
  ...entry,
  ...(entry.href ? { href: prefix + entry.href } : {}),
  ...(entry.items ? {
    items: entry.items.map((i) => ({ ...i, href: i.href.replace(/^site\//, '') })),
  } : {}),
}));

/**
 * Writes a config so each document can carry its own layout, palette and chrome.
 *
 * `home` is explicit because the default is wrong here. A page in `site/` has
 * `./` for a home page, which is `site/` itself -- so the wordmark on a paper
 * led to the slides, which are the only thing in that folder a reader can reach.
 * It has to be `../` to mean the front page.
 */
const configFor = (paper, home) => JSON.stringify({
  theme: paper.theme,
  palette: paper.palette,
  // The paper itself carries no date -- Perelman's is undated -- so the revision
  // is supplied here rather than invented into the source.
  date: paper.date,
  notice: paper.notice,
  // The full navigation, on every page.
  //
  // Every page carries the same masthead, and a document's wordmark goes to the
  // front page rather than nowhere. A bar that appears on two pages and vanishes
  // on the third tells a reader the paper is somewhere else.
  //
  // `nav` stays opt-in in the converter: pointed at a single paper it produces a
  // paper with no menu, which is right for one published on its own.
  nav: rebase(NAV, home),
  // The footer still follows the earlier line: a site footer is the mark, a
  // sentence about the tool and the site's own links, and on a converted document
  // all three are about something the reader did not come for. So the papers get
  // the colophon -- the one line of small print that is a note about the
  // document -- and only the pages that are about the site get the rest.
  footer: false,
  github: GITHUB,
  home,
  // Sibling-deck cross-references for `\dlcref`, when the document supplies
  // them (see the Fleuret entry above). Anything else on the paper object is
  // page furniture, not converter input, so only this key travels.
  ...(paper.xrefs ? { xrefs: paper.xrefs } : {}),
});

// Clean the directory this run is about to write into, and only that one: a
// hardcoded path would let a caller passing `--out` delete the real showcase.
//
// The figure cache is moved out first. It lives in `<out>/.figures`, inside the
// directory being emptied, so a wholesale delete threw it away and every run
// recompiled all fifty-odd TikZ drawings from source -- a cache that can never hit
// is the same as no cache. It goes back afterwards.
const siteDir = path.join(OUT, 'site');
const figureCache = path.join(siteDir, '.figures');
const stash = path.join(OUT, '.figures-cache-stash');
if (existsSync(figureCache)) renameSync(figureCache, stash);
if (existsSync(siteDir)) rmSync(siteDir, { recursive: true, force: true });
if (existsSync(stash)) {
  mkdirSync(siteDir, { recursive: true });
  renameSync(stash, figureCache);
}

console.log('λtex2web showcase\n');
console.log('1. sources -> site/');
for (const paper of PAPERS) {
  const cfg = path.join(scratch, `${path.basename(path.dirname(paper.file))}.json`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(cfg, configFor(paper, '../'));
  run([paper.file, '-o', siteDir, '--config', cfg, '-q'], paper.label);
}

console.log('\n1b. docs -> site/docs.html');
// The documentation page is LaTeX too. It is a page about the tool written in the
// tool, which is the only honest way to claim that a document written this way can
// come out readable.
//
// It gets the site nav and the full footer, because it is a page *about the site*:
// the same reasoning that keeps both off a converted paper puts both on this one.
{
  const docsCfg = path.join(scratch, 'docs.json');
  rmSync(scratch, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(docsCfg, JSON.stringify({
    // `notes`, not `docs`. The docs layout puts sections in cards and has no room
    // for a contents rail, so it laid a 240px column of prose down the left with the
    // contents spilling across the rest of the page and every code block scrolled
    // inside its own card. A reference page is a wide measure with a rail beside
    // it, which is what `notes` is.
    theme: 'notes',
    palette: { light: 'slate', dark: 'slate-dark' },
    // The navigation's hrefs are written for the front page, which sits at the
    // root and reaches the examples through `site/`. This page is *inside* `site/`,
    // so those links came out as `site/site/ms.html` -- four of them, and every one
    // of them a 404. Rebased rather than re-declared: a second copy of the
    // navigation is a second thing to forget to update.
    nav: rebase(NAV, '../'),
    github: GITHUB,
    home: '../',
    motion: 'off',
  }));
  run(['showcase/docs.tex', '-o', siteDir, '--config', docsCfg, '-q'], 'Documentation');

  // Every build writes two files for a single input: `index.html` as the entry
  // point and `<name>.html` beside it. For the three papers that is what a
  // static host wants. For the documentation page inside `site/` it is a
  // duplicate -- `site/index.html` is a byte-for-byte copy of `site/docs.html`,
  // reachable from nothing, and it shadows the front page for anyone who serves
  // `site/` as the root. The front page already lives at the root of the
  // repository, so the copy has no one to be.
  rmSync(path.join(siteDir, 'index.html'), { force: true });
}

console.log('\n2. index -> ./index.html');
// The landing page joins the pages already in site/ rather than beside itself,
// so it links site/theme-docs.css and the shared font tree already there. It
// brings its own figures, compiled like any other.
//
// The masthead is configured rather than hand-written: the three documents are
// the Examples dropdown, and it is built from the same list the papers were
// built from, so a paper added to PAPERS above appears in the menu on its own.

const indexCfg = path.join(scratch, 'index.json');
mkdirSync(scratch, { recursive: true });
writeFileSync(indexCfg, JSON.stringify({
  nav: NAV,
  github: GITHUB,
  // The same palette pair the papers use. Without the dark half the front page
  // had no dark scheme at all and stayed paper-white under a dark system, while
  // every page linked from it went dark -- so it was the one page that did not
  // follow the reader's system.
  palette: { light: 'slate', dark: 'slate-dark' },
  // The front page is the root of the site, so its wordmark goes there.
  home: './',
  // The title, the sentence about the tool and the row of examples are one
  // thing: the hero. The contents starts below them, level with the first
  // section, which is the first thing the contents lists.
  hero: 'front-matter',
  // And the title is the mark rather than a serif heading, because it is the
  // same object as the mark in the masthead above it.
  wordmarkHero: true,
}));

run(['showcase/index.tex', '-o', OUT, '-t', 'landing', '--base', 'site/',
  '--config', indexCfg, '-q'], 'landing page (landing layout)');

rmSync(scratch, { recursive: true, force: true });

console.log('\ndone\n  open: index.html');