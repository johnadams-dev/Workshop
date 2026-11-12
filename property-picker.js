// property-picker.js — "Is this the property?" for Prepare a Listing and the contract
// writer (John Adams, 2026-11-12: "agent confirmation of the correct information is the
// only way to make it work"). The county's search can't always tell units apart, so
// nothing is filled in until the agent confirms the parcel or picks it from the list.
//
//   PropertyPicker.show(el, response, { onConfirm, onPick, onChange, onManual })
//     response: the /lookup answer { status, chosen, candidates, message, facts }
//       "choose": the list; onPick(candidate) when one is clicked
//       "match":  the confirm card; onConfirm() for "Yes", onChange() for "No"
//       "none":   what we couldn't find; onManual() to fill it in by hand
//   PropertyPicker.confirmed(el, chosen, { onChange }) -> a one-line "Confirmed" bar
//   PropertyPicker.clear(el)
(() => {
  const css = `
  .pp-card { margin-top: 14px; border: 2px solid #C9A84C; background: #FDF6E3; border-radius: 10px; padding: 14px 16px; }
  .pp-card h3 { font-size: 16px; color: #1B3A5C; margin: 0 0 8px; }
  .pp-card .pp-msg { font-size: 13px; color: #6B7280; margin: 0 0 10px; line-height: 1.45; }
  .pp-addr { font-size: 18px; font-weight: 700; color: #1A1D23; }
  .pp-meta { font-size: 13px; color: #374151; margin-top: 6px; line-height: 1.5; }
  .pp-meta b { color: #1B3A5C; }
  .pp-legal { font-size: 13px; margin-top: 6px; padding: 8px 10px; background: #fff; border-radius: 6px; border: 1px solid #E5E7EB; line-height: 1.45; }
  .pp-btns { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  .pp-btn { border: 0; border-radius: 6px; padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .pp-yes { background: #1A7A4C; color: #fff; } .pp-yes:hover { background: #156640; }
  .pp-no { background: #fff; color: #1B3A5C; border: 1px solid #DDE1E9; } .pp-no:hover { border-color: #2E75B6; }
  .pp-filter { width: 100%; max-width: 320px; padding: 8px 10px; border: 1px solid #DDE1E9; border-radius: 6px; font-size: 14px; margin-bottom: 8px; }
  .pp-list { max-height: 420px; overflow: auto; display: grid; gap: 6px; }
  .pp-item { text-align: left; background: #fff; border: 1px solid #DDE1E9; border-radius: 8px; padding: 9px 12px; cursor: pointer; font-family: inherit; font-size: 14px; color: #1A1D23; }
  .pp-item:hover, .pp-item:focus-visible { border-color: #2E75B6; outline: none; box-shadow: 0 0 0 2px rgba(46,117,182,.2); }
  .pp-item .pp-u { font-weight: 700; color: #1B3A5C; }
  .pp-item .pp-l { display: block; font-size: 12px; color: #6B7280; margin-top: 3px; line-height: 1.4; }
  .pp-bar { margin-top: 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; color: #1A7A4C; background: #E8F4EE; border-radius: 8px; padding: 8px 12px; }
  .pp-bar button { background: none; border: 0; color: #2E75B6; font-weight: 600; cursor: pointer; font-size: 13px; padding: 0; font-family: inherit; text-decoration: underline; }
  a.pp-pa { color: #2E75B6; font-weight: 600; }`;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tc = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(N|S|E|W|Ne|Nw|Se|Sw)\b/g, (m) => m.toUpperCase());
  const paLink = (url, county) => url ? `<a class="pp-pa" href="${esc(url)}" target="_blank" rel="noopener">${esc(county)} Property Appraiser ↗</a>` : "";

  function choose(el, r, o) {
    const list = r.candidates || [];
    el.innerHTML = `<div class="pp-card"><h3>Which property is it?</h3>
      <p class="pp-msg">${esc(r.message || "Choose the property from the county's records.")} Each one's legal description is shown so you can tell them apart.</p>
      ${list.length > 8 ? `<input class="pp-filter" type="search" placeholder="Type the unit number to narrow the list" aria-label="Filter the list">` : ""}
      <div class="pp-list" role="list">${list.map((c, i) => `<button type="button" class="pp-item" data-i="${i}" role="listitem">
        <span class="pp-u">${c.unit ? `Unit ${esc(c.unit)}` : esc(tc(c.address))}</span>${c.unit ? ` · ${esc(tc(c.address.replace(/\s*#.*$/, "")))}` : ""}${c.city ? `, ${esc(tc(c.city))}` : ""}
        <span class="pp-l">${esc(c.legal || c.use || "")}${c.parcel ? ` · Parcel ${esc(c.parcel)}` : ""}</span></button>`).join("")}</div>
      <div class="pp-btns">${o.onManual ? `<button type="button" class="pp-btn pp-no" data-manual>It isn't in this list</button>` : ""}</div></div>`;
    el.querySelectorAll(".pp-item").forEach((b) => b.addEventListener("click", () => o.onPick && o.onPick(list[Number(b.dataset.i)])));
    const f = el.querySelector(".pp-filter");
    if (f) {
      f.addEventListener("input", () => {
        const q = f.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        el.querySelectorAll(".pp-item").forEach((b) => { const c = list[Number(b.dataset.i)]; b.hidden = !!q && !`${c.unit} ${c.legal} ${c.address}`.toUpperCase().replace(/[^A-Z0-9 ]/g, "").split(" ").some((w) => w.startsWith(q)) && !`${c.unit}`.toUpperCase().replace(/[^A-Z0-9]/g, "").includes(q); });
      });
      f.focus();
    }
    const m = el.querySelector("[data-manual]"); if (m) m.addEventListener("click", () => o.onManual());
  }

  function confirm(el, r, o) {
    const c = r.chosen || {}, f = r.facts || {};
    el.innerHTML = `<div class="pp-card"><h3>Is this the property?</h3>
      ${r.message ? `<p class="pp-msg">${esc(r.message)}</p>` : `<p class="pp-msg">Check the unit, the legal description and the owner against what you know before going on.</p>`}
      <div class="pp-addr">${esc(f.address || c.address)}</div>
      <div class="pp-meta">${c.unit ? `<b>Unit ${esc(c.unit)}</b> · ` : ""}${f.county ? `${esc(f.county)} County` : ""}${f.parcel ? ` · Parcel ${esc(f.parcel)}` : ""}${c.use ? ` · ${esc(c.use)}` : ""}
        ${f.owner ? `<br>Owner of record: <b>${esc(f.owner)}</b>` : "<br>No owner on record."}</div>
      <div class="pp-legal"><b>Legal description:</b> ${esc(f.legalDescription || c.legal || "none on record")}</div>
      <div class="pp-btns"><button type="button" class="pp-btn pp-yes" data-yes>Yes, this is it</button>
        <button type="button" class="pp-btn pp-no" data-no>No, choose another</button>
        <span style="align-self:center">${paLink(c.appraiserUrl, f.county || c.county)}</span></div></div>`;
    el.querySelector("[data-yes]").addEventListener("click", () => o.onConfirm && o.onConfirm());
    el.querySelector("[data-no]").addEventListener("click", () => o.onChange && o.onChange());
    el.querySelector("[data-yes]").focus();
  }

  function none(el, r, o) {
    el.innerHTML = `<div class="pp-card"><h3>We couldn't find it in the county's records</h3>
      <p class="pp-msg">${esc(r.message || "Check the address, including the street direction and type.")} New homes can take a few months to appear. You can look it up on the
        <a class="pp-pa" href="https://vcpa.vcgov.org/" target="_blank" rel="noopener">Volusia</a> or
        <a class="pp-pa" href="https://qpublic.net/fl/flagler/" target="_blank" rel="noopener">Flagler</a> Property Appraiser's site.</p>
      <div class="pp-btns">${o.onManual ? `<button type="button" class="pp-btn pp-no" data-manual>Fill in the details myself</button>` : ""}</div></div>`;
    const m = el.querySelector("[data-manual]"); if (m) m.addEventListener("click", () => o.onManual());
  }

  window.PropertyPicker = {
    show(el, r, o = {}) {
      if (r.status === "choose") return choose(el, r, o);
      if (r.status === "match" && (r.chosen || (r.facts && r.facts.parcel))) return confirm(el, r, o);
      return none(el, r, o);
    },
    confirmed(el, chosen, o = {}) {
      el.innerHTML = chosen ? `<div class="pp-bar">✓ Confirmed: <b>${esc(chosen.address)}</b>${chosen.parcel ? ` · Parcel ${esc(chosen.parcel)}` : ""}
        ${paLink(chosen.appraiserUrl, chosen.county)} <button type="button" data-change>Wrong property? Change it</button></div>`
        : `<div class="pp-bar" style="color:#92400e;background:#FEF3C7">Not found in county records; check the details below. <button type="button" data-change>Search again</button></div>`;
      const b = el.querySelector("[data-change]"); if (b) b.addEventListener("click", () => o.onChange && o.onChange());
    },
    clear(el) { el.innerHTML = ""; },
  };
})();
