import { serverConfig } from './config.js';

export async function recordSettlement(settlement) {
  // Writes to the ledger using server-side credentials.
  return {
    table: serverConfig.ledgerTable,
    region: serverConfig.region,
    settlement,
  };
}
