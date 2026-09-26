// Read-only snapshot of the local Base mainnet fork, for hosted builds (Vercel) where no fork is running.
// Captured with `npm run snapshot` while ./scripts/start_local.sh is up; served when VERCEL or SNAPSHOT=1 is set.
import fs from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data", "snapshot");
export const snapshotMode = (net: string) => net === "local" && (process.env.SNAPSHOT === "1" || !!process.env.VERCEL);
export const readSnapshot = (name: "status" | "activity" | "replay") => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), "utf8"));
export function requireLive(net: string) {
  if (snapshotMode(net)) throw new Error("this is a recorded snapshot of the local Base mainnet fork: trading is off here. Run ./scripts/start_local.sh to trade live.");
}
