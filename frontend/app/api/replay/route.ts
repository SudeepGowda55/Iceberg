import { apiReplay } from "@/lib/server";
import { handle } from "@/lib/route";
export async function GET() { return handle(async () => apiReplay()); }
