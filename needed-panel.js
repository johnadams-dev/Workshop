// needed-panel.js — "Still needed" for the paperwork pages (Prepare a Listing and the
// Contract Writer; John Adams, 2026-11-10). Each blank or question that still needs an
// answer is marked in red where it is; a panel on the right (wide screens) or a bar along
// the bottom (phones and narrow windows) lists them, jumps to each, and offers Create
// once nothing is left.
//
//   NeededPanel.update(items, { show, ready, readyText, createLabel, onCreate, blockedText, aliases })
//     items       [{ key, label }]: what's still needed, in order
//     show        false hides the panel and bar (e.g. before the property is looked up)
//     ready       true when Create can be pressed (nothing needed, FS connected, …)
//     blockedText why Create can't be pressed when nothing is listed (e.g. FS not connected)
//     aliases     { key: "#elementId" } for items whose field isn't found by its key
//   A key's field is found as [data-fact=key], [data-answer=key], #q-key, #s-key, #e-key,
//   #a-key, a question row (.qwrap[data-q=key]) or its Yes/No or choice buttons.

(function () {
  const css = `
  .need-missing { background: var(--red-lt, #FBEDEB) !important; border-left: 4px solid var(--red, #C0392B) !important; border-radius: 6px; padding-left: 8px !important; }
  .need-missing input, .need-missing select, .need-missing textarea { border-color: var(--red, #C0392B) !important; }
  .need-tag { display: inline-block; margin-left: 6px; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #fff; background: var(--red, #C0392B); border-radius: 999px; padding: 1px 7px; vertical-align: middle; }
  .need-flash { animation: needFlash 1.2s ease-out 1; }
  @keyframes needFlash { 0% { box-shadow: 0 0 0 4px rgba(192,57,43,.45); } 100% { box-shadow: 0 0 0 0 rgba(192,57,43,0); } }
  #needPanel, #needBar { display: none; font-family: inherit; }
  #needPanel h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--navy, #1B3A5C); margin: 0 0 8px; }
  #needPanel ol { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.45; }
  #needPanel li { margin: 0 0 6px; }
  #needPanel li button { background: none; border: 0; padding: 0; color: var(--red, #C0392B); font: inherit; text-align: left; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  #needPanel .ok { color: var(--green, #1A7A4C); font-weight: 700; font-size: 14px; margin-bottom: 10px; }
  #needPanel .why { color: var(--muted, #6B7280); font-size: 12px; margin-top: 8px; line-height: 1.4; }
  #needPanel .go, #needBar .go { background: var(--navy, #1B3A5C); color: #fff; border: 0; border-radius: 6px; padding: 9px 12px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; width: 100%; }
  #needPanel .go:hover, #needBar .go:hover { background: var(--blue, #2E75B6); }
  @media (min-width: 1200px) {
    body.need-on #needPanel { display: block; position: fixed; top: 70px; right: 16px; width: 260px; max-height: calc(100vh - 90px); overflow: auto;
      background: var(--surface, #fff); border: 1px solid var(--border, #DDE1E9); border-top: 4px solid var(--red, #C0392B); border-radius: 10px; padding: 14px 16px; box-shadow: 0 4px 18px rgba(0,0,0,.08); z-index: 20; }
    body.need-on.need-done #needPanel { border-top-color: var(--green, #1A7A4C); }
    body.need-on .content { margin-left: max(16px, calc((100vw - 900px - 300px) / 2)); margin-right: 300px; }
  }
  @media (max-width: 1199px) {
    body.need-on #needBar { display: flex; gap: 10px; align-items: center; position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
      background: var(--navy, #1B3A5C); color: #fff; padding: 10px 16px; font-size: 14px; box-shadow: 0 -2px 10px rgba(0,0,0,.15); }
    body.need-on #needBar .msg-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    body.need-on #needBar .go { width: auto; background: var(--gold, #C9A84C); color: var(--navy, #1B3A5C); }
    body.need-on #needBar .go:disabled { opacity: .5; cursor: default; }
    body.need-on { padding-bottom: 60px; }
  }`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  let panel, bar, items = [], opts = {};

  function mount() {
    if (panel) return;
    panel = document.createElement("aside"); panel.id = "needPanel"; panel.setAttribute("aria-label", "Still needed");
    bar = document.createElement("div"); bar.id = "needBar"; bar.setAttribute("role", "status");
    document.body.append(panel, bar);
    panel.addEventListener("click", onClick);
    bar.addEventListener("click", onClick);
  }

  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  function find(key) {
    const k = cssEsc(key);
    const alias = opts.aliases && opts.aliases[key];
    const sels = [alias, `[data-fact="${k}"]`, `[data-answer="${k}"]`, `#q-${k}`, `#s-${k}`, `#e-${k}`, `#a-${k}`, `.qwrap[data-q="${k}"]`, `button[data-yn="${k}"]`, `button[data-choice="${k}"]`].filter(Boolean);
    let fallback = null;
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) { if (visible(el)) return el; fallback = fallback || el; }
    }
    return fallback;
  }
  // The block to colour: the question row, or the field with its label
  const box = (el) => el && (el.closest(".qwrap .q, .fq, .grid > div, .row > div, .wide") || el.parentElement);

  function go(key) {
    const el = find(key);
    if (!el) return;
    const b = box(el) || el;
    b.scrollIntoView({ behavior: "smooth", block: "center" });
    b.classList.remove("need-flash"); void b.offsetWidth; b.classList.add("need-flash");
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) setTimeout(() => el.focus({ preventScroll: true }), 350);
  }

  function onClick(e) {
    const t = e.target.closest("[data-need], [data-need-create], [data-need-next]");
    if (!t) return;
    if (t.dataset.needCreate != null) { if (opts.onCreate) opts.onCreate(); return; }
    if (t.dataset.needNext != null) { if (items[0]) go(items[0].key); return; }
    go(t.dataset.need);
  }

  function mark() {
    for (const el of document.querySelectorAll(".need-missing")) el.classList.remove("need-missing");
    for (const el of document.querySelectorAll(".need-tag")) el.remove();
    for (const it of items) {
      const b = box(find(it.key));
      if (!b || b.classList.contains("need-missing")) continue;
      b.classList.add("need-missing");
      const lab = b.querySelector("label, .qt, strong");
      if (lab) lab.insertAdjacentHTML("beforeend", '<span class="need-tag">Needed</span>');
    }
  }

  function update(list, o = {}) {
    mount();
    items = (list || []).filter((x) => x && x.label);
    opts = o;
    const show = o.show !== false;
    document.body.classList.toggle("need-on", show);
    document.body.classList.toggle("need-done", show && !items.length);
    mark();
    if (!show) return;
    const createLabel = o.createLabel || "Create in Form Simplicity";
    if (items.length) {
      panel.innerHTML = `<h3>Still needed (${items.length})</h3><ol>${items.map((it) => `<li><button type="button" data-need="${esc(it.key)}">${esc(it.label)}</button></li>`).join("")}</ol>
        <div class="why">Marked in red on the page. Click one to go to it.</div>`;
      bar.innerHTML = `<span class="msg-t">${items.length} still needed: ${esc(items[0].label)}</span><button type="button" class="go" data-need-next>Next ›</button>`;
    } else if (o.ready) {
      panel.innerHTML = `<div class="ok">✓ Everything's in</div><button type="button" class="go" data-need-create>${esc(createLabel)}</button>
        ${o.readyText ? `<div class="why">${esc(o.readyText)}</div>` : ""}`;
      bar.innerHTML = `<span class="msg-t">✓ Everything's in</span><button type="button" class="go" data-need-create>Create</button>`;
    } else {
      panel.innerHTML = `<h3>Not ready yet</h3><div class="why">${esc(o.blockedText || "Fill in the form to see what's needed.")}</div>`;
      bar.innerHTML = `<span class="msg-t">${esc(o.blockedText || "Not ready yet")}</span>`;
    }
  }

  window.NeededPanel = { update, go };
})();
