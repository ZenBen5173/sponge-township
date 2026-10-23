"use client";
import dynamic from "next/dynamic";

// WebGL, Web Workers and MapLibre are browser-only.
const App = dynamic(() => import("./App"), {
  ssr: false,
  loading: () => (
    <div className="grid h-dvh place-items-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="size-10 animate-bounce rounded-xl border-[1.5px] border-foreground bg-sun shadow-[3px_3px_0_0_var(--foreground)]" />
      </div>
    </div>
  ),
});

export default function ClientApp() {
  return <App />;
}
