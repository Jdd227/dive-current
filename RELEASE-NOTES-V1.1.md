# Dive Current v1.1: currents + tides recovery

This patch updates 5 existing files, preserving the working route planner and GitHub Pages configuration.

## Changes

- **Projection correction:** WA DNR ArcGIS relief now exports in EPSG:3857, aligned to the Leaflet/OpenStreetMap map. Image sizes maintain equal aspect ratio when capped at 3,000 pixels. Previous EPSG:4326 bitmap overlay was visually distorted at wider extents. This does not create a water-only mask; relief may still shade coastal land.
- **NOAA current map:** `STRIDE=3` replaces `9` for finer wet-cell sampling on the next successful GitHub Action (not a hydrodynamic resolution increase). Flow mode particles start at actual wet-model cells; arrows draw at actual wet-model cell positions. Current readouts report distance to the model sample in kilometers for context and do not fill missing coverage with synthetic vectors.
- **Two map-bottom time sliders:** one for actual published SSCOFS frames, another for the official NOAA tide curve. Both control the same map time, and click-to-scrub tide chart restored. Current animation may be unavailable at selected times without a nearby verified frame.
- **NOAA tides:** Cache generator falls back to querying the known Tacoma/Seattle/Port Townsend/Port Angeles station IDs if metadata fails. High/low predictions are optional. Browser can also fetch official NOAA CO-OPS tide predictions directly when caching fails, subject to NOAA CORS support.
- **Depth markers:** clearer message outside marine raster coverage; no invented depth.

## Upload

Extract the patch ZIP, then upload its contents to the root of `Jdd227/dive-current` in GitHub, preserving `docs/` and `scripts/`. Files overwrite their existing versions. Do not remove `.github/workflows/deploy-pages.yml`. After committing to main, the existing workflow should run automatically and refresh the static site and NOAA data cache.

## Verify

- GitHub Actions run ends successfully. Confirm `docs/data/stations.json` contains at least Tacoma and `docs/data/sscofs/manifest.json` says `grid_stride: 3`. The default forecast displayed should have a valid run time, not simulated values.
- Open `https://jdd227.github.io/dive-current/`, force refresh, test map near Tacoma, and then at wider zooms. Test Flow/Arrows and both sliders.
- If tidal predictions remain unavailable, inspect the `Fetch NOAA CO-OPS tide predictions` step log and confirm the browser can access the NOAA CO-OPS API (CORS can vary).

## Limits

NOAA SSCOFS surface-model forecasts are not local current-meter observations, and ~1-mile wet-cell sample spacing is not suitable for interpreting narrow channels, near-bottom flow, shore approaches, or decompression conditions. Model velocity fields are explicitly limited by source-data timestamps. The WA DNR imagery is grayscale survey relief and may include shaded upland features until a water-only raster mask is developed.
