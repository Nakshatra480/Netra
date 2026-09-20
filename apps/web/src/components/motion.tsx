import type { ReactNode } from 'react';
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
  type Transition,
} from 'framer-motion';

/**
 * Netra's motion vocabulary.
 *
 * Every animation here exists to say something: that state changed, that
 * something arrived, that an action registered. Nothing moves for decoration.
 *
 * Reduced motion is honoured in JavaScript, not only in CSS. The stylesheet's
 * `prefers-reduced-motion` rule collapses CSS transitions, but Framer Motion
 * animates inline styles frame by frame and never reads it — so a reader who
 * has asked for less movement would still have seen all of it. The components
 * below drop to a plain opacity change, and `MotionProvider` sets the global
 * `reducedMotion="user"` so any bare `motion.*` element in the app follows the
 * same preference.
 */

/** The house easing: decelerating, no overshoot, nothing springy. */
export const EASE = [0.22, 1, 0.36, 1] as const;

/** Durations, in seconds. Micro-interactions stay under a fifth of a second. */
export const DURATION = {
  /** Hover, press, colour changes. */
  micro: 0.15,
  /** Content arriving: a card, a row, a value replacing a skeleton. */
  enter: 0.22,
  /** A whole section or route changing. */
  section: 0.32,
} as const;

export const transition: Transition = { duration: DURATION.enter, ease: EASE };
export const sectionTransition: Transition = { duration: DURATION.section, ease: EASE };

/**
 * Wraps the app so every `motion` element respects the reader's preference.
 * `reducedMotion="user"` disables transform and layout animation globally while
 * leaving opacity alone, which keeps state changes legible without movement.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={transition}>
      {children}
    </MotionConfig>
  );
}

/**
 * Content arriving in place.
 *
 * Used where something becomes available that was not there a moment ago — a
 * finding, a section, a result replacing its skeleton.
 */
export function FadeIn({
  children,
  delay = 0,
  y = 6,
  className,
}: {
  children: ReactNode;
  delay?: number;
  /** Distance travelled. Kept small; this is arrival, not entrance. */
  y?: number;
  className?: string | undefined;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: reduced ? 0 : y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...transition, delay: reduced ? 0 : delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * A region that swaps between states — skeleton to content, one phase to the
 * next — without the layout jumping.
 *
 * `mode="wait"` lets the outgoing state finish before the incoming one starts,
 * so the two are never on screen together.
 */
export function SwapIn({
  children,
  swapKey,
  className,
}: {
  children: ReactNode;
  /** Changing this is what triggers the swap. */
  swapKey: string;
  className?: string | undefined;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={swapKey}
        className={className}
        initial={{ opacity: 0, y: reduced ? 0 : 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: DURATION.enter, ease: EASE }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * An expanding region, animated by height rather than snapped open.
 *
 * Height is the one non-transform property worth animating here: collapsing
 * sections are the place where an abrupt change is most disorienting, because
 * everything below them jumps.
 */
export function Expand({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string | undefined;
}) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className={className}
          style={{ overflow: 'hidden' }}
          initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduced ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: DURATION.enter, ease: EASE }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * A list whose rows arrive in order.
 *
 * Staggering is only worth it where the order carries meaning — commits newest
 * first, evidence along an exposure path. The step is deliberately small: the
 * last row of a twenty-row list should not be waiting on an animation.
 */
export function Stagger({
  children,
  className,
  step = 0.03,
}: {
  children: ReactNode;
  className?: string | undefined;
  step?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: reduced ? 0 : step } } }}
    >
      {children}
    </motion.div>
  );
}

/** One row of a {@link Stagger}. */
export const staggerRow = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.enter, ease: EASE } },
};

/**
 * A new line arriving in a live stream.
 *
 * Terminal output is the one place where rows appear continuously, so the
 * motion is the smallest thing that still reads as "this just happened".
 */
export const streamRow = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: DURATION.micro, ease: EASE },
};

export { AnimatePresence, motion, useReducedMotion };
