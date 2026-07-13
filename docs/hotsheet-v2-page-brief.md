# Build: Hotsheet v2 comparison page (Postgres-sourced)

## Context

We're migrating the nightly Hotsheet report off the legacy Google Sheet
pipeline and onto Postgres (`ac_pathfinder`), running both in parallel until
we trust the new one. The data-fetch layer for the new pipeline is already
built: `hotsheet-postgres-source.js` (attached / already in this repo root).

Before touching the automated email, I want a **webpage** that renders the
v2 data in the *same visual format* as the existing legacy page, so I can
open both side by side and compare counts/content directly. This is a
comparison tool, not a redesign — match the legacy page's look exactly.

## What already exists (do not modify)

- **`hotsheet-report.js`** — legacy data fetch (Google Sheets + DeltaNet) +
  `buildEmail()`. Leave untouched.
- **`hotsheet-page.js`** — legacy web page. Route: `GET /hotsheet/report`,
  mounted in `server.js` as `app.get("/hotsheet/report", requireAuth, handleHotsheetPage)`.
  Contains `buildPage(data, since, until, key, isManager)` — the HTML/CSS/JS
  for the page: key-auth gate, date range picker, filter tabs (All/Listings/
  Contracts/Closings/Changes/Upcoming/Buyer Needs/Open Houses), section
  renderers, photo elements, property links. **Read this file in full before
  writing anything** — it's the template to match.
- **`hotsheet-postgres-source.js`** — new Postgres-backed data fetch, already
  built and reviewed. Exports `createPostgresHotsheetSource({ db })` →
  `{ fetchHotsheetDataV2(since) }`. Returns:
  ```
  { newListings, newContracts, closings, changes, upcoming, buyerNeeds, openHouses }
  ```
  Same field shape as legacy `fetchHotsheetData()` **except there is no
  `dnOnly`** — that section was intentionally dropped in v2 (see file header
  comments for why). Every item has the same field names the legacy renderers
  already expect (`address`, `mlsIds`, `city`, `listPrice`, `agentFirst`,
  `agentLast`, etc.) — check the file's per-section return shapes against
  what `hotsheet-page.js`'s render functions actually read, and reconcile any
  small naming gaps you find.

## What to build

1. **New file `hotsheet-page-v2.js`.** Don't fork all of `hotsheet-page.js`
   line for line if you can avoid it — factor out and reuse whatever you can
   (styles, `buildPage`'s shell/layout, photo/link helpers, filter-tab JS).
   Only the data source and the removal of the dnOnly section should differ.
   Use your judgment on the cleanest way to share code between the two files
   without risking a change that affects the legacy page's live output.

2. **Factory pattern**, since this one needs a live `db` pool (the legacy
   files don't take DI — this one will need to):
   ```js
   module.exports = function createHotsheetPageV2({ db }) {
     const { fetchHotsheetDataV2 } = require("./hotsheet-postgres-source").createPostgresHotsheetSource({ db });
     async function handleHotsheetPageV2(req, res) { ... }
     return { handleHotsheetPageV2 };
   };
   ```

3. **Route:** `GET /hotsheet/report-v2`, same auth pattern as the legacy page
   (`x-proxy-key` header or `?key=` query param against `PROXY_SECRET`, same
   key-entry form on missing/invalid key — copy that behavior exactly).

4. **Same date-range picker and filter tabs**, minus an "Open Houses" caveat:
   confirm whether `since`/`until` should scope open houses (legacy doesn't
   date-filter open houses at all, it just shows the next N days — check
   `OPEN_HOUSE_DAYS` behavior in `hotsheet-postgres-source.js` and match
   the legacy page's expectations here, not a new interpretation).

5. **No dnOnly / "MLS Only" tab or section.** If `hotsheet-page.js`'s
   `buildPage` has a dnOnly-specific filter tab or render call, drop it for
   v2 rather than rendering an always-empty section.

## Wiring into server.js

Additive only — two lines, don't touch anything else in `server.js`:
```js
const hotsheetPageV2 = require("./hotsheet-page-v2")({ db });
app.get("/hotsheet/report-v2", requireAuth, hotsheetPageV2.handleHotsheetPageV2);
```

## Constraints

- `server.js` is a shared hub for unrelated features — the only change there
  should be the two lines above.
- Don't touch `hotsheet-report.js` or the legacy `hotsheet-page.js` — the
  legacy pipeline needs to keep running untouched while we compare.
- No schema/DDL changes needed for this step — `hotsheet-postgres-source.js`
  only reads.
- Match the legacy page's visual output as closely as possible — the whole
  point is an apples-to-apples comparison, not a redesign.

## To test locally

```
npm start
# then open http://localhost:<port>/hotsheet/report-v2?key=<PROXY_SECRET>
```
Compare against `http://localhost:<port>/hotsheet/report?key=<PROXY_SECRET>`
for the same date range and eyeball the counts/content per section.
