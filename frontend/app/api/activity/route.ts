import { apiActivity } from "@/lib/server";
import { handle, net } from "@/lib/route";
export async function GET(req: Request) { return handle(() => apiActivity(net(req))); }
