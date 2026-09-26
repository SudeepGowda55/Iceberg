export const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const q = (req: Request) => new URL(req.url).searchParams;
export const net = (req: Request) => q(req).get("net") || "local";
export const venue = (req: Request) => { const v = q(req).get("venue"); return (v === "aqua" || v === "official" ? v : "v4") as "v4" | "aqua" | "official"; };
export const side = (req: Request) => (q(req).get("side") === "sell" ? "sell" : "buy") as "buy" | "sell";
export const usd = (req: Request) => Math.max(0.01, Math.min(10_000, Number(q(req).get("usd") || 100)));
export async function handle(fn: () => Promise<any>) { try { return json(await fn()); } catch (e: any) { return json({ error: e.shortMessage || e.message }, 400); } }
