import type { Metadata } from "next";
import { OG_IMAGE } from "@/lib/site";

export const metadata: Metadata = { title: "Contracts", description: "Every Iceberg contract on Base mainnet, and the transactions that show both venues trading.", alternates: { canonical: "/contracts" }, openGraph: { title: "Contracts · Iceberg", description: "Every Iceberg contract on Base mainnet, and the transactions that show both venues trading.", url: "/contracts", images: [OG_IMAGE] }, twitter: { card: "summary_large_image", images: [OG_IMAGE.url] } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
