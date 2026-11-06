/* ── CMA in Market Update ────────────────────────────────────────────────────
   Search the MLS instead of uploading an export: the subject's facts, the
   comparable sales with a confidence score, adjustments worked out from local
   sales (the agent can change any of them), and a recommended price from the
   adjusted $/sq ft. All numbers come from the server (server/cma-routes.js,
   server/cma/*.js); rules: "CMA" in server/docs/business-rules.md.

   Daytona sales come from the Back Office Feed and Stellar through Bridge;
   neither needs anything from the agent. The Flexmls sign-in code below only
   runs if the server has no feed token (server/flexmls-auth.js).

   The search results also feed the page's existing market pages (price vs
   size, $/sq ft, absorption, days on market) through cmaMarketRows(), and
   the CMA pages are added to the printed report by cmaPagesHTML(). */

const CMA = {
  mode: 'search',          // 'search' | 'upload'
  subject: null,           // facts the agent can edit
  analysis: null,          // /cma/analyze response
  chosen: new Set(),       // mlsNumbers of the comps the agent picked
  amounts: {},             // adjustment key → dollars per unit (derived, then the agent's changes)
  edited: new Set(),       // adjustment keys the agent changed
  ratePerMonth: 0,
  cellOverrides: {},       // mlsNumber → { key: dollars }
  reads: {},               // mlsNumber|'subject' → { condition, conditionLabel, notes }
  priced: null,            // /cma/price response
  priceEdited: false,      // the agent typed their own list price in step 5
  adjOpen: false,          // the adjustments section is open
  flexmls: null,           // /flexmls/status response
};
const CMA_CONDITIONS = ['Original', 'Updated', 'Remodeled', 'New construction'];
const CMA_WATER = { none: 'No water', access: 'Water access / view', lake: 'Lake / pond front', canal: 'Canal front', river: 'River / ICW front', ocean: 'Oceanfront', other: 'Waterfront (other)' };
const cmaEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmaMoney = n => (n == null || isNaN(n)) ? '—' : (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const cmaDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const cmaEl = id => document.getElementById(id);

// ── Mode: search the MLS, or upload an export (today's flow) ───────────────
function cmaSetMode(mode) {
  CMA.mode = mode;
  cmaEl('cmaSection').style.display = mode === 'search' ? '' : 'none';
  cmaEl('uploadGroup').style.display = mode === 'upload' ? '' : 'none';
  document.querySelectorAll('.cma-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  cmaEl('generateBtn').textContent = mode === 'search' ? '🚀 Generate Report' : '🚀 Generate Reports';
  // Searching, the size comes from step 1 and the list price starts at the recommended price
  cmaEl('sqftGroup').style.display = mode === 'search' ? 'none' : '';
  cmaEl('subjectPriceLabel').innerHTML = mode === 'search'
    ? '💰 List price for the report'
    : '💰 Subject Property List Price <span style="font-weight:normal;color:var(--muted);text-transform:none;letter-spacing:0">(optional)</span>';
  cmaEl('subjectPriceHint').textContent = mode === 'search'
    ? 'Starts at the recommended price from step 4 — change it to the price you\'ll suggest. Numbers only.'
    : 'Enter numbers only (no dollar signs or commas)';
  if (mode === 'search') cmaFlexmlsStatus();
}

function cmaStatus(msg, type) {
  const el = cmaEl('cmaStatus');
  el.textContent = msg || '';
  el.className = 'status ' + (type || 'processing');
  el.style.display = msg ? 'block' : 'none';
}

async function cmaNeedSignIn() {
  if (Auth.user) return true;
  cmaStatus('Sign in with your Adams Cameron Google account (below) to search the MLS.', 'error');
  document.getElementById('zillowOptions').style.display = '';   // the sign-in button lives there
  zgSignIn();
  return false;
}

// ── Daytona connection ─────────────────────────────────────────────────────
async function cmaFlexmlsStatus() {
  if (!Auth.user) return cmaRenderFlexmls();
  try {
    if ((await Auth.api('/cma/sources')).daytona === 'feed') { CMA.daytonaFeed = true; return cmaRenderFlexmls(); }
  } catch (_) { /* an older server: ask about the sign-in */ }
  try { CMA.flexmls = await Auth.api('/flexmls/status'); } catch (e) { CMA.flexmls = null; }
  cmaRenderFlexmls();
}

// Connecting Flexmls is hidden from agents while Flexmls refuses our app ("MCP has not been
// enabled for your MLS", 2026-11-05, even on a fresh login with MCP on). Reachable for testing
// with market-update.html?flexmls-setup; set to true once Flexmls/DBAR enable the app.
const CMA_FLEXMLS_OPEN = false;
const cmaFlexmlsSetup = () => CMA_FLEXMLS_OPEN || new URLSearchParams(location.search).has('flexmls-setup');

function cmaRenderFlexmls() {
  const f = CMA.flexmls, el = cmaEl('cmaFlexmls');
  if (!Auth.user) {
    el.innerHTML = `<b>Sign in to search the MLS</b> — use the Google sign-in below (in the Zillow section), or look a home up and you'll be asked.`;
    return;
  }
  if (CMA.daytonaFeed) {
    el.innerHTML = `<b>Searches Stellar and Daytona.</b> There's nothing to connect.`;
    return;
  }
  if (!f || !f.configured || (!cmaFlexmlsSetup() && !(f.connected && ((f.account || {}).mcp || {}).call?.ok))) {
    el.innerHTML = `<b>Daytona (Flex):</b> Daytona sales aren't available yet — comps come from Stellar.`;
    return;
  }
  if (f.connected) {
    // The server tests the connection with Flexmls's MCP server on every status check
    const m = (f.account || {}).mcp || {};
    const check = (f.account || {}).error ? ` — couldn't test it: ${cmaEsc(f.account.error)}`
      : m.call && m.call.ok ? ' — Flexmls accepts searches ✓'
      : m.call ? ` — but Flexmls refuses searches: "${cmaEsc(m.call.error)}"`
      : m.error ? ` — but Flexmls refuses the connection: "${cmaEsc(m.error.replace(/^MCP error -?\d+:\s*/, ''))}"` : '';
    el.innerHTML = `<b>Daytona (Flex):</b> connected with your Flexmls account${check}. <a href="#" onclick="cmaFlexmlsDisconnect();return false">Disconnect</a>`;
  } else {
    el.innerHTML = `<b>Daytona (Flex):</b> ${f.expired ? 'your Flexmls sign-in has run out — connect again.' : f.fallbackAvailable ? 'using the company\'s Flexmls connection.' : 'not connected — comps come from Stellar only.'}
      <button class="cma-btn-sm" onclick="cmaFlexmlsConnect()">Connect my Flexmls account</button>
      <div class="input-hint">First turn on the MCP server in Flexmls: Preferences → <a href="https://help.flexmls.com/en/ai-settings--enable-the-mcp-server.html" target="_blank">AI Settings</a>, and accept its terms. You sign in on Flexmls's own page — we never see your password.</div>`;
  }
}

async function cmaFlexmlsConnect() {
  try {
    const r = await Auth.api('/flexmls/connect', { body: { returnTo: location.origin + location.pathname + (cmaFlexmlsSetup() ? '?flexmls-setup' : '') } });
    location.href = r.url;
  } catch (e) { cmaStatus('Couldn\'t start the Flexmls sign-in: ' + e.message, 'error'); }
}
async function cmaFlexmlsDisconnect() {
  try { await Auth.api('/flexmls/disconnect', { body: {} }); } catch (_) {}
  cmaFlexmlsStatus();
}

// ── Step 1: the subject ────────────────────────────────────────────────────
// Facts both records carry; where they differ the agent picks (John Adams, 2026-11-05)
const CMA_BOTH = { sqft: 'Living area (sq ft)', beds: 'Bedrooms', baths: 'Bathrooms' };

async function cmaLookup() {
  if (!(await cmaNeedSignIn())) return;
  const address = cmaEl('subjectAddress').value.trim();
  const unit = cmaEl('subjectUnit').value.trim();
  if (!address) return cmaStatus("Enter the subject property's address first.", 'error');
  cmaStatus("🔎 Looking the home up in the MLS and the county property appraiser's records…");
  try {
    const r = await Auth.api('/cma/subject', { body: { address, unit } });
    const mls = r.subject, county = r.county;
    if (!mls && !county) {
      CMA.subject = null; cmaRenderSubject();
      return cmaStatus('Neither the MLS nor the county has a home at that address' + (r.countyError ? ' (county: ' + r.countyError + ')' : '') + '. Check the address — the county needs the house number, street and ZIP.', 'error');
    }
    // Everything except the shared facts comes from the MLS listing when there is one
    const s = mls ? { ...mls } : { address: county.address, city: county.city, zip: county.zip,
      subType: /condo/i.test(county.propertyUse || '') ? 'Condominium' : 'Single Family Residence',
      yearBuilt: null, garage: null, pool: null, water: null, golf: null, subdivision: null, remarks: null, mlsNumber: null };
    if (s.lat == null && county) { s.lat = county.lat; s.lon = county.lon; }
    CMA.records = { mls, county };
    CMA.conflicts = new Set();
    for (const k of Object.keys(CMA_BOTH)) {
      const a = mls ? mls[k] : null, b = county ? county[k] : null;
      if (a != null && b != null && Number(a) !== Number(b)) { s[k] = null; CMA.conflicts.add(k); }
      else s[k] = a ?? b ?? null;
    }
    const found = [
      mls ? (mls.source === 'daytona' ? 'Daytona' : 'Stellar') + ' MLS# ' + mls.mlsNumber + ' (' + mls.status + (mls.closeDate ? ' ' + cmaDate(mls.closeDate) : '') + ')' : 'not in the MLS',
      county ? county.county + ' County parcel ' + county.parcel : 'no county record' + (r.countyError ? ' (' + r.countyError + ')' : ''),
    ];
    const differ = [...CMA.conflicts].map(k => CMA_BOTH[k].toLowerCase()).join(', ');
    cmaStatus('Found: ' + found.join(' · ') + '.' + (differ ? ' The MLS and the county differ on ' + differ + ' — choose which to use below.' : ' Check the facts below.'), differ ? 'error' : 'success');
    CMA.subject = s;
    CMA.analysis = null; CMA.priced = null; CMA.chosen.clear(); CMA.reads = {}; CMA.cellOverrides = {};
    CMA.priceEdited = false; cmaEl('subjectPrice').value = '';   // a new home: the price follows its recommendation again
    cmaEl('subjectSqft').value = s.sqft || '';
    cmaRenderSubject();
    cmaRenderComps(); cmaRenderAdjust(); cmaRenderPrice();
  } catch (e) { cmaStatus("Couldn't look the address up: " + e.message, 'error'); }
}

// The agent picks the MLS or county figure (or types their own)
function cmaPick(k, v) {
  CMA.conflicts.delete(k);
  cmaSubjectSet(k, v);
  cmaRenderSubject();
}

function cmaRenderSubject() {
  const s = CMA.subject, el = cmaEl('cmaSubject');
  if (!s) { el.innerHTML = ''; return; }
  const { mls, county } = CMA.records || {};
  const conflict = k => CMA.conflicts && CMA.conflicts.has(k);
  const fmt = (k, v) => k === 'sqft' ? Number(v).toLocaleString() : v;
  const pick = k => {
    const a = mls ? mls[k] : null, b = county ? county[k] : null;
    if (a == null || b == null || Number(a) === Number(b)) return '';
    const btn = (label, v) => '<button type="button" class="cma-pick' + (s[k] != null && Number(s[k]) === Number(v) ? ' on' : '') + '" onclick="cmaPick(\'' + k + '\', ' + Number(v) + ')">' + label + ' ' + fmt(k, v) + '</button>';
    return '<div class="cma-picks">' + btn('MLS', a) + btn('County', b) + '</div>';
  };
  const num = (k, label, step) => '<div class="' + (conflict(k) ? 'cma-conflict' : '') + '"><label>' + label + '</label>'
    + '<input type="number" step="' + (step || 1) + '" value="' + (s[k] ?? '') + '" placeholder="' + (conflict(k) ? 'Choose ↓' : '') + '"'
    + ' oninput="CMA.conflicts && CMA.conflicts.delete(\'' + k + '\'); cmaSubjectSet(\'' + k + '\', this.value === \'\' ? null : Number(this.value))">' + pick(k) + '</div>';
  const yn = (k, label) => '<div><label>' + label + '</label><select onchange="cmaSubjectSet(\'' + k + '\', this.value === \'\' ? null : this.value === \'yes\')">'
    + '<option value="" ' + (s[k] == null ? 'selected' : '') + '>Unknown</option><option value="yes" ' + (s[k] === true ? 'selected' : '') + '>Yes</option><option value="no" ' + (s[k] === false ? 'selected' : '') + '>No</option></select></div>';
  const read = CMA.reads.subject;
  const countyLine = county
    ? 'County (' + cmaEsc(county.county) + '): parcel ' + cmaEsc(county.parcel)
      + (county.justValue ? ' · just value ' + cmaMoney(county.justValue) : '')
      + (county.stories ? ' · ' + county.stories + (county.stories > 1 ? ' stories' : ' story') : '')
      + (county.lotSqft ? ' · lot ' + county.lotSqft.toLocaleString() + ' sq ft' : '')
      + (county.neighbourhood ? ' · ' + cmaEsc(county.neighbourhood) : '')
    : 'No county record found.';
  const mlsLine = mls
    ? 'MLS: ' + (mls.source === 'daytona' ? 'Daytona' : 'Stellar') + ' ' + cmaEsc(mls.mlsNumber) + ', ' + cmaEsc(mls.status) + (mls.closeDate ? ' ' + cmaDate(mls.closeDate) : '') + ' — pool, water, golf, year built and garage come from this listing.'
    : 'Not in the MLS — enter pool, water, golf, year built and garage yourself.';
  el.innerHTML = '<p class="input-hint" style="margin-bottom:8px">' + mlsLine + '<br>' + countyLine + '</p>'
    + '<div class="cma-grid">'
    + num('sqft', 'Living area (sq ft)') + num('beds', 'Bedrooms') + num('baths', 'Bathrooms', 0.5) + num('yearBuilt', 'Year built') + num('garage', 'Garage spaces')
    + yn('pool', 'Private pool') + yn('golf', 'On a golf course')
    + '<div><label>Water</label><select onchange="cmaSubjectSet(\'water\', this.value || null)"><option value="">Unknown</option>'
    + Object.entries(CMA_WATER).map(([k, v]) => '<option value="' + k + '" ' + (s.water === k ? 'selected' : '') + '>' + v + '</option>').join('') + '</select></div>'
    + '<div><label>Condition</label><select onchange="cmaSubjectSet(\'condition\', this.value === \'\' ? null : Number(this.value))"><option value="">Unknown</option>'
    + CMA_CONDITIONS.map((c, i) => '<option value="' + i + '" ' + (s.condition === i ? 'selected' : '') + '>' + c + '</option>').join('') + '</select></div>'
    + '<div style="grid-column:span 2"><label>Subdivision</label><input type="text" value="' + cmaEsc(s.subdivision || '') + '" oninput="cmaSubjectSet(\'subdivision\', this.value)"></div>'
    + '</div>'
    + (read && read.notes.length ? '<p class="input-hint">AI read of the remarks: ' + cmaEsc(read.notes.join(' · ')) + '</p>' : '')
    + '<button class="button-primary" style="margin-top:12px" onclick="cmaAnalyze()">Find comparable sales</button>';
}

function cmaSubjectSet(k, v) {
  CMA.subject[k] = v;
  if (k === 'sqft' && v) cmaEl('subjectSqft').value = v;
  if (CMA.priced) cmaReprice();
}

// ── Step 2: comparables ────────────────────────────────────────────────────
async function cmaAnalyze() {
  if (!(await cmaNeedSignIn())) return;
  const s = CMA.subject;
  if (!s || s.lat == null) return cmaStatus('The subject\'s location is needed — look the address up first.', 'error');
  if (CMA.conflicts && CMA.conflicts.size) return cmaStatus('Choose the MLS or county figure for ' + [...CMA.conflicts].map(k => CMA_BOTH[k].toLowerCase()).join(', ') + ' first (step 1).', 'error');
  if (!s.sqft) return cmaStatus('Enter the subject\'s living area.', 'error');
  cmaStatus('🔎 Searching closed sales nearby and working out the adjustments… (about 10–30 seconds)');
  try {
    const a = await Auth.api('/cma/analyze', { body: { subject: s } });
    CMA.analysis = a;
    CMA_MAP.fit = true;
    CMA.chosen = new Set(a.candidates.filter(c => c.suggested).map(c => c.mlsNumber));
    CMA.amounts = Object.fromEntries(a.adjustments.adjustments.map(x => [x.key, x.amount]));
    CMA.edited.clear();
    CMA.ratePerMonth = a.adjustments.time.ratePerMonth;
    CMA.cellOverrides = {};
    const src = a.sources.daytona === 'ok' ? 'Stellar and Daytona'
      : a.sources.daytona === 'not_connected' ? (cmaFlexmlsSetup() ? 'Stellar (Daytona not connected)' : "Stellar (Daytona sales aren't available yet)")
      : a.sources.daytona === 'not_enabled' && !cmaFlexmlsSetup() ? "Stellar (Daytona sales aren't available yet)"
      : a.sources.daytona === 'not_enabled' ? `Stellar only — Flexmls refused the Daytona search: "${a.sources.daytonaMessage}"`
      : 'Stellar (Daytona didn\'t answer' + (a.sources.daytonaMessage ? `: ${a.sources.daytonaMessage}` : '') + ')';
    cmaStatus(`Found ${a.candidates.filter(c => c.inTier).length} sales within ${a.tier.miles} mi over ${a.tier.months} months from ${src}. ${CMA.chosen.size} are ticked as the best matches — change the selection as you like.`, 'success');
    cmaRenderComps(); cmaRenderAdjust();
    await cmaReprice();
  } catch (e) { cmaStatus('Couldn\'t search the MLS: ' + e.message, 'error'); }
}

const cmaScoreColor = score => score >= 75 ? '#1A7A4C' : score >= 55 ? '#C9A84C' : '#C0392B';
// The sales shown in the table and on the map
const cmaShownComps = () => CMA.analysis.candidates.filter(c => c.inTier && !c.outlier || CMA.chosen.has(c.mlsNumber) || CMA.showAll);

function cmaRenderComps() {
  const el = cmaEl('cmaComps'), a = CMA.analysis;
  if (!a) { el.innerHTML = ''; cmaRenderMap(); return; }
  const rows = cmaShownComps().map(c => {
    const flag = c.acrossWater && c.acrossWater.length ? ' cma-across' : '';
    const read = CMA.reads[c.mlsNumber];
    return `<tr class="${CMA.chosen.has(c.mlsNumber) ? 'on' : ''}${flag}">
      <td><input type="checkbox" ${CMA.chosen.has(c.mlsNumber) ? 'checked' : ''} onchange="cmaToggle('${cmaEsc(c.mlsNumber)}', this.checked)"></td>
      <td><span class="cma-score" style="background:${cmaScoreColor(c.score)}">${c.score}</span></td>
      <td><b><a href="#" class="cma-comp-link" title="Show on the map" onclick="cmaFocusPin('${cmaEsc(c.mlsNumber)}');return false">${cmaEsc(c.address)}</a></b><div class="cma-sub">${cmaEsc(c.subdivision || '')} · ${c.source === 'daytona' ? 'Daytona' : 'Stellar'} ${cmaEsc(c.mlsNumber)}${c.outlier ? ' · <b>priced far from the others</b>' : ''}${!c.inTier ? ' · outside the search area/time' : ''}</div>
        <div class="cma-reasons">${(c.reasons || []).map(r => `<span${/less comparable/.test(r) ? ' class="warn"' : ''}>${cmaEsc(r)}</span>`).join('')}</div>
        ${read && read.notes.length ? `<div class="cma-sub">AI read: ${cmaEsc(read.notes.join(' · '))}</div>` : ''}</td>
      <td>${cmaDate(c.closeDate)}</td><td>${cmaMoney(c.closePrice)}</td><td>${(c.sqft || 0).toLocaleString()}</td>
      <td>${c.sqft ? cmaMoney(c.closePrice / c.sqft) : '—'}</td><td>${c.beds ?? '—'}/${c.baths ?? '—'}</td><td>${c.yearBuilt || '—'}</td>
      <td>${cmaEsc(CMA_WATER[c.water] || '—')}${c.pool ? '<br>Pool' : ''}${c.golf ? '<br>Golf' : ''}</td>
      <td><select onchange="cmaSetCondition('${cmaEsc(c.mlsNumber)}', this.value)"><option value="">—</option>
        ${CMA_CONDITIONS.map((x, i) => `<option value="${i}" ${c.condition === i ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    </tr>`;
  }).join('');
  const listings = (a.listings || []).filter(l => l.sqft && l.listPrice);
  el.innerHTML = `
    <div class="cma-toolbar">
      <label class="check-label" style="font-weight:400"><input type="checkbox" id="cmaShowAll" ${CMA.showAll ? 'checked' : ''} onchange="CMA.showAll = this.checked; cmaRenderComps()"> Show sales left out (outliers, outside the area)</label>
      <button class="cma-btn-sm" onclick="cmaReadRemarks()">✨ Read the remarks (condition)</button>
    </div>
    <div class="cma-table-wrap"><table class="cma-table">
      <tr><th></th><th>Score</th><th>Sale</th><th>Sold</th><th>Price</th><th>Sq ft</th><th>$/sq ft</th><th>Bd/Ba</th><th>Built</th><th>Features</th><th>Condition</th></tr>
      ${rows}</table></div>
    <p class="input-hint">Score out of 100: distance, subdivision, size, how recent, beds/baths, water, age, golf, pool and kind of home. Sales across a major waterway are marked and scored lower — use them only when the subject's side has too few.</p>
    ${listings.length ? `<details style="margin-top:10px"><summary><b>${listings.length} active and pending listings within a mile</b> (the competition — not used in the price)</summary>
      <div class="cma-table-wrap"><table class="cma-table"><tr><th>Address</th><th>Status</th><th>List price</th><th>Sq ft</th><th>$/sq ft</th><th>Days</th></tr>
      ${listings.slice(0, 40).map(l => `<tr><td>${cmaEsc(l.address)}</td><td>${cmaEsc(l.status)}</td><td>${cmaMoney(l.listPrice)}</td><td>${l.sqft.toLocaleString()}</td><td>${cmaMoney(l.listPrice / l.sqft)}</td><td>${l.dom ?? '—'}</td></tr>`).join('')}
      </table></div></details>` : ''}`;
  cmaRenderMap();
}

// ── The map (workshop-map.js) ──────────────────────────────────────────────
// Pins are updated in place so ticking a sale doesn't move the map. It's fitted
// only on a new search. If Google won't draw it, the table still does everything.
const CMA_MAP = { map: null, pins: new Map(), info: null, openKey: null, fit: false };
const CMA_STAR = 'M0,-12 L3.5,-4 L12,-4 L5,1.5 L7.5,10 L0,5 L-7.5,10 L-5,1.5 L-12,-4 L-3.5,-4 Z';

// How a sold comp looks: solid and larger when used, hollow when not; orange edge across the water
function cmaPinStyle(c, used) {
  const color = cmaScoreColor(c.score);
  const across = !!(c.acrossWater && c.acrossWater.length);
  return {
    scale: used ? 9 : 6,
    fillColor: used ? color : '#FFFFFF',
    fillOpacity: 1,
    strokeColor: across ? '#E67E22' : used ? '#FFFFFF' : color,
    strokeWeight: across ? 3 : used ? 1.5 : 2,
  };
}

const cmaHasPoint = r => r && r.lat != null && r.lon != null;

// What belongs on the map now: { key: { kind, record } }
function cmaMapItems() {
  const items = new Map(), a = CMA.analysis;
  if (!a) return items;
  if (cmaHasPoint(CMA.subject)) items.set('subject', { kind: 'subject', record: CMA.subject });
  for (const c of cmaShownComps()) if (cmaHasPoint(c)) items.set('c:' + c.mlsNumber, { kind: 'comp', record: c });
  if (cmaEl('cmaMapListings')?.checked) {
    for (const l of a.listings || []) if (cmaHasPoint(l)) items.set('l:' + l.mlsNumber, { kind: 'listing', record: l });
  }
  return items;
}

function cmaPinOptions({ kind, record }) {
  const circle = google.maps.SymbolPath.CIRCLE;
  if (kind === 'subject') return { zIndex: 1000, title: record.address, icon: { path: CMA_STAR, scale: 1.3, fillColor: '#1B3A5C', fillOpacity: 1, strokeColor: '#C9A84C', strokeWeight: 1.5 } };
  if (kind === 'listing') return { zIndex: 1, title: record.address, icon: { path: circle, scale: 5, fillColor: /^active$/i.test(record.status || '') ? '#2E75B6' : '#6B7280', fillOpacity: 0.9, strokeColor: '#FFFFFF', strokeWeight: 1 } };
  const used = CMA.chosen.has(record.mlsNumber);
  return { zIndex: used ? 100 + record.score : record.score, title: record.address, icon: { path: circle, ...cmaPinStyle(record, used) } };
}

// Built as elements, with listing text escaped, so the button needs no inline handler
function cmaPinContent({ kind, record: r }) {
  const box = document.createElement('div');
  box.className = 'cma-pin-info';
  const facts = [r.beds != null || r.baths != null ? `${r.beds ?? '—'} bd / ${r.baths ?? '—'} ba` : '', r.sqft ? Number(r.sqft).toLocaleString() + ' sq ft' : ''].filter(Boolean).join(' · ');
  if (kind === 'subject') {
    box.innerHTML = `<b>${cmaEsc(r.address)}</b><div>The home you're pricing</div><div>${cmaEsc(facts)}</div>`;
  } else if (kind === 'listing') {
    box.innerHTML = `<b>${cmaEsc(r.address)}</b><div>${cmaEsc(r.status)} · ${cmaMoney(r.listPrice)}${r.sqft && r.listPrice ? ' · ' + cmaMoney(r.listPrice / r.sqft) + '/sq ft' : ''}</div>
      <div>${cmaEsc(facts)}${r.dom != null ? ' · ' + cmaEsc(r.dom) + ' days' : ''}</div>`;
  } else {
    const reasons = r.reasons || [];
    const warn = reasons.filter(x => /less comparable/.test(x)), others = reasons.filter(x => !/less comparable/.test(x));
    box.innerHTML = `<b>${cmaEsc(r.address)}</b><div>Sold ${cmaDate(r.closeDate)} · ${cmaMoney(r.closePrice)}${r.sqft ? ' · ' + cmaMoney(r.closePrice / r.sqft) + '/sq ft' : ''}</div>
      <div>${cmaEsc(facts)} · Score ${cmaEsc(r.score)}</div>
      ${warn.map(x => `<div class="warn">${cmaEsc(x)}</div>`).join('')}
      ${others.length ? `<div>${cmaEsc(others.join(' · '))}</div>` : ''}`;
    const used = CMA.chosen.has(r.mlsNumber);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cma-btn-sm';
    btn.style.marginLeft = '0';
    btn.textContent = used ? "Don't use this sale" : 'Use this sale';
    btn.addEventListener('click', () => cmaToggle(r.mlsNumber, !used));
    box.appendChild(btn);
  }
  return box;
}

function cmaOpenPin(key) {
  const pin = CMA_MAP.pins.get(key);
  if (!pin) return;
  CMA_MAP.openKey = key;
  CMA_MAP.info.setContent(cmaPinContent(pin.item));
  CMA_MAP.info.open({ map: CMA_MAP.map, anchor: pin.marker });
}

// From a table row's address
function cmaFocusPin(mls) {
  const pin = CMA_MAP.pins.get('c:' + mls);
  if (!pin) return;
  cmaEl('cmaMapWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  CMA_MAP.map.panTo(pin.marker.getPosition());
  cmaOpenPin('c:' + mls);
}

function cmaMapFailed() {
  cmaEl('cmaMapWrap').innerHTML = '<p class="input-hint">The map couldn\'t load just now — everything below still works from the table.</p>';
}

async function cmaRenderMap() {
  const wrap = cmaEl('cmaMapWrap');
  if (!CMA.analysis) {
    wrap.style.display = 'none';
    CMA_MAP.pins.forEach(p => p.marker.setMap(null));
    CMA_MAP.pins.clear();
    if (CMA_MAP.info) CMA_MAP.info.close();
    CMA_MAP.openKey = null;
    return;
  }
  wrap.style.display = '';
  if (WorkshopMap.failed) return cmaMapFailed();
  try { await WorkshopMap.load(); } catch (_) { return cmaMapFailed(); }
  if (WorkshopMap.failed) return cmaMapFailed();
  if (!CMA.analysis) return;   // changed while Google's script loaded
  if (!CMA_MAP.map) {
    WorkshopMap.onFailure(cmaMapFailed);
    CMA_MAP.map = WorkshopMap.create(cmaEl('cmaMap'), { center: { lat: CMA.subject.lat, lng: CMA.subject.lon } });
    CMA_MAP.info = new google.maps.InfoWindow();
    CMA_MAP.info.addListener('closeclick', () => { CMA_MAP.openKey = null; });
  }
  const items = cmaMapItems();
  for (const [key, pin] of CMA_MAP.pins) {
    if (!items.has(key)) { pin.marker.setMap(null); CMA_MAP.pins.delete(key); }
  }
  for (const [key, item] of items) {
    const position = { lat: Number(item.record.lat), lng: Number(item.record.lon) };
    let pin = CMA_MAP.pins.get(key);
    if (!pin) {
      pin = { marker: new google.maps.Marker({ map: CMA_MAP.map, position }), item };
      pin.marker.addListener('click', () => cmaOpenPin(key));
      CMA_MAP.pins.set(key, pin);
    }
    pin.item = item;
    pin.marker.setPosition(position);
    pin.marker.setOptions(cmaPinOptions(item));
  }
  if (CMA_MAP.fit) {
    CMA_MAP.fit = false;
    const fitTo = [...items.values()].filter(i => i.kind === 'subject' || (i.kind === 'comp' && CMA.chosen.has(i.record.mlsNumber)));
    WorkshopMap.fit(CMA_MAP.map, fitTo.map(i => ({ lat: Number(i.record.lat), lng: Number(i.record.lon) })));
  }
  // An open info window follows its pin's changes, such as Use / Don't use
  if (CMA_MAP.openKey) {
    if (CMA_MAP.pins.has(CMA_MAP.openKey)) CMA_MAP.info.setContent(cmaPinContent(CMA_MAP.pins.get(CMA_MAP.openKey).item));
    else { CMA_MAP.info.close(); CMA_MAP.openKey = null; }
  }
}

// The report's map: a Static Maps image, the subject plus chosen comps lettered A, B, C…
// in the order of the report's table. Stays under Google's 8,192-character URL limit.
const CMA_STATIC_MAX = 8000;
const cmaCompLetter = i => i < 26 ? String.fromCharCode(65 + i) : '';
function cmaStaticMapUrl(subject, comps, key = WorkshopMap.KEY) {
  const params = new URLSearchParams({ size: '640x270', scale: '2', maptype: 'roadmap', key });
  const hasSubject = cmaHasPoint(subject);
  if (hasSubject) params.append('markers', `color:0x1B3A5C|label:H|${subject.lat},${subject.lon}`);
  let added = 0;
  (comps || []).forEach((c, i) => {
    const letter = cmaCompLetter(i);
    if (!letter || !cmaHasPoint(c)) return;
    const across = c.acrossWater && c.acrossWater.length;
    const next = new URLSearchParams(params);
    next.append('markers', `color:${across ? '0xE67E22' : '0x2E75B6'}|label:${letter}|${c.lat},${c.lon}`);
    if (`https://maps.googleapis.com/maps/api/staticmap?${next}`.length > CMA_STATIC_MAX) return;
    params.append('markers', `color:${across ? '0xE67E22' : '0x2E75B6'}|label:${letter}|${c.lat},${c.lon}`);
    added++;
  });
  if (!hasSubject && !added) return null;
  return `https://maps.googleapis.com/maps/api/staticmap?${params}`;
}

function cmaToggle(mls, on) {
  on ? CMA.chosen.add(mls) : CMA.chosen.delete(mls);
  cmaRenderComps();
  cmaReprice();
}

function cmaSetCondition(mls, v) {
  const c = CMA.analysis.candidates.find(x => x.mlsNumber === mls);
  if (c) c.condition = v === '' ? null : Number(v);
  cmaReprice();
}

async function cmaReadRemarks() {
  const chosen = cmaChosenComps();
  if (!chosen.length) return cmaStatus('Tick some comparables first.', 'error');
  cmaStatus('✨ Reading the listing remarks for condition and features the MLS fields miss…');
  try {
    const r = await Auth.api('/cma/read-remarks', { body: { subject: CMA.subject, comps: chosen } });
    CMA.reads = r.reads || {};
    for (const c of CMA.analysis.candidates) if (CMA.reads[c.mlsNumber] && CMA.reads[c.mlsNumber].condition != null) c.condition = CMA.reads[c.mlsNumber].condition;
    if (CMA.reads.subject && CMA.reads.subject.condition != null && CMA.subject.condition == null) CMA.subject.condition = CMA.reads.subject.condition;
    cmaStatus('Condition filled in from the remarks — check each one; you know these homes better than the remarks do.', 'success');
    cmaRenderSubject(); cmaRenderComps();
    cmaReprice();
  } catch (e) { cmaStatus(e.message, 'error'); }
}

const cmaChosenComps = () => CMA.analysis ? CMA.analysis.candidates.filter(c => CMA.chosen.has(c.mlsNumber)) : [];

// ── Step 3: adjustments ────────────────────────────────────────────────────
function cmaRenderAdjust() {
  const el = cmaEl('cmaAdjust'), a = CMA.analysis;
  if (!a) { el.innerHTML = ''; return; }
  const badge = m => `<span class="cma-method ${m}">${m === 'regression' ? 'measured' : m === 'paired' ? 'paired sales' : 'estimate'}</span>`;
  const rows = a.adjustments.adjustments.map(x => `
    <tr class="${CMA.edited.has(x.key) ? 'edited' : ''}"><td>${cmaEsc(x.label)}</td>
      <td><input type="number" step="500" value="${CMA.amounts[x.key]}" onchange="cmaSetAmount('${x.key}', this.value)"></td>
      <td>${CMA.edited.has(x.key) ? '<span class="cma-method edited">changed by you</span>' : badge(x.method)}</td>
      <td class="cma-basis">${cmaEsc(x.basis)}</td></tr>`).join('');
  const t = a.adjustments.time;
  const measured = a.adjustments.adjustments.filter(x => x.method !== 'estimate').length;
  // Rolled up like the active/pending listings; stays open across re-renders once opened
  el.innerHTML = `
    <details ${CMA.adjOpen ? 'open' : ''} ontoggle="CMA.adjOpen = this.open">
    <summary><b>Adjustment amounts and grid</b> — ${measured} measured from local sales, ${a.adjustments.adjustments.length - measured} estimated${CMA.edited.size ? `, ${CMA.edited.size} changed by you` : ''} (open to review or change)</summary>
    <p class="input-hint">Worked out from ${a.pool.sales} sales of this kind of home within ${a.pool.radiusMiles} miles over ${a.pool.months} months${a.pool.sameSideOnly ? ', on the subject\'s side of the water' : ''}. Each comparable is moved toward the subject by these amounts; size is handled by the price per square foot, so it isn't adjusted here.</p>
    <div class="cma-table-wrap"><table class="cma-table cma-adj">
      <tr><th>Difference</th><th>Amount</th><th>How</th><th>Basis</th></tr>${rows}
      <tr class="${CMA.edited.has('time') ? 'edited' : ''}"><td>Market change (per month)</td>
        <td><input type="number" step="0.1" value="${(CMA.ratePerMonth * 100).toFixed(2)}" onchange="cmaSetRate(this.value)"> %</td>
        <td>${CMA.edited.has('time') ? '<span class="cma-method edited">changed by you</span>' : badge(t.method)}</td><td class="cma-basis">${cmaEsc(t.basis)}</td></tr>
    </table></div>
    <div id="cmaGrid"></div>
    </details>`;
  cmaRenderGrid();
}

function cmaSetAmount(key, v) { CMA.amounts[key] = Number(v) || 0; CMA.edited.add(key); cmaRenderAdjust(); cmaReprice(); }
function cmaSetRate(v) { CMA.ratePerMonth = (Number(v) || 0) / 100; CMA.edited.add('time'); cmaRenderAdjust(); cmaReprice(); }

function cmaRenderGrid() {
  const el = cmaEl('cmaGrid');
  if (!el) return;
  const p = CMA.priced;
  if (!p || !p.comps.length) { el.innerHTML = ''; return; }
  const keys = [...new Set(p.comps.flatMap(c => c.lines.map(l => l.key)))];
  const label = k => (p.comps.flatMap(c => c.lines).find(l => l.key === k) || {}).label || k;
  el.innerHTML = `<h4 style="margin:16px 0 6px;color:var(--navy)">Adjustment grid</h4>
    <p class="input-hint">Change any cell to override it for that sale only.</p>
    <div class="cma-table-wrap"><table class="cma-table cma-grid-t">
    <tr><th>Sale</th><th>Sold for</th>${keys.map(k => `<th>${cmaEsc(label(k))}</th>`).join('')}<th>Adjusted</th><th>Adj. $/sq ft</th></tr>
    ${p.comps.map(c => {
      const over = CMA.cellOverrides[c.mlsNumber] || {};
      return `<tr><td>${cmaEsc(c.address)}</td><td>${cmaMoney(c.closePrice)}</td>
      ${keys.map(k => { const l = c.lines.find(x => x.key === k); const v = over[k] ?? (l ? l.amount : 0);
        return `<td class="${over[k] != null ? 'edited' : ''}"><input type="number" step="500" value="${v}" onchange="cmaSetCell('${cmaEsc(c.mlsNumber)}','${k}',this.value)"></td>`; }).join('')}
      <td><b>${cmaMoney(c.adjustedPrice)}</b></td><td>${cmaMoney(c.adjustedPrice / c.sqft)}</td></tr>`; }).join('')}
    </table></div>`;
}

function cmaSetCell(mls, key, v) {
  (CMA.cellOverrides[mls] = CMA.cellOverrides[mls] || {})[key] = Number(v) || 0;
  cmaReprice();
}

// ── Step 4: the price ──────────────────────────────────────────────────────
let cmaRepriceTimer = null;
function cmaReprice() {
  clearTimeout(cmaRepriceTimer);
  return new Promise(resolve => {
    cmaRepriceTimer = setTimeout(async () => {
      const comps = cmaChosenComps().map(c => ({ ...c, remarks: undefined, cellOverrides: CMA.cellOverrides[c.mlsNumber] || {} }));
      try {
        CMA.priced = await Auth.api('/cma/price', { body: { subject: CMA.subject, comps, amounts: CMA.amounts, ratePerMonth: CMA.ratePerMonth } });
      } catch (e) { cmaStatus('Couldn\'t work out the price: ' + e.message, 'error'); }
      cmaRenderGrid(); cmaRenderPrice();
      resolve();
    }, 250);
  });
}

function cmaRenderPrice() {
  const el = cmaEl('cmaPrice'), p = CMA.priced;
  if (!p) { el.innerHTML = ''; return; }
  const r = p.recommendation;
  if (r.status !== 'ok') { el.innerHTML = `<p class="input-hint">${cmaEsc(r.reason)}</p>`; return; }
  // The report's list price (step 5) follows the recommendation until the agent types their own
  if (!CMA.priceEdited) cmaEl('subjectPrice').value = r.value;
  el.innerHTML = `
    <div class="cma-price">
      <div><div class="cma-big">${cmaMoney(r.value)}</div><div class="cma-sub">Recommended price · range ${cmaMoney(r.low)} – ${cmaMoney(r.high)}</div></div>
    </div>
    <table class="cma-table" style="margin-top:10px"><tr><th>Adjusted $/sq ft</th><th>Per sq ft</th><th>Value at ${Number(CMA.subject.sqft).toLocaleString()} sq ft</th></tr>
      ${r.table.map(t => `<tr><td>${t.label}</td><td>${cmaMoney(t.pricePerSqft)}</td><td>${cmaMoney(t.value)}</td></tr>`).join('')}</table>
    <p class="input-hint">${cmaEsc(r.how)}</p>`;
}

// ── Into the report ────────────────────────────────────────────────────────
// Rows in parseMLSData()'s shape, so the existing market pages work from the search
function cmaMarketRows() {
  const a = CMA.analysis;
  if (!a) return [];
  const sold = a.candidates.filter(c => c.inTier && c.closePrice && c.sqft).map(c => ({
    status: 'Closed', sqft: c.sqft, price: c.closePrice, pricePerSqft: c.closePrice / c.sqft,
    closeDate: c.closeDate ? new Date(c.closeDate + 'T12:00:00') : null, dom: c.dom, city: c.city || '', zip: c.zip || '' }));
  const active = (a.listings || []).filter(l => /^active$/i.test(l.status || '') && l.listPrice && l.sqft).map(l => ({
    status: 'Active', sqft: l.sqft, price: l.listPrice, pricePerSqft: l.listPrice / l.sqft, closeDate: null, dom: l.dom, city: l.city || '', zip: l.zip || '' }));
  return [...sold, ...active];
}

// Snapshot for the printed report
function cmaReportData() {
  if (!CMA.priced || CMA.priced.recommendation.status !== 'ok') return null;
  const byMls = Object.fromEntries(cmaChosenComps().map(c => [c.mlsNumber, c]));
  return {
    subject: { ...CMA.subject },
    comps: CMA.priced.comps.map(p => ({ ...byMls[p.mlsNumber], ...p })),
    recommendation: CMA.priced.recommendation,
    adjustments: CMA.analysis.adjustments.adjustments.map(x => ({ ...x, amount: CMA.amounts[x.key], edited: CMA.edited.has(x.key) })),
    ratePerMonth: CMA.ratePerMonth, rateEdited: CMA.edited.has('time'),
    overrides: Object.entries(CMA.cellOverrides).flatMap(([mls, o]) => Object.entries(o).map(([k, v]) => ({ address: (byMls[mls] || {}).address, key: k, amount: v }))),
    pool: CMA.analysis.pool, tier: CMA.analysis.tier, listPrice: Number(cmaEl('subjectPrice').value) || null,
  };
}

function cmaPagesHTML(d, header) {
  const footer = '<div class="page-footer">© Adams, Cameron &amp; Co. 2026</div>';
  const page = content => `<section class="print-page">${header}<div class="page-body zg-body">${content}</div>${footer}</section>`;
  const s = d.subject, r = d.recommendation;
  const facts = [['Living area', s.sqft ? Number(s.sqft).toLocaleString() + ' sq ft' : '—'], ['Bedrooms / baths', `${s.beds ?? '—'} / ${s.baths ?? '—'}`],
    ['Year built', s.yearBuilt || '—'], ['Garage', s.garage != null ? s.garage + ' spaces' : '—'], ['Pool', s.pool == null ? '—' : s.pool ? 'Yes' : 'No'],
    ['Water', CMA_WATER[s.water] || '—'], ['Golf course', s.golf == null ? '—' : s.golf ? 'Yes' : 'No'], ['Condition', s.condition != null ? CMA_CONDITIONS[s.condition] : '—'],
    ['Subdivision', s.subdivision || '—']];
  const keys = [...new Set(d.comps.flatMap(c => c.lines.map(l => l.key)))];
  const label = k => (d.comps.flatMap(c => c.lines).find(l => l.key === k) || {}).label || k;
  const changed = d.adjustments.filter(a => a.edited);
  const mapUrl = cmaStaticMapUrl(s, d.comps);
  return page(`
      <h2 style="color:#1e3c72;margin-bottom:6px">Comparative Market Analysis</h2>
      <p style="margin-bottom:12px"><b>${zgEsc(s.address)}</b>${s.city ? ', ' + zgEsc(s.city) : ''}</p>
      <div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
        <table class="zg-compact">${facts.map(([k, v]) => `<tr><td>${k}</td><td>${zgEsc(v)}</td></tr>`).join('')}</table>
        <div style="flex:1;min-width:240px;background:#f4f6f9;border-radius:8px;padding:16px">
          <div style="font-size:.8em;color:#666;text-transform:uppercase;letter-spacing:.5px">Recommended price</div>
          <div style="font-size:2em;font-weight:700;color:#1e3c72">${cmaMoney(r.value)}</div>
          <div style="color:#555">Range ${cmaMoney(r.low)} – ${cmaMoney(r.high)}</div>
          ${d.listPrice ? `<div style="margin-top:10px">Suggested list price: <b>${cmaMoney(d.listPrice)}</b></div>` : ''}
        </div>
      </div>
      ${mapUrl ? `<div style="margin-top:14px"><img src="${cmaEsc(mapUrl)}" alt="Map of this home (H) and the comparable sales" style="width:100%;display:block;border:1px solid #ddd;border-radius:6px" onerror="this.parentNode.style.display='none'"></div>` : ''}
      <h3 style="color:#1e3c72;margin:18px 0 6px">Comparable sales</h3>
      <table class="zg-compact"><tr>${mapUrl ? '<th></th>' : ''}<th>Address</th><th>Sold</th><th>Price</th><th>Sq ft</th><th>Bd/Ba</th><th>Built</th><th>Distance</th><th>Adjusted</th><th>Adj. $/sq ft</th></tr>
        ${d.comps.map((c, i) => `<tr>${mapUrl ? `<td><b>${cmaCompLetter(i)}</b></td>` : ''}<td>${zgEsc(c.address)}${c.acrossWater && c.acrossWater.length ? ' *' : ''}</td><td>${cmaDate(c.closeDate)}</td><td>${cmaMoney(c.closePrice)}</td><td>${(c.sqft || 0).toLocaleString()}</td>
          <td>${c.beds ?? '—'}/${c.baths ?? '—'}</td><td>${c.yearBuilt || '—'}</td><td>${c.distanceMiles != null ? c.distanceMiles + ' mi' : '—'}</td><td><b>${cmaMoney(c.adjustedPrice)}</b></td><td>${cmaMoney(c.adjustedPrice / c.sqft)}</td></tr>`).join('')}</table>
      ${d.comps.some(c => c.acrossWater && c.acrossWater.length) ? '<p style="font-size:.8em;color:#666;margin-top:4px">* Across a major waterway from the subject — less comparable, used because the subject\'s side had too few recent sales.</p>' : ''}
      <h3 style="color:#1e3c72;margin:18px 0 6px">Price per square foot after adjustments</h3>
      <table class="zg-compact"><tr><th></th><th>Per sq ft</th><th>Value at ${Number(s.sqft).toLocaleString()} sq ft</th></tr>
        ${r.table.map(t => `<tr><td>${t.label}</td><td>${cmaMoney(t.pricePerSqft)}</td><td>${cmaMoney(t.value)}</td></tr>`).join('')}</table>
      <p style="font-size:.85em;color:#555;margin-top:6px">${zgEsc(r.how)}</p>`)
    + page(`
      <h2 style="color:#1e3c72;margin-bottom:6px">Adjustments</h2>
      <p style="font-size:.85em;color:#555;margin-bottom:10px">Each sale is adjusted toward the subject for its differences. Amounts are measured from ${d.pool.sales} local sales over ${d.pool.months} months where the data allows${changed.length || d.rateEdited ? '; amounts marked † were set by the agent' : ''}.</p>
      <table class="zg-compact"><tr><th>Sale</th><th>Sold for</th>${keys.map(k => `<th>${zgEsc(label(k))}</th>`).join('')}<th>Adjusted</th></tr>
        ${d.comps.map(c => `<tr><td>${zgEsc(c.address)}</td><td>${cmaMoney(c.closePrice)}</td>${keys.map(k => { const l = c.lines.find(x => x.key === k); return `<td>${l ? cmaMoney(l.amount) : ''}</td>`; }).join('')}<td><b>${cmaMoney(c.adjustedPrice)}</b></td></tr>`).join('')}</table>
      <h3 style="color:#1e3c72;margin:16px 0 6px">Amounts used</h3>
      <table class="zg-compact"><tr><th>Difference</th><th>Amount</th><th>Basis</th></tr>
        ${d.adjustments.filter(a => d.comps.some(c => c.lines.some(l => l.key === a.key))).map(a => `<tr><td>${zgEsc(a.label)}${a.edited ? ' †' : ''}</td><td>${cmaMoney(a.amount)}</td><td style="font-size:.85em">${a.edited ? 'Set by the agent' : zgEsc(a.basis)}</td></tr>`).join('')}
        ${d.ratePerMonth ? `<tr><td>Market change${d.rateEdited ? ' †' : ''}</td><td>${(d.ratePerMonth * 100).toFixed(2)}% a month</td><td style="font-size:.85em">${d.rateEdited ? 'Set by the agent' : 'Measured from local sales'}</td></tr>` : ''}</table>
      ${d.overrides.length ? `<p style="font-size:.85em;color:#555;margin-top:8px">Changed by the agent for single sales: ${d.overrides.map(o => `${zgEsc(o.address)} (${zgEsc(label(o.key))} ${cmaMoney(o.amount)})`).join('; ')}.</p>` : ''}
      <p style="font-size:.8em;color:#777;margin-top:14px">This analysis is an estimate of market value prepared by a real estate licensee from MLS sales data. It is not an appraisal. Waterway boundaries: © OpenStreetMap contributors.</p>`);
}

// Back from the Flexmls sign-in page
window.addEventListener('load', () => {
  const p = new URLSearchParams(location.search);
  const f = p.get('flexmls');
  if (!f) return;
  history.replaceState(null, '', location.pathname);
  cmaSetMode('search');
  cmaStatus(f === 'connected' ? 'Your Flexmls account is connected — Daytona sales are included in your searches.'
    : f === 'expired' ? 'The Flexmls sign-in took too long — try connecting again.' : 'The Flexmls sign-in didn\'t finish — try again.', f === 'connected' ? 'success' : 'error');
});
