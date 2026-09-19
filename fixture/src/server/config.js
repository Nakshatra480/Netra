// Server-side configuration – credentials live here, never in the browser.
export const serverConfig = {
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION ?? 'eu-north-1',
};
