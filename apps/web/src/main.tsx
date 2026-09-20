import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// ── HTTP→HTTPS SPA redirect restoration ──────────────────────────────────────
// When auth.ts redirects the HTTP s3-website URL to the HTTPS s3 REST URL,
// it lands on /index.html?__redirect=/original/path because the REST endpoint
// has no SPA fallback. Restore the original path before React mounts so that
// BrowserRouter sees the correct route (e.g. /signin, /auth/callback?code=…).
const redirectParam = new URLSearchParams(window.location.search).get('__redirect');
if (redirectParam) {
  const restored = decodeURIComponent(redirectParam);
  window.history.replaceState(null, '', restored);
}

const container = document.getElementById('root');
if (!container) throw new Error('Netra could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

