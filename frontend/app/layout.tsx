import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Iceberg",
  description: "A Partially Active AMM on 1inch Aqua and Uniswap v4: only λ of the reserves trade each block, λ set by a fee-aware keeper, idle reserves earning in Morpho.",
  icons: { icon: "data:," },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
