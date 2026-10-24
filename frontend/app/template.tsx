"use client";
// Re-mounts on every navigation: an ice-blue curtain wipes up, then the page fades in.
// Only opacity on the wrapper: a transform would break position: fixed inside pages (the 3D canvas).
import { motion } from "motion/react";
import { BergMark } from "@/components/Shell";

export default function Template({ children }: { children: React.ReactNode }) {
  return <>
    <motion.div className="curtain" initial={{ scaleY: 1 }} animate={{ scaleY: 0 }} transition={{ duration: 0.85, ease: [0.76, 0, 0.24, 1], delay: 0.15 }} aria-hidden>
      <motion.div initial={{ opacity: 1, scale: 1 }} animate={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.35 }}><BergMark size={56} /></motion.div>
    </motion.div>
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.35 }}>{children}</motion.div>
  </>;
}
