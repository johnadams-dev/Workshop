-- Review Engine Schema
-- Adams, Cameron & Co. Realtors
-- Confirmed: Postgres (matches the real transactions table — uuid PK, timestamptz)
-- Goal: turn "we checked totals once a month" into a real funnel:
--   sent -> clicked -> platform -> review confirmed
-- while keeping every touch tied back to the closing, the agent, and the A/B variant that produced it.

-- ============================================================
-- 0. EXISTING TABLES (yours — not created or altered here)
-- ============================================================
-- transactions (id uuid PK, buyer/seller name+email, represents_buyer/seller booleans, ...)
-- transaction_events (id uuid, transaction_id uuid, event_type text, close_date date,
--                      buyer_name/email, seller_name/email, submitted_by int, ...)
--   -> Closing trigger confirmed: event_type = 'closed', close_date populated.
--      buyer/seller name+email here may be more current than transactions' own fields
--      (captured at time of the event) — prefer transaction_events' values when present.
-- transaction_participants (id uuid, transaction_id uuid, agent_id int, external_name/email,
--                            role text, is_acc_agent boolean, ...)
--   -> Confirmed role values: 'listing_agent' (seller side), 'buyers_agent' (buyer side),
--      'co_listing_agent' (rare — seller side, second agent).
--   -> is_acc_agent distinguishes an internal Adams Cameron agent (agent_id populated, join to
--      agents table) from an external/FSBO participant (external_name/email/brokerage populated,
--      agent_id null). Since review_recipients only exists for sides we represent
--      (transactions.represents_buyer/represents_seller), the matching participant row for that
--      side should always be is_acc_agent = true — external rows represent the *other* side's
--      outside agent, not relevant here.
-- agents (id int PK, first_name, last_name, email, active, email_opted_in, sms_opted_in, ...)
--   -> agent_name = first_name || ' ' || last_name

-- ============================================================
-- 1. REVIEW RECIPIENTS (populated by the closing trigger — one or two rows per transaction)
-- ============================================================

CREATE TABLE review_recipients (
    recipient_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id     UUID NOT NULL REFERENCES transactions(id),
    transaction_event_id UUID NOT NULL,  -- REFERENCES transaction_events(id); which 'closed' event triggered this
    transaction_side    TEXT NOT NULL CHECK (transaction_side IN ('buyer','seller')),
    customer_name      TEXT NOT NULL,
    customer_email      TEXT,
    agent_id         INTEGER,        -- transaction_participants.agent_id for the matching internal-agent role
    agent_name        TEXT,          -- snapshotted at closing time so later name changes don't rewrite history
    office_id         INTEGER,
    close_date        DATE NOT NULL,        -- actual closing date, from transaction_events.close_date — for reporting
    trigger_detected_at  TIMESTAMPTZ NOT NULL, -- transaction_events.submitted_at — this is what scheduling anchors on
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, transaction_side)
);

CREATE INDEX idx_review_recipients_close_date ON review_recipients (close_date);
CREATE INDEX idx_review_recipients_agent ON review_recipients (agent_id);

-- Why two timestamps: close_date is when the sale actually closed; trigger_detected_at is when
-- someone entered that closing into Daily Desk. There's a real-world lag between the two, and
-- the day 1/3/8 sequence needs to count from when the system *learns* about the closing, not
-- the closing date itself — otherwise a closing entered 5 days late would have its "day 1"
-- email already 4 days overdue the moment it's created. close_date stays on the row purely for
-- reporting (funnel by actual closing month), and is never used to compute send times.
--
-- Cutover note for first deploy: on go-live, transaction_events will already contain historical
-- 'closed' rows. Only backfill review_recipients for events with submitted_at at or after a
-- chosen go-live cutoff — otherwise the first scheduler run mass-triggers day 1/3/8 sequences
-- for closings from months or years ago, all at once.

-- Population logic (in the closing-trigger job, not SQL):
--   1. Poll transaction_events for new rows where event_type = 'closed' and close_date is set
--      and not yet represented in review_recipients (join on transaction_event_id), limited to
--      submitted_at >= go-live cutoff (see cutover note above).
--   2. For each closed event, join back to transactions for represents_buyer/represents_seller:
--        IF represents_buyer AND an email is available -> insert a 'buyer' row
--          (customer_name/email: prefer transaction_events.buyer_name/email, fall back to
--          transactions.buyer_name/email)
--          agent: transaction_participants WHERE transaction_id = X AND role = 'buyers_agent'
--                 AND is_acc_agent = true -> agents.id for the name
--        IF represents_seller AND an email is available -> insert a 'seller' row
--          agent: transaction_participants WHERE transaction_id = X
--                 AND role IN ('listing_agent','co_listing_agent') AND is_acc_agent = true
--                 -> agents.id for the name (co_listing_agent is rare — take the first match,
--                 low enough volume that a wrong pick isn't worth extra logic yet)
--   3. review_requests.scheduled_at for each step = recipient.trigger_detected_at
--      + campaign_steps.send_offset_days, then rolled into that step's business-hours window.

-- ============================================================
-- 1. REVIEW RECIPIENTS (populated by the closing trigger — one or two rows per transaction)
-- ============================================================

CREATE TABLE review_recipients (
    recipient_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id     UUID NOT NULL REFERENCES transactions(id),
    transaction_side    TEXT NOT NULL CHECK (transaction_side IN ('buyer','seller')),
    customer_name      TEXT NOT NULL,
    customer_email      TEXT,
    agent_id         INTEGER,        -- from transactions.created_by; revisit once the users/agents table is confirmed
    agent_name        TEXT,          -- snapshotted at closing time so later name changes don't rewrite history
    office_id         INTEGER,
    close_date        DATE NOT NULL, -- source TBD, see note above
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (transaction_id, transaction_side)
);

CREATE INDEX idx_review_recipients_close_date ON review_recipients (close_date);
CREATE INDEX idx_review_recipients_agent ON review_recipients (agent_id);

-- Population logic (in the closing-trigger job, not SQL):
--   IF represents_buyer AND buyer_email IS NOT NULL -> insert a 'buyer' row
--   IF represents_seller AND seller_email IS NOT NULL -> insert a 'seller' row
--   (a dual-represented closing produces two independent recipients, two independent sequences)

-- ============================================================
-- 2. CAMPAIGN / TEMPLATE DEFINITIONS (what gets sent, and when)
-- ============================================================

CREATE TABLE review_campaigns (
    campaign_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,          -- e.g. "Standard post-closing review request"
    is_active      BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per touch in the sequence (currently day 1, day 3, day 8)
CREATE TABLE campaign_steps (
    step_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id      UUID NOT NULL REFERENCES review_campaigns(campaign_id),
    step_order       SMALLINT NOT NULL,          -- 1, 2, 3
    send_offset_days  SMALLINT NOT NULL,         -- 1, 3, 8
    channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
    skip_if_reviewed  BOOLEAN NOT NULL DEFAULT true,  -- don't send day 3/8 if they already reviewed
    -- Business-hours send window (America/New_York assumed — single-timezone brokerage).
    -- The scheduler computes close_date + send_offset_days, then rolls the actual send time
    -- forward into this window rather than firing whenever the overnight batch job runs.
    send_window_start_hour SMALLINT NOT NULL DEFAULT 10,  -- 10am
    send_window_end_hour  SMALLINT NOT NULL DEFAULT 16,  -- 4pm
    skip_weekends      BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (campaign_id, step_order)
);

-- Actual content. Multiple rows per step = A/B variants.
CREATE TABLE templates (
    template_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    step_id        UUID NOT NULL REFERENCES campaign_steps(step_id),
    variant_name    TEXT NOT NULL,       -- e.g. "control", "agent_from_name", "shorter_subject"
    channel        TEXT NOT NULL CHECK (channel IN ('email','sms')),
    subject        TEXT,                -- null for sms
    body           TEXT NOT NULL,        -- merge fields: {{customer_name}}, {{agent_name}}, {{transaction_side}}
    from_name_mode   TEXT NOT NULL DEFAULT 'brokerage' CHECK (from_name_mode IN ('brokerage','agent')),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (step_id, variant_name)
);

-- ============================================================
-- 3. A/B TEST ASSIGNMENT
-- ============================================================

CREATE TABLE ab_tests (
    test_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,          -- e.g. "day1_from_name_2026Q3"
    step_id       UUID NOT NULL REFERENCES campaign_steps(step_id),
    starts_at      TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ,
    notes         TEXT
);

-- Deterministic per-recipient assignment so a customer sees a consistent variant across their sequence
CREATE TABLE ab_assignments (
    assignment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id     UUID NOT NULL REFERENCES review_recipients(recipient_id),
    test_id         UUID NOT NULL REFERENCES ab_tests(test_id),
    template_id      UUID NOT NULL REFERENCES templates(template_id),
    assigned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (recipient_id, test_id)
);

-- ============================================================
-- 4. SEND / TRACKING LAYER
-- ============================================================
-- Sending is decoupled from tracking: whatever service sends the message (see plan doc — a
-- small standalone Node service, separate from server.js) just needs to render a template and
-- use the tracked redirect link. send_provider records which mechanism handled a given send,
-- so it can change over time without losing history or complicating the schema.

CREATE TABLE review_requests (
    request_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id     UUID NOT NULL REFERENCES review_recipients(recipient_id),
    step_id         UUID NOT NULL REFERENCES campaign_steps(step_id),
    template_id      UUID NOT NULL REFERENCES templates(template_id),
    channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
    send_provider     TEXT NOT NULL DEFAULT 'workspace',  -- 'workspace', 'crm_partner', 'esp', etc.
    scheduled_at      TIMESTAMPTZ NOT NULL,
    sent_at         TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','sent','skipped','failed')),
    skip_reason      TEXT   -- e.g. 'already_reviewed', 'invalid_email', 'bounced'
);

CREATE INDEX idx_review_requests_recipient ON review_requests (recipient_id);
CREATE INDEX idx_review_requests_scheduled ON review_requests (scheduled_at) WHERE status = 'scheduled';

-- Click-through only for now — pixel-based open tracking is deliberately out of scope (unreliable
-- in Gmail/Outlook previews, and click-through is the more trustworthy signal at this volume
-- anyway). 'open' stays a valid event_type in case that changes later; nothing depends on it today.
CREATE TABLE request_events (
    event_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL REFERENCES review_requests(request_id),
    event_type      TEXT NOT NULL CHECK (event_type IN ('open','click')),
    platform       TEXT CHECK (platform IN ('google','facebook','zillow','reply')),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent      TEXT
);

CREATE INDEX idx_request_events_request ON request_events (request_id);
CREATE INDEX idx_request_events_type ON request_events (event_type, platform);

-- ============================================================
-- 5. OUTCOME (matched from GBP/Zillow API polling, manual for Facebook)
-- ============================================================

CREATE TABLE review_confirmations (
    confirmation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id     UUID NOT NULL REFERENCES review_recipients(recipient_id),
    platform        TEXT NOT NULL CHECK (platform IN ('google','facebook','zillow')),
    rating          SMALLINT,             -- 1-5 where the platform exposes it
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    match_method     TEXT NOT NULL CHECK (match_method IN ('api_poll','manual')),
    match_confidence   TEXT CHECK (match_confidence IN ('high','medium','low'))
);

CREATE INDEX idx_review_confirmations_recipient ON review_confirmations (recipient_id);

-- The "out": a reply/feedback channel offered alongside (not instead of) the public links,
-- available to every recipient regardless of anything they've said — no gating.
CREATE TABLE reply_feedback (
    feedback_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id     UUID NOT NULL REFERENCES review_recipients(recipient_id),
    request_id      UUID REFERENCES review_requests(request_id),
    message        TEXT NOT NULL,
    received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    routed_to_agent   BOOLEAN NOT NULL DEFAULT false
);

-- ============================================================
-- 6. REPORTING VIEWS
-- ============================================================

-- Per-recipient funnel state, one row per buyer or seller in a closing
CREATE VIEW v_recipient_funnel AS
SELECT
    r.recipient_id,
    r.transaction_id,
    r.transaction_side,
    r.agent_name,
    r.close_date,
    COUNT(DISTINCT rr.request_id) FILTER (WHERE rr.status = 'sent') AS touches_sent,
    BOOL_OR(re.event_type = 'click') AS ever_clicked,
    ARRAY_AGG(DISTINCT re.platform) FILTER (WHERE re.platform IS NOT NULL) AS platforms_clicked,
    BOOL_OR(rc.confirmation_id IS NOT NULL) AS reviewed
FROM review_recipients r
LEFT JOIN review_requests rr ON rr.recipient_id = r.recipient_id
LEFT JOIN request_events re ON re.request_id = rr.request_id
LEFT JOIN review_confirmations rc ON rc.recipient_id = r.recipient_id
GROUP BY r.recipient_id, r.transaction_id, r.transaction_side, r.agent_name, r.close_date;

-- Monthly rollup: sent / clicked / reviewed, and rate vs. the 15% target
CREATE VIEW v_monthly_funnel AS
SELECT
    DATE_TRUNC('month', r.close_date) AS month,
    COUNT(DISTINCT r.recipient_id) AS recipients,
    COUNT(DISTINCT r.recipient_id) FILTER (WHERE f.ever_clicked) AS clicked,
    COUNT(DISTINCT r.recipient_id) FILTER (WHERE f.reviewed) AS reviewed,
    ROUND(100.0 * COUNT(DISTINCT r.recipient_id) FILTER (WHERE f.reviewed)
        / NULLIF(COUNT(DISTINCT r.recipient_id), 0), 1) AS review_rate_pct
FROM review_recipients r
JOIN v_recipient_funnel f ON f.recipient_id = r.recipient_id
GROUP BY DATE_TRUNC('month', r.close_date)
ORDER BY month;

-- A/B variant performance: click rate and review rate per variant
CREATE VIEW v_variant_performance AS
SELECT
    tp.step_id,
    tp.variant_name,
    COUNT(DISTINCT rr.recipient_id) AS sent_count,
    COUNT(DISTINCT re.request_id) FILTER (WHERE re.event_type = 'click') AS clicked_count,
    COUNT(DISTINCT rc.recipient_id) AS reviewed_count,
    ROUND(100.0 * COUNT(DISTINCT rc.recipient_id)
        / NULLIF(COUNT(DISTINCT rr.recipient_id), 0), 1) AS review_rate_pct
FROM templates tp
JOIN review_requests rr ON rr.template_id = tp.template_id AND rr.status = 'sent'
LEFT JOIN request_events re ON re.request_id = rr.request_id
LEFT JOIN review_confirmations rc ON rc.recipient_id = rr.recipient_id
GROUP BY tp.step_id, tp.variant_name;

-- Schema is now fully specified against real table structures — no remaining introspection
-- needed before handoff. See review-engine-plan.md for the handful of build-detail decisions
-- still open (service layout, deploy/scheduling mechanics).
