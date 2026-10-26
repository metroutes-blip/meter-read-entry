# iPad Tracker

Offline PWA for keeping track of the iPads: which area each one is in, who has it, and a QR / Data Matrix label to find it again.

Live at **https://metroutes-blip.github.io/meter-read-entry/ipad-tracker/** (the `ipad-tracker/` folder of this repo, published with LVB). Open it on the iPad or phone you'll use for tracking and choose **Add to Home Screen**.

## What it does
- **Inventory**: asset tag, serial number, device name, model, area, assigned worker, status (In use / Spare / Repair / Lost / Retired) and notes. Grouped by area, with search and filters, including **Not seen in 30 days**.
- **History**: every change, scan and stocktake is logged per iPad with who did it (set **Your name** in Settings).
- **Make codes**: each iPad shows a QR code and a Data Matrix for its asset tag. **Print labels** prints a sheet (whole fleet or one area) in three sizes; each code can also be saved as a PNG.
- **Scan codes**: the camera reads QR, Data Matrix, and ordinary barcodes (Code 128/39, etc., e.g. the serial barcode on an iPad's box or existing asset stickers). A known code opens that iPad; an unknown one offers to add it.
- **Stocktake**: tick *keep scanning* and walk round scanning labels; each iPad is marked as seen, with a running count.
- **Read the Settings screen**: on the iPad being registered, open **Settings › General › About**. Point the camera at it and tap **Read the screen**. The app pulls out the **Serial Number**, **Name** and **Model**, and finds the iPad if it's already in the list. For the iPad you're holding, take a screenshot of that page and choose **Use a screenshot**. Screenshots read more accurately than camera photos.

### About reading the Settings screen
- The text reader (Tesseract) works on the device, offline. It gets about 9 in 10 serials exactly right on clean screens. The app warns you when it isn't sure, so **always compare the serial with the screen** before saving. Tap a box in the results, then tap any piece of recognised text to fill it.
- Apple serials never use the letters O or I, so those are read as 0 and 1.
- iPadOS doesn't show an asset tag on the About screen. If you set the iPad's **Name** to its asset tag, tick *use the iPad's Name as its asset tag* in Settings. If your tags share a prefix (e.g. `LVB-`), enter it and the reader will pick out a matching tag.
- iPad fallback: tap the Serial field, tap it again and choose **Scan Text**. This uses Apple's own Live Text.

## Sharing between devices (optional)
By default the list stays on the device it was entered on. To share one list between several iPads/phones, use the same approach as LVB's meter locations: one JSON file in a **private** GitHub repo.

1. Use the existing private repo **`metroutes-blip/meter-geocodes`** (the default) or another private repo. The app creates `ipads.json` on the first sync.
2. Use a fine-grained token with **Contents: Read and write** on that repo. A tablet's existing LVB token for `meter-geocodes` works.
3. On each device: Settings › **Share between devices (GitHub)** › paste the token › **Save & sync**.

Edits made offline upload when a connection returns. When two devices change the same iPad, the newer edit wins. Histories and "last seen" are merged, so nothing is lost. Deleted iPads are deleted everywhere.

## Import and export
Settings › **Your data**:
- **Export spreadsheet (CSV)**: opens in Excel.
- **Import CSV**: the first row needs an `Asset Tag` or `Serial` column. `Name`, `Model`, `Area`/`Location`, `Assigned To`/`Worker`, `Status` and `Notes` are used if present. Rows update iPads with the same tag or serial, and the rest are added. This is the quickest way to load all 47 iPads from an existing list.
- **Export backup (JSON)** / import it again to restore or move to another device.

## Label content
Settings › *What the label codes hold*: the asset tag (default), the serial number, or a link (`…/ipad-tracker/#ipad=LVB-023`) that opens the iPad in the app when scanned with the Camera app. Links only find the iPad on a device that has the list (see Sharing).

## Files
- `index.html`, `styles.css`, `app.js`: the app. `parse.js` turns OCR text from the About screen into fields.
- `sw.js`: offline cache. Bump `CACHE` when app files change. Bump `VENDOR_CACHE` only when a file in `vendor/` changes, so the 7 MB text reader isn't downloaded again on every update.
- LVB's own service worker (`../sw.js`) ignores this folder, so the two apps don't interfere. Settings use the `ipt.` prefix in localStorage, data is in the `ipad-tracker` IndexedDB database, and caches start with `ipad-tracker-`.

## Libraries (vendored, offline)
- zxing-wasm 2.2.4 (zxing-cpp, MIT): `vendor/zxing/`. Reads and writes QR / Data Matrix / barcodes.
- Tesseract.js 7.0.0 + tesseract.js-core LSTM builds (Apache-2.0): `vendor/tesseract/`. English `best_int` model (`lang/eng.traineddata.gz`). Fetched once in the background after the first launch so it works offline.
