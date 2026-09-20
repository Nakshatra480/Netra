/**
 * Netra brand mark — inline SVG so it renders crisp at any size with no
 * network request. The icon is an eye (Netra = "eye" in Sanskrit) with a
 * security-shield iris: the eye watches code, the shield verifies it.
 *
 * Usage:
 *   <NetraLogoIcon size={32} />           — icon only (square)
 *   <NetraLogoMark size={20} />           — icon + "Netra" wordmark (horizontal)
 */

interface IconProps {
  /** Height in pixels. Width is derived from the SVG viewBox aspect ratio. */
  size?: number;
  className?: string;
}

/** The eye-shield icon mark only — use in small nav/header slots. */
export function NetraLogoIcon({ size = 28, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Netra"
      className={className}
    >
      {/* Background rounded square */}
      <rect width="100" height="100" rx="22" fill="#FFA67D" />

      {/* Eye outline — almond / vesica shape */}
      <path
        d="M50 26 C28 26 14 50 14 50 C14 50 28 74 50 74 C72 74 86 50 86 50 C86 50 72 26 50 26 Z"
        fill="#FBF8F5"
        stroke="#111827"
        strokeWidth="4.5"
        strokeLinejoin="round"
      />

      {/* Iris circle */}
      <circle cx="50" cy="50" r="16" fill="#FFA67D" />

      {/* Shield inside iris */}
      <path
        d="M50 36.5 C50 36.5 42 39.5 42 44.5 L42 50.5 C42 55 46 58.5 50 61 C54 58.5 58 55 58 50.5 L58 44.5 C58 39.5 50 36.5 50 36.5 Z"
        fill="#111827"
      />

      {/* Checkmark inside shield */}
      <path
        d="M46.5 50 L49 52.5 L53.5 47.5"
        stroke="#FBF8F5"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Full horizontal brand mark — icon + "Netra" text — for landing page header. */
export function NetraLogoMark({ size = 20, className }: IconProps) {
  // Icon aspect: 100x100 box → scale by size/100
  const iconH = size;
  const iconW = size;

  return (
    <span
      className={`inline-flex items-center gap-2.5 select-none ${className ?? ''}`}
      aria-label="Netra"
    >
      <NetraLogoIcon size={iconH} />
      <span
        style={{
          fontSize: `${iconW * 0.9}px`,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: '#111827',
          fontFamily: "'Plus Jakarta Sans', 'Inter', sans-serif",
          lineHeight: 1,
        }}
      >
        Netra
      </span>
    </span>
  );
}
