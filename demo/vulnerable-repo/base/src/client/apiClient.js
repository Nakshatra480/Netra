import { clientConfig } from './config.js';

export async function fetchSettlements(sessionToken) {
  const response = await fetch(`${clientConfig.apiBaseUrl}/settlements`, {
    headers: {
      authorization: `Bearer ${sessionToken}`,
    },
  });
  return response.json();
}
