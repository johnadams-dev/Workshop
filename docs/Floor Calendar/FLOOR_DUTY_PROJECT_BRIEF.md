# Floor Duty Scheduling System — Project Brief

**Adams Cameron & Co. Realtors** *For use with Claude Code / VS Code*

---

## **What This Is**

A floor duty scheduling module that plugs into the existing Adams Cameron tool suite at **johnadams.org**. It collects agent availability preferences, distributes agents across shifts using a priority algorithm, publishes schedules to Google Calendar, and collects post-shift feedback.

This is **not** a standalone application — it is a new module that integrates with existing infrastructure: same auth, same database, same email system, same Google API setup, same UI patterns.

---

## **Existing Infrastructure — Do Not Rebuild**

| Capability | Status |
| :---- | :---- |
| Google OAuth (`@adamscameron.com` accounts) | Already wired up |
| PostgreSQL on Google Cloud | Existing connection, existing pool |
| Email sending | Existing infrastructure |
| Google Calendar API | Service account with Workspace admin access |
| Agent records UI (`agent-master-form.html`) | Exists — needs one addition |
| UI pattern / design language | Match johnadams.org exactly |

**Match the existing codebase patterns** for routing, database queries, auth middleware, and error handling. Do not introduce new frameworks or patterns without a strong reason.

---

## **Tech Stack**

- **Frontend:** HTML / vanilla JavaScript — matches all existing tools  
- **Backend:** Node.js / Express  
- **Database:** PostgreSQL (Google Cloud)  
- **Auth:** Google OAuth, restricted to `@adamscameron.com` accounts  
- **Calendar:** Google Calendar API via service account  
- **Email:** Existing transactional email setup

---

## **User Roles**

Roles are stored in `staff.role` as plain strings. The `staff.office_id` column is **not populated** — always use the `staff_offices` junction table to determine which offices a staff member can access.

| `staff.role` value | Floor Duty Permissions |
| :---- | :---- |
| `admin` | Full access — all offices, all configuration |
| `manager` | Configure shifts, set agent eligibility, publish schedules |
| `coordinator` | Manage availability, manual adjustments, publish schedules — cannot change shift times |

Fine-grained access is controlled by `flr_staff_access` (see schema doc), which allows individual exceptions independent of role (e.g. Relocation Coordinator excluded from floor duty entirely).

**Agents** authenticate via Google OAuth using their `@adamscameron.com` account. They are matched to `agents.email`. They have no `staff` record — they access a separate agent-facing portal.

---

## **Key Business Rules**

1. **One agent per shift per date per office** — enforced by UNIQUE constraint on `flr_assignments(office_id, shift_id, assignment_date)`  
2. **Floor eligibility required** — only agents with `flr_agent_eligibility.is_eligible = true` are candidates for scheduling  
3. **Home office preference** — algorithm prioritizes agents whose `agents.office_id` matches the shift's office  
4. **Agent opt-in** — agents set standing preferences (days, shifts, offices) and adjust monthly  
5. **Agents can volunteer for any office** — not just their home office; `flr_agent_defaults.willing_office_ids` stores their selections  
6. **Manager or coordinator publishes** — schedules are drafts until explicitly published; publishing triggers Google Calendar and email  
7. **Google Calendar is display only** — database (`flr_assignments`) is the source of truth; Calendar events are kept in sync but never read back

---

## **Distribution Algorithm — Priority Order**

When filling a shift slot for a given office/date/shift:

1. **Tier 1:** Agent requested this specific office, is available this date/shift, home office matches  
2. **Tier 2:** Agent requested this specific office, is available this date/shift, home office is different  
3. **Tier 3:** Agent's home office matches, they are generally available but didn't specifically request this office  
4. **Tier 4:** Agent volunteered for other offices and is available this date  
5. **Unfilled:** No eligible available agent — slot remains NULL, manager alerted

Within each tier, secondary sort should be by **fewest floor shifts already assigned this period** to distribute fairly.

---

## **Monthly Scheduling Workflow**

```
~20th of prior month
  Admin/Manager opens scheduling period for next month
  → flr_scheduling_periods status = 'open'
  → Email sent to all eligible agents: "Submit your availability for [Month]"
        ↓
Agents log in to portal
  Set or confirm standing preferences
  Add one-off overrides for the month
  (2-week window before closes_at)
        ↓
Manager closes availability window
  → flr_scheduling_periods status = 'closed'
        ↓
Manager runs distribution algorithm
  → flr_assignments rows created (draft)
  → flr_scheduling_periods status = 'draft'
        ↓
Manager reviews draft calendar
  Manually fills open slots
  Adjusts any assignments as needed
        ↓
Manager or Coordinator publishes
  → flr_scheduling_periods status = 'published'
  → Google Calendar events created on office calendar
  → Agents receive Google Calendar invites
  → Agents receive confirmation email
        ↓
Day before each shift
  → Reminder email to assigned agent
        ↓
Day after each shift
  → Feedback request email to agent (1–5 rating + optional comment)
```

---

## **Google Calendar Integration**

- **One calendar per office** — office managers can see the full month at a glance in Google Calendar without logging in  
- **Service account** has Editor access to each office calendar  
- **On publish:** Create event on office calendar → add agent as guest → agent receives invite → agent accepts → blocks their personal Google Calendar  
- **On assignment change:** Update the existing `gcal_event_id` event  
- **On cancellation:** Delete/cancel the event, notify agent  
- `flr_assignments.gcal_event_id` stores the Google Calendar event ID for all future updates  
- `flr_assignments.gcal_invite_sent_at` tracks when the invite was sent

---

## **Notification Emails**

Three triggers per assignment:

| Trigger | Timing | Content |
| :---- | :---- | :---- |
| Schedule published | On publish | "You're on floor at \[Office\] on \[Date\], \[Shift time\]" \+ calendar invite |
| Day-before reminder | 4:00 PM day before | "Reminder: floor duty tomorrow at \[Office\], \[Time\]" |
| Feedback request | 9:00 AM day after | "How did floor duty go?" — single click 1–5 rating |

Feedback email should be a **one-click rating** — each rating option is a direct link that records the response without requiring login if possible.

---

## **Agent Portal — Four Screens**

### 1\. Dashboard

- Next upcoming assignment  
- Stats: shifts this month, next floor date, average feedback rating  
- Alert banner when availability window is open  
- Rate most recent shift (if feedback pending)

### 2\. My Availability

- **Office selector:** Checkboxes for all offices; home office pre-checked. Agent can volunteer for as many as they want.  
- **Standing day preferences:** Seven day toggles (Mon–Sun)  
- **Shift time preferences:** Toggle per shift type (Morning / Afternoon / Evening)  
- **Monthly override calendar:** Click any day to block or unblock it for the current period. Shows three states: available (blue), blocked (red), off by default (gray).  
- Save preferences button

### 3\. Office Calendar

- Dropdown to select office (only offices agent volunteered for)  
- Full month calendar showing all assignments — agent names on filled slots, "open" indicator on unfilled slots  
- Agent's own assignments highlighted  
- Clicking an open slot allows volunteering for it (after schedule is published)

### 4\. My History

- List of past shifts with date, office, shift time  
- Feedback emoji shown for shifts they rated  
- Running stats

---

## **Manager Portal — Five Screens**

### 1\. Schedule

- Office selector dropdown (scoped to staff\_offices)  
- Month selector  
- Stats: total slots, filled, open, agents submitted availability  
- Full month calendar — color coded: fully staffed (gray), partial (amber), all open (red)  
- Open slots listed below calendar with inline agent assignment dropdown  
- "Run algorithm" button — fills draft assignments  
- "Publish" button — goes to publish tab

### 2\. Shift Setup *(admin and manager only)*

- List of shifts for selected office  
- Each shift: name, start time, end time, day toggles (Mo Tu We Th Fr Sa Su)  
- Add shift / delete shift  
- Scheduling period settings: window open date, window close date  
- Reminder email toggle, feedback email toggle

### 3\. Agent Eligibility *(admin and manager only)*

- List of agents for selected office  
- Toggle per agent: eligible / pending  
- Shows licensed date, eligible since date  
- Filter: all / eligible / pending  
- Links to agent-master-form.html — changes sync both ways

### 4\. Feedback

- Stats: avg rating, response count, unreviewed low ratings  
- List of all feedback for the office with agent name, shift, date, rating emoji, comment  
- Manager note input on each item — saving the note marks it reviewed  
- Alert badge for unreviewed low scores (rating 1 or 2\)

### 5\. Publish

- Pre-flight checklist: algorithm run, open slots count, calendar ready, emails ready  
- Summary of what publish will do  
- Publish button — irreversible, but individual assignments can still be edited after

---

## **Existing Page to Modify**

**`agent-master-form.html`** — Add floor eligibility toggle to the agent detail panel:

- Toggle: "Floor duty eligible" (boolean)  
- Date field: "Eligible since" (shown when toggled on)  
- Writes to `flr_agent_eligibility` table (upsert on agent\_id)  
- Read: JOIN `flr_agent_eligibility` when loading agent record  
- This is the only modification to any existing file

---

## **Suggested Build Sequence**

1. **Shift configuration UI** — managers populate `flr_shifts` per office (nothing else works without this)  
2. **Agent eligibility toggle** — add to `agent-master-form.html`  
3. **Scheduling period management** — open/close monthly windows, send availability emails  
4. **Agent availability portal** — defaults \+ monthly overrides  
5. **Distribution algorithm** — fills `flr_assignments` from availability data  
6. **Manager review \+ manual assignment** — fill open slots, override algorithm  
7. **Publish flow** — Google Calendar events \+ agent confirmation emails  
8. **Notifications** — day-before reminder, day-after feedback request  
9. **Feedback dashboard** — manager review of ratings and comments

---

## **UI Design Rules**

Match the existing johnadams.org tool design exactly:

- Header: tool icon \+ "Floor Duty" title \+ "Adams Cameron & Co." right-aligned  
- Navigation: horizontal tab bar with bottom-border active indicator, color `#1a3c6b`  
- Cards: white background, `0.5px` border, `border-radius: var(--border-radius-lg)`  
- Primary button: `background: #1a3c6b`, white text  
- Badges: pill shape, semantic colors (green=confirmed, blue=pending, amber=warning, red=error)  
- Stat cards: `background: var(--color-background-secondary)`, 11px label, 22px value  
- Section labels: 11px, uppercase, `letter-spacing: 0.06em`, muted color  
- Emoji icons for navigation (matches existing tools: 📅 🔑 🗂️ etc.)  
- No external CSS frameworks — vanilla CSS with existing CSS variables  
- Back link to `https://johnadams.org/index.html` in header

Reference pages for style: `lockbox-app.html`, `agent-master-form.html`

