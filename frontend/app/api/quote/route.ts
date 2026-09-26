import { apiQuote } from "@/lib/server";
import { handle, net, side, usd, venue } from "@/lib/route";
export async function GET(req: Request) { return handle(() => apiQuote(net(req), venue(req), side(req), usd(req))); }
