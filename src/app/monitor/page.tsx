import type { Metadata } from "next";
import MonitorClient from "./MonitorClient";

export const metadata: Metadata = {
  title: "Court monitor — Sponge Township",
  description: "Live water level, court status and alerts for the Sponge Township water square.",
};

export default function MonitorPage() {
  return (
    <div className="h-dvh overflow-y-auto bg-background">
      <MonitorClient />
    </div>
  );
}
