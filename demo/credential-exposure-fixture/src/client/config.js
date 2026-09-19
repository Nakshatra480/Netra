// Browser configuration. Anything referenced here is inlined into the public
// JavaScript bundle, so only values that are safe to publish belong in it.
export const clientConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'https://api.orbital.example',
  region: import.meta.env.VITE_REGION ?? 'eu-north-1',

  // Added so the browser can upload receipts straight to the bucket without
  // waiting on a presign round-trip.
  uploadCredentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
};
