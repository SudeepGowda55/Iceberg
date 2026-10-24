import type { Metadata } from "next";
import { OG_IMAGE } from "@/lib/site";

export const metadata: Metadata = { title: "Evidence", description: "−19.3% LP loss to arbitrage vs a real plain Uniswap v4 pool on the real 24 hours of 21 Sep 2026, with the command to reproduce every number.", alternates: { canonical: "/evidence" }, openGraph: { title: "Evidence · Iceberg", description: "−19.3% LP loss to arbitrage vs a real plain Uniswap v4 pool on the real 24 hours of 21 Sep 2026, with the command to reproduce every number.", url: "/evidence", images: [OG_IMAGE] }, twitter: { card: "summary_large_image", images: [OG_IMAGE.url] } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
