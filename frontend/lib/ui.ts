// Client-safe formatting helpers and the series palette (validated colours from the WalletIndex UI)
export const fmt = (x: number, d = 2) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
export const usd0 = (x: number) => "$" + Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
export const short = (a?: string) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "–");
export const HEX = ["#3987e5", "#d95926", "#199e70", "#9c6ade"];
