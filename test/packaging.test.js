// The package ships a subset of the layouts. The registry is keyed on which
// stylesheets are on disk rather than on a fixed list, so an unshipped layout
// is absent rather than an error. Two things are pinned here: every stylesheet
// in `themes/` is selectable (an unreachable file is dead CSS nothing loads),
// and the published tarball works (a registry entry pointing at a file that is
// not shipped is caught here rather than by the first person to `npm i`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadLayouts, layoutNames, layoutSummary } from '../src/themes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** The theme paths package.json ships, as bare file names. */
const shipped = pkg.files.filter((f) => f.startsWith('themes/')).map((f) => path.basename(f));
const shippedNames = shipped.map((f) => f.replace(/\.css$/, ''));

/** Every stylesheet in the repository. */
const onDisk = fs.readdirSync(path.join(root, 'themes')).filter((f) => f.endsWith('.css'));

test('every stylesheet named in `files` exists', () => {
  assert.ok(shipped.length, 'package.json should name the layouts it ships');
  for (const file of shipped) {
    assert.ok(fs.existsSync(path.join(root, 'themes', file)), `package.json ships themes/${file}, which does not exist`);
  }
});

test('`files` does not ship the whole themes directory by accident', () => {
  // The point of the subset is that `themes` as a directory entry is gone. If
  // it comes back, the other checks still pass and the package quietly grows
  // every layout again.
  assert.ok(!pkg.files.includes('themes'), '`files` must not list the themes directory wholesale');
});

test('every stylesheet on disk is selectable', async () => {
  const layouts = await loadLayouts();
  const unreachable = onDisk.map((f) => f.replace(/\.css$/, '')).filter((n) => !layouts[n]);
  assert.deepEqual(unreachable, [], `themes/ holds ${unreachable.join(', ')}, which no layout name can reach`);
  assert.deepEqual([...layoutNames()].sort(), onDisk.map((f) => f.replace(/\.css$/, '')).sort());
  assert.equal(layoutSummary().length, onDisk.length);
});

test('an installed package exposes exactly what it shipped', async (t) => {
  // A copy laid out the way npm lays one out: the listed files, and nothing else.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2w-pkg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const entry of pkg.files) {
    const from = path.join(root, entry);
    const to = path.join(dir, entry);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }

  const themes = await import(pathToFileURL(path.join(dir, 'src/themes.js')).href);
  const layouts = await themes.loadLayouts();

  assert.deepEqual(Object.keys(layouts).sort(), [...shippedNames].sort());
  assert.deepEqual([...themes.layoutNames()].sort(), [...shippedNames].sort());
  assert.deepEqual(
    themes.layoutSummary().map((l) => l.split(' — ')[0]).sort(), [...shippedNames].sort(),
    'the --help layout list disagrees with what is installed',
  );
  for (const name of shippedNames) {
    assert.ok(layouts[name].css.length > 500, `${name} loaded an implausibly small stylesheet`);
  }
  // The masthead is appended by the loader, so a layout that loads at all has it.
  assert.match(layouts[shippedNames[0]].css, /\.masthead/, 'the shared masthead was not appended');
});