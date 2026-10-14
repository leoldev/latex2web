/**
 * WCAG 2.1 contrast maths and the palette repair built on it.
 *
 * Why this module exists: the Catppuccin flavours upstream were never designed
 * for this token contract, and two of their mappings are backwards. Mantle is
 * *darker* than base, so `bg-raised = mantle` paints every card as a hole in
 * the page; and `ink-faint = subtext1` is *brighter* than `ink-soft =
 * subtext0`, so the faintest text shouts while secondary text recedes. Every
 * level derived here is measured against the page ground with real
 * relative-luminance maths.
 */

/** An sRGB colour with channels in 0..255. */
const toChannel = (v) => Math.min(255, Math.max(0, Math.round(v)));

/**
 * Parse a CSS colour into `{r, g, b}` channels, or `null` when it cannot.
 *
 * Handles `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` (alpha is dropped: these
 * tokens are all opaque grounds and inks) and `rgb()/rgba()` with numbers or
 * percentages, comma- or space-separated, with an optional `/ alpha`.
 *
 * Returns `null` -- never throws -- for anything else: `color-mix()` recipes
 * (which only the browser can resolve), bare keywords like the `black` in
 * shadow tokens, and named colours. A parser that threw on those would make
 * the derivation itself the crash.
 */
export function parseColor(value) {
  try {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') {
      const { r, g, b } = value;
      if ([r, g, b].every((c) => typeof c === 'number' && Number.isFinite(c))) {
        return { r: toChannel(r), g: toChannel(g), b: toChannel(b) };
      }
      return null;
    }
    if (typeof value !== 'string') return null;
    const s = value.trim().toLowerCase();
    if (!s) return null;
    // A runtime recipe, not a colour: the browser resolves it, we cannot.
    if (s.startsWith('color-mix(')) return null;

    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (hex) {
      const h = hex[1];
      if (h.length === 3 || h.length === 4) {
        // #rgb / #rgba: the alpha nibble, when present, is dropped (see above).
        const [r, g, b] = [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
        return { r, g, b };
      }
      // #rrggbb / #rrggbbaa: trailing alpha byte dropped, same reason.
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      return { r, g, b };
    }

    const fn = /^rgba?\(\s*(.+?)\s*\)$/.exec(s);
    if (fn) {
      // Split `r, g, b / a`, `r g b / a` and plain `r, g, b` uniformly: commas
      // become spaces, then an optional `/ alpha` tail is cut off.
      const noCommas = fn[1].replaceAll(',', ' ');
      const [front] = noCommas.split('/');
      const parts = front.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 3 || parts.length > 4) return null;
      const channels = [];
      for (let i = 0; i < 3; i++) {
        const p = parts[i];
        if (p.endsWith('%')) {
          const n = Number(p.slice(0, -1));
          if (!Number.isFinite(n)) return null;
          channels.push(toChannel((n / 100) * 255));
        } else {
          const n = Number(p);
          if (!Number.isFinite(n)) return null;
          channels.push(toChannel(n));
        }
      }
      return { r: channels[0], g: channels[1], b: channels[2] };
    }

    // Named colours, keywords (`transparent`, `black` in shadows), dimensions,
    // shadows, font stacks -- none of these is a measurable colour.
    return null;
  } catch {
    return null;
  }
}

/** Format channels as a lowercase `#rrggbb` hex string. */
export function toHex({ r, g, b }) {
  const h = (c) => toChannel(c).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Relative luminance per WCAG 2.1.
 *
 * Each channel is linearised (`0.03928` threshold, `2.4` gamma) and weighted
 * `0.2126R + 0.7152G + 0.0722B`. Without linearisation a saturated blue ranks
 * brighter than it reads and weak accents pass that should fail.
 */
export function relativeLuminance(rgb) {
  const c = parseColor(rgb);
  if (!c) return null;
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG 2.1 contrast ratio of two colours, each a hex string or `{r,g,b}`.
 *
 * Returns `null` when either side is unparseable (a `color-mix()` accent, a
 * keyword shadow) instead of throwing, so callers can decide to leave that
 * token alone rather than crash the build over a token they never measured.
 */
export function contrastRatio(a, b) {
  const la = typeof a === 'number' ? a : relativeLuminance(a);
  const lb = typeof b === 'number' ? b : relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Mix two colours in sRGB: `t = 0` is pure `a`, `t = 1` is pure `b`.
 *
 * sRGB rather than a perceptual space on purpose: `color-mix(in srgb, ...)`
 * evaluates in sRGB, so precomputing the mix here is bit-identical rendering
 * with the value visible to the contrast maths. Returns `null` when either
 * side is unparseable.
 */
export function mix(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb || !Number.isFinite(t)) return null;
  const k = Math.min(1, Math.max(0, t));
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

/**
 * Which way should text walk? A dark ground wants light text and vice versa.
 *
 * Decided by measurement -- whichever of black or white contrasts more with
 * the ground names the polarity -- not by a luminance threshold, which would
 * put a cliff at mid-grey.
 */
export function isDark(bg) {
  const lum = relativeLuminance(bg);
  if (lum === null) return false;
  return contrastRatio('#ffffff', bg) > contrastRatio('#000000', bg);
}

/**
 * Walk `fg` away from `bg` in one direction until it reaches `target` contrast.
 *
 * Only as far as needed, by binary search, so a colour that already passes
 * comes back unchanged and each flavour keeps its character. `prefer` picks
 * the direction (`'lighter'` walks toward white, `'darker'` toward black);
 * omitted, it picks whichever direction gains contrast from where `fg` is.
 *
 * Honest about failure: when even the endpoint cannot reach the target, it
 * returns the endpoint with `met: false` rather than looping forever or
 * claiming success. The search is a fixed 24 bisection steps, so it always
 * terminates.
 *
 * @returns {{color: string|null, ratio: number|null, met: boolean}}
 */
export function mixToContrast(fg, bg, target, { prefer } = {}) {
  const bgC = parseColor(bg);
  const fgC = parseColor(fg);
  if (!bgC || !fgC) return { color: null, ratio: null, met: false };
  if (!Number.isFinite(target) || target <= 1) {
    const hex = toHex(fgC);
    return { color: hex, ratio: contrastRatio(fgC, bgC), met: true };
  }

  const WHITE = { r: 255, g: 255, b: 255 };
  const BLACK = { r: 0, g: 0, b: 0 };
  let endpoint = null;
  if (prefer === 'lighter') endpoint = WHITE;
  else if (prefer === 'darker') endpoint = BLACK;
  else {
    // Auto: probe a short step each way from where fg stands and follow the
    // one that gains contrast. Probing from fg (not from bg) keeps a colour
    // that is already on the right side from flipping sides.
    const up = contrastRatio(mix(fgC, WHITE, 0.2), bgC);
    const down = contrastRatio(mix(fgC, BLACK, 0.2), bgC);
    endpoint = up >= down ? WHITE : BLACK;
  }

  const at = (t) => mix(fgC, endpoint, t);
  const current = contrastRatio(fgC, bgC);
  if (current !== null && current >= target)
    return { color: toHex(fgC), ratio: current, met: true };

  const full = contrastRatio(endpoint, bgC);
  if (full === null || full < target) {
    // Unreachable even at the endpoint: hand back the best there is (pure
    // white/black in the chosen direction) rather than the failure.
    return { color: toHex(endpoint), ratio: full, met: false };
  }

  // The ratio rises monotonically along the walk, so bisection finds the
  // smallest `t` that passes: the least change that fixes the contrast.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(at(mid), bgC) >= target) hi = mid;
    else lo = mid;
  }
  const color = at(hi);
  return { color, ratio: contrastRatio(color, bgC), met: true };
}

/**
 * Largest per-channel distance between two colours, on the 0..255 scale.
 *
 * Used for the `accent-soft` vs `line` check: two washes can share a luminance
 * yet read as one smear, so "distinct" is measured in channels, not contrast.
 * Returns `null` when either side is unparseable.
 */
export function maxChannelDelta(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  return Math.max(Math.abs(ca.r - cb.r), Math.abs(ca.g - cb.g), Math.abs(ca.b - cb.b));
}

// The contrast floors every derived ramp guarantees. `ink` at 12:1 clears
// the 7:1 WCAG AAA body-text bar with headroom for titles on a dim projector;
// `ink-soft` at 7:1 keeps secondary prose at AAA; `ink-faint` at 4.5:1 is the
// AA floor for the captions and bylines set in it.
const FLOOR_INK = 12;
const FLOOR_SOFT = 7;
const FLOOR_FAINT = 4.5;
// The rule ramps. A hairline is decoration, not text, so the 3:1 non-text
// floor does not apply; what rules need is to be *visible*. 1.4 and 1.15 are
// the levels the palettes already met, written down so one that does not is
// repaired rather than shipped.
const FLOOR_RULE = 1.4;
const FLOOR_RULE_SOFT = 1.15;
// Two levels whose ratios differ by less than this read as the same weight;
// the ordering gaps below keep "faint" below "soft".
const ORDER_GAP = 0.5;

/**
 * Repair a token map's text and surface ramps against its own background.
 *
 * Pure: returns a new object, never mutates, never invents hues. Surfaces come
 * from the page ground mixed toward the palette's own ink (same hue family) or
 * achromatic endpoints; text comes from the flavour's own text colours walked
 * only as far as the floors require. `bg` itself is never touched: the page
 * ground is the palette author's choice, and `config.test.js` pins Mocha's.
 *
 * Safe to run twice (and it is: once in `palettes.js`, once per build for
 * user overrides). Every step is a no-op when its target already holds, and
 * surfaces are a pure function of `(bg, ink)` -- never of the previous
 * raised/tint -- so a second pass recomputes the same values instead of
 * drifting.
 *
 * Tokens it cannot measure (a `color-mix()` accent from a user override, a
 * keyword shadow) are left exactly as found: an unmeasured token kept is
 * better than a build crashed.
 *
 * @param {object} tokens token map, in `PALETTE_KEYS` vocabulary.
 * @param {object} [opts]
 * @param {boolean} [opts.dark] force the polarity; otherwise measured from `bg`.
 * @returns {object} new token map with repaired ramps.
 */
export function deriveContrastTokens(tokens, { dark } = {}) {
  const out = { ...tokens };
  const bg = parseColor(tokens.bg);
  if (!bg) return out;
  const bgHex = toHex(bg);
  const isDarkMode = dark ?? isDark(bgHex);
  // Text polarity: a dark ground is read with light text, a light ground with
  // dark text. One direction for the whole ramp, so levels never cross.
  const dir = isDarkMode ? 'lighter' : 'darker';

  // --- surfaces -----------------------------------------------------------

  // Amounts are deliberately small: elevation is a step, not a restyle. A
  // large dark step turns every card into a grey slab and collapses the text
  // contrast on top of it (faint must clear 4.5:1 on the raised surface too).
  // The `while` below still guarantees a measurable step.
  let raised = mix(bgHex, '#ffffff', isDarkMode ? 0.12 : 0.55);
  let raisedT = isDarkMode ? 0.12 : 0.55;
  while (raised && contrastRatio(raised, bgHex) < 1.12 && raisedT < 0.95) {
    // A near-white ground (or rounding) can collapse the step to nothing;
    // widen it until the card is measurably off the page.
    raisedT = Math.min(0.95, raisedT + 0.1);
    raised = mix(bgHex, '#ffffff', raisedT);
  }
  let sunken = mix(bgHex, '#000000', isDarkMode ? 0.32 : 0.06);
  let tint = raised ? mix(bgHex, raised, 0.5) : null;
  // The tint is the midpoint by construction, so it sits between page and card
  // unless rounding collapsed it onto one of them; nudge the blend until the
  // three hexes are three colours.
  if (tint && (tint === bgHex || tint === raised)) {
    for (const k of [0.4, 0.6, 0.3, 0.7]) {
      const alt = mix(bgHex, raised, k);
      if (alt && alt !== bgHex && alt !== raised) {
        tint = alt;
        break;
      }
    }
  }
  if (raised && raised !== bgHex) out['bg-raised'] = raised;
  if (sunken && sunken !== bgHex) out['bg-sunken'] = sunken;
  if (tint && tint !== bgHex && tint !== raised) out['bg-tint'] = tint;

  const surfaces = [bgHex, out['bg-raised'], out['bg-sunken'], out['bg-tint']];

  // --- rules ---------------------------------------------------------------
  // Rules were not re-derived with the surfaces, so the two are reconciled
  // here: each rule clears its floor on every surface, and each stays a
  // *different colour* from the card it borders (`bg-raised` sits only ~1.12
  // off the ground, so a rule merely clearing 1.4 against the ground can read
  // stronger against the page behind the box than against the box itself).
  //
  // The two rules constrain each other, so the block runs to a fixed point
  // rather than once: that is what makes the function idempotent across
  // repeated derivations.
  const RULES = [['line', FLOOR_RULE, null], ['line-soft', FLOOR_RULE_SOFT, 'line']];
  for (let settle = 0; settle < 4; settle++) {
    let changed = false;
    for (const [key, floor, target] of RULES) {
      const start = parseColor(out[key]) ? toHex(parseColor(out[key])) : null;
      if (!start) continue;
      let cur = start;
      for (const s of [bgHex, ...surfaces.filter((x) => x && x !== bgHex)]) {
        const r = mixToContrast(cur, s, floor, { prefer: dir });
        if (r.color && r.met) cur = r.color;
      }
      // Ordering: soft is the quieter rule and must not draw heavier than
      // `line`. The guard runs after the floors and never undoes them: a
      // candidate is accepted only when it still clears the floor on every
      // surface, otherwise the floor-satisfying colour stands.
      const parent = target ? out[target] : null;
      if (parent && parseColor(parent)) {
        const cSelf = contrastRatio(cur, bgHex);
        const cParent = contrastRatio(parent, bgHex);
        if (cSelf !== null && cParent !== null && cSelf > cParent + ORDER_GAP) {
          const r = mixToContrast(cur, bgHex, cParent - ORDER_GAP, { prefer: dir });
          const clearsEverywhere = r.color && surfaces.filter(Boolean).every(
            (s) => {
              const v = contrastRatio(r.color, s);
              return v !== null && v >= floor;
            });
          if (clearsEverywhere) cur = r.color;
        }
      }
      if (cur !== out[key]) changed = true;
      out[key] = cur;
    }
    if (!changed) break;
  }

  // --- text ---------------------------------------------------------------
  // Each level starts from the flavour's own text colour and walks only to its
  // floor, so a flavour that already passes keeps its exact colours.
  const need = (value, floor, extra = []) => {
    let cur = parseColor(value) ? toHex(parseColor(value)) : null;
    if (!cur) return value;
    const r0 = mixToContrast(cur, bgHex, floor, { prefer: dir });
    if (r0.color) cur = r0.color;
    for (const s of extra) {
      const r = mixToContrast(cur, s, FLOOR_FAINT, { prefer: dir });
      // Extra surfaces must not cost the bg floor or the ordering budget: ink
      // and soft are boosted here, faint is handled below where the cap has
      // the final say.
      if (r.color && r.met) cur = r.color;
    }
    return cur;
  };

  if (parseColor(out.ink)) {
    out.ink = need(
      out.ink, FLOOR_INK, [out['bg-raised'], out['bg-tint'], out['bg-sunken']]);
  }
  if (parseColor(out['ink-soft'])) {
    // Aimed half a point above its floor: faint must clear 4.5:1 on the
    // *raised* surface while staying a full gap under soft on bg, and a soft
    // at exactly 7.0 leaves no room for that.
    out['ink-soft'] = need(
      out['ink-soft'], FLOOR_SOFT + 0.5,
      [out['bg-raised'], out['bg-tint'], out['bg-sunken']]);
    // Strictly below ink with a gap rounding cannot collapse. Reducing toward
    // the page ground lowers contrast on every surface at once, and the loop
    // stops above the 7:1 floor because ink (>= 12) always leaves room.
    for (let i = 0; i < 20; i++) {
      const cSoft = contrastRatio(out['ink-soft'], bgHex);
      const cInk = contrastRatio(out.ink, bgHex);
      if (cSoft === null || cInk === null || cSoft < cInk - ORDER_GAP
        || cSoft <= FLOOR_SOFT + 0.05) break;
      out['ink-soft'] = mix(out['ink-soft'], bgHex, 0.1);
    }
  }
  if (parseColor(out['ink-faint'])) {
    out['ink-faint'] = need(out['ink-faint'], FLOOR_FAINT);
    // Below soft with the same gap, never below the 4.5 floor: soft (>= 7)
    // always leaves a window, so the cap never has to choose between order
    // and legibility. Best effort on the other surfaces afterwards, accepted
    // only when it preserves both.
    for (let i = 0; i < 20; i++) {
      const cFaint = contrastRatio(out['ink-faint'], bgHex);
      const cSoft = contrastRatio(out['ink-soft'], bgHex);
      if (cFaint === null || cSoft === null || cFaint < cSoft - ORDER_GAP
        || cFaint <= FLOOR_FAINT + 0.05) break;
      out['ink-faint'] = mix(out['ink-faint'], bgHex, 0.1);
    }
    for (const s of [out['bg-raised'], out['bg-tint'], out['bg-sunken']]) {
      if (!parseColor(s)) continue;
      if (contrastRatio(out['ink-faint'], s) >= FLOOR_FAINT) continue;
      const r = mixToContrast(out['ink-faint'], s, FLOOR_FAINT, { prefer: dir });
      if (!r.color || !r.met) continue;
      const keepsFloor = contrastRatio(r.color, bgHex) >= FLOOR_FAINT;
      const keepsOrder = contrastRatio(r.color, bgHex)
        < contrastRatio(out['ink-soft'], bgHex) - ORDER_GAP;
      if (keepsFloor && keepsOrder) out['ink-faint'] = r.color;
    }
  }

  // --- accent ---------------------------------------------------------------
  // The link colour, so it clears 4.5:1 everywhere prose sits. Unparseable
  // values (a user's `color-mix()`) are left alone: see the contract above.
  for (const key of ['accent', 'accent-ink']) {
    if (!parseColor(out[key])) continue;
    for (const s of [bgHex, out['bg-raised'], out['bg-tint']]) {
      const r = mixToContrast(out[key], s, FLOOR_FAINT, { prefer: dir });
      if (r.color && r.met) out[key] = r.color;
    }
  }
  // The wash behind the accent: rebuilt from the (now legible) accent on the
  // page ground at a low weight so it stays a wash, and kept at least 6
  // channels off the border colour so the two never coincide.
  if (parseColor(out.accent) && parseColor(out.line)) {
    let weight = 0.16;
    let wash = mix(bgHex, out.accent, weight);
    while (wash && maxChannelDelta(wash, out.line) < 6 && weight < 0.32) {
      weight = Math.min(0.32, weight + 0.04);
      wash = mix(bgHex, out.accent, weight);
    }
    if (wash && maxChannelDelta(wash, out.line) >= 6) out['accent-soft'] = wash;
  }

  return out;
}
