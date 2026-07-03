# Implementation Brief: Online Presence Audit Tool

## Goal

Add an "Online Presence Audit" feature to our existing JS backend / HTML frontend that scores a real estate agent's online presence via the Claude API, stores the result, and (once enough data exists) shows how that agent compares to a global benchmark, our company average, their office average, and their own history.

## Reference files (load these into context before building)

- `adams_cameron_online_presence_audit_prompt.md` — Stage 1 prompt: does the actual research and scoring
- `presence_audit_comparison_prompt.md` — Stage 2 prompt: writes the comparative narrative from numbers we hand it
- `presence_audit_schema.sql` — Postgres table, view, and the four benchmark queries

## Architecture: two separate Claude API calls, not one conversation

**Stage 1 — Score.** Call the Claude API with the audit prompt and the agent's identifying info already filled in (name, city/state, brokerage, mode). This call needs the web_search tool enabled, since it has to actually look the agent up — without it, Claude will have nothing real to score against. The response includes a markdown report plus a fenced JSON block with the category scores; parse the JSON block out and store it.

**Between calls — Store and aggregate.** Insert the parsed scores as a row in `presence_audit_results`. Then run the four benchmark queries from the schema file: global average + p90 per category, company average, office average (if internal agent), and this agent's own run history.

**Stage 2 — Compare.** Call Claude again with the comparison prompt, passing in this agent's scores plus the benchmark numbers from the previous step as plain values. No web search needed on this call — it's pure narrative generation from numbers we already have.

Important: since this runs unattended from the backend, not in an interactive chat, give the model everything it needs in the first message (agent name, city, state, brokerage, mode) rather than letting the prompt's "wait for the user's answer" language apply — that's written for a human typing in chat, not an API call.

## New backend endpoints

- `POST /api/audits/run` — body: `{ agentId }` for internal agents, or `{ externalName, externalBrokerage, externalCity }` for external. Runs Stage 1, stores the row, runs Stage 2 once enough benchmark data exists, returns the full report.
- `GET /api/audits/:agentId/history` — past runs for one agent, for the trend view. Internal agents only — external audits are one-off reports and have no history to show.
- `GET /api/audits/:id` — a single stored report.

Roster-mode (bulk run across many agents) and the rollup view can wait for a later phase — see below.

## Claude API specifics to get right

- Stage 1 call must include `tools: [{ "type": "web_search_20250305", "name": "web_search" }]`. Stage 2 call does not need it.
- Confirm current model name/pricing at the time of building — check docs.claude.com rather than hardcoding an assumption, since model availability changes.
- Web search has its own per-search cost on top of normal token cost. Worth logging cost per audit from day one so this doesn't surprise anyone once it's running at volume.
- Parsing: pull the fenced ```json block out of the Stage 1 response text and `JSON.parse` it inside a try/catch. If parsing fails, store the raw response for manual review instead of silently dropping the run.

## Phased rollout

1. **Phase 1:** Single-agent mode, Stage 1 only. Store scores, show the report card. No comparison yet — there's nothing to compare against with a handful of runs.
2. **Phase 2:** Once you've got roughly 20-30 runs in the table, turn on Stage 2 and surface the benchmark comparison in the UI.
3. **Phase 3:** Roster mode for bulk-running across the team, plus the rollup/ranking view.
4. **Phase 4 (decide deliberately, don't default into it):** Running this on agents at other brokerages for recruiting. These are one-off reports — no need to re-identify or re-match an external agent across runs, and no history view for them. Each run just adds one row that feeds the global benchmark pool. Worth a quiet internal rule on who can see the individual external reports versus only the aggregated benchmark stats, since these are real people being scored without having asked for it.

## Things to flag for whoever builds this

- **Run time:** a real audit involves several actual web searches and will take noticeably longer than a typical request — build it as an async job (queue + polling or webhook), not something the frontend sits and waits on synchronously.
- **"Not found" is a valid result, not an error.** Make sure a missing profile on some platform is distinguished from an actual API/network failure in error handling.
- **Decide whether to store the full narrative text** or regenerate the Stage 2 call every time someone views a report. Storing it is cheaper and faster; regenerating it lets you update the comparison if more data has accumulated since the run.
- **Add a simple cap** on audits per day, so a bug or a loop doesn't quietly rack up search costs.
