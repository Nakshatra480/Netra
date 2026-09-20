/**
 * PageLoader — full-viewport branded loading screen.
 *
 * Uses the Netra eye mark (the same SVG as NetraLogoIcon) at a large size with
 * a layered animation:
 *   1. A slow, gentle scale-breathe on the whole icon
 *   2. An animated "scan line" that sweeps across the iris — conveying
 *      "actively investigating"
 *   3. A pulsing ring halo that grows outward and fades
 *   4. A staggered three-dot ellipsis beneath the label
 *
 * Drop-in for any full-page wait:
 *   <PageLoader label="Completing sign-in…" />
 *   <PageLoader label="Verifying GitHub…" sublabel="Loading your repositories" />
 */

import { motion } from 'framer-motion';

interface PageLoaderProps {
  /** Main status label — required, says what is happening. */
  label: string;
  /** Optional secondary line for extra context. */
  sublabel?: string;
}

export function PageLoader({ label, sublabel }: PageLoaderProps) {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas">
      <div className="flex flex-col items-center gap-8">
        {/* ── Logo mark with layered animations ── */}
        <div className="relative flex items-center justify-center">

          {/* Outer pulsing halo ring */}
          <motion.span
            className="absolute rounded-full border-2 border-[#FFA67D]"
            initial={{ width: 96, height: 96, opacity: 0.6 }}
            animate={{ width: 160, height: 160, opacity: 0 }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeOut', repeatDelay: 0.3 }}
            style={{ borderRadius: '50%' }}
          />

          {/* Second, delayed halo */}
          <motion.span
            className="absolute rounded-full border border-[#FFA67D]"
            initial={{ width: 96, height: 96, opacity: 0.35 }}
            animate={{ width: 148, height: 148, opacity: 0 }}
            transition={{ duration: 2, delay: 0.7, repeat: Infinity, ease: 'easeOut', repeatDelay: 0.3 }}
            style={{ borderRadius: '50%' }}
          />

          {/* Main icon — gentle breathe */}
          <motion.div
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <EyeShieldIcon size={96} />
          </motion.div>

          {/* Scan line sweeping across the iris */}
          <motion.span
            className="pointer-events-none absolute overflow-hidden"
            style={{ width: 96, height: 96, borderRadius: '50%' }}
          >
            <motion.span
              className="absolute left-0 top-0 h-full w-[3px] bg-gradient-to-b from-transparent via-[#FFA67D] to-transparent opacity-70"
              animate={{ x: [-12, 108, -12] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            />
          </motion.span>
        </div>

        {/* ── Text ── */}
        <div className="flex flex-col items-center gap-2 text-center">
          <motion.p
            className="text-[1.0625rem] font-semibold tracking-tight text-ink"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {label}
          </motion.p>

          {sublabel ? (
            <motion.p
              className="max-w-xs text-[0.875rem] leading-relaxed text-ink-muted"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            >
              {sublabel}
            </motion.p>
          ) : null}

          {/* Staggered dot-pulse */}
          <div className="mt-2 flex items-center gap-1.5">
            {[0, 0.18, 0.36].map((delay) => (
              <motion.span
                key={delay}
                className="h-1.5 w-1.5 rounded-full bg-[#FFA67D]"
                animate={{ opacity: [0.25, 1, 0.25], scale: [0.8, 1.2, 0.8] }}
                transition={{ duration: 1.2, delay, repeat: Infinity, ease: 'easeInOut' }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Internal SVG mark — same geometry as NetraLogoIcon ── */
function EyeShieldIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {/* Rounded square bg */}
      <rect width="100" height="100" rx="22" fill="#FFA67D" />

      {/* Eye outline */}
      <path
        d="M50 26 C28 26 14 50 14 50 C14 50 28 74 50 74 C72 74 86 50 86 50 C86 50 72 26 50 26 Z"
        fill="#FBF8F5"
        stroke="#111827"
        strokeWidth="4.5"
        strokeLinejoin="round"
      />

      {/* Iris */}
      <circle cx="50" cy="50" r="16" fill="#FFA67D" />

      {/* Shield */}
      <path
        d="M50 36.5 C50 36.5 42 39.5 42 44.5 L42 50.5 C42 55 46 58.5 50 61 C54 58.5 58 55 58 50.5 L58 44.5 C58 39.5 50 36.5 50 36.5 Z"
        fill="#111827"
      />

      {/* Checkmark */}
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
