# Logbook

Personal workout log and progression tracker. Installable web app (PWA) for iPhone, works offline, stores all data on the device.

- `src/` TypeScript source (no runtime dependencies): `domain.ts` calculations, `db.ts` IndexedDB, `seed.ts` exercise library, `data.ts` backup/CSV, `importer.ts` plan/workout import (text, CSV, Excel, OCR text), `app.ts` screens, `i18n.ts` English/Italian.
- Image import loads Tesseract.js from jsDelivr on first use (runs on the device; language data cached after the first download).
- `public/` the deployed site: compiled `js/`, `styles.css`, `sw.js` (offline cache), manifest and icons.
- `tests/domain.test.mjs` unit tests for every calculation (`npm test`); `tests/e2e.mjs` browser flows on an iPhone-sized screen.

Build: `tsc -p .` · Deploy: push to `main`; GitHub Actions runs the tests and publishes `public/` to GitHub Pages.
Release checklist: bump `VERSION` in `src/app.ts` and `CACHE` in `public/sw.js` together, so installed phones pick up the update.

Your data: More → Back up (JSON) saves everything to the Files app / iCloud Drive. Restore with More → Restore / import backup. Imports never duplicate records.
