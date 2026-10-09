# Meter Read Entry

Offline PWA for entering monthly meter reads on a tablet instead of paper.

1. Open a route spreadsheet (`.xlsx` or `.xls`).
2. The app finds the first empty monthly column group (Corrected / Uncorrected / Metered / Date Read / Read By / Comments). You can change it from the route list.
3. Enter reads meter by meter. Each change is autosaved on the tablet (IndexedDB).
4. **Finish & Export** builds `… completed.xlsx` / `.xls`, which you can share or download.

Spreadsheet data never leaves the device. The only thing sent anywhere is meter numbers with GPS positions, which go to a private GitHub repo (see below).

## File formats
- **.xlsx**: only the new cells are written into the sheet XML. Formatting, formulas and external links are untouched.
- **.xls**: the whole workbook is rewritten. Values are kept, but **formulas become plain values** and some formatting is lost. Save inputs as `.xlsx` to avoid this.

## Meter locations (map)
Each meter's GPS position is saved the first time a read is entered for it. Workers can redo it with **Save my location here** while standing at the meter.
Locations are keyed by **Meter#** and shared between tablets through one JSON file in a **private** GitHub repo:

```json
{ "version": 1, "updated": "…", "meters": { "914368": {"lat":43.70,"lng":-79.64,"acc":6,"by":"AC","at":"2026-10-09T15:02:00Z"} } }
```

- Locations captured offline wait on the tablet and upload automatically when a connection returns.
- When two tablets save at the same time, the app re-reads the file and merges. For the same meter, the newest location wins.
- The **Map** screen (from the route list) shows numbered pins coloured by read status, plus your position. **Directions** opens Apple Maps on iPad, or Google Maps elsewhere.
- Street and satellite (with street names) maps come from Esri's public basemaps and need a connection. (OpenStreetMap's own tile servers block apps like this one, and CARTO now requires an API key.)

### One-time setup
1. On GitHub, create a **private** repository, e.g. `meter-geocodes`. It can be empty; the app creates `geocodes.json`.
2. Create a fine-grained personal access token (Settings › Developer settings › Fine-grained tokens):
   - Repository access: **Only select repositories** › `meter-geocodes`
   - Permissions: **Contents: Read and write** (Metadata: read is added automatically)
   - Pick an expiry date and note it.
3. On each tablet: Home › **Meter location sync (GitHub)** › enter `owner/meter-geocodes` and the token, then tap **Save & test connection**.

The token is stored only on that tablet. If a tablet is lost, revoke the token on GitHub and issue a new one.

## Hosting
Any static host over HTTPS (e.g. GitHub Pages). Upload this folder as-is; there is no build step.
On the tablet, open the URL and use Add to Home Screen. The app then works offline.

## Updating
Edit the files and redeploy. Tablets pick up the new version on the next launch after it has been fetched.
To force old caches to be cleared, change `CACHE` in `sw.js`, and bump `APP_VERSION` in `app.js`.

## Libraries (vendored, offline)
- SheetJS 0.18.5: `vendor/xlsx.full.min.js`
- JSZip 3.10.1: `vendor/jszip.min.js`
- Leaflet 1.9.4: `vendor/leaflet/`
