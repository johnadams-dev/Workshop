# Review engine — planning doc

For handoff into the existing codebase. Companion file: `review-engine-schema.sql`.

## Current baseline (from June 2026 data)

- ~1,000 closings/year, 3–8% leave a review (roughly matches the monthly totals: mostly 3–8 reviews against ~83 closings/month)
- Reviews skew almost entirely positive already (negative/neutral are rare in the data) — this is not a gating problem, it's a volume problem
- Cadence: day 1, day 3, day 8 — three touches, no SMS live yet (Twilio blocked separately)
- Target: 15%+ review rate (~150/year), with some competitors reportedly at 65%
- Current tracking exists but isn't surfaced well enough to see which message/step/platform is working — that's the gap this plan closes

## Sending mechanism: a small standalone service

Decoupling tracking from the sender is still the core fix (see below), but on reflection a separate small Node service — rather than folding this into `server.js` — is the better call, volume aside:

- **Scheduling doesn't belong in the main request-handling server.** The day 1/3/8 logic needs something running on a timer (cron-style), independent of whether Daily Desk's main server is busy serving requests. Cleaner as its own process.
- **Independent deploy cadence.** Iterating on templates and A/B tests shouldn't require redeploying core Daily Desk.
- **Still one repo, shared code.** It can live alongside Daily Desk in the same GitHub repo and reuse the existing DB connection module as a shared package — no duplication, no new infra to stand up.

Send provider itself is still swappable and worth deciding separately from the service question: Google Workspace (reusing the cooperating-agent thank-you's auth) is the simplest default at this volume, recorded in `review_requests.send_provider` so it's not hard-coded into the schema if that changes later.

## Decouple tracking from the sender

This is the actual fix for "if we change the message we lose tracking." The problem isn't the CRM partner's tool specifically — it's that tracking currently lives *inside* whichever tool sends the email. Own the tracking layer independently (the `request_events` table + redirect links in the schema), and treat the send mechanism as swappable underneath it. Whatever sends the email just needs to render a template and use the tracked redirect links instead of raw platform URLs — the funnel data ends up in your own DB regardless of sender.

Open tracking (pixel-based) is out of scope for now — agreed as a fair tradeoff given how unreliable pixels are in Gmail/Outlook previews. Click-through is the more trustworthy signal at this volume, and the schema still has an `open` event type available if that's worth revisiting later.

## Architecture (see diagram)

1. **Daily Desk closing** → `transaction_events` (`closed`) expands into one or two `review_recipients` (buyer/seller), anchored on entry time, not close_date
2. **Review engine** → schedules the day 1/3/8 touches into the business-hours window, assigns A/B variant per active test
3. **Tracked send** → every platform link is a first-party redirect (`reviews.adamscameron.com/r/{request_id}/{platform}`) that logs the click, then 302s to the real Google/Facebook/Zillow URL
4. **Review platform** → customer lands on Google Business Profile / Facebook / Zillow
5. **Reporting dashboard** → aggregates sent → clicked → reviewed, by step, agent, and variant

The reply/feedback option sits alongside the platform links at every step — same links for everyone, no gating — and routes to the agent, satisfying the "give them an out" goal without touching what any individual customer sees based on sentiment.

## Reporting layer (the middle layer you're missing)

Three views in the schema do the heavy lifting:

- `v_recipient_funnel` — per-recipient status: sent, clicked, which platform(s), reviewed y/n
- `v_monthly_funnel` — the number you check today (reviews/month), plus the funnel stages that explain *why* it's low: is it a click problem, or a click-to-review problem?
- `v_variant_performance` — review rate by A/B variant, so a test result is a query, not a manual pull

Suggested cadence: **weekly** automated summary (even a simple emailed report from these views) instead of the current monthly manual check. At your volume, weekly is frequent enough to catch a broken link or a bad send fast, without over-reacting to daily noise.

## A/B testing plan

At ~83 closings/month, don't run more than one test variable at a time — splitting further than that makes it hard to get a clean read within a reasonable window. Suggested order:

1. **From-name framing** (day 1 email): "from" the agent vs. from the brokerage. This is the highest-hypothesis-value test given the agent-relationship theory — run it first.
2. **Day 1 send delay**: same-day vs. next-day. Closing day is paperwork-heavy; a next-day send might land better.
3. **Subject line variants** on day 1 (the one most people will see).
4. **Day 8 content**: last touch is a good place to test a shorter, more direct ask vs. the current framing.

Run each for a full month minimum (~80+ sends) before reading results, and let `v_variant_performance` be the source of truth rather than eyeballing counts.

## Platform links (current)

- Google: `https://business.google.com/reviews?hl=en` (you already have GBP API access — use it to poll for new reviews and match to transactions by name/timing, once the domain-auth issue is sorted)
- Facebook: `https://www.facebook.com/adamscameron/reviews/?id=100042181485552&sk=reviews` (no reliable API path for confirmation — plan on `match_method = 'manual'` here)
- Zillow: `https://www.zillow.com/profile/AdamsCameronandCo#reviews` (Zillow API already in place — same polling approach as Google)

## Explicitly out of scope for this pass

- Twilio/A2P 10DLC fix — tracked separately, but the schema already has `channel` as `email | sms` so texting slots in without a redesign once it's unblocked
- GBP domain-auth fix — separate, doesn't block building the engine itself

## Settled

- **Trigger, confirmed**: `transaction_events` where `event_type = 'closed'` and `close_date` is populated. (Sample data only shows 25 closed events, presumably a partial/dev dataset — worth a sanity check against the real count once this is pointed at production.)
- **Agent attribution, confirmed**: `transaction_participants.role` is `'listing_agent'` (seller side), `'buyers_agent'` (buyer side), or the rare `'co_listing_agent'` (seller side, second agent — 3 rows total, not worth special-casing yet). `is_acc_agent = true` marks an internal Adams Cameron agent (agent_id populated); `false` is an external/FSBO participant on the other side of the deal. Since a review recipient only exists for sides Adams Cameron represents, the matching participant row is always the internal one.
- Recipients aren't 1:1 with transactions: dual agency produces two independent review recipients, each with their own sequence.
- **Sending, clarified**: the cooperating-agent thank-you isn't actually an automation pattern to reuse — you review and send those manually, by design, since you often have a direct relationship with the agent and want to adjust the message. Buyers and sellers are different: no personal relationship basis for that kind of manual review, and the whole point here is a fully automated sequence. What's reusable is narrower than "the workflow" — just the technical send path (Workspace API auth) that the manual thank-you already uses, called from the new automated scheduler instead of from your manual send action.
- The overnight jobs are mostly reporting messages, not the thing this system would replace — no direct conflict, but the send-window fix still stands on its own merits for whatever the new engine schedules.
- Open tracking: skipped in favor of click-through.
- **Send timing anchor, resolved**: the day 1/3/8 sequence counts from `review_recipients.trigger_detected_at` (`transaction_events.submitted_at` — when the closing was entered into Daily Desk), not `close_date` (when the sale actually closed). There's a real gap between the two, and closings are sometimes entered late — counting from close_date would mean a closing entered a week late starts its sequence already behind, with day 1 firing four days late. `close_date` stays on the row purely for reporting; the schema never uses it to compute send times.

## One decision needed before go-live (not before build)

`transaction_events` already has historical `closed` rows. The first time the scheduler runs, it'll see all of them as "new" unless bounded — which would fire an entire backlog of day 1/3/8 sequences at once for closings from months or years ago. Need a go-live cutoff (only process events with `submitted_at` at or after some chosen date) before flipping this on in production. Doesn't affect the schema or the build itself, just needs a decision — and a date — before the first real run.

## Open questions before build

- Nothing blocking the schema anymore — the last two unknowns (`event_type`, `role` values) are confirmed and reflected in `review-engine-schema.sql`.
- Remaining are build-detail decisions, not data-model decisions: where the redirect/tracking routes live within the new service, and how it's deployed/scheduled (its own cron, a queue, etc.) — reasonable to leave for the Claude Code session itself.
