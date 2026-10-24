import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "lenis/dist/lenis.css";
import "./globals.css";
import { Cursor } from "@/components/fx";
import { Nav, SmoothScroll } from "@/components/Shell";

const sans = Geist({ subsets: ["latin"], variable: "--f-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--f-mono" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--f-serif" });

export const metadata: Metadata = {
  title: "Iceberg",
  description: "A Partially Active AMM on 1inch Aqua and Uniswap v4: only λ of the reserves trade each block, λ set by a fee-aware keeper, idle reserves earning in Morpho.",
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M12 3 L16 9 L14.5 10.5 L19 13 H5 L8.5 8 L10 9.5 Z' fill='%23dff4ff'/><path d='M5 13 H19 L16 20 L12 22 L7.5 19.5 Z' fill='%234a7fb5'/></svg>" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body>
        <SmoothScroll />
        <Nav />
        {children}
        <div className="grain" aria-hidden />
        <Cursor />
      </body>
    </html>
  );
}
