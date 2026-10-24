// Mutable target state for the 3D iceberg. Pages (GSAP timelines, sliders) write it; the scene eases towards it every frame.
export type SceneTarget = {
  lambda: number;   // fraction of the berg above the waterline = active reserves
  morpho: number;   // 0..1 glow of the parked reserves earning in Morpho
  arb: number;      // 0..1 arbitrage sparks hitting the tip
  danger: number;   // 0..1 hot tint on the exposed part (plain AMM)
  orbit: number;    // extra camera orbit, radians
  zoom: number;     // -1 (closer) .. 1 (further)
  lift: number;     // camera height offset
  shift: number;    // frame offset: + pushes the berg right (text on the left), − left
  px: number; py: number; // pointer, -1..1
  blockPhase: number;     // written by the scene: 0..1 within the current 2 s Base block
};

export const scene: SceneTarget = { lambda: 0.42, morpho: 0, arb: 0.25, danger: 0, orbit: 0, zoom: 0, lift: 0, shift: 0, px: 0, py: 0, blockPhase: 0 };

export const resetScene = (o: Partial<SceneTarget> = {}) =>
  Object.assign(scene, { lambda: 0.42, morpho: 0, arb: 0.25, danger: 0, orbit: 0, zoom: 0, lift: 0, shift: 0 }, o);
