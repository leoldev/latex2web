import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { build } from '../src/index.js';
import { parseArgs } from '../src/args.js';
import { DEFAULTS, checkConfigKeys, loadConfig, resolveAppearance } from '../src/config.js';
import { PALETTES, PALETTE_NAMES, isPalette, resolvePalette } from '../src/palettes.js';
import { loadLayouts, stripTokenBlocks } from '../src/themes.js';
import { MASTHEAD_CSS, stripChrome } from '../src/chrome.js';
import { BASE_LAYOUT, PALETTE_KEYS, deepMerge, tokensToCss, unknownTokens } from '../src/tokens.js';

/**
 * Reads the stylesheet a build emitted for a layout.
 *
 * The name carries a fingerprint of the CSS, so it changes whenever the CSS
 * does; that is the point of it. Tests therefore resolve it by stem rather than
 * by a fixed name, which would fail every time a token changed.
 */
async function readStylesheet(dir, layout) {
  const { readdir } = await import('node:fs/promises');
  const name = (await readdir(dir)).find((f) => f.startsWith(`theme-${layout}.`) && f.endsWith('.css'));
  assert.ok(name, `${layout} stylesheet emitted in ${dir}: ${(await readdir(dir)).join(', ')}`);
  return readFile(path.join(dir, name), 'utf8');
}

async function stylesheetExists(dir, layout) {
  const { readdir } = await import('node:fs/promises');
  try {
    return (await readdir(dir)).some((f) => f.startsWith(`theme-${layout}.`) && f.endsWith('.css'));
  } catch { return false; }
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'l2w-cfg-'));

async function project(files = {}) {
  const root = await tmp();
  await writeFile(path.join(root, 'doc.tex'),
    '\\begin{document}\n\\section{One}\\label{s:1}\nHello $x$.\n\\begin{figure}\\includegraphics{gone.png}\\caption{C}\\end{figure}\n\\end{document}');
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

const htmlIn = async (root, name = 'doc.html') =>
  readFile(path.join(root, 'dist', name), 'utf8');

// ------------------------------------------------------------------- merging

test('deepMerge overrides scalars and recurses into plain objects', () => {
  assert.deepEqual(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } }), { a: 1, b: { c: 9, d: 3 } });
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
  assert.equal(deepMerge('x', 'y'), 'y');
});

test('tokensToCss emits custom properties and skips empties', () => {
  assert.equal(tokensToCss({ ink: '#000', blank: '', gone: null }), '  --ink: #000;');
});

test('unknownTokens reports typos against the known contract', () => {
  assert.deepEqual(unknownTokens({ ink: '#000', inkk: '#111' }), ['inkk']);
  assert.deepEqual(unknownTokens({ measure: '40rem' }, [...PALETTE_KEYS, 'measure']), []);
});

// ------------------------------------------------------------------ palettes

test('every palette supplies every colour token', () => {
  for (const name of PALETTE_NAMES) {
    const missing = PALETTE_KEYS.filter((k) => resolvePalette(name).tokens[k] === undefined);
    assert.deepEqual(missing, [], `${name} is missing tokens`);
  }
});

test('palettes resolve by name, bare flavour and alias', () => {
  assert.equal(resolvePalette('catppuccin-mocha').label, 'Catppuccin Mocha');
  assert.equal(resolvePalette('mocha').tokens, resolvePalette('catppuccin-mocha').tokens);
  assert.equal(resolvePalette('catppuccin/mocha').tokens, resolvePalette('mocha').tokens);
  assert.equal(resolvePalette('MOCHA').tokens, resolvePalette('mocha').tokens);
  assert.ok(isPalette('paper'));
  assert.ok(!isPalette('dracula'));
  assert.throws(() => resolvePalette('nope'), /Unknown palette "nope".*catppuccin-latte/s);
});

test('a light palette is light and a dark palette is dark', () => {
  assert.equal(PALETTES['catppuccin-latte'].dark, false);
  assert.equal(PALETTES['catppuccin-mocha'].dark, true);
  // Latte's base is light, Mocha's is not
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  assert.ok(lum(PALETTES['catppuccin-latte'].tokens.bg) > 0.7);
  assert.ok(lum(PALETTES['catppuccin-mocha'].tokens.bg) < 0.25);
});

test('every palette supplies the font stacks a layout needs', () => {
  for (const name of PALETTE_NAMES) {
    const t = resolvePalette(name).tokens;
    assert.ok(t.serif && t.sans && t.mono, `${name} is missing a font stack`);
  }
});

// -------------------------------------------------------------------- layout

test('layout CSS declares no colours, so the palette is the only source', async () => {
  for (const [name, layout] of Object.entries(await loadLayouts())) {
    const stray = layout.css.split('\n').filter((l) =>
      /^\s*--(?:bg|ink|accent|mark|shadow|tok-|serif|sans|mono)[\w-]*\s*:/.test(l));
    assert.deepEqual(stray, [], `${name}.css still hardcodes colour/type tokens`);
  }
});

test('layout CSS keeps its structure after token stripping', async () => {
  const paper = (await loadLayouts()).paper.css;
  assert.match(paper, /--measure:/);
  assert.match(paper, /--sp-4:/);
  assert.match(paper, /@media print/);
});

test('stripTokenBlocks removes colour lines but keeps a root opener balanced', () => {
  const out = stripTokenBlocks(':root {\n  --ink: #000;\n  --measure: 40rem;\n}\n.x { color: red; }\n');
  assert.match(out, /--measure: 40rem;/);
  assert.doesNotMatch(out, /--ink/);
  assert.match(out, /\.x \{ color: red; \}/);
  assert.equal((out.match(/\{/g) || []).length, (out.match(/\}/g) || []).length);
});

test('an emptied media query is removed', () => {
  const out = stripTokenBlocks('@media (prefers-color-scheme: dark) {\n  html[data-theme="auto"] {\n    --ink: #fff;\n  }\n}\n.x{color:red}\n');
  assert.doesNotMatch(out, /prefers-color-scheme/);
  assert.match(out, /\.x\{color:red\}/);
});

test('a layout and a palette are independent, so they can be mixed', async () => {
  const layouts = await loadLayouts();
  const a = await resolveAppearance({ theme: 'slides', palette: 'catppuccin-latte' }, layouts);
  const b = await resolveAppearance({ theme: 'notes', palette: 'catppuccin-mocha' }, layouts);
  assert.notEqual(a.css, b.css, 'different layouts must differ');
  assert.match(a.css, /--bg: #eff1f5/, 'latte base should be applied to the slides layout');
  assert.match(b.css, /--bg: #1e1e2e/, 'mocha base should be applied to the notes layout');
});

// --------------------------------------------------------------------- files

test('a config file supplies options', async () => {
  const root = await project({
    'latex2web.config.js': "export default { theme: 'notes', out: 'out2', toc: { label: 'Here' } };",
  });
  const config = await loadConfig({ cwd: root });
  assert.equal(config.theme, 'notes');
  assert.equal(config.out, 'out2');
  assert.equal(config.toc.label, 'Here');
  assert.equal(config.__configFile, path.join(root, 'latex2web.config.js'));
});

test('a JSON config file is supported', async () => {
  const root = await project({ 'latex2web.config.json': '{ "theme": "slides", "base": "/d" }' });
  const config = await loadConfig({ cwd: root });
  assert.equal(config.theme, 'slides');
  assert.equal(config.base, '/d');
});

test('a config file may export a function', async () => {
  const root = await project({
    'latex2web.config.js': 'export default (env) => ({ theme: env?.heavy ? "notes" : "paper" });',
  });
  assert.equal((await loadConfig({ cwd: root })).theme, 'paper');
});

test('config is discovered by walking up from the working directory', async () => {
  const root = await project({ 'latex2web.config.js': "export default { theme: 'notes' };" });
  const nested = path.join(root, 'a', 'b');
  await mkdir(nested, { recursive: true });
  assert.equal((await loadConfig({ cwd: nested })).theme, 'notes');
});

test('flags beat the config file', async () => {
  const root = await project({ 'latex2web.config.js': "export default { theme: 'notes', out: 'from-file' };" });
  const config = await loadConfig({ cwd: root, cli: { theme: 'slides', out: 'from-flag', explicit: ['theme', 'out'] } });
  assert.equal(config.theme, 'slides');
  assert.equal(config.out, 'from-flag');
});

test('positional arguments fill in only what a flag has not claimed', async () => {
  const root = await project({ 'cfg.js': "export default { theme: 'notes' };" });

  const neither = await parseArgs(['a.tex', 'positional']);
  assert.equal(neither.input, 'a.tex');
  assert.equal(neither.out, 'positional');
  assert.equal((await loadConfig({ cwd: root, cli: neither })).out, 'positional');

  const flagged = await parseArgs(['a.tex', 'positional', 'cfg.js', '-o', 'flagged']);
  assert.equal(flagged.out, 'flagged', 'the flag beats the positional');
  assert.equal(flagged.config, 'cfg.js', 'the positional still fills the config slot');
  assert.equal((await loadConfig({ cwd: root, cli: flagged })).out, 'flagged');
});

test('extends composes presets from inline objects and paths', async () => {
  const root = await project({
    'base.js': "export default { theme: 'notes', tokens: { accent: '#0a0' } };",
    'latex2web.config.js': "export default { extends: './base.js', tokens: { measure: '44rem' } };",
  });
  const config = await loadConfig({ cwd: root });
  assert.equal(config.theme, 'notes');
  assert.deepEqual(config.tokens, { accent: '#0a0', measure: '44rem' });
});

test('an inline preset object is accepted by extends', async () => {
  const root = await project({
    'latex2web.config.js': "export default { extends: [{ theme: 'notes' }, { base: '/x' }] };",
  });
  const config = await loadConfig({ cwd: root });
  assert.equal(config.theme, 'notes');
  assert.equal(config.base, '/x');
});

test('a broken config is reported clearly', async () => {
  const bad = await project({ 'latex2web.config.json': '{ nope' });
  await assert.rejects(loadConfig({ cwd: bad }), /is not valid JSON/);

  const notObject = await project({ 'latex2web.config.js': 'export default 42;' });
  await assert.rejects(loadConfig({ cwd: notObject }), /must export a config object/);

  await assert.rejects(loadConfig({ cwd: await tmp(), configPath: 'missing.js' }), /config file not found/);
});

test('unknown config keys are reported so typos surface', () => {
  assert.deepEqual(checkConfigKeys({ theme: 'paper', palett: 'mocha', __configFile: 'x' }), ['palett']);
});

test('defaults are complete enough to build with no config at all', () => {
  for (const key of ['out', 'theme', 'engine', 'singleFile', 'css', 'template', 'tokens', 'transforms', 'hooks']) {
    assert.ok(key in DEFAULTS, `${key} must have a default`);
  }
});

// --------------------------------------------------------------------- build

test('a config file drives a real build', async () => {
  const root = await project({
    'latex2web.config.js': `export default {
      theme: 'notes',
      palette: 'catppuccin-mocha',
      tokens: { sans: '"Inter", sans-serif' },
      assets: { dir: 'media' },
      toc: { label: 'On this page' },
      head: () => '<meta name="x" content="from-hook">',
    };`,
  });
  const config = await loadConfig({ cwd: root });
  const result = await build(path.join(root, 'doc.tex'), { ...config, out: path.join(root, 'dist') });

  assert.equal(result.layout, 'notes');
  assert.equal(result.palette, 'catppuccin-mocha');

  const page = await readFile(path.join(root, 'dist', 'doc.html'), 'utf8');
  const css = await readStylesheet(path.join(root, 'dist'), 'notes');
  assert.match(page, /class="theme-notes palette-catppuccin-mocha"/);
  assert.match(css, /--bg: #1e1e2e/, 'the palette reached the stylesheet');
  assert.match(css, /"Inter", sans-serif/, 'the user token beat the palette');
  assert.match(page, /On this page/);
  assert.match(page, /content="from-hook"/);
  assert.doesNotMatch(page, /\{\{\w+\}\}/);
});

test('a custom template replaces the shell entirely', async () => {
  const root = await project({
    'shell.html': '<!doctype html><html><head><title>{{title}}</title></head><body>{{content}}</body></html>',
    'latex2web.config.js': "export default { template: './shell.html' };",
  });
  await build(path.join(root, 'doc.tex'), { ...(await loadConfig({ cwd: root })), out: path.join(root, 'dist') });
  const page = await htmlIn(root);
  assert.match(page, /^<!doctype html><html><head><title>doc<\/title>/);
  assert.match(page, /<article class="doc">/);
});

test('a template function receives the resolved values', async () => {
  const root = await project({
    'latex2web.config.js': `export default {
      title: 'Custom',
      template: (v) => '<!doctype html><title>' + v.title + '</title><body>' + v.content + '<b>' + v.theme + '</b></body>',
    };`,
  });
  await build(path.join(root, 'doc.tex'), { ...(await loadConfig({ cwd: root })), out: path.join(root, 'dist') });
  const page = await htmlIn(root);
  assert.match(page, /<title>Custom<\/title>/);
  assert.match(page, /<b>paper<\/b>/);
});

test('extra css is appended so it can override the layout', async () => {
  const root = await project({ 'extra.css': '.doc { letter-spacing: 0.02em; }' });
  const config = await loadConfig({ cwd: root, cli: { css: './extra.css', explicit: ['css'] } });
  await build(path.join(root, 'doc.tex'), { ...config, out: path.join(root, 'dist') });
  const css = await readStylesheet(path.join(root, 'dist'), 'paper');
  assert.match(css, /\.doc \{ letter-spacing: 0\.02em; \}/);
  assert.ok(css.indexOf('letter-spacing') > css.indexOf('--bg'), 'user css must come after the tokens');
});

test('inline css and a {path} entry both work', async () => {
  const root = await project({ 'x.css': '.a{color:red}' });
  const config = await loadConfig({ cwd: root });
  config.out = path.join(root, 'dist');
  config.css = [{ inline: '.b{color:blue}' }, { path: path.join(root, 'x.css') }];
  await build(path.join(root, 'doc.tex'), config);
  const css = await readStylesheet(path.join(root, 'dist'), 'paper');
  assert.match(css, /\.b\{color:blue\}/);
  assert.match(css, /\.a\{color:red\}/);
});

test('toc can be switched off', async () => {
  const root = await project({ 'latex2web.config.js': 'export default { toc: { enabled: false } };' });
  await build(path.join(root, 'doc.tex'), { ...(await loadConfig({ cwd: root })), out: path.join(root, 'dist') });
  assert.doesNotMatch(await htmlIn(root), /<nav class="toc"/);
});

test('assets.dir changes where images land and how they are linked', async () => {
  const root = await project({
    'fig.png': 'x',
    'latex2web.config.js': "export default { assets: { dir: 'media' } };",
  });
  const config = await loadConfig({ cwd: root });
  const doc = path.join(root, 'doc.tex');
  await writeFile(doc, '\\begin{document}\n\\begin{figure}\\includegraphics{fig.png}\\end{figure}\n\\end{document}');
  await build(doc, { ...config, out: path.join(root, 'dist') });
  assert.match(await readFile(path.join(root, 'dist', 'doc.html'), 'utf8'), /src="media\/fig\.png"/);
  await readFile(path.join(root, 'dist', 'media', 'fig.png'));
});

test('hooks fire around the build', async () => {
  const root = await project();
  const seen = [];
  const config = await loadConfig({ cwd: root });
  config.hooks = {
    afterParse: ({ page }) => seen.push(`parse:${path.basename(page.file)}`),
    afterRender: ({ page }) => seen.push(`render:${path.basename(page.file)}`),
    afterBuild: ({ pages }) => seen.push(`build:${pages.length}`),
  };
  await build(path.join(root, 'doc.tex'), config);
  assert.deepEqual(seen, ['parse:doc.tex', 'render:doc.tex', 'build:1']);
});

test('a transform can rewrite the rendered markup', async () => {
  const root = await project();
  const config = await loadConfig({ cwd: root });
  config.out = path.join(root, 'dist');
  config.transforms = [{
    match: (page) => page.outName === 'doc',
    render: (html) => html.replace(/<h2 /g, '<h2 data-t="1" '),
  }];
  await build(path.join(root, 'doc.tex'), config);
  assert.match(await htmlIn(root), /<h2 data-t="1" id="section-one"/);
});

test('a transform that declines leaves the markup alone', async () => {
  const root = await project();
  const config = await loadConfig({ cwd: root });
  config.out = path.join(root, 'dist');
  config.transforms = [{ match: () => false, render: () => 'nonsense' }];
  await build(path.join(root, 'doc.tex'), config);
  assert.doesNotMatch(await htmlIn(root), /nonsense/);
});

test('tokens can be given as a JSON string, as the flag delivers them', async () => {
  const root = await project();
  await build(path.join(root, 'doc.tex'), { out: path.join(root, 'dist'), tokens: '{"accent":"#e11"}' });
  assert.match(await readStylesheet(path.join(root, 'dist'), 'paper'), /--accent: #e11;/);
  await assert.rejects(build(path.join(root, 'doc.tex'), { out: path.join(root, 'dist'), tokens: 'nope' }), /--tokens must be JSON/);
});

test('an unknown token name is warned about, not fatal', async () => {
  const root = await project();
  const result = await build(path.join(root, 'doc.tex'), { out: path.join(root, 'dist'), tokens: { accentt: '#fff' } });
  assert.ok(result.warnings.some((w) => w.includes('accentt')));
  await htmlIn(root); // still built
});

test('a theme may be a path to a css file', async () => {
  const root = await project({ 'mine.css': '.doc { color: rebeccapurple; }' });
  await build(path.join(root, 'doc.tex'), { out: path.join(root, 'dist'), theme: path.join(root, 'mine.css') });
  assert.match(await readStylesheet(path.join(root, 'dist'), 'mine'), /rebeccapurple/);
});

test('BASE_LAYOUT carries the structural keys a layout expects', () => {
  for (const key of ['measure', 'rail', 'gutter', 'radius', 'step-0', 'sp-4']) {
    assert.ok(key in BASE_LAYOUT, `${key} must be a structural default`);
  }
});

// ------------------------------------------------------------ colour schemes

test('a default build emits colour tokens', async () => {
  // With no palette configured the layout's own palette applies, so the
  // default build still emits its full colour tokens.
  const root = await project();
  await build(path.join(root, 'doc.tex'), { out: path.join(root, 'dist') });
  const css = await readStylesheet(path.join(root, 'dist'), 'paper');
  assert.match(css, /--bg:\s*#[0-9a-f]{6}/i, 'no background token was emitted');
  assert.match(css, /--ink:\s*#[0-9a-f]{6}/i);
  assert.match(css, /--accent:\s*#[0-9a-f]{6}/i);
});

test('every custom property a layout uses is defined in the output', async () => {
  const root = await project();
  for (const theme of ['paper', 'slides', 'notes']) {
    await build(path.join(root, 'doc.tex'), { out: path.join(root, 'dist'), theme });
    const css = await readStylesheet(path.join(root, 'dist'), 'paper');
    const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((m) => m[1]));
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1].slice(2)));
    const missing = [...used].filter((v) => !defined.has(v));
    assert.deepEqual(missing, [], `${theme} uses undefined custom properties`);
  }
});

/* ---- the masthead
   The bar lives once in chrome.js and is appended to every layout. These two
   tests pin both halves: no theme file carries its own copy, and every layout
   computes the same bar. Both read the layout's own CSS with the shared block
   removed, since `layout.css` contains that block. */

const isRuleLine = (line) => /^[^{}@/*]+\{.*$/.test(line);

/** Everything in a layout that is not the shared masthead. */
function ownCss(layout) {
  assert.ok(layout.css.includes(MASTHEAD_CSS), 'the shared masthead was not appended');
  return layout.css.split(MASTHEAD_CSS)[0];
}

test('no theme file carries its own copy of the masthead', async () => {
  const layouts = await loadLayouts();

  // Rules for the bar, matched on the class names the shared block owns. The hero
  // shares two of those names but is not the bar, so it is excluded from the
  // match.
  const own = /\.(?:masthead(?:-inner)?|doc-nav|doc-link|icon-link|drop(?:-toggle|-menu|-link)?|theme-toggle)\b|^a\.wordmark\b|^\.wordmark-svg\b/;
  const notTheBar = /\.hero\b|\.doc-title-mark\b|\.doc-header\b|\.doc-title\b/;
  // Print rules that hide the bar are statements about paper, not the bar:
  // `@media print { .masthead { display: none } }` must survive stripping.
  const withoutPrint = (css) => css.replace(/@media print[^{]*\{[\s\S]*?\n\}/g, '');

  for (const [name, layout] of Object.entries(layouts)) {
    const offenders = withoutPrint(ownCss(layout))
      .split('\n')
      .filter((line) => isRuleLine(line) && own.test(line) && !notTheBar.test(line));
    assert.deepEqual(offenders, [], `${name} declares its own masthead; the bar is shared (chrome.js)`);
  }

  // And the print rule that hides the bar survives in every layout that prints.
  for (const [name, layout] of Object.entries(layouts)) {
    assert.ok(/@media print[\s\S]*?\.masthead[^}]*display:\s*none/.test(layout.css),
      `${name} no longer hides the bar when printing`);
  }
});

test('every layout is given the same masthead, and the same metrics', async () => {
  const layouts = await loadLayouts();
  const names = Object.keys(layouts);
  assert.ok(names.length > 1, 'expected more than one layout');

  for (const name of names) {
    for (const rule of ['.masthead {', '.masthead-inner {', 'a.wordmark {', '.drop-menu {']) {
      assert.ok(layouts[name].css.includes(rule), `${name} is missing ${rule}`);
    }
  }

  // The bar's effective numbers, read from the cascade: the last declaration in
  // the file wins at equal specificity, so that is the one read. Reading the
  // shared block instead would pass over a layout-local override the shared
  // `:root` happens to mask.
  const effective = (css, prop) => {
    let want = null;
    for (const m of css.matchAll(new RegExp(`--${prop}:\\s*([^;]+);`, 'g'))) want = m[1].trim();
    return want;
  };
  for (const prop of ['masthead-h', 'bar-gap', 'wordmark-h', 'bar-type', 'bar-bg']) {
    assert.ok(effective(MASTHEAD_CSS, prop), `the shared bar does not set --${prop}`);
  }

  // One value for every layout, including width and padding: the bar is chrome,
  // not a document, so it takes neither the document's measure nor per-layout
  // values of its own.
  for (const [name, layout] of Object.entries(layouts)) {
    for (const prop of ['masthead-h', 'bar-gap', 'wordmark-h', 'bar-type', 'bar-bg', 'bar-max']) {
      assert.equal(effective(layout.css, prop), effective(MASTHEAD_CSS, prop),
        `${name} computes a different --${prop}; the bar is shared, so this cannot differ`);
    }
  }

  // Every entry in the bar shares one size. The dropdown trigger must use
  // --bar-type like every other entry, not a size of its own.
  const trigger = /\.drop-toggle\s*\{[^}]*\}/.exec(MASTHEAD_CSS);
  assert.ok(trigger, 'the shared bar has no dropdown trigger');
  assert.match(trigger[0], /font-size:\s*var\(--bar-type\)/,
    'the dropdown trigger sets its own font size; it must use --bar-type like every other entry');
  for (const sel of ['.doc-nav', '.doc-link', '.icon-link', '.drop-link']) {
    const rule = new RegExp(`\\${sel}\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\}`).exec(MASTHEAD_CSS);
    if (!rule) continue;
    const size = /font-size:\s*([^;]+);/.exec(rule[0]);
    assert.ok(!size || size[1].includes('--bar-type'),
      `${sel} sets its own font size (${size && size[1]}); every entry in the bar shares --bar-type`);
  }
});

/** The `--bg` inside the last rule whose selector matches. */
function bgIn(css, selector) {
  const i = css.lastIndexOf(`${selector} {`);
  if (i < 0) return null;
  const end = css.indexOf('}', i);
  return (/--bg:\s*([^;]+);/.exec(css.slice(i, end)) || [])[1] ?? null;
}

test('dark mode is declared for all three schemes', async () => {
  const layouts = await loadLayouts();

  const dark = await resolveAppearance({ theme: 'slides', palette: 'catppuccin-mocha' }, layouts);
  const mochaBg = resolvePalette('catppuccin-mocha').tokens.bg;
  assert.equal(bgIn(dark.css, 'html[data-theme="dark"]'), mochaBg, 'explicit dark toggle');
  assert.equal(bgIn(dark.css, 'html[data-theme="auto"]'), mochaBg, 'auto under a dark OS');
  assert.match(dark.css, /color-scheme:\s*dark/, 'the browser needs to be told');

  const adaptive = await resolveAppearance(
    { theme: 'paper', palette: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' } }, layouts,
  );
  assert.equal(adaptive.tokens.bg, resolvePalette('catppuccin-latte').tokens.bg);
  assert.equal(bgIn(adaptive.css, 'html[data-theme="dark"]'), mochaBg);
  assert.match(adaptive.css, /@media \(prefers-color-scheme: dark\)/);
});

test('a pinned light palette stays light even in dark mode', async () => {
  const layouts = await loadLayouts();
  const paper = await resolveAppearance({ theme: 'paper' }, layouts);
  // Reads the layout default rather than repeating it, so this follows the
  // default when it changes. Whatever it is, it is light in both schemes.
  const dflt = layouts.paper.palette;
  const light = resolvePalette(dflt).tokens.bg;
  assert.equal(resolvePalette(dflt).dark, false, `${dflt} should be a light palette`);
  assert.equal(paper.tokens.bg, light);
  assert.equal(bgIn(paper.css, 'html[data-theme="dark"]'), light);
  assert.equal(bgIn(paper.css, 'html[data-theme="auto"]'), light);
});

test('a dark palette is not silently reduced to structural tokens', async () => {
  // A pinned dark palette keeps its full token map in darkTokens, never a
  // bare flag in its place.
  const layouts = await loadLayouts();
  const r = await resolveAppearance({ theme: 'paper', palette: 'catppuccin-mocha' }, layouts);
  assert.equal(Object.keys(r.tokens).length, Object.keys(r.darkTokens).length);
  assert.equal(r.darkTokens.bg, resolvePalette('catppuccin-mocha').tokens.bg);
  assert.ok(Object.keys(r.tokens).length >= 40, 'a palette must contribute its full token set');
});

test('the palette name is reported for the CLI to show', async () => {
  const layouts = await loadLayouts();
  assert.match((await resolveAppearance({ theme: 'paper', palette: 'mocha' }, layouts)).palette, /Mocha/);
  const pair = await resolveAppearance(
    { theme: 'paper', palette: { light: 'latte', dark: 'mocha' } }, layouts,
  );
  assert.match(pair.palette, /Latte.*Mocha/);
});

test('derived token defaults are emitted for layouts that use them', async () => {
  const layouts = await loadLayouts();
  const { css, tokens } = await resolveAppearance({ theme: 'slides', palette: 'catppuccin-mocha' }, layouts);
  for (const key of ['tok-operator', 'tok-punct', 'tok-variable']) {
    assert.ok(tokens[key], `${key} should be derived from the palette`);
    assert.match(css, new RegExp(`--${key}:`));
  }
});
