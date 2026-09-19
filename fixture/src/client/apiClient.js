import { clientConfig } from './config.js';

export async function fetchSettlements(token) {
  const resp = await fetch(`${clientConfig.apiBaseUrl}/settlements`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return resp.json();
}
