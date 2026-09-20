import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// ── S3 SPA path restoration ───────────────────────────────────────────────────
// Two scenarios handled before React mounts, both caused by the S3 REST
// endpoint having no SPA fallback (only real object keys are served):
//
// 1. HTTP→HTTPS redirect: auth.ts sends the user to
//    /index.html?__redirect=/original/path  — restore the path.
//
// 2. Cognito OAuth callback: callbackUri() uses /index.html on the S3 REST
//    host so Cognito redirects to /index.html?code=...&state=...
//    Reroute to /auth/callback with the same search params so
//    AuthCallbackPage can exchange the code normally.

const sp = new URLSearchParams(window.location.search);

if (sp.get('__redirect')) {
  // Scenario 1 — restore original path from our own HTTP→HTTPS redirect.
  window.history.replaceState(null, '', decodeURIComponent(sp.get('__redirect')!));
} else if (sp.get('code') || sp.get('error')) {
  // Scenario 2 — Cognito callback landed on /index.html instead of
  // /auth/callback because the S3 REST endpoint can't serve unknown paths.
  window.history.replaceState(null, '', `/auth/callback${window.location.search}`);
}

const container = document.getElementById('root');
if (!container) throw new Error('Netra could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

