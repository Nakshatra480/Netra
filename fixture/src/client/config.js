// Browser configuration – only values safe to publish.
export const clientConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'https://api.orbital.example',
  region: import.meta.env.VITE_REGION ?? 'eu-north-1',
};
