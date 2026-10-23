# RunTime Dive Systems · Dive Current v0.9.8

**Status: integrated preview.** This package combines the user's `index.html`,
original v0.9.7 JS updated to v0.9.8, and uploaded Python v0.9.2 backend upgraded
to match the newer routes. The missing stylesheet has been recreated. The map,
route tools and bathymetry are available when the browser can load Leaflet and
its tile sources. The NOAA SSCOFS current-vector processor was **not** included
in the supplied Python source. Until its API URL is configured, current speed,
flow animation and forecasts correctly show *unavailable*, not invented data.

## Run locally on a Mac

1. Install Python 3.10+ (no packages required) and open Terminal.
2. Unzip this package, then run `cd Dive-Current-v0.9.8-Complete/app`.
3. Run `python3 serve.py`.
4. Open **http://127.0.0.1:8080/** (do not open `index.html` via a file URL).
5. Check **http://127.0.0.1:8080/diagnostics.html** and
   **http://127.0.0.1:8080/api/health** for backend status.

Note: Static water/shoreline tiles require internet. Python proxies DNR bathymetry,
contours, depth samples and NOAA tide predictions. In the Lake Washington area,
the bathymetry overlay uses the same public TMS tile format as the working DPV
Planner. Not every depth/pin source covers fresh water; DNR CoNED primarily covers
Washington marine waters.

## Tests

`python3 tests/test_server.py` and `node --check app/dive-current-v0.9.8.js`.
Server tests use simulated NOAA/DNR replies; they do not prove remote availability.

## Hosting and GitHub

Because this app has Python HTTP endpoints (`/api/*`), **GitHub Pages alone is
insufficient**. The simplest deployment is one GitHub source repository connected
to Render (or another Python-capable host). An optional `render.yaml` describes
the web service, with `app/` as the application directory. Render provides `PORT`;
`serve.py` listens on `0.0.0.0` when `PORT` is set. Set the domain
**current.runtimedivesystems.com** in the hosting dashboard after deployment,
then create the *provider-supplied* DNS record in GoDaddy. **Do not point this
subdomain at `jdd227.github.io`** for this Python-backed version.

A repo may be named `Jdd227/dive-current`. Upload the **contents** of this ZIP
not the ZIP itself; ensure `.github`, `app`, `tests`, `render.yaml`, and README
are in the repository root. Do not upload credentials.

### SSCOFS data integration still required

Frontend contracts:

- `GET /api/sscofs/info?time=<ISO8601>` responds with availability,
  valid-time and run metadata.
- `GET /api/sscofs/grid?time=<ISO8601>&west=&south=&east=&north=&rows=`
  responds with `{points:[[lat,lng,u,v],...],valid_time:...}` where `u` and
  `v` are horizontal velocities in m/s, positive east and north.
- `GET /api/sscofs/point` is reserved for point queries.

This repo returns an explicit HTTP 503 until the original current processor is
supplied or an equivalent validated vector service is configured via
`DIVE_CURRENT_SSCOFS_API_URL`. It is **not** correct to draw animated particles
using modeled current data that were never retrieved and validated.

## Source attribution and safety

The Lake Washington imagery source is
`archisgore/lake-washington-bathymetry` (CC0 dataset); basemap is © OpenStreetMap
contributors, and Puget Sound fallback ocean relief credits Esri / GEBCO / NOAA.
The NOAA tide/data sources are credited in the application. This is a planning
visualization, not an instrument for real-time underwater navigation. Confirm
forecast valid times, vertical datums, survey coverage, surface/underwater current
limitations, and coordinates before relying on the outputs.
