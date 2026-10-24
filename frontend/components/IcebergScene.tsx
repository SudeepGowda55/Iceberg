"use client";
// The iceberg: λ of it above the waterline is what arbitrage can reach this block; the rest is frozen, and glows green
// while it earns in Morpho. A ring leaves the berg every 2 s (one Base block = one split). Driven by lib/sceneStore.
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { ImprovedNoise } from "three/examples/jsm/math/ImprovedNoise.js";
import { scene as target } from "@/lib/sceneStore";

const BLOCK_S = 2;

function makeBerg() {
  const g = new THREE.IcosahedronGeometry(1, 9);
  const p = g.attributes.position, v = new THREE.Vector3(), n = new ImprovedNoise();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = 1 + 0.32 * n.noise(v.x * 1.4 + 3.1, v.y * 1.4, v.z * 1.4) + 0.1 * n.noise(v.x * 3.7, v.y * 3.7 + 9, v.z * 3.7);
    v.multiplyScalar(d);
    const up = Math.max(0, v.y), taper = 1 - 0.5 * up;          // narrower towards the peak
    v.x *= 1.3 * taper; v.z *= 1.05 * taper;
    v.y = v.y > 0 ? v.y * 1.25 + 0.25 * n.noise(v.x * 2, 4, v.z * 2) * up : v.y * 1.55; // jagged peak, deep keel
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeBoundingBox();
  return g;
}

const NOISE = /* glsl */ `
float caus(vec2 p, float t){ p *= 2.2; float v = sin(p.x + t) + sin(p.y * 1.3 - t * 1.2) + sin((p.x + p.y) * .7 + t * .8) + sin(length(p) * 1.5 - t);
  return pow(abs(sin(v * 1.2)), 7.); }`;

const bergVert = /* glsl */ `
varying vec3 vW;
void main(){ vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const bergFrag = /* glsl */ `
uniform float uTime, uMorpho, uDanger, uBlock, uWater;
varying vec3 vW;
${NOISE}
void main(){
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = normalize(vec3(-.5, .9, .4));
  float dif = clamp(dot(n, L), 0., 1.), fres = pow(1. - abs(dot(n, V)), 3.), h = vW.y - uWater;
  // above the water: lit ice, cyan rim (tradable), pink when fully exposed
  vec3 above = mix(vec3(.42, .58, .74), vec3(.96, .99, 1.), dif) + fres * vec3(.45, .9, 1.) * .7;
  above = mix(above, above * vec3(1., .55, .75) + fres * vec3(1., .25, .55), uDanger * .75);
  // below: deep blue, caustics near the surface, frozen-pulse each block, Morpho yield bands rising
  vec3 below = mix(vec3(.02, .09, .2), vec3(.1, .36, .62), dif) + fres * vec3(.1, .4, .7) * .5;
  below += caus(vW.xz * 1.4 + vW.y * .3, uTime * .6) * .35 * exp(h * 1.1) * vec3(.6, .9, 1.);
  below += vec3(.25, .55, 1.) * .18 * exp(-uBlock * 5.);
  float band = 1. - smoothstep(.0, .09, abs(fract(vW.y * 1.3 - uTime * .22) - .5));
  below += uMorpho * vec3(.14, .95, .6) * (band * .55 + .12) * smoothstep(.0, -.25, h);
  vec3 col = mix(below, above, smoothstep(-.03, .03, h));
  col += vec3(.55, .95, 1.) * exp(-abs(h) * 38.) * 1.2;           // waterline
  col = mix(col, vec3(.01, .04, .09), clamp(-h * .22, 0., .75));   // depth fog
  gl_FragColor = vec4(col, 1.);
}`;

const waterVert = /* glsl */ `
uniform float uTime; varying vec3 vW;
float wave(vec2 p){ return sin(p.x * 1.1 + uTime * .9) * .05 + sin(p.y * 1.6 - uTime * 1.1) * .04 + sin((p.x + p.y) * 2.7 + uTime * 1.7) * .018; }
void main(){ vec4 w = modelMatrix * vec4(position, 1.); w.y += wave(w.xz); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;

const waterFrag = /* glsl */ `
uniform float uTime, uBlock, uR, uMorpho; varying vec3 vW;
void main(){
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); if (n.y < 0.) n = -n;
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1. - max(dot(n, V), 0.), 4.);
  vec3 col = mix(vec3(.01, .07, .15), vec3(.32, .58, .8), fres);
  vec3 R = reflect(-normalize(vec3(-.5, .9, .4)), n);
  float spec = pow(max(dot(R, V), 0.), 140.);
  col += spec * 1.4;
  float d = length(vW.xz);
  float foam = smoothstep(uR + .3, uR, d) * (.5 + .5 * sin(d * 28. - uTime * 3.));
  float ring = exp(-pow((d - uR - uBlock * 7.) * 5., 2.)) * (1. - uBlock);   // one block = one split
  col += foam * .22 + ring * mix(vec3(.4, .85, 1.), vec3(.3, 1., .7), uMorpho) * .55;
  float fade = smoothstep(16., 5., length(vW.xz - cameraPosition.xz));
  gl_FragColor = vec4(col, (.62 + spec * .3 + ring * .3) * fade);
}`;

const ptsVert = /* glsl */ `
uniform float uTime, uMorpho, uArb, uTop, uPix; attribute vec4 aSeed; varying float vType, vA;
void main(){
  float t = uTime, type = aSeed.w; vec3 p; float size = 1., a = 1.;
  if (type < .5) {                      // snow
    float y = 5. - mod(t * (.25 + aSeed.z * .2) + aSeed.z * 9., 5.2);
    p = vec3(aSeed.x * 9. + sin(t * .5 + aSeed.z * 6.) * .3, y, aSeed.y * 9. - 2.); size = 2.2; a = .55 * smoothstep(-.2, .4, y);
  } else if (type < 1.5) {              // Morpho yield bubbles rising from the keel
    float k = mod(t * (.18 + aSeed.z * .15) + aSeed.z * 7., 1.);
    p = vec3(aSeed.x * 1.4 + sin(t + aSeed.z * 9.) * .1, -3.2 + k * 3.1, aSeed.y * 1.1); size = 3.5; a = uMorpho * sin(k * 3.14159);
  } else {                              // arbitrage sparks diving at the tip
    float k = mod(t * (.45 + aSeed.z * .4) + aSeed.z * 5., 1.);
    vec3 from = normalize(vec3(aSeed.x, .45 + abs(aSeed.y) * .6, aSeed.y * .8 + .4)) * 6.;
    p = mix(from, vec3(aSeed.x * .4, uTop - .15, aSeed.y * .3), k * k); size = 3. + k * 2.5; a = uArb * smoothstep(0., .25, k) * (1. - smoothstep(.85, 1., k));
  }
  vType = type; vA = a;
  vec4 mv = viewMatrix * vec4(p, 1.);
  gl_PointSize = size * uPix * (6. / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const ptsFrag = /* glsl */ `
varying float vType, vA;
void main(){
  float d = length(gl_PointCoord - .5); if (d > .5) discard;
  float g = smoothstep(.5, 0., d);
  vec3 c = vType < .5 ? vec3(.85, .95, 1.) : vType < 1.5 ? vec3(.25, 1., .65) : vec3(1., .35, .7);
  gl_FragColor = vec4(c * g * 1.4, g * vA);
}`;

function World({ interactive }: { interactive: boolean }) {
  const berg = useRef<THREE.Mesh>(null!);
  const cur = useRef({ lambda: target.lambda, morpho: target.morpho, arb: target.arb, danger: target.danger, orbit: target.orbit, zoom: target.zoom, lift: target.lift, shift: target.shift, px: 0, py: 0 });
  const geo = useMemo(makeBerg, []);
  const bb = geo.boundingBox!, H = bb.max.y - bb.min.y;
  const bergMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: bergVert, fragmentShader: bergFrag,
    uniforms: { uTime: { value: 0 }, uMorpho: { value: 0 }, uDanger: { value: 0 }, uBlock: { value: 0 }, uWater: { value: 0 } },
  }), []);
  const waterMat = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: waterVert, fragmentShader: waterFrag, transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uBlock: { value: 0 }, uR: { value: 1.2 }, uMorpho: { value: 0 } },
  }), []);
  const waterGeo = useMemo(() => new THREE.PlaneGeometry(40, 40, 160, 160).rotateX(-Math.PI / 2), []);
  const pts = useMemo(() => {
    const N = 900, seed = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) seed.set([Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random(), i < 420 ? 0 : i < 720 ? 1 : 2], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
    const m = new THREE.ShaderMaterial({ vertexShader: ptsVert, fragmentShader: ptsFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uMorpho: { value: 0 }, uArb: { value: 0 }, uTop: { value: 1 }, uPix: { value: 1 } } });
    return { g, m };
  }, []);

  useFrame((state, dt) => {
    const c = cur.current, e = Math.min(1, dt * 2.6), t = state.clock.elapsedTime;
    for (const k of ["lambda", "morpho", "arb", "danger", "orbit", "zoom", "lift", "shift"] as const) c[k] += (target[k] - c[k]) * e;
    c.px += (target.px - c.px) * Math.min(1, dt * 3); c.py += (target.py - c.py) * Math.min(1, dt * 3);
    const block = (t % BLOCK_S) / BLOCK_S; target.blockPhase = block;
    // λ of the berg's height above the waterline (y = 0), with a gentle bob
    const y = -(bb.min.y + (1 - c.lambda) * H) + Math.sin(t * .8) * .04;
    berg.current.position.y = y;
    berg.current.rotation.y = t * .06 + c.px * .15;
    berg.current.rotation.z = Math.sin(t * .5) * .015;
    const u = bergMat.uniforms;
    u.uTime.value = t; u.uMorpho.value = c.morpho; u.uDanger.value = c.danger; u.uBlock.value = block; u.uWater.value = 0;
    const w = waterMat.uniforms; w.uTime.value = t; w.uBlock.value = block; w.uMorpho.value = c.morpho;
    w.uR.value = 1.25 * (1 - .35 * Math.max(0, c.lambda - .5));
    const pu = pts.m.uniforms; pu.uTime.value = t; pu.uMorpho.value = c.morpho; pu.uArb.value = c.arb; pu.uTop.value = bb.max.y + y; pu.uPix.value = state.gl.getPixelRatio() * 2.2;
    // camera: slow orbit + scroll orbit + pointer parallax; always sees both sides of the waterline
    const ang = .35 + c.orbit + (interactive ? c.px * .25 : c.px * .12) + Math.sin(t * .07) * .08, R = (7.2 + c.zoom * 2.2) * (state.size.width < state.size.height * .8 ? 1.55 : 1);
    state.camera.position.set(Math.sin(ang) * R, .9 + c.lift - c.py * .35, Math.cos(ang) * R);
    state.camera.lookAt(0, -.35 + c.lift * .5, 0);
    const { width, height } = state.size;
    (state.camera as THREE.PerspectiveCamera).setViewOffset(width, height, -c.shift * width, 0, width, height);
  });

  return <>
    <mesh ref={berg} geometry={geo} material={bergMat} />
    <mesh geometry={waterGeo} material={waterMat} renderOrder={2} />
    <points geometry={pts.g} material={pts.m} renderOrder={3} />
  </>;
}

export default function IcebergScene({ interactive = false, className = "" }: { interactive?: boolean; className?: string }) {
  useEffect(() => {
    const move = (e: PointerEvent) => { target.px = e.clientX / innerWidth * 2 - 1; target.py = e.clientY / innerHeight * 2 - 1; };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, []);
  return <div className={`berg-canvas ${className}`} aria-hidden>
    <Canvas dpr={[1, 1.75]} gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }} camera={{ fov: 36, near: .1, far: 80, position: [0, 1, 7] }}>
      <World interactive={interactive} />
    </Canvas>
  </div>;
}
