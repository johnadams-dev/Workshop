# Feature brief: Manager Retreat — Task Priority Rating Tool

**For Claude Code.** This brief describes a small feature to add to the
adamscameron.com platform (Node/Express on Cloud Run, PostgreSQL on Cloud SQL,
GitHub Pages frontend, GitHub CI/CD to Cloud Build). A working reference
implementation is included as an appendix, built as a **standalone** prototype
outside this repo. It proves the logic works, but it was not written against this
codebase's conventions — treat it as a spec to adapt, not code to paste in.

## Before writing anything

Read the existing repo first and match what you find, rather than introducing a
new pattern:

- How is the Express app structured — one file, or a router-per-feature layout?
  Add this feature's routes the way existing features add theirs.
- Is there an existing Postgres connection/pool module? Reuse it — don't create a
  second `pg.Pool`.
- Is there an existing migration mechanism (a migrations folder, a tool like
  node-pg-migrate, or hand-run SQL files)? Add this feature's tables through that
  mechanism, not as a bare `schema.sql` sitting in the repo root.
- What's the existing environment-variable naming convention? Name the new ones
  (see below) to match.
- How does the GitHub Pages frontend currently talk to the Cloud Run backend — a
  fixed base URL, a config file, something else? Wire this feature's frontend into
  that same pattern rather than inventing a new one.
- Is there an existing admin/auth mechanism anywhere on the platform? If so, prefer
  it over the standalone passcode approach described below — the passcode is a
  reasonable fallback, not a requirement.
- Run whatever linting/formatting/tests the repo already has before considering
  this done.

If any of the above is unclear from the repo itself, ask rather than guessing.

## Hard requirements — do not compromise on these

This tool exists specifically to fix problems with an earlier Google Sheets
attempt. The whole point is:

1. **Fully anonymous.** No login, no user accounts, nothing that identifies who
   submitted a rating — ever, in the database, in logs, anywhere. This is the most
   important constraint in this brief.
2. **No manager can see another manager's individual answers**, at any point,
   through any endpoint. Aggregated results are fine once the facilitator opens
   them; anything per-manager is not.
3. **Facilitator controls are gated** behind something only the facilitator has
   (a shared passcode/token is what the reference implementation uses — swap in
   the platform's existing admin mechanism if there is one).
4. **Results stay hidden from managers until the facilitator opens them.**
5. **Adding a task mid-retreat must not invalidate ratings already collected** for
   existing tasks. Items are keyed by a stable id; late additions are inserts, not
   a reset.

## What it does

Four rating phases, run one at a time (or several concurrently) at the
facilitator's discretion, against a list of ~38 tasks pulled from a separate
planning exercise:

- **Current Success** (1–5): how well the org is doing this task today.
- **Time Spent** (1–5): how much time it takes relative to everything else.
- **Mission/Vision** (comparative): the reason this isn't a third 1–5 scale —
  people rate almost everything a 5 on a plain scale. Instead, each manager sees
  16 random groups of 4 tasks and picks the one that most supports the mission and
  the one that supports it least. This forces real trade-offs.
- **Revenue / Company Dollar** (comparative): same mechanism, framed around
  Company Dollar specifically (the brokerage's retained share after agent splits —
  explicitly *not* gross sales or agent GCI, and the UI should say so).

A **Results** view (facilitator-gated, then optionally opened to everyone) shows
five quadrant charts (Mission×Success, Mission×Time, Revenue×Success, Revenue×Time,
Mission×Revenue), a sortable table of every task's scores, and a "Biggest splits"
panel surfacing the tasks managers disagreed about most.

## Scoring

- **Current Success / Time Spent**: mean of every submitted 1–5 value per task,
  plus the raw min–max range across submissions (used for the disagreement panel).
- **Mission/Vision / Revenue**: for each task, `score = 1 + 4 * ((best_count -
  worst_count) / times_shown + 1) / 2` — rescales the −1..1 best-minus-worst rate
  onto the same 1–5 scale as the other two dimensions so all quadrant charts share
  axes. A separate `contested = 2 * min(best_count, worst_count) / times_shown`
  flags tasks picked as *both* best and worst often — genuine disagreement, not
  mere indifference.

## Data model (adapt to the platform's migration convention)

```sql
-- Manager retreat rating tool — schema
-- Run once against the target Postgres database (e.g. via psql or your migration tool).

CREATE TABLE IF NOT EXISTS rating_items (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rating_phase (
  id INTEGER PRIMARY KEY DEFAULT 1,
  open_success BOOLEAN NOT NULL DEFAULT false,
  open_time BOOLEAN NOT NULL DEFAULT false,
  open_mission BOOLEAN NOT NULL DEFAULT false,
  open_revenue BOOLEAN NOT NULL DEFAULT false,
  results_open BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO rating_phase (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per manager submission. No identifying information is ever written —
-- that's what makes this anonymous. "vals" maps item id -> 1-5 integer.
CREATE TABLE IF NOT EXISTS success_ratings (
  id SERIAL PRIMARY KEY,
  vals JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_ratings (
  id SERIAL PRIMARY KEY,
  vals JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per manager submission for a comparative phase. "rounds" is an array of
-- {group: [itemId, itemId, itemId, itemId], best: itemId, worst: itemId}.
CREATE TABLE IF NOT EXISTS mission_judgments (
  id SERIAL PRIMARY KEY,
  rounds JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revenue_judgments (
  id SERIAL PRIMARY KEY,
  rounds JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Note: `vals` (not `values`, a reserved word) holds a JSON map of item id → 1–5
integer for the two scale phases. `rounds` holds an array of
`{group: [id,id,id,id], best: id, worst: id}` for the two comparative phases.
Nothing in either table is ever linked to a person.

## API surface (reference — adjust paths/prefix to match existing route conventions)

- `GET /api/state` — items, phase-open flags, submission counts. Public.
- `POST /api/admin/login` — checks a passcode/token, no session created server-side
  (the reference implementation just has the client re-send the token on every
  admin call).
- `POST /api/admin/phase` — admin-only. Opens/closes one of the five phases
  (`success`, `time`, `mission`, `revenue`, `results`).
- `POST /api/admin/items` — admin-only. Upserts items by id (for late additions).
- `POST /api/submit/success`, `/api/submit/time` — body `{values: {itemId: 1-5}}`.
- `POST /api/submit/mission`, `/api/submit/revenue` — body
  `{rounds: [{group, best, worst}, ...]}`.
- `GET /api/results` — 403 unless results are open or the caller is admin. Returns
  computed scores (see Scoring above) plus submission counts.

## Environment variables (rename to match platform convention)

- `DATABASE_URL` — reuse whatever the platform already uses for its Postgres
  connection; don't add a second one.
- `ADMIN_TOKEN` — shared facilitator passcode. Only needed if the platform doesn't
  already have an admin/auth mechanism to hang this off of instead.

## Frontend

Vanilla JS, no build step, no framework — intentionally simple since this is a
short-lived, single-event tool. Talks to the API via `fetch`. If the platform's
GitHub Pages frontend has an existing pattern for hitting the Cloud Run API
cross-origin (the reference implementation already sends CORS headers), follow
that pattern rather than the standalone `express.static` setup shown in the
reference server.

## Suggested integration checklist

- [ ] Routes added following the existing router/file layout, not as a bolted-on
      standalone app
- [ ] Reuses the existing Postgres pool instead of a new one
- [ ] Tables added via the existing migration mechanism
- [ ] Env vars named per existing convention; secrets handled the way the
      platform already handles them (not committed, pulled from whatever secret
      manager / env config is already in use)
- [ ] Frontend wired into the existing GitHub Pages → Cloud Run pattern
- [ ] Existing lint/format/test tooling passes
- [ ] No unrelated existing functionality touched
- [ ] Confirmed: no code path anywhere writes an identifying value (IP, session
      id, auth identity, etc.) alongside a rating
- [ ] Since this is for one retreat: flag whether the platform has a convention
      for retiring short-lived features later, so this doesn't linger as unused
      surface area after the event

## Appendix: reference implementation

Working, syntax-checked, and smoke-tested (routes verified with curl; full
end-to-end DB test still needed against a real Postgres instance). Use it to see
the intended behavior and scoring logic — restructure freely to fit the codebase.

### server.js

```javascript
"use strict";

// Manager retreat rating tool — backend.
//
// Env vars:
//   DATABASE_URL   Postgres connection string (Cloud SQL, same as the rest of the platform)
//   ADMIN_TOKEN    A shared passcode the facilitator uses to open/close phases.
//                  Pick anything memorable; it is never stored anywhere but this env var
//                  and, once entered, the facilitator's own browser (localStorage).
//   PORT           Defaults to 8080 (Cloud Run's default).
//
// No login, no accounts, no identity is ever recorded for a submission — that's what
// makes ratings anonymous. Only the facilitator's admin actions (opening/closing phases,
// refreshing the item list) are gated, via ADMIN_TOKEN.

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

if (!ADMIN_TOKEN) {
  console.warn("WARNING: ADMIN_TOKEN is not set. Facilitator controls will be unreachable.");
}

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

// ---------------- state ----------------

app.get("/api/state", async (req, res) => {
  try {
    const itemsRes = await pool.query(
      "SELECT id, text, category, path, owner FROM rating_items ORDER BY category, id"
    );
    const phaseRes = await pool.query("SELECT * FROM rating_phase WHERE id = 1");
    const counts = await getCounts();
    res.json({
      items: itemsRes.rows,
      phase: phaseRes.rows[0] || {
        open_success: false, open_time: false, open_mission: false, open_revenue: false, results_open: false
      },
      counts
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

async function getCounts() {
  const [s, t, m, r] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM success_ratings"),
    pool.query("SELECT COUNT(*)::int AS n FROM time_ratings"),
    pool.query("SELECT COUNT(*)::int AS n FROM mission_judgments"),
    pool.query("SELECT COUNT(*)::int AS n FROM revenue_judgments")
  ]);
  return { success: s.rows[0].n, time: t.rows[0].n, mission: m.rows[0].n, revenue: r.rows[0].n };
}

// ---------------- admin ----------------

app.post("/api/admin/login", (req, res) => {
  const token = (req.body && req.body.token) || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(403).json({ ok: false });
  res.json({ ok: true });
});

const PHASE_COLUMNS = {
  success: "open_success",
  time: "open_time",
  mission: "open_mission",
  revenue: "open_revenue",
  results: "results_open"
};

app.post("/api/admin/phase", requireAdmin, async (req, res) => {
  const key = req.body && req.body.key;
  const value = !!(req.body && req.body.value);
  const col = PHASE_COLUMNS[key];
  if (!col) return res.status(400).json({ error: "bad_key" });
  try {
    await pool.query(`UPDATE rating_phase SET ${col} = $1 WHERE id = 1`, [value]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

// Refresh (or seed) the item list without redeploying — e.g. for last-minute additions
// during the retreat. Existing ids are updated in place; new ids are inserted.
// Items already removed from the source list are left as-is (not deleted), so any
// ratings already collected for them stay intact.
app.post("/api/admin/items", requireAdmin, async (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "no_items" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of items) {
      await client.query(
        "INSERT INTO rating_items (id, text, category, path, owner) " +
        "VALUES ($1,$2,$3,$4,$5) " +
        "ON CONFLICT (id) DO UPDATE SET text=$2, category=$3, path=$4, owner=$5",
        [it.id, it.text, it.category || "", it.path || "", it.owner || ""]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, count: items.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "server_error" });
  } finally {
    client.release();
  }
});

// ---------------- submissions ----------------
// Each endpoint writes exactly one row per submission, with no identifying data.

app.post("/api/submit/success", (req, res) => submitScale(req, res, "success_ratings"));
app.post("/api/submit/time", (req, res) => submitScale(req, res, "time_ratings"));

async function submitScale(req, res, table) {
  const values = (req.body && req.body.values) || {};
  if (Object.keys(values).length === 0) return res.status(400).json({ error: "empty" });
  try {
    await pool.query(`INSERT INTO ${table} (vals) VALUES ($1)`, [JSON.stringify(values)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
}

app.post("/api/submit/mission", (req, res) => submitCompare(req, res, "mission_judgments"));
app.post("/api/submit/revenue", (req, res) => submitCompare(req, res, "revenue_judgments"));

async function submitCompare(req, res, table) {
  const rounds = (req.body && req.body.rounds) || [];
  if (!Array.isArray(rounds) || rounds.length === 0) return res.status(400).json({ error: "empty" });
  try {
    await pool.query(`INSERT INTO ${table} (rounds) VALUES ($1)`, [JSON.stringify(rounds)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
}

// ---------------- results ----------------
// Only exposed once the facilitator opens results (or to the facilitator any time).

app.get("/api/results", async (req, res) => {
  try {
    const phaseRes = await pool.query("SELECT results_open FROM rating_phase WHERE id = 1");
    const isAdmin = !!ADMIN_TOKEN && req.get("x-admin-token") === ADMIN_TOKEN;
    const resultsOpen = phaseRes.rows[0] && phaseRes.rows[0].results_open;
    if (!resultsOpen && !isAdmin) {
      return res.status(403).json({ error: "results_not_open" });
    }

    const itemsRes = await pool.query("SELECT id, text, category, path, owner FROM rating_items ORDER BY category, id");
    const [successRows, timeRows, missionRows, revenueRows] = await Promise.all([
      pool.query("SELECT vals FROM success_ratings"),
      pool.query("SELECT vals FROM time_ratings"),
      pool.query("SELECT rounds FROM mission_judgments"),
      pool.query("SELECT rounds FROM revenue_judgments")
    ]);

    const scores = computeScores(
      itemsRes.rows,
      successRows.rows.map((r) => r.vals),
      timeRows.rows.map((r) => r.vals),
      missionRows.rows.map((r) => r.rounds),
      revenueRows.rows.map((r) => r.rounds)
    );

    res.json({ scores, counts: await getCounts() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error" });
  }
});

function computeScores(items, successDocs, timeDocs, missionDocs, revenueDocs) {
  const scores = {};
  items.forEach((it) => {
    scores[it.id] = {
      id: it.id, text: it.text, path: it.path, owner: it.owner,
      success: null, successN: 0, successRawMin: null, successRawMax: null, successRawRange: null,
      time: null, timeN: 0, timeRawMin: null, timeRawMax: null, timeRawRange: null,
      missionScore: null, missionShown: 0, missionBest: 0, missionWorst: 0, missionContested: null,
      revenueScore: null, revenueShown: 0, revenueBest: 0, revenueWorst: 0, revenueContested: null
    };
  });

  function avgScale(docs, key, nKey, rawPrefix) {
    const sums = {}, cnts = {}, raws = {};
    docs.forEach((vals) => {
      Object.keys(vals || {}).forEach((id) => {
        if (!scores[id]) return;
        sums[id] = (sums[id] || 0) + vals[id];
        cnts[id] = (cnts[id] || 0) + 1;
        (raws[id] = raws[id] || []).push(vals[id]);
      });
    });
    Object.keys(scores).forEach((id) => {
      if (cnts[id]) {
        scores[id][key] = sums[id] / cnts[id];
        scores[id][nKey] = cnts[id];
        const arr = raws[id];
        const mn = Math.min.apply(null, arr), mx = Math.max.apply(null, arr);
        scores[id][rawPrefix + "Min"] = mn;
        scores[id][rawPrefix + "Max"] = mx;
        scores[id][rawPrefix + "Range"] = mx - mn;
      }
    });
  }
  avgScale(successDocs, "success", "successN", "successRaw");
  avgScale(timeDocs, "time", "timeN", "timeRaw");

  function bwScore(docs, shownKey, bestKey, worstKey, scoreKey, contestedKey) {
    const shown = {}, best = {}, worst = {};
    docs.forEach((rounds) => {
      (rounds || []).forEach((r) => {
        (r.group || []).forEach((id) => { shown[id] = (shown[id] || 0) + 1; });
        if (r.best) best[r.best] = (best[r.best] || 0) + 1;
        if (r.worst) worst[r.worst] = (worst[r.worst] || 0) + 1;
      });
    });
    Object.keys(scores).forEach((id) => {
      const s = shown[id] || 0, b = best[id] || 0, w = worst[id] || 0;
      scores[id][shownKey] = s; scores[id][bestKey] = b; scores[id][worstKey] = w;
      if (s > 0) {
        const raw = (b - w) / s;
        scores[id][scoreKey] = 1 + ((raw + 1) / 2) * 4;
        scores[id][contestedKey] = (2 * Math.min(b, w)) / s;
      }
    });
  }
  bwScore(missionDocs, "missionShown", "missionBest", "missionWorst", "missionScore", "missionContested");
  bwScore(revenueDocs, "revenueShown", "revenueBest", "revenueWorst", "revenueScore", "revenueContested");

  return Object.values(scores);
}

// ---------------- static frontend ----------------

app.use(express.static(require("path").join(__dirname, "public")));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Manager rating tool listening on port " + PORT);
});
```

### schema.sql

```sql
-- Manager retreat rating tool — schema
-- Run once against the target Postgres database (e.g. via psql or your migration tool).

CREATE TABLE IF NOT EXISTS rating_items (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rating_phase (
  id INTEGER PRIMARY KEY DEFAULT 1,
  open_success BOOLEAN NOT NULL DEFAULT false,
  open_time BOOLEAN NOT NULL DEFAULT false,
  open_mission BOOLEAN NOT NULL DEFAULT false,
  open_revenue BOOLEAN NOT NULL DEFAULT false,
  results_open BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT single_row CHECK (id = 1)
);
INSERT INTO rating_phase (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per manager submission. No identifying information is ever written —
-- that's what makes this anonymous. "vals" maps item id -> 1-5 integer.
CREATE TABLE IF NOT EXISTS success_ratings (
  id SERIAL PRIMARY KEY,
  vals JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_ratings (
  id SERIAL PRIMARY KEY,
  vals JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per manager submission for a comparative phase. "rounds" is an array of
-- {group: [itemId, itemId, itemId, itemId], best: itemId, worst: itemId}.
CREATE TABLE IF NOT EXISTS mission_judgments (
  id SERIAL PRIMARY KEY,
  rounds JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revenue_judgments (
  id SERIAL PRIMARY KEY,
  rounds JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### seed.js

The `ITEMS` array is the current 38-item task list snapshot. Regenerate this list
(or replace with a query against wherever the task list actually lives) before
running.

```javascript
"use strict";

// Seeds (or refreshes) the rating_items table from the current task list snapshot.
// Safe to re-run: it upserts by id, so re-seeding after edits to the source list
// (adds/renames/removals of owner) won't create duplicates. It will NOT remove
// items that were deleted from the source list -- do that by hand if it happens.
//
// Usage:  DATABASE_URL=postgres://... node seed.js

const { Pool } = require("pg");

const ITEMS = [
  {
    "id": "n2",
    "text": "Speakers for monthly training",
    "category": "Training",
    "path": "Training",
    "owner": ""
  },
  {
    "id": "n4",
    "text": "Review",
    "category": "Compliance",
    "path": "Compliance",
    "owner": ""
  },
  {
    "id": "n5",
    "text": "Assembly",
    "category": "Compliance",
    "path": "Compliance",
    "owner": ""
  },
  {
    "id": "n7",
    "text": "1-on-1s",
    "category": "Agent Development",
    "path": "Agent Development",
    "owner": ""
  },
  {
    "id": "n8",
    "text": "Mentorship",
    "category": "Agent Development",
    "path": "Agent Development",
    "owner": ""
  },
  {
    "id": "na",
    "text": "Experienced Agents",
    "category": "Recruiting",
    "path": "Recruiting",
    "owner": ""
  },
  {
    "id": "nc",
    "text": "Pull new agent list",
    "category": "Recruiting",
    "path": "Recruiting › New Agents",
    "owner": ""
  },
  {
    "id": "nd",
    "text": "Send letters",
    "category": "Recruiting",
    "path": "Recruiting › New Agents",
    "owner": ""
  },
  {
    "id": "ne",
    "text": "Send other materials",
    "category": "Recruiting",
    "path": "Recruiting › New Agents",
    "owner": ""
  },
  {
    "id": "nf",
    "text": "Sign letters",
    "category": "Recruiting",
    "path": "Recruiting › New Agents",
    "owner": ""
  },
  {
    "id": "n11",
    "text": "Birthday cards",
    "category": "Retention",
    "path": "Retention",
    "owner": ""
  },
  {
    "id": "n13",
    "text": "President’s Club",
    "category": "Retention",
    "path": "Retention › Events",
    "owner": ""
  },
  {
    "id": "n14",
    "text": "Mid-year President’s Club",
    "category": "Retention",
    "path": "Retention › Events",
    "owner": ""
  },
  {
    "id": "n15",
    "text": "Legacy Club",
    "category": "Retention",
    "path": "Retention › Events",
    "owner": ""
  },
  {
    "id": "n16",
    "text": "Spring Fling",
    "category": "Retention",
    "path": "Retention › Events",
    "owner": ""
  },
  {
    "id": "n17",
    "text": "Christmas Party",
    "category": "Retention",
    "path": "Retention › Events",
    "owner": ""
  },
  {
    "id": "n19",
    "text": "Reviews",
    "category": "Marketing",
    "path": "Marketing",
    "owner": ""
  },
  {
    "id": "n1a",
    "text": "Social media",
    "category": "Marketing",
    "path": "Marketing",
    "owner": ""
  },
  {
    "id": "n1c",
    "text": "Office meetings",
    "category": "Meetings",
    "path": "Meetings",
    "owner": ""
  },
  {
    "id": "n1d",
    "text": "Annual meetings",
    "category": "Meetings",
    "path": "Meetings",
    "owner": ""
  },
  {
    "id": "n1e",
    "text": "Monthly speakers",
    "category": "Meetings",
    "path": "Meetings",
    "owner": ""
  },
  {
    "id": "n1f",
    "text": "Relocation",
    "category": "Relocation",
    "path": "Relocation",
    "owner": ""
  },
  {
    "id": "n21",
    "text": "New updates",
    "category": "Strategy",
    "path": "Strategy",
    "owner": ""
  },
  {
    "id": "n22",
    "text": "LeadingRE",
    "category": "Strategy",
    "path": "Strategy",
    "owner": ""
  },
  {
    "id": "n23",
    "text": "Brainstormers",
    "category": "Strategy",
    "path": "Strategy",
    "owner": ""
  },
  {
    "id": "n24",
    "text": "Tampa Palms",
    "category": "Strategy",
    "path": "Strategy",
    "owner": ""
  },
  {
    "id": "n25",
    "text": "New tools",
    "category": "Strategy",
    "path": "Strategy",
    "owner": ""
  },
  {
    "id": "n27",
    "text": "Chamber",
    "category": "Public Relations",
    "path": "Public Relations",
    "owner": ""
  },
  {
    "id": "n28",
    "text": "Cities",
    "category": "Public Relations",
    "path": "Public Relations",
    "owner": ""
  },
  {
    "id": "n29",
    "text": "Florida Realtors",
    "category": "Public Relations",
    "path": "Public Relations",
    "owner": ""
  },
  {
    "id": "n2a",
    "text": "Local Associations",
    "category": "Public Relations",
    "path": "Public Relations",
    "owner": ""
  },
  {
    "id": "n2b",
    "text": "MLSs",
    "category": "Public Relations",
    "path": "Public Relations",
    "owner": ""
  },
  {
    "id": "n2d",
    "text": "Agent business planning",
    "category": "Agent Support and Coaching",
    "path": "Agent Support and Coaching",
    "owner": ""
  },
  {
    "id": "n2e",
    "text": "Marketing support for general image",
    "category": "Agent Support and Coaching",
    "path": "Agent Support and Coaching",
    "owner": ""
  },
  {
    "id": "n2f",
    "text": "Help putting listing paperwork together",
    "category": "Agent Support and Coaching",
    "path": "Agent Support and Coaching",
    "owner": ""
  },
  {
    "id": "n30",
    "text": "Help marketing a listing",
    "category": "Agent Support and Coaching",
    "path": "Agent Support and Coaching",
    "owner": ""
  },
  {
    "id": "n31",
    "text": "Help putting a contract together",
    "category": "Agent Support and Coaching",
    "path": "Agent Support and Coaching",
    "owner": ""
  },
  {
    "id": "n32",
    "text": "Deal doctoring",
    "category": "Agent Support and Coaching",
    "path": "Agent Support and Coaching",
    "owner": ""
  }
];

async function main(){
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of ITEMS){
      await client.query(
        "INSERT INTO rating_items (id, text, category, path, owner) " +
        "VALUES ($1,$2,$3,$4,$5) " +
        "ON CONFLICT (id) DO UPDATE SET text=$2, category=$3, path=$4, owner=$5",
        [it.id, it.text, it.category || "", it.path || "", it.owner || ""]
      );
    }
    await client.query("COMMIT");
    console.log("Seeded", ITEMS.length, "items.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
```

### public/index.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Manager Retreat — Task Priority Rating</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --blue:#0089B7;
    --blue-deep:#046488;
    --gray:#BBC4D6;
    --pink:#D6326A;
    --yellow:#F7DC40;
    --ink:#172433;
    --ink-soft:#586B7D;
    --paper:#FBFCFD;
    --line:#DFE5EC;
    --card:#FFFFFF;
    --danger:#B4275A;
    --good:#1E8A5F;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ink:#EAF0F5; --ink-soft:#93A5B8; --paper:#0D1420; --line:#223040; --card:#121B27; --gray:#3B4A5C;
    }
  }
  :root[data-theme="dark"]{
    --ink:#EAF0F5; --ink-soft:#93A5B8; --paper:#0D1420; --line:#223040; --card:#121B27; --gray:#3B4A5C;
  }
  *{box-sizing:border-box;}
  html,body{height:100%;}
  html{scroll-padding-top:env(safe-area-inset-top,0px);}
  body{
    margin:0;
    background:var(--paper);
    color:var(--ink);
    font-family:'IBM Plex Sans',system-ui,-apple-system,Segoe UI,sans-serif;
    padding-top:env(safe-area-inset-top,0px);
    padding-bottom:env(safe-area-inset-bottom,0px);
    -webkit-font-smoothing:antialiased;
  }
  #app{max-width:720px;margin:0 auto;padding:32px 20px 100px;}
  h1{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:1.7rem;line-height:1.2;margin:0 0 8px;letter-spacing:-.01em;}
  h2{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:1.3rem;margin:0 0 6px;}
  p.lede{color:var(--ink-soft);font-size:.95rem;line-height:1.55;margin:0 0 22px;max-width:56ch;}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:26px;padding-bottom:2px;}
  .tab{border:none;background:none;cursor:pointer;font-size:.86rem;font-weight:500;color:var(--ink-soft);padding:9px 12px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;white-space:nowrap;}
  .tab.active{color:var(--blue-deep);border-bottom-color:var(--blue);background:rgba(0,137,183,.06);}
  .tab .tab-check{margin-left:5px;color:var(--good);}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;}
  .progress-wrap{margin-bottom:20px;}
  .progress-track{height:6px;background:var(--line);border-radius:99px;overflow:hidden;}
  .progress-fill{height:100%;background:linear-gradient(90deg,var(--pink),var(--yellow));border-radius:99px;transition:width .25s;}
  .progress-label{font-size:.8rem;color:var(--ink-soft);margin-top:7px;}
  .item-path{font-size:.78rem;color:var(--ink-soft);margin-bottom:4px;}
  .item-text{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:1.35rem;line-height:1.3;margin:0 0 22px;}
  .scale-row{display:flex;gap:10px;flex-wrap:wrap;}
  .scale-btn{flex:1;min-width:52px;border:1.5px solid var(--line);background:var(--paper);color:var(--ink);border-radius:10px;padding:14px 8px;font-size:1.15rem;font-weight:600;cursor:pointer;transition:border-color .12s, background .12s, transform .08s;}
  .scale-btn:hover{border-color:var(--blue);}
  .scale-btn:active{transform:scale(.97);}
  .scale-caption{display:flex;justify-content:space-between;font-size:.74rem;color:var(--ink-soft);margin-top:8px;}
  .nav-row{display:flex;justify-content:space-between;align-items:center;margin-top:24px;}
  .ghost-btn{border:none;background:none;cursor:pointer;color:var(--ink-soft);font-size:.85rem;padding:8px 4px;}
  .ghost-btn:hover{color:var(--ink);}
  .ghost-btn:disabled{opacity:.35;cursor:not-allowed;}
  .done-state{text-align:center;padding:20px 10px;}
  .done-check{width:52px;height:52px;border-radius:50%;background:rgba(30,138,95,.12);color:var(--good);display:flex;align-items:center;justify-content:center;font-size:1.6rem;margin:0 auto 16px;}
  .compare-item{border:1.5px solid var(--line);border-radius:12px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;}
  .compare-item-text{flex:1;font-size:1rem;line-height:1.4;}
  .compare-item-path{font-size:.74rem;color:var(--ink-soft);display:block;margin-bottom:2px;}
  .pick-btn{border:1.5px solid var(--line);background:var(--paper);border-radius:8px;padding:8px 12px;font-size:.8rem;font-weight:600;cursor:pointer;color:var(--ink-soft);flex:none;}
  .pick-btn.best{color:var(--good);}
  .pick-btn.best.selected{background:rgba(30,138,95,.12);border-color:var(--good);}
  .pick-btn.worst{color:var(--danger);}
  .pick-btn.worst.selected{background:rgba(180,39,90,.12);border-color:var(--danger);}
  .pick-hint{font-size:.82rem;color:var(--ink-soft);margin-bottom:4px;}
  .primary-btn{border:none;cursor:pointer;font-weight:600;font-size:.92rem;color:#fff;padding:11px 22px;border-radius:99px;background:linear-gradient(90deg,var(--pink),var(--yellow));box-shadow:0 1px 2px rgba(0,0,0,.12);}
  .primary-btn:disabled{opacity:.4;cursor:not-allowed;}
  .waiting{text-align:center;color:var(--ink-soft);padding:60px 20px;font-size:.95rem;}
  .admin-bar{border:1px dashed var(--blue);border-radius:12px;padding:14px 16px;margin-bottom:24px;font-size:.84rem;}
  .admin-title{font-weight:600;color:var(--blue-deep);margin-bottom:10px;display:flex;align-items:center;gap:6px;}
  .admin-grid{display:flex;flex-wrap:wrap;gap:8px;}
  .admin-chip{border:1px solid var(--line);border-radius:99px;padding:6px 12px;font-size:.78rem;display:flex;align-items:center;gap:8px;background:var(--paper);}
  .admin-chip button{border:none;background:none;cursor:pointer;font-size:.78rem;font-weight:600;padding:2px 6px;border-radius:6px;}
  .admin-chip button.open{color:var(--good);}
  .admin-chip button.close{color:var(--danger);}
  .admin-count{color:var(--ink-soft);}
  table.results-table{width:100%;border-collapse:collapse;font-size:.82rem;margin-top:14px;}
  table.results-table th, table.results-table td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);}
  table.results-table th{cursor:pointer;color:var(--ink-soft);font-weight:600;font-size:.74rem;user-select:none;white-space:nowrap;}
  table.results-table th:hover{color:var(--blue-deep);}
  table.results-table td.num{font-variant-numeric:tabular-nums;}
  .chart-select{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px;}
  .chart-select button{border:1px solid var(--line);background:var(--paper);color:var(--ink-soft);border-radius:99px;padding:7px 14px;font-size:.78rem;font-weight:500;cursor:pointer;}
  .chart-select button.active{background:var(--blue);border-color:var(--blue);color:#fff;}
  .scroll-x{overflow-x:auto;}
  .quad-label{font-size:.68rem;fill:var(--ink-soft);}
  .quad-point{fill:var(--blue);stroke:var(--card);stroke-width:1.5;}
  .quad-point:hover{fill:var(--pink);}
  .axis-line{stroke:var(--line);stroke-width:1;}
  .mid-line{stroke:var(--gray);stroke-width:1;stroke-dasharray:3,3;}
  .footer-link{text-align:center;margin-top:40px;}
  .footer-link button{border:none;background:none;color:var(--ink-soft);font-size:.76rem;cursor:pointer;text-decoration:underline;}
  ::selection{background:rgba(0,137,183,.25);}
</style>
</head>
<body>
<div id="app"></div>
<script src="/app.js"></script>
</body>
</html>
```

### public/app.js

```javascript
(function(){
  "use strict";

  var appEl = document.getElementById("app");

  var items = [];
  var itemsById = {};
  var phaseState = { open_success:false, open_time:false, open_mission:false, open_revenue:false, results_open:false };
  var counts = { success:0, time:0, mission:0, revenue:0 };

  var isAdmin = false;
  var adminToken = null;

  var activeTab = null;
  var resultsData = null;
  var resultsChart = "mv_success";
  var tableSort = { key:"path", dir:"asc" };

  var ROUNDS_PER_COMPARE = 16;
  var GROUP_SIZE = 4;

  var LOCAL_KEY = "retreatRatingV1";
  var localData = null;

  var POLL_MS = 4000;

  // ---------------- helpers ----------------

  function el(tag, className, text){
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function shuffle(arr){
    for (var i = arr.length - 1; i > 0; i--){
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function loadLocalFlags(){
    try {
      var raw = window.localStorage.getItem(LOCAL_KEY);
      localData = raw ? JSON.parse(raw) : {};
    } catch (e){ localData = {}; }
    if (!localData.success) localData.success = { submitted:false, values:{}, index:0, order:null };
    if (!localData.time) localData.time = { submitted:false, values:{}, index:0, order:null };
    if (!localData.mission) localData.mission = { submitted:false, rounds:null, roundIndex:0 };
    if (!localData.revenue) localData.revenue = { submitted:false, rounds:null, roundIndex:0 };
    try { adminToken = window.localStorage.getItem("adminToken"); } catch (e){ adminToken = null; }
  }

  function saveLocal(){
    try { window.localStorage.setItem(LOCAL_KEY, JSON.stringify(localData)); } catch (e){}
  }

  function getPhaseSession(key){ return localData[key]; }

  function phaseLabel(key){
    var map = { success:"Current Success", time:"Time Spent", mission:"Mission/Vision", revenue:"Revenue" };
    return map[key] || key;
  }

  function phaseIntro(key){
    var map = {
      success: "For each task, rate how well we're currently doing it \u2014 1 is not at all, 5 is excellent.",
      time: "For each task, rate how much time it takes relative to everything else on the list \u2014 1 is very little, 5 is a great deal.",
      mission: "You'll see small groups of tasks. Pick the one that most supports our mission and vision, and the one that supports it least.",
      revenue: "You'll see small groups of tasks. Pick the one that contributes most to Company Dollar \u2014 the brokerage's retained share, short and long term, not gross sales or agent GCI \u2014 and the one that contributes least."
    };
    return map[key] || "";
  }

  function apiFetch(path, opts){
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.admin && adminToken) headers["x-admin-token"] = adminToken;
    return fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? Object.assign({ "Content-Type": "application/json" }, headers) : headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(r){
      return r.json().then(function(data){ return { ok: r.ok, status: r.status, data: data }; });
    });
  }

  // ---------------- boot ----------------

  function boot(){
    loadLocalFlags();
    render();
    refreshState().then(function(){
      if (adminToken) checkAdmin();
    });
    setInterval(refreshState, POLL_MS);
  }

  function refreshState(){
    return apiFetch("/api/state").then(function(res){
      if (!res.ok) return;
      items = res.data.items || [];
      itemsById = {};
      items.forEach(function(it){ itemsById[it.id] = it; });
      phaseState = res.data.phase || phaseState;
      counts = res.data.counts || counts;
      if (activeTab === "results") loadResults();
      render();
    }).catch(function(){});
  }

  function checkAdmin(){
    apiFetch("/api/admin/login", { method:"POST", body:{ token: adminToken } }).then(function(res){
      isAdmin = !!(res.ok && res.data.ok);
      render();
    }).catch(function(){});
  }

  function promptAdminLogin(){
    var t = window.prompt("Facilitator passcode:");
    if (!t) return;
    apiFetch("/api/admin/login", { method:"POST", body:{ token: t } }).then(function(res){
      if (res.ok && res.data.ok){
        adminToken = t;
        try { window.localStorage.setItem("adminToken", t); } catch (e){}
        isAdmin = true;
        render();
      } else {
        window.alert("Incorrect passcode.");
      }
    });
  }

  // ---------------- admin actions ----------------

  function togglePhaseOpen(key, value){
    apiFetch("/api/admin/phase", { method:"POST", admin:true, body:{ key:key, value:value } }).then(function(){
      refreshState();
    });
  }
  function toggleResults(value){ togglePhaseOpen("results", value); }

  // ---------------- submissions ----------------

  function submitScalePhase(phaseKey, sess){
    apiFetch("/api/submit/" + phaseKey, { method:"POST", body:{ values: sess.values } }).then(function(res){
      if (res.ok){
        sess.submitted = true;
        saveLocal();
      }
      render();
    }).catch(function(){ render(); });
  }

  function submitComparePhase(phaseKey, sess){
    var payload = { rounds: sess.rounds.map(function(r){ return { group:r.group, best:r.best, worst:r.worst }; }) };
    apiFetch("/api/submit/" + phaseKey, { method:"POST", body: payload }).then(function(res){
      if (res.ok){
        sess.submitted = true;
        saveLocal();
      }
      render();
    }).catch(function(){ render(); });
  }

  function loadResults(){
    apiFetch("/api/results", { admin: isAdmin }).then(function(res){
      if (res.ok) resultsData = res.data;
      render();
    }).catch(function(){});
  }

  // ---------------- rendering: shell ----------------

  function render(){
    appEl.innerHTML = "";

    appEl.appendChild(buildHeader());

    if (isAdmin) appEl.appendChild(buildAdminBar());

    var tabDefs = getOpenTabDefs();
    if (tabDefs.length === 0){
      appEl.appendChild(el("div", "waiting", "Nothing's open for rating yet. Your facilitator will open a section shortly."));
      appEl.appendChild(buildFooterLink());
      return;
    }
    if (!activeTab || !tabDefs.some(function(t){ return t.key === activeTab; })){
      activeTab = tabDefs[0].key;
    }

    appEl.appendChild(buildTabs(tabDefs));

    if (activeTab === "results"){
      if (!resultsData) loadResults();
      appEl.appendChild(buildResults());
    } else {
      appEl.appendChild(el("p", "lede", phaseIntro(activeTab)));
      if (activeTab === "success" || activeTab === "time"){
        appEl.appendChild(buildScalePhase(activeTab));
      } else {
        appEl.appendChild(buildComparePhase(activeTab));
      }
    }

    appEl.appendChild(buildFooterLink());
  }

  function buildFooterLink(){
    var wrap = el("div", "footer-link");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = isAdmin ? "Facilitator mode is on" : "Facilitator login";
    if (!isAdmin) btn.addEventListener("click", promptAdminLogin);
    wrap.appendChild(btn);
    return wrap;
  }

  function buildHeader(){
    var header = document.createElement("header");
    header.appendChild(el("h1", null, "Task Priority Rating"));
    header.appendChild(el("p", "lede", "Anonymous \u2014 your answers are combined with every manager's. Nobody sees who rated what."));
    return header;
  }

  function getOpenTabDefs(){
    var defs = [];
    if (phaseState.open_success) defs.push({ key:"success", label:"Current Success" });
    if (phaseState.open_time) defs.push({ key:"time", label:"Time Spent" });
    if (phaseState.open_mission) defs.push({ key:"mission", label:"Mission/Vision" });
    if (phaseState.open_revenue) defs.push({ key:"revenue", label:"Revenue" });
    if (phaseState.results_open) defs.push({ key:"results", label:"Results" });
    return defs;
  }

  function buildTabs(tabDefs){
    var wrap = el("div", "tabs");
    tabDefs.forEach(function(t){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tab" + (activeTab === t.key ? " active" : "");
      b.textContent = t.label;
      var sess = t.key !== "results" ? localData[t.key] : null;
      if (sess && sess.submitted){
        b.appendChild(el("span", "tab-check", "\u2713"));
      }
      b.addEventListener("click", function(){
        activeTab = t.key;
        if (t.key === "results") loadResults();
        render();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function buildAdminBar(){
    var wrap = el("div", "admin-bar");
    wrap.appendChild(el("div", "admin-title", "Facilitator controls"));
    var grid = el("div", "admin-grid");

    var phaseDefs = [
      { key:"success", label:"Current success" },
      { key:"time", label:"Time spent" },
      { key:"mission", label:"Mission/vision" },
      { key:"revenue", label:"Revenue" }
    ];
    phaseDefs.forEach(function(pd){
      var chip = el("div", "admin-chip");
      var isOpen = !!phaseState["open_" + pd.key];
      chip.appendChild(document.createTextNode(pd.label + " "));
      chip.appendChild(el("span", "admin-count", "(" + counts[pd.key] + ")"));
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = isOpen ? "close" : "open";
      btn.textContent = isOpen ? "Close" : "Open";
      btn.addEventListener("click", function(){ togglePhaseOpen(pd.key, !isOpen); });
      chip.appendChild(btn);
      grid.appendChild(chip);
    });

    var resChip = el("div", "admin-chip");
    resChip.appendChild(document.createTextNode("Results "));
    var resBtn = document.createElement("button");
    resBtn.type = "button";
    resBtn.className = phaseState.results_open ? "close" : "open";
    resBtn.textContent = phaseState.results_open ? "Hide" : "Show";
    resBtn.addEventListener("click", function(){ toggleResults(!phaseState.results_open); });
    resChip.appendChild(resBtn);
    grid.appendChild(resChip);

    wrap.appendChild(grid);
    return wrap;
  }

  // ---------------- scale phase (1-5) ----------------

  function buildScalePhase(phaseKey){
    var wrap = document.createElement("div");
    if (items.length === 0){
      wrap.appendChild(el("p", "lede", "Loading tasks\u2026"));
      return wrap;
    }
    var sess = getPhaseSession(phaseKey);
    if (sess.submitted){
      wrap.appendChild(buildDoneCard(phaseLabel(phaseKey)));
      return wrap;
    }
    if (!sess.order || !sess.order.length){
      sess.order = shuffle(items.map(function(it){ return it.id; }));
      saveLocal();
    }
    var order = sess.order.filter(function(id){ return itemsById[id]; });
    if (order.length === 0){
      wrap.appendChild(el("p", "lede", "No items to rate."));
      return wrap;
    }
    var idx = Math.min(sess.index, order.length - 1);
    var item = itemsById[order[idx]];

    var card = el("div", "card");
    card.appendChild(buildProgress(idx, order.length));
    card.appendChild(el("div", "item-path", item.path));
    card.appendChild(el("div", "item-text", item.text));

    var scaleRow = el("div", "scale-row");
    for (var v = 1; v <= 5; v++){
      (function(v){
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "scale-btn";
        btn.textContent = String(v);
        btn.addEventListener("click", function(){
          sess.values[item.id] = v;
          sess.index = idx + 1;
          saveLocal();
          if (sess.index >= order.length){
            submitScalePhase(phaseKey, sess);
          } else {
            render();
          }
        });
        scaleRow.appendChild(btn);
      })(v);
    }
    card.appendChild(scaleRow);

    var caption = el("div", "scale-caption");
    caption.appendChild(el("span", null, phaseKey === "success" ? "Not at all" : "Very little time"));
    caption.appendChild(el("span", null, phaseKey === "success" ? "Excellent" : "A great deal of time"));
    card.appendChild(caption);

    var nav = el("div", "nav-row");
    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "ghost-btn";
    backBtn.textContent = "\u2190 Back";
    backBtn.disabled = idx === 0;
    backBtn.addEventListener("click", function(){ sess.index = Math.max(0, idx - 1); saveLocal(); render(); });
    nav.appendChild(backBtn);
    card.appendChild(nav);

    wrap.appendChild(card);
    return wrap;
  }

  function buildProgress(idx, total){
    var wrap = el("div", "progress-wrap");
    var track = el("div", "progress-track");
    var fill = el("div", "progress-fill");
    fill.style.width = Math.round((idx / total) * 100) + "%";
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.appendChild(el("div", "progress-label", (idx + 1) + " of " + total));
    return wrap;
  }

  function buildDoneCard(label){
    var card = el("div", "card done-state");
    card.appendChild(el("div", "done-check", "\u2713"));
    card.appendChild(el("h2", null, "Thanks \u2014 you're done with " + label + "."));
    card.appendChild(el("p", "lede", "Your answers are in. Switch tabs if another section is open."));
    return card;
  }

  // ---------------- compare phase (best-worst) ----------------

  function generateRounds(itemList, roundsNeeded, groupSize){
    var rounds = [];
    var pool = [];
    var guard = 0;
    while (rounds.length < roundsNeeded && guard < 500){
      guard++;
      if (pool.length < groupSize) pool = pool.concat(shuffle(itemList.slice()));
      var group = pool.splice(0, groupSize).map(function(it){ return it.id; });
      if (group.length === groupSize) rounds.push({ group:group, best:null, worst:null });
    }
    return rounds;
  }

  function buildComparePhase(phaseKey){
    var wrap = document.createElement("div");
    if (items.length === 0){
      wrap.appendChild(el("p", "lede", "Loading tasks\u2026"));
      return wrap;
    }
    var groupSize = Math.min(GROUP_SIZE, items.length);
    if (items.length < 2){
      wrap.appendChild(el("p", "lede", "Need at least two items to compare."));
      return wrap;
    }
    var sess = getPhaseSession(phaseKey);
    if (sess.submitted){
      wrap.appendChild(buildDoneCard(phaseLabel(phaseKey)));
      return wrap;
    }
    if (!sess.rounds || !sess.rounds.length){
      sess.rounds = generateRounds(items, ROUNDS_PER_COMPARE, groupSize);
      sess.roundIndex = 0;
      saveLocal();
    }
    var idx = Math.min(sess.roundIndex, sess.rounds.length - 1);
    var round = sess.rounds[idx];

    var card = el("div", "card");
    card.appendChild(buildProgress(idx, sess.rounds.length));
    card.appendChild(el("div", "pick-hint", "Tap \u201cMost\u201d for one, \u201cLeast\u201d for one."));

    round.group.forEach(function(itemId){
      var it = itemsById[itemId];
      if (!it) return;
      var row = el("div", "compare-item");

      var textWrap = el("div", "compare-item-text");
      textWrap.appendChild(el("span", "compare-item-path", it.path));
      textWrap.appendChild(document.createTextNode(it.text));
      row.appendChild(textWrap);

      var bestBtn = document.createElement("button");
      bestBtn.type = "button";
      bestBtn.className = "pick-btn best" + (round.best === itemId ? " selected" : "");
      bestBtn.textContent = "Most";
      bestBtn.addEventListener("click", function(){
        round.best = (round.best === itemId) ? null : itemId;
        if (round.worst === itemId) round.worst = null;
        saveLocal();
        render();
      });
      row.appendChild(bestBtn);

      var worstBtn = document.createElement("button");
      worstBtn.type = "button";
      worstBtn.className = "pick-btn worst" + (round.worst === itemId ? " selected" : "");
      worstBtn.textContent = "Least";
      worstBtn.addEventListener("click", function(){
        round.worst = (round.worst === itemId) ? null : itemId;
        if (round.best === itemId) round.best = null;
        saveLocal();
        render();
      });
      row.appendChild(worstBtn);

      card.appendChild(row);
    });

    var nav = el("div", "nav-row");
    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "ghost-btn";
    backBtn.textContent = "\u2190 Back";
    backBtn.disabled = idx === 0;
    backBtn.addEventListener("click", function(){ sess.roundIndex = Math.max(0, idx - 1); saveLocal(); render(); });
    nav.appendChild(backBtn);

    var nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "primary-btn";
    nextBtn.textContent = (idx === sess.rounds.length - 1) ? "Finish" : "Next \u2192";
    nextBtn.disabled = !(round.best && round.worst);
    nextBtn.addEventListener("click", function(){
      sess.roundIndex = idx + 1;
      saveLocal();
      if (sess.roundIndex >= sess.rounds.length){
        submitComparePhase(phaseKey, sess);
      } else {
        render();
      }
    });
    nav.appendChild(nextBtn);
    card.appendChild(nav);

    wrap.appendChild(card);
    return wrap;
  }

  // ---------------- results ----------------

  var CHART_CONFIGS = [
    { key:"mv_success", label:"Mission \u00d7 Success", xKey:"missionScore", yKey:"success", xLabel:"Mission/vision importance", yLabel:"Current success", kind:"success" },
    { key:"mv_time", label:"Mission \u00d7 Time", xKey:"missionScore", yKey:"time", xLabel:"Mission/vision importance", yLabel:"Time spent", kind:"time" },
    { key:"rev_success", label:"Revenue \u00d7 Success", xKey:"revenueScore", yKey:"success", xLabel:"Revenue importance (Company Dollar)", yLabel:"Current success", kind:"success" },
    { key:"rev_time", label:"Revenue \u00d7 Time", xKey:"revenueScore", yKey:"time", xLabel:"Revenue importance (Company Dollar)", yLabel:"Time spent", kind:"time" },
    { key:"mv_rev", label:"Mission \u00d7 Revenue", xKey:"missionScore", yKey:"revenueScore", xLabel:"Mission/vision importance", yLabel:"Revenue importance (Company Dollar)", kind:"combo" }
  ];

  function buildResults(){
    var wrap = document.createElement("div");

    if (!resultsData){
      wrap.appendChild(el("p", "lede", "Loading results\u2026"));
      return wrap;
    }
    var scoreList = resultsData.scores || [];
    var c = resultsData.counts || counts;

    wrap.appendChild(el("p", "lede",
      "Submissions so far \u2014 Success: " + c.success + ", Time: " + c.time +
      ", Mission/vision: " + c.mission + ", Revenue: " + c.revenue + "."));

    var selectRow = el("div", "chart-select");
    CHART_CONFIGS.forEach(function(cfg){
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = cfg.label;
      b.className = (resultsChart === cfg.key) ? "active" : "";
      b.addEventListener("click", function(){ resultsChart = cfg.key; render(); });
      selectRow.appendChild(b);
    });
    wrap.appendChild(selectRow);

    var cfg = CHART_CONFIGS.filter(function(cc){ return cc.key === resultsChart; })[0] || CHART_CONFIGS[0];

    var chartCard = el("div", "card scroll-x");
    chartCard.appendChild(renderQuadrantChart(scoreList, cfg));
    wrap.appendChild(chartCard);

    wrap.appendChild(renderResultsTable(scoreList));
    wrap.appendChild(buildDisagreement(scoreList));

    return wrap;
  }

  function buildDisagreement(scoreList){
    var wrap = el("div", "card");
    wrap.style.marginTop = "18px";
    wrap.appendChild(el("h2", null, "Biggest splits"));
    wrap.appendChild(el("p", "lede", "Where managers disagreed most \u2014 worth raising directly in the discussion. Needs at least 3 responses on an item to show up here."));

    var sections = [
      {
        title: "Current success",
        items: scoreList.filter(function(s){ return s.successN >= 3; })
          .sort(function(a, b){ return (b.successRawRange || 0) - (a.successRawRange || 0); }).slice(0, 5),
        render: function(s){ return "ranged " + s.successRawMin + "\u2013" + s.successRawMax + " (n=" + s.successN + ")"; }
      },
      {
        title: "Time spent",
        items: scoreList.filter(function(s){ return s.timeN >= 3; })
          .sort(function(a, b){ return (b.timeRawRange || 0) - (a.timeRawRange || 0); }).slice(0, 5),
        render: function(s){ return "ranged " + s.timeRawMin + "\u2013" + s.timeRawMax + " (n=" + s.timeN + ")"; }
      },
      {
        title: "Mission/vision",
        items: scoreList.filter(function(s){ return s.missionShown >= 3; })
          .sort(function(a, b){ return (b.missionContested || 0) - (a.missionContested || 0); }).slice(0, 5),
        render: function(s){ return "picked most " + s.missionBest + "\u00d7, least " + s.missionWorst + "\u00d7 (seen " + s.missionShown + "\u00d7)"; }
      },
      {
        title: "Revenue",
        items: scoreList.filter(function(s){ return s.revenueShown >= 3; })
          .sort(function(a, b){ return (b.revenueContested || 0) - (a.revenueContested || 0); }).slice(0, 5),
        render: function(s){ return "picked most " + s.revenueBest + "\u00d7, least " + s.revenueWorst + "\u00d7 (seen " + s.revenueShown + "\u00d7)"; }
      }
    ];

    sections.forEach(function(sec){
      var subTitle = el("div", null, sec.title);
      subTitle.style.fontWeight = "600";
      subTitle.style.fontSize = ".82rem";
      subTitle.style.color = "var(--blue-deep)";
      subTitle.style.margin = "16px 0 6px";
      wrap.appendChild(subTitle);
      if (sec.items.length === 0){
        wrap.appendChild(el("div", "lede", "Not enough data yet."));
        return;
      }
      sec.items.forEach(function(s){
        var row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.gap = "12px";
        row.style.padding = "6px 0";
        row.style.borderBottom = "1px solid var(--line)";
        row.style.fontSize = ".85rem";
        var left = document.createElement("span");
        left.textContent = s.text;
        var right = document.createElement("span");
        right.style.color = "var(--ink-soft)";
        right.style.flex = "none";
        right.textContent = sec.render(s);
        row.appendChild(left);
        row.appendChild(right);
        wrap.appendChild(row);
      });
    });

    return wrap;
  }

  function quadrantLabels(kind){
    if (kind === "success"){
      return { hh:"On track", lh:"Doing well, lower priority", hl:"Fix first", ll:"Low priority" };
    }
    if (kind === "time"){
      return { hh:"Worth the investment", lh:"Time sink \u2014 reduce", hl:"Underinvested", ll:"Low priority, low time" };
    }
    return { hh:"Core priorities", lh:"Revenue driver, low mission fit", hl:"Mission-critical, not revenue", ll:"Cut or automate" };
  }

  function addSvgText(svg, x, y, str, anchor, transform){
    var t = document.createElementNS(svg.namespaceURI, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("text-anchor", anchor || "start");
    if (transform) t.setAttribute("transform", transform);
    t.setAttribute("class", "quad-label");
    t.textContent = str;
    svg.appendChild(t);
  }

  function renderQuadrantChart(scoreList, cfg){
    var w = 640, h = 420, pad = 46;
    var pts = scoreList.filter(function(s){ return s[cfg.xKey] != null && s[cfg.yKey] != null; });

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("width", "100%");
    svg.style.minWidth = "560px";
    svg.style.display = "block";

    function sx(v){ return pad + (v - 1) / 4 * (w - 2 * pad); }
    function sy(v){ return h - pad - (v - 1) / 4 * (h - 2 * pad); }

    var rect = document.createElementNS(svg.namespaceURI, "rect");
    rect.setAttribute("x", pad); rect.setAttribute("y", pad);
    rect.setAttribute("width", w - 2 * pad); rect.setAttribute("height", h - 2 * pad);
    rect.setAttribute("fill", "none"); rect.setAttribute("class", "axis-line");
    svg.appendChild(rect);

    var vline = document.createElementNS(svg.namespaceURI, "line");
    vline.setAttribute("x1", sx(3)); vline.setAttribute("x2", sx(3));
    vline.setAttribute("y1", pad); vline.setAttribute("y2", h - pad);
    vline.setAttribute("class", "mid-line");
    svg.appendChild(vline);

    var hline = document.createElementNS(svg.namespaceURI, "line");
    hline.setAttribute("y1", sy(3)); hline.setAttribute("y2", sy(3));
    hline.setAttribute("x1", pad); hline.setAttribute("x2", w - pad);
    hline.setAttribute("class", "mid-line");
    svg.appendChild(hline);

    addSvgText(svg, w / 2, h - 10, cfg.xLabel, "middle");
    addSvgText(svg, 14, h / 2, cfg.yLabel, "middle", "rotate(-90 14 " + (h / 2) + ")");

    var ql = quadrantLabels(cfg.kind);
    addSvgText(svg, sx(4.5), sy(4.5) - 6, ql.hh, "end");
    addSvgText(svg, sx(1.5), sy(4.5) - 6, ql.lh, "start");
    addSvgText(svg, sx(4.5), sy(1.5) + 16, ql.hl, "end");
    addSvgText(svg, sx(1.5), sy(1.5) + 16, ql.ll, "start");

    pts.forEach(function(p){
      var c = document.createElementNS(svg.namespaceURI, "circle");
      c.setAttribute("cx", sx(p[cfg.xKey]));
      c.setAttribute("cy", sy(p[cfg.yKey]));
      c.setAttribute("r", 5);
      c.setAttribute("class", "quad-point");
      var title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = p.text + " (" + p[cfg.xKey].toFixed(1) + ", " + p[cfg.yKey].toFixed(1) + ")";
      c.appendChild(title);
      svg.appendChild(c);
    });

    if (pts.length === 0){
      addSvgText(svg, w / 2, h / 2, "No data yet for this pair.", "middle");
    }

    return svg;
  }

  function renderResultsTable(scoreList){
    var wrap = el("div", "card scroll-x");
    wrap.style.marginTop = "18px";
    wrap.appendChild(el("h2", null, "All items"));

    var cols = [
      { key:"path", label:"Category" },
      { key:"text", label:"Task" },
      { key:"owner", label:"Owner" },
      { key:"missionScore", label:"Mission" },
      { key:"revenueScore", label:"Revenue" },
      { key:"success", label:"Success" },
      { key:"time", label:"Time" }
    ];

    var sorted = scoreList.slice().sort(function(a, b){
      var av = a[tableSort.key], bv = b[tableSort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string"){ av = av.toLowerCase(); bv = (bv || "").toLowerCase(); }
      if (av < bv) return tableSort.dir === "asc" ? -1 : 1;
      if (av > bv) return tableSort.dir === "asc" ? 1 : -1;
      return 0;
    });

    var table = document.createElement("table");
    table.className = "results-table";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    cols.forEach(function(c){
      var th = document.createElement("th");
      th.textContent = c.label + (tableSort.key === c.key ? (tableSort.dir === "asc" ? " \u2191" : " \u2193") : "");
      th.addEventListener("click", function(){
        if (tableSort.key === c.key) tableSort.dir = tableSort.dir === "asc" ? "desc" : "asc";
        else { tableSort.key = c.key; tableSort.dir = "desc"; }
        render();
      });
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    sorted.forEach(function(row){
      var tr = document.createElement("tr");
      cols.forEach(function(c){
        var td = document.createElement("td");
        var v = row[c.key];
        if (c.key === "path" || c.key === "text" || c.key === "owner"){
          td.textContent = v || (c.key === "owner" ? "\u2014" : "");
        } else {
          td.className = "num";
          td.textContent = (v == null) ? "\u2014" : v.toFixed(1);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  boot();
})();
```
