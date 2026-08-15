import { MotionConfig } from "motion/react";

// Apple-grade default easing curve (ease-out-quart) — used for every
// motion.* component that doesn't specify its own transition.
const SMOOTH_TRANSITION = {
  type: "tween" as const,
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
  duration: 0.5,
};

export function DefaultProviders({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig transition={SMOOTH_TRANSITION} reducedMotion="never">
      {children}
    </MotionConfig>
  );
}
