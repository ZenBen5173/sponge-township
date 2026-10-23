import type { Metadata } from "next";
import MonitorClient from "./MonitorClient";

export const metadata: Metadata = {
  title: "Court monitor — Sponge Township",
  description: "Live water level, court status and alerts for the Sponge Township water square.",
};

export default function MonitorPage() {
  return (
    <div className="h-dvh overflow-y-auto bg-[radial-gradient(ellipse_at_top,#10202e,#070b10_60%)]">
      <MonitorClient />
    </div>
  );
}
