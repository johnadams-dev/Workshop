// ════════════════════════════════════════════════════════════════════════
// auth.js — shared sign-in for Workshop pages (added 2026-10-18)
//
// Replaces the sign-in block each page used to carry. One Google sign-in
// gives a per-person session (POST /auth/session on mls-proxy, see
// server/auth-sessions.js); every API call then carries it as
// "Authorization: Bearer …" and the server takes the caller's identity from
// the session, not from the x-user-email header.
//
// Usage — the page keeps its own sign-in screen markup:
//
//   <script src="auth.js"></script>
//   Auth.ready({ tool: 'Floor Time',                         // Tool Usage name
//                button: document.getElementById('g-signin-btn'),
//                status: document.getElementById('auth-status') })
//     .then(user => { hideGate(); start(user); });       // { email, name, picture }
//
// onSignInNeeded (optional) runs only when there's no valid session, before
// the Google button is drawn — for pages that show their sign-in screen only
// when it's needed.
//
// `tool` records the visit in the Tool Usage report (ac_activity_log) as
// part of the session check, so a page on auth.js drops its separate
// POST /log/visit script tag.
//
//   const data = await Auth.api('/floor/my-access');           // GET, JSON back
//   await Auth.api('/notices', { method: 'POST', body: {...} });
//   fetch(Auth.API + '/x', { headers: Auth.headers() });      // raw fetch
//
// Changeover: pages are moved to this file one at a time. Until all are,
// it also keeps the legacy localStorage keys (ac_proxy_key, ac_user_email,
// ac_pathfinder_session) up to date and sends the legacy headers, so going
// between moved and unmoved pages never asks anyone to sign in twice.
// Plan: server/docs/web-hosting-and-agent-app-plan.md.
// ════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const API = 'https://mls-proxy-975684028597.us-east1.run.app';
  const GOOGLE_CLIENT_ID = '205198562122-ruhu1eemehs3nfgss3d1jdah47m8eadf.apps.googleusercontent.com';
  const K = {
    token: 'ac_session_token',
    profile: 'ac_session_profile',
    proxyKey: 'ac_proxy_key',
    email: 'ac_user_email',
    pathfinder: 'ac_pathfinder_session',
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let user = null;
  let readyPromise = null;

  function readProfile() {
    try { return JSON.parse(store.get(K.profile) || 'null'); } catch { return null; }
  }

  // Legacy keys for pages not yet on auth.js.
  function writeLegacy(profile, proxyKey) {
    if (proxyKey) store.set(K.proxyKey, proxyKey);
    store.set(K.email, profile.email);
    store.set(K.pathfinder, JSON.stringify({
      email: profile.email, name: profile.name, picture: profile.picture,
      exp: Date.now() + 8 * 3600 * 1000,
    }));
  }

  function clearAll() {
    Object.values(K).forEach(store.del);
    user = null;
  }

  function headers(extra) {
    const h = { 'Content-Type': 'application/json' };
    const token = store.get(K.token);
    if (token) h.Authorization = 'Bearer ' + token;
    // Changeover: routes still on the legacy check need these.
    const key = store.get(K.proxyKey);
    if (key) h['x-proxy-key'] = key;
    if (user) h['x-user-email'] = user.email;
    return Object.assign(h, extra || {});
  }

  async function api(path, opts) {
    opts = opts || {};
    const r = await fetch(API + path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: headers(opts.headers),
      body: opts.body === undefined ? undefined
        : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && store.get(K.token)) {
      // Session expired or revoked: back to the sign-in screen.
      clearAll();
      location.reload();
    }
    if (!r.ok) {
      const err = new Error(data.error || r.statusText || ('HTTP ' + r.status));
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Checks a stored session with the server. Returns the profile or null.
  // `tool` also records this page visit in the Tool Usage report.
  async function checkSession(tool) {
    if (!store.get(K.token)) return null;
    try {
      const q = tool ? '?tool=' + encodeURIComponent(tool) : '';
      const r = await fetch(API + '/auth/me' + q, { headers: headers() });
      if (r.status === 401) { clearAll(); return null; }
      if (!r.ok) return readProfile(); // server hiccup: trust what we have
      const me = await r.json();
      const profile = { email: me.email, name: me.name, picture: me.picture };
      store.set(K.profile, JSON.stringify(profile));
      writeLegacy(profile, me.proxyKey);
      return profile;
    } catch {
      return readProfile(); // offline: let the page try
    }
  }

  function loadGoogle() {
    return new Promise((resolve) => {
      if (window.google?.accounts?.id) return resolve();
      if (!document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        document.head.appendChild(s);
      }
      const t = setInterval(() => {
        if (window.google?.accounts?.id) { clearInterval(t); resolve(); }
      }, 100);
    });
  }

  function setStatus(el, text) { if (el) el.textContent = text; }

  // Shows Google sign-in in opts.button and resolves once signed in.
  function signIn(opts) {
    if (opts.onSignInNeeded) opts.onSignInNeeded();
    return new Promise((resolve) => {
      loadGoogle().then(() => {
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          auto_select: true,
          callback: async (cred) => {
            setStatus(opts.status, 'Signing in…');
            try {
              const r = await fetch(API + '/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken: cred.credential, platform: 'web', tool: opts.tool || null }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) { setStatus(opts.status, data.error || 'Sign-in failed. Please try again.'); return; }
              const profile = { email: data.email, name: data.name, picture: data.picture };
              store.set(K.token, data.sessionToken);
              store.set(K.profile, JSON.stringify(profile));
              writeLegacy(profile, data.proxyKey);
              resolve(profile);
            } catch (e) {
              setStatus(opts.status, 'Sign-in error: ' + e.message);
            }
          },
        });
        // Only reached when there's no session, so One Tap is wanted here
        // (see "Always gate google.accounts.id.prompt()" in CLAUDE.md).
        google.accounts.id.prompt();
        if (opts.button) {
          google.accounts.id.renderButton(opts.button, {
            theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular',
          });
        }
        setStatus(opts.status, 'Sign in with your @adamscameron.com account.');
      });
    });
  }

  // Resolves with { email, name, picture } once the person is signed in.
  function ready(opts) {
    opts = opts || {};
    if (!readyPromise) {
      readyPromise = checkSession(opts.tool)
        .then(profile => profile || signIn(opts))
        .then(profile => { user = profile; return profile; });
    }
    return readyPromise;
  }

  async function signOut() {
    try { await fetch(API + '/auth/sign-out', { method: 'POST', headers: headers() }); } catch {}
    clearAll();
    try { google.accounts.id.disableAutoSelect(); } catch {}
  }

  window.Auth = {
    API,
    ready,
    api,
    headers,
    signOut,
    get user() { return user; },
    get email() { return user ? user.email : ''; },
    get proxyKey() { return store.get(K.proxyKey) || ''; },
  };
})();
