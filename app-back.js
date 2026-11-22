// ════════════════════════════════════════════════════════════════════════
// app-back.js — a Back button for Workshop pages opened as a home-screen app
// (John Adams, 2026-11-22).
//
// A page saved to the phone's home screen opens without the browser's address
// bar or Back button, so a page with no link of its own back (a tour preview,
// a form) left people stuck until they closed the app. This draws a small
// round Back button in the bottom-left corner, only when the page is running
// as a home-screen app and isn't the app's own home page. In a normal browser
// tab it does nothing.
//
// Back goes to the previous page when there is one in this app; otherwise
// (a page opened on its own, e.g. a "Preview" that opened a new window) it
// goes home: index.html, which sends each person to their chosen home page.
//
// Loaded by auth.js, so every page on auth.js has it. Pages not on auth.js add
//   <script src="app-back.js" defer></script>
// A page that doesn't want it: <body data-app-back="off">.
// ════════════════════════════════════════════════════════════════════════
(function () {
  if (window.__appBack) return;
  window.__appBack = true;

  const standalone = () =>
    window.navigator.standalone === true ||
    ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia && window.matchMedia(`(display-mode: ${m})`).matches);

  // The app's home pages, and pages saved as their own home-screen apps
  const HOMES = /^\/?(index\.html)?$|\/(index|agent-hub|roster|sign-installer|checkin)\.html$/i;

  function draw() {
    if (!standalone() || HOMES.test(location.pathname)) return;
    if (!document.body || document.body.dataset.appBack === 'off' || document.getElementById('app-back-btn')) return;

    const css = document.createElement('style');
    css.textContent = `
#app-back-btn{position:fixed;left:calc(12px + env(safe-area-inset-left,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));
  z-index:2147483000;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.35);
  background:rgba(15,41,66,.82);color:#fff;display:flex;align-items:center;justify-content:center;padding:0;
  box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer;-webkit-tap-highlight-color:transparent;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
#app-back-btn:active{transform:scale(.94)}
#app-back-btn svg{width:22px;height:22px}
@media print{#app-back-btn{display:none!important}}`;
    document.head.appendChild(css);

    const b = document.createElement('button');
    b.id = 'app-back-btn';
    b.type = 'button';
    b.setAttribute('aria-label', 'Back');
    b.title = 'Back';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
    b.addEventListener('click', () => {
      let sameSite = false;
      try { sameSite = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch (e) {}
      if (sameSite && history.length > 1) {
        const here = location.href;
        history.back();
        // Nothing to go back to after all (e.g. a page opened in its own window): go home
        setTimeout(() => { if (location.href === here) location.href = './index.html'; }, 400);
      } else {
        location.href = './index.html';
      }
    });
    document.body.appendChild(b);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw);
  else draw();
})();
