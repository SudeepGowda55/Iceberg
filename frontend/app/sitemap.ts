import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/mechanism", "/evidence", "/live", "/contracts"].map(p => ({ url: SITE + p, changeFrequency: "weekly", priority: p ? 0.7 : 1 }));
}
