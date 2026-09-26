import { apiSwap } from "@/lib/server";
import { handle, net, q, side, usd, venue } from "@/lib/route";
// POST /api/swap?venue=v4|aqua&side=buy|sell&usd=50[&who=ui] — real swap on the local fork, signed by the CLI (or UI) test key
export async function POST(req: Request) { return handle(() => apiSwap(net(req), venue(req), side(req), usd(req), q(req).get("who") === "ui" ? "ui" : "cli")); }
