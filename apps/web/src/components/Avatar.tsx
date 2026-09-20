import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { usableImageUrl } from '@/lib/imageUrl';

/**
 * A person's avatar, with the initial as the ground truth.
 *
 * The picture is decoration; the initial is what identifies the account. So
 * the initial is what renders unless a photo actually loads — never a broken
 * image glyph, which tells the reader nothing and looks like a fault in Netra.
 *
 * A remote avatar fails for reasons the app cannot see or control: a privacy
 * extension blocking `googleusercontent.com`, the CDN rate-limiting a
 * hotlinked image, a stale URL from an old sign-in, or simply being offline.
 * Each of those is normal, and none of them is worth showing an error for.
 */
export function Avatar({
  src,
  initial,
  className,
}: {
  /** Remote image URL, typically the `picture` claim. Anything unusable is ignored. */
  src?: string | null | undefined;
  /** Shown when there is no usable photo. */
  initial: string;
  className?: string | undefined;
}) {
  const usable = usableImageUrl(src);
  const [failed, setFailed] = useState(false);

  // A new URL deserves a fresh attempt; without this, one failure would
  // suppress the avatar for the rest of the session.
  useEffect(() => setFailed(false), [usable]);

  const base = 'h-7 w-7 shrink-0 rounded-full border border-line';

  if (!usable || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          base,
          'grid place-items-center bg-surface-sunken text-[0.75rem] font-semibold text-ink-muted',
          className,
        )}
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={usable}
      alt=""
      width={28}
      height={28}
      // The avatar carries no information the page does not already show in
      // text, so it must never delay anything or block the main thread.
      loading="lazy"
      decoding="async"
      // Google's image CDN throttles hotlinked avatars by referrer. Sending
      // none is both the conventional fix and one less thing leaked to a
      // third party on every page load.
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn(base, 'object-cover', className)}
    />
  );
}
