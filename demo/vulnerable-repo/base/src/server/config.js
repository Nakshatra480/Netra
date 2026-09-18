// Server-side configuration. This module runs only on the API host and may
// read privileged credentials from the process environment.
export const serverConfig = {
  region: process.env.AWS_REGION ?? 'eu-north-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  ledgerTable: process.env.LEDGER_TABLE ?? 'orbital-ledger',
};
