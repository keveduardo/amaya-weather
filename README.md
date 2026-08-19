# amaya-weather

Amaya Weather Station — publishes `weather.brisaloca.com` via GitHub Pages
(source: `main`, root).

⚠️ **This repo is PUBLIC and must stay public.** Pages from a private repo needs
a paid plan. `index.html` is served to the internet as-is, so anything added
here is published — including the Apps Script `/exec` URLs it calls, which are
anonymously fetchable by design.

## The pool controller script moved

`scripts/pool_script.gs` used to live here. It is now tracked in the **private**
`keveduardo/homecare` repo under `apps-script/`, alongside the other four files
of the same Apps Script project ("Pool Script",
`1PEHdU8p9UY2dOdDA70Vnnet7TB-xZVeToAeEFBjlnaYOotCvI7N9czxZ`).

It was moved on 2026-08-19 for consolidation, not because it leaked: every
credential it uses comes from Script Properties, and its only literal is the
iAquaLink app's own public API key. **The copy here was also stale** — it was
143 lines behind the live project, missing the `probeSWC()` diagnostic — which
is the real argument for one tracked copy rather than two.

Note that removing it does not remove it from this repo's git history, and it
does not need to: there is nothing in it to redact.
