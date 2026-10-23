"use client";
import { MotionConfig } from "motion/react";
import Link from "next/link";
import { Monitor } from "@/components/monitor/Monitor";

export default function MonitorClient() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="flex items-center justify-between px-4 pt-4 sm:px-6">
        <span className="font-display text-lg italic">Sponge Township</span>
        <Link href="/" className="text-[11px] text-muted-foreground hover:text-foreground">
          Open the simulator →
        </Link>
      </div>
      <Monitor />
    </MotionConfig>
  );
}
