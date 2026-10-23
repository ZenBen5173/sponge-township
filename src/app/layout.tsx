import type { Metadata, Viewport } from "next";
import { Caveat, DM_Sans, Space_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";

const sans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const display = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"], weight: ["500", "600", "700"] });
const mono = Space_Mono({ variable: "--font-space-mono", subsets: ["latin"], weight: ["400", "700"] });
const hand = Caveat({ variable: "--font-caveat", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Sponge Township — flood simulator",
  description:
    "Simulate a storm on real terrain, place a water square, rain gardens and permeable paths, and see how much street flooding they prevent. Built for the Sime Darby Property University Hackathon 2026.",
};

export const viewport: Viewport = {
  themeColor: "#f7f5ef",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable} ${hand.variable} h-full`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
