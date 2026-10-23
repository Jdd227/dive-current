# RunTime Dive Systems · Dive Current v1.0 (GitHub Pages)

**This project removes the always-on Python server.** `docs/` is a static website;
`.github/workflows/deploy-pages.yml` retrieves and validates NOAA data on a schedule
and deploys the site to GitHub Pages. No Render account, paid server, or local Mac
needs to remain on.

## First-time publishing

1. Upload the **contents** of this package to the root of the existing
   [`Jdd227/dive-current`](https://github.com/Jdd227/dive-current) repository.
   Keep `docs/`, `scripts/`, `tests/` and **`.github/workflows/deploy-pages.yml`**
   as directories. Existing `app/`, `serve.py`, and `render.yaml` can remain for
   historical reference but are **not used** by GitHub Pages.
2. Open **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Open **Actions → Dive Current · NOAA data and GitHub Pages → Run workflow**.
   The same workflow will also run after new commits and on the scheduled times.
4. Watch **both** the "Fetch NOAA" and "Process NOAA SSCOFS" steps in Actions.
   If either fails, the site still publishes but clearly marks that source
   as unavailable rather than inventing tide predictions or ocean currents.
5. Confirm the Pages test URL, usually
   `https://jdd227.github.io/dive-current/`, works before adding DNS.
6. After validation, set the custom domain in GitHub Pages to
   `current.runtimedivesystems.com`. GitHub will tell you the needed target
   for GoDaddy (`jdd227.github.io` for a standard GitHub Pages subdomain).
   Do not modify the existing DPV Planner CNAME record or the root domain.

**macOS note:** Finder hides `.github` by default. Use Command + Shift + Period
(`⌘⇧.`) to show hidden files when uploading through the GitHub website.

## How forecasts work

- NOAA operational SSCOFS data is public NetCDF: model runs 03, 09, 15, and
  21 UTC, with hourly forecasts. This Action starts at 05:15/11:15/17:15/23:15
  UTC and tries to retrieve the latest available production cycle.
- `scripts/update_sscofs.py` selects **near-surface** eastward/northward
  current components from official SSCOFS OPeNDAP NetCDF. It reads a downsampled
  subset through OPeNDAP (`STRIDE=9`), filters the model water mask and the
  western Washington region, checks timestamps, and outputs sparse vectors
  to `docs/data/sscofs/frame-....json`.
- The app reads `docs/data/sscofs/manifest.json` and refuses to display any
  cycle more than **18 hours old**. The displayed time is the actual model
  validity time, never an assumed current observation. If the NOAA endpoint
  is down or the conversion fails, it shows **Unavailable**.
- NOAA CO-OPS tide predictions are cached in `docs/data/tides/` with times
  explicitly set to UTC and station metadata in `docs/data/stations.json`.
  Tide caches older than 72 hours are marked unavailable; they are not shown
  as fresh tide predictions. The forecast pipeline caches selected Washington
  stations only, to minimize load on NOAA.

**First-live-run limitation:** This package was built and unit-tested without
live access to NOAA's OPeNDAP servers. The production THREDDS dataset URLs and
variable names are grounded in NOAA's documentation, but the workflow MUST be
run against the live production service to verify parsing and performance.
Until a complete NetCDF run passes, the currents manifest deliberately says
`unavailable`, and no current animation appears. See Action logs if there is a
remote API failure; do not substitute synthetic values for live dive planning.

## What remains working without forecast data

- OpenStreetMap basemap and Lake Washington TMS bathymetry (the same source as
  the existing RunTime DPV Planner)
- WA DNR CoNED hillshade and depth sampling where the agency provides data
- Marine contour data where available
- Click-to-place multi-leg DPV route, feet, true bearings, travel times
- Route persistence and depth pins (browser storage)

Remote WA DNR REST responses may be affected by agency availability or CORS;
when the DNR imagery fails the regional ocean-relief fallback remains available.

## Local preview (no Python application backend)

```sh
cd docs
python3 -m http.server 8080
# http://localhost:8080/
```

Run validations:

```sh
python3 scripts/validate.py
python3 -m unittest discover -s tests -v
node --check docs/dive-current.js
```

## Caveats

SSCOFS is **modeled near-surface flow guidance, not observed dive-depth current**.
Grid downsampling limits narrow-channel detail. Do not use forecasts as a direct
substitute for site assessment, dive planning controls, or underwater navigation.
Datum information for tidal heights (MLLW) and marine bathymetry is not identical
with all fresh-water datasets.

Sources: NOAA CO-OPS operational SSCOFS, NOAA CO-OPS tide predictions,
WA DNR CoNED, OpenStreetMap, the public Lake Washington bathymetry tile dataset.
