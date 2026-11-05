# Feedback & Support System — Build Overview

## Problem

`johnadams.org` hosts a growing list of tools for Adams Cameron agents and staff
(Cameron's Lens, Contract Date Calculator, Market Update, Daily Desk, Hotsheet,
etc.), served from the `mls-proxy` Cloud Run backend. There's currently no
structured way for users to report bugs, suggest improvements, or ask process
questions — especially relevant right now, since a brokerage-wide process
redesign is underway and process questions will spike.

Google Groups was considered and set aside as the primary mechanism: it has no
structured fields (so bug/suggestion/question can't be reliably separated
without manual tagging), and it's flat (everyone in a group sees every
message, so backend-tool reports can't be cleanly scoped away from users who
don't have that tool).

## Approach: three phases

### Phase 1 — Reporting page (build first)

A single page, linked from relevant tools starting with **Daily Desk** and
**Hotsheet**, that does two things:

1. **Submit** — a simple form to post a bug, suggestion, or question
2. **Browse** — a list/feed of past submissions, searchable

No access control and no external integrations yet. Everyone who reaches the
page sees everything. That's an acceptable stopgap *if* Daily Desk and
Hotsheet have roughly the same audience; worth a quick sanity check before
launch, since anything more restricted linking in here would leak.

**Fields captured at submission (locked in for Phase 1):**
- `tool_id` — which product this is about. Auto-captured from the referring
  page/link, not user-entered, so it's reliable from day one.
- `user` — from existing Google Auth session
- `type` — Bug / Suggestion / Question
- `summary` / `description` — free text
- `created_at`, `status` (open / in progress / resolved), `id`

Capturing `tool_id` and `type` accurately now — even though Phase 1 does
nothing with them structurally — is what makes Phase 2 a filtering problem
instead of a data-migration problem.

**Deferred to a later pass, but worth designing the schema to allow:**
- Thumbs up/down voting on suggestions (needs a `votes` join table —
  submission_id, user, direction — so people can change or retract a vote,
  and so you can dedupe one vote per user per item)

### Phase 2 — Access control per product

A layer that knows, per tool, who's allowed to see and post about it —
so a user without Cameron's Lens access never sees Cameron's Lens reports,
and someone without backend access doesn't see backend-tool threads.

- Needs a `tool_id → allowed audience` mapping (could piggyback on whatever
  already gates access to the tools themselves, rather than a separate
  permissions system)
- The Phase 1 browse view starts filtering by this once it exists
- This is also the natural place to add moderation/admin controls (edit
  status, merge duplicates, close items)

### Phase 3 — Integration with external tools

Once the data model and access rules are stable, wire up automation:
- Bugs/Suggestions → GitHub Issues (labeled, routed to the right repo)
- Possibly Process Questions → a living FAQ doc or Google Group thread,
  since the same question likely applies to many people during the redesign
  and a 1:1 ticket queue is inefficient for that case
- Routing rules as data (a small config table), not hardcoded, since tool
  names and process categories are still shifting mid-redesign

## Data Model (Phase 1 baseline, built to extend)

```
feedback_submissions
- id (uuid)
- created_at (timestamp)
- tool_id (string)         -- auto-captured from referring page
- type (string)             -- "bug" | "suggestion" | "question"
- summary (string)
- description (string)
- submitted_by (string)     -- from existing Google Auth session
- status (string)           -- "open" | "in_progress" | "resolved"

-- Phase 2 addition
- visibility_tier (string)  -- derived from tool_id's access rules

-- Phase 3 addition
- routed_to (string)        -- e.g. GitHub issue URL

-- Deferred (voting)
feedback_votes
- submission_id (fk)
- user (string)
- direction (int)           -- +1 | -1
- created_at (timestamp)
```

## Where This Lives

Given your existing infra: a new route on `mls-proxy` (Cloud Run) for the
API, a BigQuery table (`mls-data-sync` project, new `feedback` dataset) for
storage — consistent with how the rest of the platform already works, so
Phase 2/3 additions are incremental rather than a new system.

## Open Questions

- Daily Desk and Hotsheet audience overlap — any gap that makes launching
  Phase 1 without access control risky?
- Phase 2: should visibility be tied to existing tool-access permissions, or
  a separate list you maintain?
