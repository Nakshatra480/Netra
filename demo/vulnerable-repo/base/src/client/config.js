// Browser configuration. Anything referenced here is inlined into the public
// JavaScript bundle, so only values that are safe to publish belong in it.
export const clientConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'https://api.orbital.example',
  region: import.meta.env.VITE_REGION ?? 'eu-north-1',
};
