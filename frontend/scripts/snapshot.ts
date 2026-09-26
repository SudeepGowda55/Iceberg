/* Snapshot the running local stack (status, activity, replay) into data/snapshot/, so a hosted build of the UI
 * (Vercel) can show real fork data read-only. Run while ./scripts/start_local.sh is up:  npm run snapshot */
import fs from "fs";
import path from "path";

const UI = process.env.UI || "http://localhost:8788", DIR = path.join(process.cwd(), "data", "snapshot");
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const get = async (p: string) => { const r = await (await fetch(`${UI}${p}`)).json(); if (r?.error) throw new Error(`${p}: ${r.error}`); return r; };
  const [status, activity, replay] = await Promise.all([get("/api/status?net=local"), get("/api/activity?net=local"), get("/api/replay")]);
  const takenAt = new Date().toISOString();
  status.snapshot = { takenAt, block: status.block };
  for (const [n, v] of Object.entries({ status, activity, replay })) fs.writeFileSync(path.join(DIR, `${n}.json`), JSON.stringify(v, null, 1));
  console.log(`snapshot at fork block ${status.block} (${takenAt}): ${activity.items.length} activity rows -> data/snapshot/`);
})().catch(e => { console.error(e.message); process.exit(1); });
