import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contrastRatio,
  deriveContrastTokens,
  isDark,
  maxChannelDelta,
  mix,
  mixToContrast,
  parseColor,
  relativeLuminance,
} from '../src/contrast.js';
import { PALETTES, PALETTE_NAMES } from '../src/palettes.js';

// ------------------------------------------------------------------- the maths

test('relative luminance anchors at black and white', () => {
  assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
  assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
});

test('contrast ratio matches the known WCAG values', () => {
  // Black on white is 21:1 by definition; the three anchors together pin the
  // linearisation.
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  const grey = contrastRatio('#767676', '#ffffff');
  assert.ok(Math.abs(grey - 4.54) < 0.03, `#767676 on white should be ~4.54, got ${grey}`);
});

test('contrast ratio is null-safe, so a color-mix token cannot crash it', () => {
  assert.equal(contrastRatio('color-mix(in srgb, #1e66f5 28%, #000000)', '#eff1f5'), null);
  assert.equal(contrastRatio('#000000', 'nonsense'), null);
});

test('parseColor reads the forms the token maps actually use', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseColor('#1e1e2e'), { r: 30, g: 30, b: 46 });
  assert.deepEqual(parseColor('#abcd'), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColor('rgb(100%, 0%, 0%)'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColor('rgba(27 26 23 / 0.05)'), { r: 27, g: 26, b: 23 });
});

test('parseColor returns null without throwing for anything unmeasurable', () => {
  // The old dark emphasis tokens are color-mix() recipes and the shadows use
  // bare keywords; both flow through here during derivation.
  assert.equal(parseColor('color-mix(in srgb, #1e66f5 28%, #000000)'), null);
  assert.equal(parseColor('black'), null);
  assert.equal(parseColor('not a colour'), null);
  assert.equal(parseColor(''), null);
  assert.equal(parseColor(null), null);
  assert.equal(parseColor(undefined), null);
});

test('mix blends in sRGB with t as the weight of b', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('nonsense', '#ffffff', 0.5), null);
});

test('mixToContrast leaves a passing colour alone', () => {
  const r = mixToContrast('#1b1a17', '#fbfaf7', 12, { prefer: 'darker' });
  assert.equal(r.met, true);
  assert.equal(r.color, '#1b1a17');
});

test('mixToContrast walks the smallest distance that reaches the target', () => {
  const r = mixToContrast('#6c6f85', '#eff1f5', 7, { prefer: 'darker' });
  assert.equal(r.met, true);
  assert.ok(r.ratio >= 7, `reached ${r.ratio}`);
  // Minimal means the result is still recognisably the input hue, not black.
  assert.notEqual(r.color, '#000000');
});

test('mixToContrast reports honest failure when the target is impossible', () => {
  // Mid-grey on mid-grey can never reach 21:1 in either direction.
  const start = Date.now();
  const r = mixToContrast('#808080', '#808080', 21, { prefer: 'lighter' });
  assert.ok(Date.now() - start < 5000, 'must terminate promptly');
  assert.equal(r.met, false);
  assert.ok(r.ratio < 21, `best effort was ${r.ratio}`);
  assert.match(r.color || '', /^#[0-9a-f]{6}$/, 'best effort is still a usable hex');
});

test('isDark measures polarity instead of thresholding a magic number', () => {
  assert.equal(isDark('#1e1e2e'), true);
  assert.equal(isDark('#eff1f5'), false);
  assert.equal(isDark('#fbfaf7'), false);
  assert.equal(isDark('#14151a'), true);
});

// ------------------------------------------- every palette, in registry order

/** The page grounds are the palette authors' choice and must never move. */
const PINNED_BG = {
  // Slate is the default palette every layout carries.
  'slate': '#f6f6f6',
  'slate-dark': '#1c1c1e',
  'warm-paper': '#fbfaf7',
  'warm-paper-dark': '#14151a',
  'catppuccin-latte': '#eff1f5',
  'catppuccin-frappe': '#303446',
  'catppuccin-macchiato': '#24273a',
  'catppuccin-mocha': '#1e1e2e',
};

test('every palette keeps its page ground', () => {
  for (const name of PALETTE_NAMES) {
    assert.equal(PALETTES[name].tokens.bg, PINNED_BG[name], `${name} moved its bg`);
  }
});

test('surfaces are monotonic in the right direction per mode', () => {
  for (const name of PALETTE_NAMES) {
    const t = PALETTES[name].tokens;
    const lum = (k) => relativeLuminance(t[k]);
    // Raised is LIGHTER than the page and sunken DARKER in both modes. An
    // inverted dark ramp paints every card as a hole in the page.
    assert.ok(lum('bg-sunken') < lum('bg'), `${name}: sunken must be darker than the page`);
    assert.ok(lum('bg') < lum('bg-raised'), `${name}: a card must be lighter than the page`);
    // The tint sits strictly between page and card and is three colours, not one.
    assert.ok(lum('bg-tint') > Math.min(lum('bg'), lum('bg-raised')), `${name}: tint below its interval`);
    assert.ok(lum('bg-tint') < Math.max(lum('bg'), lum('bg-raised')), `${name}: tint above its interval`);
    assert.notEqual(t['bg-tint'], t.bg, `${name}: tint collapsed onto bg`);
    assert.notEqual(t['bg-tint'], t['bg-raised'], `${name}: tint collapsed onto raised`);
  }
});

test('text levels meet their floors and are strictly ordered', () => {
  for (const name of PALETTE_NAMES) {
    const t = PALETTES[name].tokens;
    const on = (fg, surface) => contrastRatio(fg, t[surface]);
    const ink = on(t.ink, 'bg');
    const soft = on(t['ink-soft'], 'bg');
    const faint = on(t['ink-faint'], 'bg');
    assert.ok(ink >= 12, `${name}: ink ${ink.toFixed(2)} is below 12:1 on bg`);
    assert.ok(soft >= 7, `${name}: ink-soft ${soft.toFixed(2)} is below 7:1 on bg`);
    assert.ok(faint >= 4.5, `${name}: ink-faint ${faint.toFixed(2)} is below 4.5:1 on bg`);
    // Strictly monotonic with a gap rounding cannot collapse: faint must stay
    // clearly dimmer than soft, or faint shouts.
    assert.ok(ink > soft + 0.5, `${name}: ink must clearly beat ink-soft (${ink.toFixed(2)} vs ${soft.toFixed(2)})`);
    assert.ok(soft > faint + 0.5, `${name}: ink-soft must clearly beat ink-faint (${soft.toFixed(2)} vs ${faint.toFixed(2)})`);
    // Prose really sits on cards and washes too, so ink and soft hold the AA
    // floor on every surface, and faint -- captions, bylines -- holds it too.
    for (const surface of ['bg', 'bg-raised', 'bg-sunken', 'bg-tint']) {
      assert.ok(on(t.ink, surface) >= 4.5, `${name}: ink below 4.5:1 on ${surface}`);
      assert.ok(on(t['ink-soft'], surface) >= 4.5, `${name}: ink-soft below 4.5:1 on ${surface}`);
      assert.ok(on(t['ink-faint'], surface) >= 4.5, `${name}: ink-faint below 4.5:1 on ${surface}`);
    }
  }
});

test('the link colour holds everywhere prose sits', () => {
  for (const name of PALETTE_NAMES) {
    const t = PALETTES[name].tokens;
    for (const key of ['accent', 'accent-ink']) {
      for (const surface of ['bg', 'bg-raised', 'bg-tint']) {
        const r = contrastRatio(t[key], t[surface]);
        assert.ok(r !== null && r >= 4.5, `${name}: ${key} is ${r?.toFixed(2)} on ${surface}`);
      }
    }
  }
});

test('accent-soft is a wash, and never the border colour again', () => {
  for (const name of PALETTE_NAMES) {
    const t = PALETTES[name].tokens;
    // accent-soft must differ from line: a tinted surface and a border in one
    // colour are indistinguishable.
    assert.notEqual(t['accent-soft'], t.line, `${name}: accent-soft is still line`);
    const delta = maxChannelDelta(t['accent-soft'], t.line);
    assert.ok(delta !== null && delta >= 6, `${name}: accent-soft differs from line by ${delta} channels`);
    // ...while staying subtle enough to be a background wash, not a banner.
    const wash = contrastRatio(t['accent-soft'], t.bg);
    assert.ok(wash !== null && wash < 2, `${name}: accent-soft contrasts ${wash?.toFixed(2)} with bg; too loud for a wash`);
  }
});

test('rules are visible on the page and on every surface they cross', () => {
  // Rules are checked against every surface they cross, not just the page:
  // re-derived surfaces and hand-set rules can disagree about the distance
  // between two colours, down to a shade off invisible.
  for (const name of PALETTE_NAMES) {
    const t = PALETTES[name].tokens;
    const floors = [['line', 1.4], ['line-soft', 1.15]];
    for (const [key, floor] of floors) {
      for (const surface of ['bg', 'bg-raised', 'bg-sunken', 'bg-tint']) {
        const r = contrastRatio(t[key], t[surface]);
        assert.ok(r !== null && r >= floor,
          `${name}: ${key} is ${r?.toFixed(2)} on ${surface}, below ${floor}`);
      }
    }
    // A rule is a boundary: it has to read as different from the box it draws,
    // not merely as different from the page behind the box.
    for (const [key, surface] of [['line', 'bg-raised'], ['line-soft', 'bg-raised']]) {
      assert.ok(maxChannelDelta(t[key], t[surface]) >= 4,
        `${name}: ${key} is within 4 channels of ${surface}; its border would vanish into the card`);
    }
  }
});

test('the softer rule never draws harder than the rule it sits under', () => {
  for (const name of PALETTE_NAMES) {
    const t = PALETTES[name].tokens;
    const strong = contrastRatio(t.line, t.bg);
    const soft = contrastRatio(t['line-soft'], t.bg);
    assert.ok(soft < strong,
      `${name}: line-soft is ${soft?.toFixed(2)} against line's ${strong?.toFixed(2)}`);
  }
});

test('derivation is idempotent, so the build-time pass is a no-op', () => {
  // Derivation runs in palettes.js and again per build; a second run must
  // recompute the same ramp, not drift it.
  for (const name of PALETTE_NAMES) {
    const entry = PALETTES[name];
    assert.deepEqual(
      deriveContrastTokens(entry.tokens, { dark: entry.dark }),
      entry.tokens,
      `${name} drifted under a second derivation`,
    );
  }
});
