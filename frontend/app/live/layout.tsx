import type { Metadata } from "next";
import { OG_IMAGE } from "@/lib/site";

export const metadata: Metadata = { title: "Live", description: "Both venues right now: λ, active vs frozen reserves, Morpho balances, the keeper's last decision and the on-chain feed.", alternates: { canonical: "/live" }, openGraph: { title: "Live · Iceberg", description: "Both venues right now: λ, active vs frozen reserves, Morpho balances, the keeper's last decision and the on-chain feed.", url: "/live", images: [OG_IMAGE] }, twitter: { card: "summary_large_image", images: [OG_IMAGE.url] } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
