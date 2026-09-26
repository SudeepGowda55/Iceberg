import { rebalanceAqua } from "@/lib/server";
import { handle, net, q } from "@/lib/route";
// POST /api/rebalance[?force=1] — weight-tracking rebalance of the Aqua position (local fork: signed by the maker test key)
export async function POST(req: Request) {
  return handle(async () => {
    if (net(req) === "mainnet" && process.env.MAINNET_UI_TRADES !== "1") throw new Error("rebalancing on mainnet from the UI needs MAINNET_UI_TRADES=1");
    return rebalanceAqua(net(req), { force: q(req).get("force") === "1" });
  });
}
