import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LogoMark } from "@/components/ui/logo";

/** Once the film is on YouTube, put its link here and /film forwards to it (the slide's QR code never changes). */
const YOUTUBE_URL = "";

export const metadata: Metadata = {
  title: "The film — Sponge Township",
  description: "Sponge Township in 72 seconds: the 2023 Kapar storm, a sunken court, and the streets it keeps dry.",
};

export default function FilmPage() {
  if (YOUTUBE_URL) redirect(YOUTUBE_URL);
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-6 overflow-y-auto bg-[#10212b] p-4 sm:p-8">
      <video
        src="/film/sponge-township-launch.mp4"
        poster="/film/poster.jpg"
        controls
        autoPlay
        playsInline
        className="w-full max-w-6xl rounded-2xl border-[1.5px] border-white/10 shadow-[0_30px_80px_rgba(0,0,0,0.5)]"
      />
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-white">
          <LogoMark className="size-9" />
          Sponge Township
        </span>
        <Link href="/" className="btn-ink rounded-xl px-4 py-2 font-display text-sm font-semibold">
          Try it →
        </Link>
      </div>
    </main>
  );
}
