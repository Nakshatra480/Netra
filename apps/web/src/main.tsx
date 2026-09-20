import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// ── S3 REST endpoint SPA routing ──────────────────────────────────────────────
// The S3 REST endpoint serves only real object keys.  Paths like /app,
// /signin, /auth/callback don't exist as objects → AccessDenied.
// /index.html IS a real object → always safe to load.
//
// We fix URL issues here, before React/BrowserRouter mount, so the router
// always sees a valid route.
//
// Cases handled:
//   A. HTTP → HTTPS redirect from auth.ts:
//      /index.html?__redirect=/some/path  → restore /some/path
//      /index.html?__redirect=/           → stay at /  (BrowserRouter handles it)
//
//   B. Cognito OAuth callback:
//      /index.html?code=…&state=…         → reroute to /auth/callback?code=…
//      /index.html?error=…               → reroute to /auth/callback?error=…
//
//   C. Cognito logout redirect or bare bucket root:
//      /index.html (no params)            → /  (landing page)
//
// After replaceState, BrowserRouter sees a normal path and renders correctly.
// Client-side navigate() calls never reload the page, so no further S3
// requests are made for non-existent paths.

const sp = new URLSearchParams(window.location.search);
const isS3Rest = window.location.hostname.match(/\.s3\.[^.]+\.amazonaws\.com$/);

if (isS3Rest) {
  const redirect = sp.get('__redirect');
  const code = sp.get('code');
  const error = sp.get('error');

  if (redirect) {
    // Case A: restore original path from our HTTP→HTTPS redirect.
    // Decode and replaceState — BrowserRouter will pick up the correct route.
    window.history.replaceState(null, '', decodeURIComponent(redirect));
  } else if (code ?? error) {
    // Case B: Cognito callback landed on /index.html (because /auth/callback
    // is not a real S3 object).  Reroute so AuthCallbackPage sees it normally.
    window.history.replaceState(
      null,
      '',
      `/auth/callback${window.location.search}`,
    );
  }
  // Case C: bare /index.html with no params — user got here from sign-out
  // redirect or direct navigation.  Leave URL as-is; BrowserRouter will
  // route '/' to the landing page.
}

const container = document.getElementById('root');
if (!container) throw new Error('Netra could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

