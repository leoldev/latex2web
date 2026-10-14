/**
 * The long-equation fitter.
 *
 * A display equation wider than the column is shrunk first, then allowed to
 * bleed into the margin, and only then scrolled: a scrollbar hides most of
 * the equation behind an undiscoverable gesture, so it is the last resort.
 *
 * Shrinking follows a descending ladder of fixed steps (converges within 4%,
 * which reads identically) down to a 0.78 floor, below which subscripts stop
 * being legible and a legible scrolled equation wins. Equations still over at
 * the floor may reach 0.66 and gain the margin besides.
 *
 * One pass, on load and on resize. No animation, no scroll handler, nothing
 * per frame.
 */
export function fitEquationsScript() {
  return `
<script>
(() => {
  // The ladder, and why it has a floor and a second, lower one.
  //
  // The first floor is 0.78: below that the subscripts stop being legible and a
  // legible equation the reader scrolls beats an illegible one they can see.
  // The second is 0.66, and it applies only to the equations that are still over
  // at the first -- the ones with no choice. An entropy formula that runs to
  // eleven integrals is either small or unreachable, and small is the answer
  // that lets the reader see that there is a second line of it at all.
  const STEPS = [1, 0.96, 0.92, 0.88, 0.85, 0.82, 0.8, 0.78, 0.75, 0.72, 0.69, 0.66];

  // The box that scrolls is the one that is measured: '.math-block' and
  // '.equation' carry the overflow, and the KaTeX display inside them is only
  // as wide as its container is wide -- so measuring the display measured the
  // scroll container against itself and found everything fitting.
  const fits = (box) => box.scrollWidth <= box.clientWidth + 1;

  const fitOne = (box) => {
    box.style.setProperty('--eq-fit', '');
    box.classList.remove('eq-over');
    if (fits(box)) return;
    for (const step of STEPS.slice(1)) {
      box.style.setProperty('--eq-fit', String(step));
      if (fits(box)) break;
    }
    // Still over at the floor: it gets the margin to reach into, and whatever is
    // left of it scrolls. The margin is capped at the gap between the column and
    // the rail, for the same reason the figures are: past the rail is the
    // contents, and nothing may reach over the contents.
    box.classList.toggle('eq-over', !fits(box));
  };

  const all = () => document.querySelectorAll('.math-block, .equation');
  const pass = () => all().forEach(fitOne);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(pass));
  } else {
    requestAnimationFrame(pass);
  }

  // KaTeX lays out after its own fonts land, and a webfont swapping in changes
  // the width of every equation on the page.
  if (document.fonts?.ready) document.fonts.ready.then(() => requestAnimationFrame(pass));

  let queued = false;
  addEventListener('resize', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; pass(); });
  });
})();
</script>
`;
}
