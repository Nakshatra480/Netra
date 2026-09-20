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
const hostname = window.location.hostname ?? (window.location.origin ? new URL(window.location.origin).hostname : '');
const isS3Rest = /\.s3\.[^.]+\.amazonaws\.com$/.test(hostname);

if (isS3Rest) {
  const redirect = sp.get('__redirect');
  const code = sp.get('code');
  const error = sp.get('error');
  const installationId = sp.get('installation_id');

  if (redirect) {
    // Case A: restore original path from our HTTP→HTTPS redirect.
    window.history.replaceState(null, '', decodeURIComponent(redirect));

  } else if (installationId ?? sp.get('setup_action')) {
    // Case D: GitHub App installation callback (install/update flow).
    // GitHub sends: /index.html?installation_id=…&setup_action=install
    window.history.replaceState(
      null,
      '',
      `/auth/github-callback${window.location.search}`,
    );

  } else if (code ?? error) {
    // Cases B/E: OAuth callback landed on /index.html.
    // Both Cognito and GitHub use code+state. Distinguish by checking whether
    // the Cognito PKCE verifier is in sessionStorage (set before the redirect).
    const isCognito = Boolean(sessionStorage.getItem('netra.pkce.state'));
    const targetPath = isCognito ? '/auth/callback' : '/auth/github-callback';
    window.history.replaceState(
      null,
      '',
      `${targetPath}${window.location.search}`,
    );
  }
  // Case C: bare /index.html — sign-out redirect or direct nav → landing page.
}

const container = document.getElementById('root');
if (!container) throw new Error('Netra could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

