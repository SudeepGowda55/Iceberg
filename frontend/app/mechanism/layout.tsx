import type { Metadata } from "next";
import { OG_IMAGE } from "@/lib/site";

export const metadata: Metadata = { title: "Mechanism", description: "Drag λ and watch the iceberg sink or rise; replay the real 21 Sep 2026 prices in your browser with the keeper's own model.", alternates: { canonical: "/mechanism" }, openGraph: { title: "Mechanism · Iceberg", description: "Drag λ and watch the iceberg sink or rise; replay the real 21 Sep 2026 prices in your browser with the keeper's own model.", url: "/mechanism", images: [OG_IMAGE] }, twitter: { card: "summary_large_image", images: [OG_IMAGE.url] } };

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
