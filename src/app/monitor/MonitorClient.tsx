"use client";
import { MotionConfig } from "motion/react";
import Link from "next/link";
import { Monitor } from "@/components/monitor/Monitor";
import { Logo } from "@/components/ui/logo";

export default function MonitorClient() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="flex items-center justify-between px-4 pt-4 sm:px-6">
        <Logo />
        <Link href="/" className="lift shrink-0 whitespace-nowrap rounded-lg border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground">
          Simulator →
        </Link>
      </div>
      <Monitor />
    </MotionConfig>
  );
}
