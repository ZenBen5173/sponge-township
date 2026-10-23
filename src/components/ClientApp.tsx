"use client";
import dynamic from "next/dynamic";

// WebGL, Web Workers and MapLibre are browser-only.
const App = dynamic(() => import("./App"), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center bg-background text-xs text-muted-foreground">Loading Sponge Township…</div>
  ),
});

export default function ClientApp() {
  return <App />;
}
