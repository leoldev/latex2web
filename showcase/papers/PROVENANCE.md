# Provenance of the showcase sources

Every document in this directory is the **original author source**, converted
unmodified. Nothing here is written for the showcase, and no figure is
redrawn: the point is to exercise λtex2web against what people actually write.

## `attention-2017/`

* Vaswani, Shazeer, Parmar, Uszkoreit, Jones, Gomez, Kaiser, Polosukhin —
  *Attention Is All You Need*, NeurIPS 2017.
* arXiv:1706.03762 — <https://arxiv.org/abs/1706.03762>
* Obtained from the arXiv e-print archive: <https://arxiv.org/e-print/1706.03762>
  which is the authors' own submission, unmodified.
* Note the vendor style file `nips_2017.sty` and the `\input` chain; both are
  shipped as they came.

## `perelman-2002/`

* G. Perelman — *Ricci flow with surgery on three-manifolds*,
  arXiv:math/0211159.
* <https://arxiv.org/abs/math/0211159>
* Obtained from <https://arxiv.org/e-print/math/0211159> as `src.tex`,
  the single-file preprint, unmodified. There are no figures in it, which is
  the point of including it: a paper with no diagrams still has to look
  impeccable.

## `fleuret-attention/`

* François Fleuret — *Deep Learning Course*, lecture 13.2,
  *Attention Mechanisms*.
* <https://github.com/francoisfleuret/dlc> (branch `main`, tree
  `7ec50dcb7fb8d7c2dda6e597b9c72f92cd106ecd`), the whole repository including
  `includes/`, `materials/`, `pics/` and `dlc.bib`.
* **Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0**
  (`LICENSE` in that directory, SPDX `NOASSERTION`). It is *not* CC0. It is
  included here unmodified, with attribution, as a test document. It is not
  covered by this project's own licence.

  Fleuret's shorter `attention.tex`, published on
  <https://fleuret.org> under CC0, is public domain and can be used more
  freely if a permissively licensed lecture deck is wanted instead.

## A note on what conversion means here

These pages are **conversions of the sources**, not scans and not
transcriptions. Text, mathematics, tables and figures are the authors'. Where
λtex2web cannot reproduce something, it says so on the page rather than
guessing — see the figure fallback and the broken-reference markers.