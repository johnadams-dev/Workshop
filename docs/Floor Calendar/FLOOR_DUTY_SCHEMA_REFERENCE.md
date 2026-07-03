# Floor Duty Module — Database Schema Reference

**Adams Cameron & Co. Realtors** *All new tables prefixed `flr_` — no existing tables modified*

---

## **Existing Tables Used (Read Only — Do Not Modify)**

```
agents          — agent records; agents.office_id = home office
offices         — office records
staff           — staff records; staff.role = 'admin' | 'manager' | 'coordinator'
staff_offices   — junction: which offices each staff member can access
                  NOTE: staff.office_id is NOT populated — always use staff_offices
```

---

## **New Tables — Floor Duty Module**

### `flr_shifts`

Shift definitions per office. Configurable by `admin` and `manager` roles only.

```sql
CREATE TABLE flr_shifts (
    id              SERIAL          PRIMARY KEY,
    office_id       integer         NOT NULL REFERENCES offices(id),
    name            character varying(100) NOT NULL,  -- 'Morning', 'Afternoon', 'Evening'
    start_time      time            NOT NULL,          -- e.g. 08:30
    end_time        time            NOT NULL,          -- e.g. 13:00
    mon             boolean         NOT NULL DEFAULT false,
    tue             boolean         NOT NULL DEFAULT false,
    wed             boolean         NOT NULL DEFAULT false,
    thu             boolean         NOT NULL DEFAULT false,
    fri             boolean         NOT NULL DEFAULT false,
    sat             boolean         NOT NULL DEFAULT false,
    sun             boolean         NOT NULL DEFAULT false,
    display_order   integer         NOT NULL DEFAULT 0,
    is_active       boolean         NOT NULL DEFAULT true,
    created_by      integer         REFERENCES staff(id),
    updated_by      integer         REFERENCES staff(id),
    created_at      timestamptz     NOT NULL DEFAULT now(),
    updated_at      timestamptz     NOT NULL DEFAULT now()
);
```

**Notes:**

- Each shift has its own day flags — a Sunday-only shift just has `sun = true`  
- Offices can have 1–3 shifts per day, fully configurable  
- Soft delete via `is_active = false`

---

### `flr_scheduling_periods`

One row per office per month. Controls the availability submission window and publish state.

```sql
CREATE TABLE flr_scheduling_periods (
    id              SERIAL          PRIMARY KEY,
    office_id       integer         NOT NULL REFERENCES offices(id),
    period_year     integer         NOT NULL,
    period_month    integer         NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    opens_at        timestamptz     NOT NULL,   -- when agents can start submitting
    closes_at       timestamptz     NOT NULL,   -- when window closes
    status          character varying(20) NOT NULL DEFAULT 'pending',
    published_at    timestamptz,
    published_by    integer         REFERENCES staff(id),
    created_by      integer         REFERENCES staff(id),
    created_at      timestamptz     NOT NULL DEFAULT now(),
    updated_at      timestamptz     NOT NULL DEFAULT now(),
    UNIQUE (office_id, period_year, period_month)
);
```

**Status values:** | Value | Meaning | |---|---| | `pending` | Not yet open; agents cannot submit | | `open` | Agents actively submitting availability | | `closed` | Window closed; ready for algorithm | | `draft` | Algorithm has run; manager reviewing | | `published` | Live — Google Calendar events created, agents notified |

---

### `flr_agent_eligibility`

Extends `agents` without modifying it. One row per agent, created when eligibility is first set.

```sql
CREATE TABLE flr_agent_eligibility (
    agent_id            integer         PRIMARY KEY REFERENCES agents(id),
    is_eligible         boolean         NOT NULL DEFAULT false,
    eligible_since      date,
    ineligible_reason   text,           -- 'Training incomplete', etc.
    updated_by          integer         REFERENCES staff(id),
    updated_at          timestamptz     NOT NULL DEFAULT now()
);
```

**Notes:**

- Managed by `admin` and `manager` roles  
- Also toggled from `agent-master-form.html` (existing page, modified)  
- Agents without a row here are treated as ineligible  
- Use UPSERT when writing: `INSERT ... ON CONFLICT (agent_id) DO UPDATE`

---

### `flr_agent_defaults`

Standing availability preferences per agent. Persists month to month — agents set once and adjust as needed.

```sql
CREATE TABLE flr_agent_defaults (
    id                  SERIAL          PRIMARY KEY,
    agent_id            integer         NOT NULL UNIQUE REFERENCES agents(id),
    mon                 boolean         NOT NULL DEFAULT false,
    tue                 boolean         NOT NULL DEFAULT false,
    wed                 boolean         NOT NULL DEFAULT false,
    thu                 boolean         NOT NULL DEFAULT false,
    fri                 boolean         NOT NULL DEFAULT false,
    sat                 boolean         NOT NULL DEFAULT false,
    sun                 boolean         NOT NULL DEFAULT false,
    willing_office_ids  integer[]       NOT NULL DEFAULT '{}',
    preferred_shift_ids integer[]       NOT NULL DEFAULT '{}',
    updated_at          timestamptz     NOT NULL DEFAULT now()
);
```

**Notes:**

- `willing_office_ids`: array of `offices.id` the agent is willing to work. Home office should always be included.  
- `preferred_shift_ids`: array of `flr_shifts.id` the agent prefers (e.g. morning shifts only)  
- One row per agent — use UPSERT when writing  
- `updated_at` only — no `created_at` since it's a single mutable preferences record

---

### `flr_agent_overrides`

One-off additions or blocks for a specific date within a scheduling period. Overrides the standing defaults for that date only.

```sql
CREATE TABLE flr_agent_overrides (
    id              SERIAL          PRIMARY KEY,
    agent_id        integer         NOT NULL REFERENCES agents(id),
    period_id       integer         NOT NULL REFERENCES flr_scheduling_periods(id),
    override_date   date            NOT NULL,
    shift_id        integer         REFERENCES flr_shifts(id),
    is_available    boolean         NOT NULL,
    note            text,           -- 'Vacation', 'Closing', 'Added this day', etc.
    created_at      timestamptz     NOT NULL DEFAULT now(),
    UNIQUE (agent_id, period_id, override_date, shift_id)
);
```

**Notes:**

- `shift_id = NULL` means the override applies to the **entire day**  
- `shift_id = <id>` means the override applies to **one specific shift only**  
- `is_available = true`: agent added this date (was off by default)  
- `is_available = false`: agent blocked this date (was on by default)  
- UNIQUE constraint prevents duplicate overrides for same agent/date/shift

---

### `flr_assignments`

The actual schedule — one row per shift slot per date. `agent_id = NULL` means unfilled.

```sql
CREATE TABLE flr_assignments (
    id                      SERIAL          PRIMARY KEY,
    period_id               integer         NOT NULL REFERENCES flr_scheduling_periods(id),
    office_id               integer         NOT NULL REFERENCES offices(id),
    shift_id                integer         NOT NULL REFERENCES flr_shifts(id),
    assignment_date         date            NOT NULL,
    agent_id                integer         REFERENCES agents(id),  -- NULL = unfilled
    status                  character varying(20) NOT NULL DEFAULT 'draft',
    assigned_by             character varying(20) NOT NULL DEFAULT 'algorithm',
    assigned_by_staff       integer         REFERENCES staff(id),
    assigned_at             timestamptz     NOT NULL DEFAULT now(),
    gcal_event_id           character varying(255),
    gcal_invite_sent_at     timestamptz,
    reminder_sent_at        timestamptz,
    feedback_requested_at   timestamptz,
    notes                   text,
    created_at              timestamptz     NOT NULL DEFAULT now(),
    updated_at              timestamptz     NOT NULL DEFAULT now(),
    UNIQUE (office_id, shift_id, assignment_date)
);
```

**Status values:** | Value | Meaning | |---|---| | `draft` | Created by algorithm or manager, not yet published | | `confirmed` | Period published — agent has been notified | | `cancelled` | Assignment cancelled after confirmation |

**`assigned_by` values:** | Value | Meaning | |---|---| | `algorithm` | Filled by the distribution algorithm | | `manager` | Manually assigned by a manager or coordinator | | `agent_volunteer` | Agent claimed an open slot via the portal |

**Notes:**

- UNIQUE on `(office_id, shift_id, assignment_date)` enforces one agent per slot  
- `gcal_event_id` is stored so events can be updated or cancelled when assignments change  
- Slot rows are created for every shift/date combination when algorithm runs — unfilled slots have `agent_id = NULL`  
- When reassigning: update existing row, don't delete and recreate (preserve `gcal_event_id`)

---

### `flr_feedback`

Post-shift agent rating. One per assignment. Manager-visible in full detail.

```sql
CREATE TABLE flr_feedback (
    id              SERIAL          PRIMARY KEY,
    assignment_id   integer         NOT NULL UNIQUE REFERENCES flr_assignments(id),
    agent_id        integer         NOT NULL REFERENCES agents(id),
    office_id       integer         NOT NULL REFERENCES offices(id),
    rating          smallint        NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment         text,
    submitted_at    timestamptz     NOT NULL DEFAULT now(),
    manager_note    text,
    reviewed_by     integer         REFERENCES staff(id),
    reviewed_at     timestamptz     -- NULL = unreviewed
);
```

**Rating scale:** | Value | Emoji | Label | |---|---|---| | 5 | 🚀 | Excellent | | 4 | 😊 | Good | | 3 | 😐 | Okay | | 2 | 😕 | Slow | | 1 | 😞 | Rough |

**Notes:**

- `reviewed_at = NULL` triggers the unreviewed alert badge for managers  
- Low ratings (1 or 2\) should generate a manager notification  
- `office_id` is denormalized here for efficient manager dashboard queries  
- One feedback per assignment enforced by UNIQUE constraint

---

### `flr_staff_access`

Floor duty permissions per staff member. Independent of `staff.role` — allows fine-grained exceptions.

```sql
CREATE TABLE flr_staff_access (
    staff_id                integer         PRIMARY KEY REFERENCES staff(id),
    has_floor_access        boolean         NOT NULL DEFAULT true,
    can_configure_shifts    boolean         NOT NULL DEFAULT false,
    can_set_eligibility     boolean         NOT NULL DEFAULT false,
    can_publish             boolean         NOT NULL DEFAULT true,
    updated_by              integer         REFERENCES staff(id),
    updated_at              timestamptz     NOT NULL DEFAULT now()
);
```

**Seeded values:**

| staff\_id | Name | Role | has\_access | configure | eligibility | publish |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| 1 | John Adams | admin | true | true | true | true |
| 2 | Kelly Brooks | admin | true | true | true | true |
| 12 | Anderson Welch | admin | true | true | true | true |
| 3 | Ashlee Selman | manager | true | true | true | true |
| 4 | Kristin Petersen | manager | true | true | true | true |
| 5 | Joeyl Cannamela | coordinator | true | false | false | true |
| 6 | Kim Fink | coordinator | true | false | false | true |
| 7 | Michelle Overin | coordinator | true | false | false | true |
| 8 | Nykea Ross | coordinator | true | false | false | true |
| 9 | Vicki Agan | coordinator | true | false | false | true |
| 10 | Brett Thompson | coordinator | **false** | false | false | false |

---

## **Indexes**

```sql
-- Active shifts by office (shift config page)
CREATE INDEX idx_flr_shifts_office
    ON flr_shifts(office_id)
    WHERE is_active = true;

-- Periods by office and month (calendar views)
CREATE INDEX idx_flr_periods_office_month
    ON flr_scheduling_periods(office_id, period_year, period_month);

-- Agent overrides by period (availability queries)
CREATE INDEX idx_flr_overrides_agent_period
    ON flr_agent_overrides(agent_id, period_id);

-- Assignments by period and office (calendar view)
CREATE INDEX idx_flr_assignments_period_office
    ON flr_assignments(period_id, office_id);

-- Assignments by agent (agent dashboard)
CREATE INDEX idx_flr_assignments_agent
    ON flr_assignments(agent_id)
    WHERE agent_id IS NOT NULL;

-- Unfilled slots (manager alert query)
CREATE INDEX idx_flr_assignments_unfilled
    ON flr_assignments(period_id, office_id)
    WHERE agent_id IS NULL;

-- Unreviewed feedback (manager alert badge)
CREATE INDEX idx_flr_feedback_unreviewed
    ON flr_feedback(office_id)
    WHERE reviewed_at IS NULL;
```

---

## **Key Queries**

### Get all eligible agents available for a given shift slot

```sql
-- Used by the distribution algorithm
-- Replace $1=office_id, $2=shift_id, $3=target_date, $4=day_of_week_column
SELECT
    a.id,
    a.first_name,
    a.last_name,
    a.office_id AS home_office_id,
    -- Priority tier
    CASE
        WHEN a.office_id = $1 THEN 1   -- home office matches
        ELSE 2                          -- volunteering from another office
    END AS priority_tier,
    -- Fairness: how many shifts already assigned this period
    COUNT(fa.id) AS shifts_this_period
FROM agents a
JOIN flr_agent_eligibility ae ON ae.agent_id = a.id AND ae.is_eligible = true
JOIN flr_agent_defaults ad ON ad.agent_id = a.id
WHERE
    -- Agent willing to work this office
    $1 = ANY(ad.willing_office_ids)
    -- Agent's standing preference includes this day
    -- (substitute correct day column: mon/tue/wed/thu/fri/sat/sun)
    AND ad.mon = true  -- replace with correct day
    -- Agent prefers this shift (or has no shift preference set)
    AND (
        array_length(ad.preferred_shift_ids, 1) IS NULL
        OR $2 = ANY(ad.preferred_shift_ids)
    )
    -- No blocking override for this date
    AND NOT EXISTS (
        SELECT 1 FROM flr_agent_overrides o
        WHERE o.agent_id = a.id
          AND o.period_id = (
              SELECT id FROM flr_scheduling_periods
              WHERE office_id = $1
                AND period_year = EXTRACT(YEAR FROM $3::date)
                AND period_month = EXTRACT(MONTH FROM $3::date)
          )
          AND o.override_date = $3
          AND o.is_available = false
          AND (o.shift_id IS NULL OR o.shift_id = $2)
    )
    -- Not already assigned another shift same day
    AND NOT EXISTS (
        SELECT 1 FROM flr_assignments fa2
        WHERE fa2.agent_id = a.id
          AND fa2.assignment_date = $3
          AND fa2.status != 'cancelled'
    )
    AND a.active = true
-- Fairness join
LEFT JOIN flr_assignments fa
    ON fa.agent_id = a.id
    AND fa.period_id = (
        SELECT id FROM flr_scheduling_periods
        WHERE office_id = $1
          AND period_year = EXTRACT(YEAR FROM $3::date)
          AND period_month = EXTRACT(MONTH FROM $3::date)
    )
    AND fa.status != 'cancelled'
GROUP BY a.id, a.first_name, a.last_name, a.office_id
ORDER BY priority_tier, shifts_this_period;
```

### Get manager dashboard summary for an office+period

```sql
SELECT
    COUNT(*) FILTER (WHERE agent_id IS NOT NULL) AS filled_slots,
    COUNT(*) FILTER (WHERE agent_id IS NULL)     AS open_slots,
    COUNT(*)                                      AS total_slots
FROM flr_assignments
WHERE period_id = $1
  AND office_id = $2
  AND status != 'cancelled';
```

### Get unreviewed low feedback for a manager's offices

```sql
SELECT
    f.id,
    f.rating,
    f.comment,
    f.submitted_at,
    a.first_name || ' ' || a.last_name AS agent_name,
    o.name AS office_name,
    fa.assignment_date,
    s.name AS shift_name
FROM flr_feedback f
JOIN flr_assignments fa ON fa.id = f.assignment_id
JOIN flr_shifts s ON s.id = fa.shift_id
JOIN agents a ON a.id = f.agent_id
JOIN offices o ON o.id = f.office_id
WHERE f.office_id = ANY($1)   -- array of office_ids from staff_offices
  AND f.reviewed_at IS NULL
  AND f.rating <= 2
ORDER BY f.submitted_at DESC;
```

### Upsert agent defaults

```sql
INSERT INTO flr_agent_defaults
    (agent_id, mon, tue, wed, thu, fri, sat, sun, willing_office_ids, preferred_shift_ids)
VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (agent_id) DO UPDATE SET
    mon = EXCLUDED.mon,
    tue = EXCLUDED.tue,
    wed = EXCLUDED.wed,
    thu = EXCLUDED.thu,
    fri = EXCLUDED.fri,
    sat = EXCLUDED.sat,
    sun = EXCLUDED.sun,
    willing_office_ids  = EXCLUDED.willing_office_ids,
    preferred_shift_ids = EXCLUDED.preferred_shift_ids,
    updated_at = now();
```

### Get staff access \+ office scope for auth middleware

```sql
SELECT
    fa.has_floor_access,
    fa.can_configure_shifts,
    fa.can_set_eligibility,
    fa.can_publish,
    ARRAY_AGG(so.office_id) AS office_ids
FROM flr_staff_access fa
JOIN staff_offices so ON so.staff_id = fa.staff_id
WHERE fa.staff_id = $1
  AND fa.has_floor_access = true
GROUP BY fa.staff_id, fa.has_floor_access,
         fa.can_configure_shifts, fa.can_set_eligibility, fa.can_publish;
```

---

## **Auth Middleware Pattern**

```javascript
// Attach to all /api/floor/* routes
async function requireFloorAccess(req, res, next) {
    const { rows } = await db.query(`
        SELECT
            fa.has_floor_access,
            fa.can_configure_shifts,
            fa.can_set_eligibility,
            fa.can_publish,
            ARRAY_AGG(so.office_id) AS office_ids
        FROM flr_staff_access fa
        JOIN staff_offices so ON so.staff_id = fa.staff_id
        WHERE fa.staff_id = $1
          AND fa.has_floor_access = true
        GROUP BY fa.staff_id, fa.has_floor_access,
                 fa.can_configure_shifts, fa.can_set_eligibility, fa.can_publish
    `, [req.user.staff_id]);

    if (rows.length === 0) {
        return res.status(403).json({ error: 'No floor duty access' });
    }

    req.floorAccess = rows[0];
    next();
}

// Capability gates — compose as needed
const requireShiftConfig = (req, res, next) =>
    req.floorAccess.can_configure_shifts
        ? next()
        : res.status(403).json({ error: 'Requires manager or admin role' });

const requirePublish = (req, res, next) =>
    req.floorAccess.can_publish
        ? next()
        : res.status(403).json({ error: 'Requires manager, coordinator, or admin role' });

const requireEligibilityControl = (req, res, next) =>
    req.floorAccess.can_set_eligibility
        ? next()
        : res.status(403).json({ error: 'Requires manager or admin role' });

// Office scope gate — use on any route with :officeId param
const requireOfficeAccess = (req, res, next) => {
    const officeId = parseInt(req.params.officeId);
    if (!req.floorAccess.office_ids.includes(officeId)) {
        return res.status(403).json({ error: 'No access to this office' });
    }
    next();
};
```

---

## **API Route Structure (Suggested)**

```
Agent-facing (authenticated via Google OAuth as agent)
  GET    /api/floor/agent/me                        — profile, eligibility, next assignment
  GET    /api/floor/agent/defaults                  — standing preferences
  PUT    /api/floor/agent/defaults                  — save standing preferences
  GET    /api/floor/agent/overrides/:periodId       — overrides for a period
  PUT    /api/floor/agent/overrides/:periodId       — save overrides for a period
  GET    /api/floor/agent/assignments               — upcoming assignments
  GET    /api/floor/agent/history                   — past assignments
  POST   /api/floor/agent/feedback/:assignmentId    — submit post-shift rating
  GET    /api/floor/calendar/:officeId/:year/:month — full office calendar (all agents)
  POST   /api/floor/volunteer/:assignmentId         — claim an open slot

Manager-facing (authenticated via Google OAuth as staff)
  GET    /api/floor/offices                         — offices this staff can manage
  GET    /api/floor/shifts/:officeId                — shift config for office
  POST   /api/floor/shifts/:officeId                — create shift (manager/admin)
  PUT    /api/floor/shifts/:shiftId                 — update shift (manager/admin)
  DELETE /api/floor/shifts/:shiftId                 — deactivate shift (manager/admin)

  GET    /api/floor/periods/:officeId               — list periods for office
  POST   /api/floor/periods/:officeId               — create/open a period
  PUT    /api/floor/periods/:periodId/close         — close availability window
  PUT    /api/floor/periods/:periodId/publish       — publish + trigger calendar + email

  GET    /api/floor/schedule/:periodId              — full draft/published schedule
  POST   /api/floor/schedule/:periodId/run          — run distribution algorithm
  PUT    /api/floor/assignments/:assignmentId       — manual assignment override
  
  GET    /api/floor/eligibility/:officeId           — agent eligibility list
  PUT    /api/floor/eligibility/:agentId            — set eligibility (manager/admin)

  GET    /api/floor/feedback/:officeId              — feedback list for office
  PUT    /api/floor/feedback/:feedbackId/review     — add manager note, mark reviewed
```

