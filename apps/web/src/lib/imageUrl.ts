/**
 * Whether a claim value can be used as an image source.
 *
 * Identity providers do not all hand back a bare URL. Some wrap it in JSON,
 * and a claim can arrive empty or as the literal string "null". Feeding any of
 * those to `src` makes the browser resolve it against the site's own origin,
 * request a page that does not exist, and draw a broken image — which is
 * exactly the failure this guards against. Only absolute http(s) URLs pass.
 */
export function usableImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;

  // Some providers map the claim to a JSON document rather than a URL.
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const nested =
        (parsed.url as string | undefined) ??
        ((parsed.data as Record<string, unknown> | undefined)?.url as string | undefined);
      return usableImageUrl(nested);
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(trimmed);
    // A relative path or a javascript:/data: source is never a profile photo.
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
