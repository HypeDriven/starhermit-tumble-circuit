// The sky arena on starhermit:scene, as the browser build's js/render/scene.js
// drew it with three.js r160: the gradient sky dome (sun glow and drifting
// high haze when detailed), exponential fog, a hemisphere fill and the key
// sun whose shadow box is fitted around the followed racer and snapped to
// whole texels; the course (platform slabs with tiled tops, striped sides and
// a raised rim trim, the finish pad, arena discs with their rim), moving
// platforms with their lane hints, spinners, pendulums with their gantries,
// pistons, bumpers, weave walls, bounce pads, conveyor arrows, fan streams,
// checkpoint rings and the chequered finish gate; the decor (floating rock
// islands, cumulus clouds, stars, balloons, kites, aurora ribbons, light
// motes); the racers (capsule body, face marker, grounded ring, name sprite)
// with squash and stretch; burst particles; the critically damped follow
// camera with shake; the title backdrop's slow pan over Ridge Run.
//
// Engine minor 23 is three.js r185's light units and shadows, so the page's
// own (r160, physical) light intensities and the sun's shadow (its fitted
// camera box, bias -0.0004 / normal bias 0.03, PCF) are used as written.
// Reflections as r160 drew them: the page set scene.environment to a
// RoomEnvironment(renderer) PMREM (sigma 0.04) and relied on each material's
// envMapIntensity (0.2–0.5, 1 where unset), which r160 applied to the scene
// environment and the engine (as r163+) does not, so each lit material gets
// that environment as its own envMap at its old intensity; with reflections
// the hemisphere fill halves, as before. The composer (half floats → GTAO →
// bloom → OutputPass with ACES 1.05 → the colour grade + vignette → SMAA /
// FXAA / MSAA) is the runtime's renderer.ao / bloom / grade / antialias.
// The old bloom fed only glowing pieces (rings, gate, pads, sparkles, motes)
// through a glow-only render; the runtime's bloom has no per-object mask, so
// its threshold sits above the sunlit platforms and the glowing pieces'
// emissive light passes it.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CapsuleGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DodecahedronGeometry, DoubleSide, Euler, FogExp2, Group, HemisphereLight, InstancedMesh,
  Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PCFShadowMap, PerspectiveCamera,
  PlaneGeometry, PMREMGenerator, Points, PointsMaterial, RepeatWrapping, RingGeometry, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace,
  ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector3, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Course, Rng, Sim, Themes, type Any, type Ev, type State, type Theme } from "./game.ts";
import { SPARK_CAP, type Look } from "./quality.ts";

type Ctx = OffscreenCanvasRenderingContext2D;
const TAU = Math.PI * 2;
const PSTATE = Sim.PSTATE;

/** Colour-vision-safe gameplay palettes (scene.js PALETTES). */
const PALETTES: Record<string, Record<string, number>> = {
  standard: {},
  deuteranopia: { checkpoint: 0x56b4e9, finish: 0xf0e442, hazard: 0xd55e00 },
  protanopia: { checkpoint: 0x56b4e9, finish: 0xf0e442, hazard: 0x0072b2 },
  tritanopia: { checkpoint: 0x009e73, finish: 0xf0e442, hazard: 0xcc79a7 },
};

// ---------------------------------------------------------------- renderer, camera, environment
const camera = new PerspectiveCamera(55, 1, 0.1, 400);
renderer.shadowMap.type = PCFShadowMap;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.camera = camera;

let envTex: Texture | null = null;
function environment(): Texture | null {
  if (!envTex) {
    try {
      // r160 page: new RoomEnvironment(renderer), sigma 0.04
      const room = new RoomEnvironment(renderer);
      envTex = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}

// ---------------------------------------------------------------- state
let look: Look | null = null;
let palette = "standard";
export let reducedMotion = false;
export let camShake = true;
export let cameraMode = "follow";
let course: Any = null;
let themeId = "cumulus";
let theme: Theme = Themes.themeById("cumulus");
let courseGroup: Group | null = null;
let decorGroup: Group | null = null;
let sky: Mesh | null = null;
let sun: DirectionalLight | null = null;
let hemi: HemisphereLight | null = null;
interface ObView { ob: Any; kind: string; grp?: Group; arms?: Group[]; mesh?: Mesh }
let obstacleViews: ObView[] = [];
let moverViews: { m: Any; mesh: Mesh }[] = [];
let zoneViews: { zn: Any; mesh: Mesh; kind: string; speed?: number; phase?: number }[] = [];
let cpViews: { mesh: Mesh; index: number }[] = [];
let decorAnim: { kind: string; obj: Object3D; phase: number; base?: number }[] = [];
let motes: { pts: Points; base: Float32Array; pos: Float32Array } | null = null;
interface PView { grp: Group; body: Mesh; ring: Mesh; label: Sprite; name: string }
const playerViews = new Map<string, PView>();
interface Spark { mesh: Mesh; vx: number; vy: number; vz: number; life: number }
let particles: Spark[] = [];
const burstGeo = new SphereGeometry(0.09, 6, 5);
let shakeAmp = 0;
let ambientT = 0;
const camPos = new Vector3(0, 9, -10);
const camTarget = new Vector3();
const focus = new Vector3();
let aspect = 0;

export function setReducedMotion(v: boolean): void { reducedMotion = v; }
export function setCameraOptions(shake: boolean, mode: string): void { camShake = shake; cameraMode = mode; }
/** The colour palette changed: rebuild to apply its colours (app.js applySettings). */
export function setPalette(p: string): void {
  if (p === palette) return;
  palette = p;
  rebuild();
}
export function applyLook(l: Look): void {
  const prev = look;
  look = l;
  renderer.shadowMap.enabled = l.shadows > 0;
  renderer.antialias = l.antialias;
  renderer.ao = l.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1, samples: l.ao === "high" ? 16 : 8,
    resolution: l.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: l.ao === "high" ? 6 : 4, rings: 2, samples: l.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // r160 page: r160 UnrealBloom at the page's strength
  renderer.bloom = l.bloom ? { model: "r160", strength: 0.4, radius: 0.25, threshold: 1.25, resolution: l.budget.bloomRes } : null;
  renderer.grade = l.grade ? {
    space: "display", contrastCurve: "s", amount: 1, contrast: 0.22, saturation: 1.1,
    shadows: [0.97, 0.98, 1.04], highlights: [1.03, 1.0, 0.97], split: [0.25, 0.85],
    vignette: { amount: 0.2, inner: 0.4, outer: 0.9 },
  } as Any : null;
  if (prev && (prev.preset !== l.preset)) rebuild();
}

// ---------------------------------------------------------------- materials
interface MatP {
  color?: number | Color; map?: Texture | null; roughness?: number; metalness?: number; emissive?: number | Color; emissiveIntensity?: number;
  transparent?: boolean; opacity?: number; clearcoat?: number; clearcoatRoughness?: number; envMapIntensity?: number; flatShading?: boolean;
  side?: Any;
}
const disposables: { dispose(): void }[] = [];
function track<T extends { dispose(): void }>(r: T): T { disposables.push(r); return r; }
/** scene.js _mat: Lambert on Low, Standard on Balanced, the clear-coat Physical look only on High/Ultra. Colours are cloned (the engine keeps a Color passed in). */
function mat(params: MatP, glossy = false): Material {
  const p: MatP = { ...params };
  if (p.color instanceof Color) p.color = p.color.clone();
  if (p.emissive instanceof Color) p.emissive = p.emissive.clone();
  const kind = look!.budget.material;
  if (kind === "lambert") {
    const { roughness: _r, metalness: _m, clearcoat: _c, clearcoatRoughness: _cr, envMapIntensity: _e, flatShading: _f, ...rest } = p;
    return track(new MeshLambertMaterial(rest as Any));
  }
  const env = look!.reflections ? environment() : null;
  const { envMapIntensity, ...q } = p;
  const withEnv: Any = env ? { ...q, envMap: env, envMapIntensity: envMapIntensity ?? 1 } : q;
  if (glossy && kind === "physical") return track(new MeshPhysicalMaterial(withEnv));
  const { clearcoat: _c, clearcoatRoughness: _cr, ...rest } = withEnv;
  return track(new MeshStandardMaterial(rest));
}
const basic = (p: Any): MeshBasicMaterial => track(new MeshBasicMaterial({ ...p }));
const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * look!.budget.segments));

// ---------------------------------------------------------------- procedural textures (scene.js _surfaceTextures)
const texBySize = new Map<number, { tiles: Texture; stripes: Texture; checker: Texture }>();
function surfaceTextures(size: number): { tiles: Texture; stripes: Texture; checker: Texture } {
  const have = texBySize.get(size);
  if (have) return have;
  const make = (paint: (g: Ctx) => void): Texture => {
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext("2d")! as Ctx;
    g.scale(size / 256, size / 256);
    paint(g);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  const rng = new Rng(7, "decor");
  const speckle = (g: Ctx, n: number, a: number): void => {
    for (let i = 0; i < n; i++) {
      const v = rng.range(0, 1) < 0.5 ? 0 : 255;
      g.fillStyle = `rgba(${v},${v},${v},${rng.range(0, a)})`;
      g.fillRect(rng.range(0, 256), rng.range(0, 256), 2, 2);
    }
  };
  const tex = {
    tiles: make((g) => {
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { g.fillStyle = (x + y) % 2 ? "#e9e9e9" : "#ffffff"; g.fillRect(x * 128, y * 128, 128, 128); }
      speckle(g, 2600, 0.08);
      g.strokeStyle = "rgba(0,0,0,0.16)";
      g.lineWidth = 5;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { g.beginPath(); g.roundRect(x * 128 + 3, y * 128 + 3, 122, 122, 14); g.stroke(); }
    }),
    stripes: make((g) => {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, 256, 256);
      g.fillStyle = "rgba(0,0,0,0.07)";
      for (let x = 0; x < 256; x += 32) g.fillRect(x, 0, 14, 256);
      speckle(g, 1600, 0.05);
    }),
    checker: make((g) => {
      for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) { g.fillStyle = (x + y) % 2 ? "#1c2233" : "#ffffff"; g.fillRect(x * 64, y * 128, 64, 128); }
    }),
  };
  texBySize.set(size, tex);
  return tex;
}
let dot: Texture | null = null;
function softDot(): Texture {
  if (dot) return dot;
  const c = new OffscreenCanvas(32, 32);
  const g = c.getContext("2d")! as Ctx;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.4, "rgba(255,255,255,0.5)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  dot = new CanvasTexture(c);
  return dot;
}
/** Scale a geometry's UVs so tiled textures keep a world-space size. */
function scaleUv(geo: BufferGeometry, su: number, sv: number, centered: boolean): void {
  const uv = geo.attributes.uv as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, centered ? (u - 0.5) * su : u * su, centered ? (v - 0.5) * sv : v * sv);
  }
  uv.needsUpdate = true;
}
/** Deterministic vertex jitter for rock silhouettes (keeps shared vertices welded). */
function jitter(geo: BufferGeometry, rng: InstanceType<typeof Rng>, amt: number): void {
  const pos = geo.attributes.position as BufferAttribute;
  const seen = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let f = seen.get(key);
    if (f == null) { f = 1 + rng.range(-amt, amt); seen.set(key, f); }
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i) * f);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// ---------------------------------------------------------------- the sky dome (WGSL port of scene.js's sky ShaderMaterial)
const SKY_FRAGMENT = `
fn hash2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), f.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), f.x), f.y);
}
fn fragment(f: Fragment) -> vec4f {
  let d = normalize(f.world - camera_position());
  let h = d.y;
  var c = mix(uniforms.horizon, uniforms.top, pow(max(h, 0.0), 0.6));
  if (h <= 0.0) { c = mix(uniforms.horizon, uniforms.ground, pow(max(-h, 0.0), 0.5)); }
  let s = max(dot(d, normalize(uniforms.sunDir)), 0.0);
  c = c + uniforms.sunColor * (pow(s, 12.0) * 0.18 + pow(s, 400.0) * 0.9) * uniforms.uDetail;
  if (uniforms.uDetail > 0.5 && h > 0.02) {
    let uv = d.xz / (h + 0.25) * 1.6 + vec2f(uniforms.uTime * 0.01, uniforms.uTime * 0.004);
    let n = noise2(uv) * 0.6 + noise2(uv * 2.3) * 0.3 + noise2(uv * 5.1) * 0.1;
    let wisp = smoothstep(0.55, 0.85, n) * smoothstep(0.02, 0.25, h) * (1.0 - smoothstep(0.5, 0.9, h));
    c = mix(c, mix(c, vec3f(1.0), 0.55), wisp * 0.5);
  }
  // theme sky colours are authored as display colours: linearized as the page did
  return vec4f(pow(max(c, vec3f(0.0)), vec3f(2.2)) * 1.12, 1.0);
}`;

// ---------------------------------------------------------------- disposal
function disposeDeep(obj: Object3D): void {
  obj.traverse((o: Object3D) => {
    const m = o as Mesh;
    if (m.geometry && m.geometry !== burstGeo) m.geometry.dispose();
  });
}
function disposeCourse(): void {
  if (courseGroup) { scene.remove(courseGroup); disposeDeep(courseGroup); courseGroup = null; }
  if (decorGroup) { scene.remove(decorGroup); disposeDeep(decorGroup); decorGroup = null; }
  if (sky) { scene.remove(sky); sky.geometry.dispose(); sky = null; }
  if (sun) { scene.remove(sun); scene.remove(sun.target); sun = null; }
  if (hemi) { scene.remove(hemi); hemi = null; }
  for (const [, v] of playerViews) { scene.remove(v.grp); disposeDeep(v.grp); (v.label.material.map as Texture | null)?.dispose(); }
  playerViews.clear();
  for (const pt of particles) scene.remove(pt.mesh);
  particles = [];
  for (const d of disposables.splice(0)) { try { d.dispose(); } catch { /* gone */ } }
  motes = null;
  decorAnim = [];
  obstacleViews = []; moverViews = []; zoneViews = []; cpViews = [];
}

/** Shadow box fitted to the play area around the focus point, snapped to whole texels. */
function fitShadow(fx: number, fz: number): void {
  if (!sun) return;
  const sp = theme.sun.pos as number[];
  const half = Math.min(24, Math.max(14, (course?.width || 16) / 2 + 8));
  const size = look!.shadows || 1024;
  const texel = (half * 2) / size;
  const cx = Math.round(fx / texel) * texel, cz = Math.round((fz + 5) / texel) * texel;
  const len = Math.hypot(sp[0]!, sp[1]!, sp[2]!) || 1;
  const dist = 60;
  sun.target.position.set(cx, 0, cz);
  sun.position.set(cx + (sp[0]! / len) * dist, (sp[1]! / len) * dist, cz + (sp[2]! / len) * dist);
  const c = sun.shadow.camera as Any;
  if (c.right !== half) {
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.near = dist - 30; c.far = dist + 40;
    c.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- the course (scene.js buildCourse)
export function rebuild(): void { if (course && look) buildCourse(course, themeId); }
/** The title backdrop (a show course, no racers). */
export function buildAttract(def: Any): void { buildCourse(Course.buildCourse(def), def.theme); }

export function buildCourse(c: Any, tId: string): void {
  if (!look) return;
  disposeCourse();
  course = c;
  themeId = tId;
  const th = Themes.themeById(tId);
  theme = th;
  const pal = PALETTES[palette] || {};
  const C = (k: string): number => (pal[k] != null ? pal[k]! : th[k]);
  const detailed = look.detailed;
  const shadows = look.shadows > 0;
  const B = look.budget;

  scene.fog = new FogExp2(th.fog.color, th.fog.density);
  const sunDir = new Vector3(...(th.sun.pos as [number, number, number])).normalize();
  const skyMat = track(new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new Color(th.sky.top) }, horizon: { value: new Color(th.sky.horizon) }, ground: { value: new Color(th.sky.ground) },
      sunColor: { value: new Color(th.sun.color) }, sunDir: { value: sunDir }, uTime: { value: 0 }, uDetail: { value: detailed ? 1 : 0 },
    },
    fragmentShader: SKY_FRAGMENT,
  }));
  sky = new Mesh(new SphereGeometry(320, seg(32, 16), seg(20, 10)), skyMat);
  sky.noAO = true;
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  hemi = new HemisphereLight(th.hemi.sky, th.hemi.ground, th.hemi.intensity * (look.reflections ? 0.5 : 1));
  scene.add(hemi);
  sun = new DirectionalLight(th.sun.color, th.sun.intensity);
  sun.position.set(...(th.sun.pos as [number, number, number]));
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.castShadow = shadows;
  if (shadows) sun.shadow.mapSize = look.shadows;
  fitShadow(0, 10);
  scene.add(sun);
  scene.add(sun.target);

  const g = new Group();
  courseGroup = g;
  scene.add(g);
  const tex = detailed ? surfaceTextures(B.texture) : null;
  const glossy = (color: number, extra: MatP = {}): Material => detailed
    ? mat({ color, roughness: 0.42, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.2, envMapIntensity: 0.3, ...extra }, true)
    : mat({ color, roughness: 0.45, envMapIntensity: 0.3, ...extra });
  const box = (w: number, h: number, d: number): BufferGeometry => detailed
    ? new RoundedBoxGeometry(w, h, d, 3, Math.min(0.22, w * 0.2, h * 0.3, d * 0.2))
    : new BoxGeometry(w, h, d);

  const matTop = mat({ color: th.platform.top, roughness: 0.78, metalness: 0.02, envMapIntensity: 0.2, map: tex?.tiles ?? null });
  const matSide = mat({ color: th.platform.side, roughness: 0.85, envMapIntensity: 0.5, map: tex?.stripes ?? null });
  const matEdge = mat({ color: th.platform.edge, roughness: 0.45, emissive: th.platform.edge, emissiveIntensity: 0.3, envMapIntensity: 0.3 });
  const matUnder = mat({ color: th.platform.under, roughness: 1, envMapIntensity: 0.4 });

  for (const p of c.platforms) {
    if (p.disc) {
      const geo = new CylinderGeometry(p.r, p.r * 0.82, 1.6, seg(48, 24));
      if (tex) scaleUv(geo, p.r / 2, p.r / 2, true);
      const mesh = new Mesh(geo, [matSide, matTop, matUnder]);
      mesh.position.set(c.arena.cx, -0.8, c.arena.cz);
      mesh.receiveShadow = true;
      g.add(mesh);
      const rim = new Mesh(new TorusGeometry(p.r - 0.1, 0.14, seg(10, 4), seg(64, 32)), matEdge);
      rim.rotation.x = Math.PI / 2;
      rim.position.set(c.arena.cx, 0.02, c.arena.cz);
      g.add(rim);
      continue;
    }
    const w = p.x1 - p.x0, d = p.z1 - p.z0;
    const geo = new BoxGeometry(w, 1.2, d);
    if (tex) scaleUv(geo, w / 4, d / 4, false);
    const mesh = new Mesh(geo, [matSide, matSide, matTop, matUnder, matSide, matSide]);
    mesh.position.set((p.x0 + p.x1) / 2, p.y - 0.6, (p.z0 + p.z1) / 2);
    mesh.receiveShadow = true;
    g.add(mesh);
    if (p.finish) {
      const edge = new Mesh(new BoxGeometry(w + 0.08, 0.12, d + 0.08), mat({ color: C("finish"), emissive: C("finish"), emissiveIntensity: 0.5, roughness: 0.4 }));
      edge.position.set((p.x0 + p.x1) / 2, p.y + 0.02, (p.z0 + p.z1) / 2);
      edge.receiveShadow = true;
      g.add(edge);
    } else {
      const t = 0.35, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
      for (const [ex, ez, ew, ed] of [[cx, p.z0 + t / 2, w, t], [cx, p.z1 - t / 2, w, t], [p.x0 + t / 2, cz, t, d - 2 * t], [p.x1 - t / 2, cz, t, d - 2 * t]] as number[][]) {
        if (ew! <= 0 || ed! <= 0) continue;
        const edge = new Mesh(box(ew! + 0.04, 0.14, ed! + 0.04), matEdge);
        edge.position.set(ex!, p.y, ez!);
        edge.receiveShadow = true;
        g.add(edge);
      }
    }
  }

  for (const m of c.movers) {
    const mesh = new Mesh(box(m.w, 0.7, m.d), glossy(th.obstacle.block, { emissive: th.obstacle.block, emissiveIntensity: 0.15 }));
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    g.add(mesh);
    const laneLen = m.A * 2 + (m.axis === "x" ? m.w : m.d);
    const lane = new Mesh(new BoxGeometry(m.axis === "x" ? laneLen : 0.3, 0.06, m.axis === "z" ? laneLen : 0.3),
      basic({ color: 0xffffff, transparent: true, opacity: 0.22 }));
    lane.position.set(m.cx, 0.05, m.cz);
    lane.noAO = true;
    g.add(lane);
    moverViews.push({ m, mesh });
  }

  const barMat = glossy(th.obstacle.bar, { emissive: th.obstacle.bar, emissiveIntensity: 0.3 });
  const poleMat = mat({ color: th.obstacle.pole, roughness: 0.5, metalness: detailed ? 0.2 : 0, envMapIntensity: 0.4 });
  for (const ob of c.obstacles) {
    if (ob.kind === "spinner") {
      const grp = new Group();
      const pole = new Mesh(new CylinderGeometry(0.3, 0.45, ob.h + 1.4, seg(16, 8)), poleMat);
      pole.position.y = (ob.h + 1.4) / 2 - 0.6;
      grp.add(pole);
      if (detailed) {
        const hub = new Mesh(new SphereGeometry(0.55, seg(20, 8), seg(14, 6)), barMat);
        hub.position.y = ob.h;
        grp.add(hub);
      }
      const arms: Group[] = [];
      for (let k = 0; k < ob.arms; k++) {
        const bar = new Mesh(new CapsuleGeometry(ob.barR, ob.L, seg(8, 3), seg(16, 8)), barMat);
        bar.rotation.z = Math.PI / 2;
        const holder = new Group();
        bar.position.x = ob.L / 2;
        holder.add(bar);
        holder.position.y = ob.h;
        holder.rotation.y = (k * TAU) / ob.arms;
        grp.add(holder);
        arms.push(holder);
      }
      grp.position.set(ob.cx, 0, ob.cz);
      grp.traverse((o: Object3D) => { o.castShadow = shadows; });
      g.add(grp);
      obstacleViews.push({ ob, kind: "spinner", grp, arms });
    } else if (ob.kind === "pendulum") {
      const grp = new Group();
      const arm = new Mesh(new CylinderGeometry(0.1, 0.1, ob.L, seg(10, 5)), poleMat);
      arm.position.y = -ob.L / 2;
      const bob = new Mesh(new SphereGeometry(ob.bobR, seg(28, 12), seg(20, 8)), glossy(th.obstacle.bob, { emissive: th.obstacle.bob, emissiveIntensity: 0.2 }));
      bob.position.y = -ob.L;
      grp.add(arm); grp.add(bob);
      const beam = new Mesh(box(c.width + 2, 0.4, 0.4), poleMat);
      beam.position.set(0, ob.py + 0.2, ob.pz);
      beam.castShadow = shadows;
      g.add(beam);
      grp.position.set(ob.px, ob.py, ob.pz);
      grp.traverse((o: Object3D) => { o.castShadow = shadows; });
      g.add(grp);
      obstacleViews.push({ ob, kind: "pendulum", grp });
    } else if (ob.kind === "piston") {
      const block = new Mesh(box(2.0, ob.h, ob.z1 - ob.z0), glossy(th.obstacle.block, { roughness: 0.5 }));
      block.position.y = ob.h / 2;
      block.castShadow = shadows;
      block.receiveShadow = true;
      g.add(block);
      obstacleViews.push({ ob, kind: "piston", mesh: block });
    } else if (ob.kind === "bumper") {
      const mesh = new Mesh(new CylinderGeometry(ob.r, ob.r * 1.1, ob.h, seg(24, 12)), glossy(th.obstacle.bumper, { emissive: th.obstacle.bumper, emissiveIntensity: 0.25 }));
      mesh.position.set(ob.x, ob.h / 2, ob.z);
      mesh.castShadow = shadows;
      g.add(mesh);
      obstacleViews.push({ ob, kind: "bumper", mesh });
    } else if (ob.kind === "weave") {
      const wallMat = glossy(th.obstacle.bar, { roughness: 0.5, emissive: th.obstacle.bar, emissiveIntensity: 0.2 });
      const grp = new Group();
      const sideW = (c.width - ob.gapW) / 2;
      for (const s of [-1, 1]) {
        const wm = new Mesh(box(sideW, ob.h, 0.7), wallMat);
        wm.position.x = s * (ob.gapW / 2 + sideW / 2);
        wm.position.y = ob.h / 2;
        wm.castShadow = shadows;
        wm.receiveShadow = true;
        grp.add(wm);
      }
      grp.position.z = ob.wz;
      g.add(grp);
      obstacleViews.push({ ob, kind: "weave", grp });
    }
  }

  for (const zn of c.zones) {
    if (zn.kind === "bounce") {
      const pad = new Mesh(new CylinderGeometry(zn.r, zn.r, 0.25, seg(28, 14)), mat({ color: 0xffffff, roughness: 0.3, emissive: th.checkpoint, emissiveIntensity: 0.8 }));
      pad.position.set(zn.x, 0.12, zn.z);
      g.add(pad);
      zoneViews.push({ zn, mesh: pad, kind: "bounce" });
    } else if (zn.kind === "conveyor") {
      const dir = Math.atan2(zn.vx, zn.vz);
      const speed = Math.hypot(zn.vx, zn.vz);
      const n = Math.max(2, Math.floor((zn.z1 - zn.z0) / 4));
      const geo = new ConeGeometry(0.5, 1.2, 4);
      for (let i = 0; i < n; i++) {
        const arrow = new Mesh(i ? geo : geo, basic({ color: 0xffffff, transparent: true, opacity: 0.35 }));
        arrow.rotation.order = "YXZ";
        arrow.rotation.x = Math.PI / 2;
        arrow.rotation.y = dir;
        arrow.position.set((zn.x0 + zn.x1) / 2, 0.06, zn.z0 + ((i + 0.5) * (zn.z1 - zn.z0)) / n);
        arrow.noAO = true;
        g.add(arrow);
        zoneViews.push({ zn, mesh: arrow, kind: "conveyor", speed, phase: i * 0.7 });
      }
    } else if (zn.kind === "wind") {
      const dir = Math.atan2(zn.vx, zn.vz);
      for (let i = 0; i < 3; i++) {
        const band = new Mesh(new PlaneGeometry(0.3, Math.max(4, Math.hypot(zn.x1 - zn.x0, zn.z1 - zn.z0) * 0.8)),
          basic({ color: 0xffffff, transparent: true, opacity: 0.14, side: DoubleSide, depthWrite: false }));
        band.rotation.x = -Math.PI / 2;
        band.position.set((zn.x0 + zn.x1) / 2 + (i - 1) * 2, 1.2 + i * 0.8, (zn.z0 + zn.z1) / 2);
        band.rotation.z = -dir;
        band.noAO = true;
        g.add(band);
        zoneViews.push({ zn, mesh: band, kind: "wind", phase: i * 1.3 });
      }
    }
  }

  for (let i = 0; i < c.checkpoints.length; i++) {
    const cp = c.checkpoints[i];
    const ring = new Mesh(new TorusGeometry(3.2, 0.16, seg(12, 5), seg(64, 32)),
      mat({ color: C("checkpoint"), emissive: C("checkpoint"), emissiveIntensity: 1.0, roughness: 0.35 }));
    ring.position.set(cp.x, 3.4, cp.z);
    g.add(ring);
    cpViews.push({ mesh: ring, index: i });
  }
  if (c.kind === "race") {
    const gate = new Group();
    const gm = mat({ color: C("finish"), emissive: C("finish"), emissiveIntensity: 1.0, roughness: 0.3 });
    for (const s of [-1, 1]) {
      const post = new Mesh(new CylinderGeometry(0.25, 0.25, 6.4, seg(16, 8)), gm);
      post.position.set(s * (c.width / 2), 3.2, c.finishZ);
      gate.add(post);
    }
    const top = new Mesh(box(c.width + 0.5, 0.5, 0.5), gm);
    top.position.set(0, 6.4, c.finishZ);
    gate.add(top);
    if (detailed && tex) {
      const banner = new Mesh(new PlaneGeometry(c.width, 0.9), mat({ map: tex.checker, side: DoubleSide, roughness: 0.6 }));
      scaleUv(banner.geometry, c.width / 1.8, 1, false);
      banner.position.set(0, 5.65, c.finishZ);
      gate.add(banner);
    }
    gate.traverse((o: Object3D) => { o.castShadow = shadows; });
    g.add(gate);
  }
  buildDecor(c, th);
}

function buildDecor(c: Any, th: Theme): void {
  const L = look!;
  const rng = new Rng(c.seed, "decor");
  const grp = new Group();
  decorGroup = grp;
  decorAnim = [];
  const detailed = L.detailed;
  const kinds: string[] = th.decor || ["cloud", "island"];
  const B = L.budget;
  const density = (detailed ? 1 : 0.35) * B.decor;
  const count = Math.round(26 * density);
  const islandGeo = new DodecahedronGeometry(1, detailed ? 1 : 0);
  if (detailed) jitter(islandGeo, new Rng(c.seed, "decor-rock"), 0.12);
  const islandMat = mat({ color: th.platform.under, roughness: 1, flatShading: true, envMapIntensity: 0.4 });
  const storm = kinds.includes("storm");
  const cloudMat = mat({
    color: storm ? 0x8d99ae : 0xffffff, roughness: 1, envMapIntensity: 0.3,
    emissive: storm ? 0x3a4458 : new Color(th.sky.horizon).lerp(new Color(0xffffff), 0.5),
    emissiveIntensity: detailed ? 0.35 : 0, transparent: true, opacity: storm ? 0.95 : 0.88,
  });
  const puffs = detailed ? 5 : 1;
  const cloudGeo = new SphereGeometry(1, Math.max(8, Math.round((detailed ? 16 : 10) * B.segments)), Math.max(6, Math.round((detailed ? 12 : 8) * B.segments)));
  const islands = new InstancedMesh(islandGeo, islandMat, Math.max(1, count));
  const clouds = new InstancedMesh(cloudGeo, cloudMat, Math.max(1, count * 3 * puffs));
  clouds.noAO = true;
  const mtx = new Matrix4();
  let ci = 0;
  for (let i = 0; i < count; i++) {
    const ang = rng.range(0, TAU), rad = rng.range(40, 130);
    const x = Math.cos(ang) * rad, z = rng.range(-30, (c.length || 60) + 60) + Math.sin(ang) * 20;
    const y = rng.range(-24, -6);
    const sc = rng.range(2, 7);
    mtx.makeRotationY(rng.range(0, TAU));
    mtx.scale(new Vector3(sc, sc * 0.5, sc));
    mtx.setPosition(x, y, z);
    islands.setMatrixAt(i, mtx);
    for (let k = 0; k < 3; k++) {
      const cs = rng.range(1.5, 4);
      const cx = x + rng.range(-14, 14), cy = rng.range(6, 30), cz = z + rng.range(-14, 14);
      if (puffs === 1) {
        mtx.makeScale(cs * 1.8, cs * 0.7, cs);
        mtx.setPosition(cx, cy, cz);
        clouds.setMatrixAt(ci++, mtx);
      } else {
        for (let j = 0; j < puffs; j++) {
          const ps = cs * (j === 0 ? 1 : rng.range(0.55, 0.85));
          mtx.makeScale(ps * (j === 0 ? 1.9 : 1.1), ps * (j === 0 ? 0.55 : 0.8), ps * (j === 0 ? 1.1 : 0.9));
          mtx.setPosition(cx + (j === 0 ? 0 : rng.range(-1.4, 1.4) * cs), cy + (j === 0 ? 0 : rng.range(0.1, 0.5) * cs), cz + (j === 0 ? 0 : rng.range(-0.6, 0.6) * cs));
          clouds.setMatrixAt(ci++, mtx);
        }
      }
    }
  }
  islands.count = count;
  clouds.count = ci;
  islands.instanceMatrix.needsUpdate = true;
  clouds.instanceMatrix.needsUpdate = true;
  grp.add(islands); grp.add(clouds);
  decorAnim.push({ kind: "drift", obj: clouds, phase: 0 });

  if (kinds.includes("star")) {
    const n = Math.round(240 * density);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ang = rng.range(0, TAU), rad = rng.range(150, 300);
      pos[i * 3] = Math.cos(ang) * rad;
      pos[i * 3 + 1] = rng.range(30, 170);
      pos[i * 3 + 2] = Math.sin(ang) * rad;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    grp.add(new Points(geo, track(new PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 }))));
  }
  if (kinds.includes("balloon")) {
    const n = Math.max(2, Math.round(6 * density));
    const mesh = new InstancedMesh(new SphereGeometry(1, 16, 12),
      mat({ color: th.accent, roughness: 0.35, clearcoat: detailed ? 0.8 : 0, emissive: th.accent, emissiveIntensity: 0.15 }, detailed), n);
    for (let i = 0; i < n; i++) {
      const ang = rng.range(0, TAU), rad = rng.range(28, 90);
      const sc = rng.range(1.1, 2.1);
      mtx.makeScale(sc, sc * 1.3, sc);
      mtx.setPosition(Math.cos(ang) * rad, rng.range(10, 28), rng.range(-20, (c.length || 60) + 40));
      mesh.setMatrixAt(i, mtx);
    }
    mesh.instanceMatrix.needsUpdate = true;
    grp.add(mesh);
    decorAnim.push({ kind: "bob", obj: mesh, phase: 1.3 });
  }
  if (kinds.includes("kite")) {
    const n = Math.max(2, Math.round(5 * density));
    const mesh = new InstancedMesh(new ConeGeometry(1, 0.5, 4), mat({ color: th.hazard, roughness: 0.6, emissive: th.hazard, emissiveIntensity: 0.2 }), n);
    const rot = new Matrix4();
    for (let i = 0; i < n; i++) {
      const ang = rng.range(0, TAU), rad = rng.range(24, 80);
      rot.makeRotationFromEuler(new Euler(rng.range(-0.5, 0.5), rng.range(0, TAU), Math.PI));
      rot.scale(new Vector3(1.4, 1.4, 0.25));
      rot.setPosition(Math.cos(ang) * rad, rng.range(12, 30), rng.range(-16, (c.length || 60) + 36));
      mesh.setMatrixAt(i, rot);
    }
    mesh.instanceMatrix.needsUpdate = true;
    grp.add(mesh);
    decorAnim.push({ kind: "bob", obj: mesh, phase: 0.4 });
  }
  if (kinds.includes("aurora")) {
    for (let i = 0; i < 3; i++) {
      const m = basic({ color: th.checkpoint, transparent: true, opacity: 0.14, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false });
      const ribbon = new Mesh(new PlaneGeometry(rng.range(30, 60), rng.range(40, 70)), m);
      ribbon.position.set(rng.range(-130, 130), rng.range(42, 72), rng.range(60, 170));
      ribbon.rotation.y = rng.range(0, TAU);
      ribbon.noAO = true;
      grp.add(ribbon);
      decorAnim.push({ kind: "shimmer", obj: ribbon, base: 0.14, phase: i * 2.1 });
    }
  }
  motes = null;
  if (L.particles === "high" && B.motes > 0) {
    const n = B.motes;
    const base = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      base[i * 3] = rng.range(-20, 20);
      base[i * 3 + 1] = rng.range(1, 15);
      base[i * 3 + 2] = rng.range(-14, 26);
    }
    const pos = base.slice();
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    const pts = new Points(geo, track(new PointsMaterial({
      color: new Color(th.accent).lerp(new Color(0xffffff), 0.5), size: 0.16, map: softDot(),
      transparent: true, opacity: 0.7, depthWrite: false, blending: AdditiveBlending,
    })));
    pts.frustumCulled = false;
    grp.add(pts);
    motes = { pts, base, pos };
  }
  scene.add(grp);
}

// ---------------------------------------------------------------- racers
function nameSprite(name: string): Sprite {
  const c = new OffscreenCanvas(256, 64);
  const g = c.getContext("2d")! as Ctx;
  g.fillStyle = "rgba(10,14,28,0.9)";
  g.beginPath(); g.roundRect(24, 8, 208, 44, 12); g.fill();
  g.font = "bold 28px sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "#fff";
  g.fillText(name.slice(0, 12), 128, 31);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 2.1;
  return sprite;
}
export function ensurePlayers(players: { id: string; name: string; color: number }[]): void {
  if (!look || !course) return;
  const detailed = look.detailed;
  const shadows = look.shadows > 0;
  const k = look.budget.segments;
  for (const p of players) {
    if (playerViews.has(p.id)) continue;
    const grp = new Group();
    const body = new Mesh(new CapsuleGeometry(0.5, 0.7, Math.max(3, Math.round(8 * k)), Math.max(8, Math.round((detailed ? 24 : 16) * k))),
      detailed ? mat({ color: p.color, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 0.4 }, true) : mat({ color: p.color, roughness: 0.45 }));
    body.position.y = 0.85;
    body.castShadow = shadows;
    grp.add(body);
    const face = new Mesh(new SphereGeometry(0.16, Math.max(6, Math.round(12 * k)), Math.max(5, Math.round(10 * k))), mat({ color: 0xffffff, roughness: 0.2 }));
    face.position.set(0, 1.15, 0.42);
    grp.add(face);
    const ring = new Mesh(new RingGeometry(0.5, 0.72, Math.max(16, Math.round(32 * k))), basic({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.noAO = true;
    grp.add(ring);
    const label = nameSprite(p.name);
    grp.add(label);
    scene.add(grp);
    playerViews.set(p.id, { grp, body, ring, label, name: p.name });
  }
}
/** Redraw a racer's name sprite (the localized "You" after a language change). */
export function setPlayerName(id: string, name: string): void {
  const v = playerViews.get(id);
  if (!v || v.name === name) return;
  v.grp.remove(v.label);
  (v.label.material.map as Texture | null)?.dispose();
  v.label = nameSprite(name);
  v.name = name;
  v.grp.add(v.label);
}

function spawnBurst(x: number, y: number, z: number, color: number, n = 10): void {
  const high = look!.particles === "high";
  const B = look!.budget;
  const cap = Math.round(SPARK_CAP * B.sparks);
  const count = Math.min(Math.round(n * (high ? 1 : 0.3) * B.sparks), cap - particles.length);
  for (let i = 0; i < count; i++) {
    const c = new Color(color);
    if (high && i % 3 === 0) c.multiplyScalar(2.2);
    const mesh = new Mesh(burstGeo, basic({ color: c, transparent: true }));
    mesh.position.set(x, y, z);
    mesh.noAO = true;
    const a = Math.random() * TAU, v = 2 + Math.random() * 4;
    scene.add(mesh);
    particles.push({ mesh, vx: Math.cos(a) * v, vy: 2 + Math.random() * 4, vz: Math.sin(a) * v, life: 0.6 });
  }
}
/** scene.js onEvent: bursts and the local racer's camera shake. */
export function onEvent(e: Ev, localId: string): void {
  if (!look) return;
  const mine = e.p === localId;
  const shakeOk = !reducedMotion && camShake;
  switch (e.t) {
    case "knock": spawnBurst(e.x!, e.y! + 1, e.z!, 0xffffff, 14); if (mine && shakeOk) shakeAmp = Math.min(0.5, shakeAmp + 0.3); break;
    case "fall": if (mine && shakeOk) shakeAmp = Math.min(0.4, shakeAmp + 0.2); break;
    case "checkpoint": spawnBurst(e.x != null ? e.x : 0, 3.4, e.z || 0, 0x06d6a0, 8); break;
    case "bounce": spawnBurst(e.x!, e.y!, e.z!, 0xffffff, 8); break;
    case "finish": if (mine) spawnBurst(e.x || 0, 2, e.z || 0, 0xffd166, 24); break;
  }
}

// ---------------------------------------------------------------- per frame
function wrap(v: number, size: number): number { return (((v % size) + size) % size) - size / 2; }
function ambient(dt: number): void {
  if (!look) return;
  if (!reducedMotion && look.animated) ambientT += dt;
  const t = ambientT;
  if (sky) (sky.material as ShaderMaterial).uniforms.uTime!.value = t;
  for (const a of decorAnim) {
    if (a.kind === "drift") a.obj.position.x = Math.sin(t * 0.02 + a.phase) * 10;
    else if (a.kind === "bob") a.obj.position.y = Math.sin(t * 0.5 + a.phase) * 0.8;
    else if (a.kind === "shimmer") ((a.obj as Mesh).material as MeshBasicMaterial).opacity = a.base! * (0.75 + 0.25 * Math.sin(t * 0.4 + a.phase));
  }
  if (motes) {
    const { base, pos } = motes;
    const fx = focus.x, fz = focus.z + 6;
    const n = base.length / 3;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = fx + wrap(base[i * 3]! + Math.sin(t * 0.3 + i) * 0.6 - fx, 40);
      pos[i * 3 + 1] = 1 + wrap(base[i * 3 + 1]! + t * 0.35 - 1, 14);
      pos[i * 3 + 2] = fz + wrap(base[i * 3 + 2]! - fz, 40);
    }
    (motes.pts.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  }
}
function animateObstacles(tick: number): void {
  for (const v of obstacleViews) {
    const ob = v.ob;
    if (v.kind === "spinner") {
      const th = ob.phase + Course.spinnerOmega(ob, tick) * tick;
      for (let k = 0; k < v.arms!.length; k++) v.arms![k]!.rotation.y = th + (k * TAU) / ob.arms;
    } else if (v.kind === "pendulum") {
      const th = ob.A * Math.sin(ob.omega * tick + ob.phase);
      if (ob.plane === "x") v.grp!.rotation.z = th; else v.grp!.rotation.x = th;
    } else if (v.kind === "piston") {
      v.mesh!.position.x = ob.baseX + ob.A * Math.sin(ob.omega * tick + ob.phase);
      v.mesh!.position.z = (ob.z0 + ob.z1) / 2;
    } else if (v.kind === "weave") {
      v.grp!.position.x = ob.A * Math.sin(ob.omega * tick + ob.phase);
    }
  }
  for (const v of moverViews) {
    const mt = Course.moverTransform(v.m, tick);
    v.mesh.position.set(mt.x, v.m.y - 0.35, mt.z);
  }
}
function fitCamera(w: number, h: number): void {
  const a = w / Math.max(1, h);
  if (a !== aspect) { aspect = a; camera.aspect = a; camera.updateProjectionMatrix(); }
}
/** The title backdrop: obstacles ticking slowly, an authored pan (scene.js renderAttract). */
export function renderAttract(t: number, dt: number, w: number, h: number): void {
  if (!look || !course) return;
  fitCamera(w, h);
  animateObstacles(t * 20);
  const cz = 10 + 8 * Math.sin(t * 0.05);
  camera.position.set(14 * Math.sin(t * 0.04), 12, cz - 16);
  camera.lookAt(0, 0, cz + 8);
  focus.set(0, 0, cz);
  fitShadow(0, cz);
  if (sky) sky.position.copy(camera.position);
  ambient(dt);
}
/** A round's frame from the sim state (scene.js render; the state is drawn at its latest fixed step). */
export function render(state: State, localId: string, dt: number, w: number, h: number): void {
  if (!look || !course) return;
  fitCamera(w, h);
  const tick = state.tick;
  animateObstacles(tick);
  for (const v of zoneViews) {
    if (v.kind === "bounce") v.mesh.scale.y = 1 + 0.25 * Math.sin(tick * 0.12 + v.zn.z);
    else if (v.kind === "conveyor") {
      v.mesh.position.z = v.zn.z0 + (((tick * v.speed! * 0.06 + v.phase!) % 1) * (v.zn.z1 - v.zn.z0));
      (v.mesh.material as MeshBasicMaterial).opacity = 0.2 + 0.18 * Math.sin(tick * 0.1 + v.phase!);
    } else if (v.kind === "wind") (v.mesh.material as MeshBasicMaterial).opacity = 0.1 + 0.08 * Math.sin(tick * 0.15 + v.phase!);
  }
  const local = state.players.find((p) => p.id === localId);
  for (const cp of cpViews) {
    cp.mesh.rotation.y = tick * 0.02;
    const passed = !!local && state.kind === "race" && local.cp > cp.index;
    (cp.mesh.material as MeshStandardMaterial).emissiveIntensity = passed ? 0.15 : 1.0;
  }
  ensurePlayers(state.players);
  for (const p of state.players) {
    const v = playerViews.get(p.id);
    if (!v) continue;
    v.grp.position.set(p.x, p.y, p.z);
    v.grp.rotation.y = Math.atan2(p.vx, p.vz || 0.0001);
    const squash = p.st === PSTATE.DIVE ? 0.55 : p.st === PSTATE.STUN ? 0.7 : 1;
    const stretch = p.st === PSTATE.AIR && p.vy > 2 ? 1.12 : 1;
    if (!reducedMotion) v.body.scale.set(1, squash * stretch, 1);
    v.body.rotation.x = p.st === PSTATE.DIVE ? Math.PI / 2.3 : 0;
    const rm = v.ring.material as MeshBasicMaterial;
    rm.opacity = p.id === localId ? 0.7 : 0.3;
    rm.color.setHex(p.invulnT > 0 ? 0xffff66 : p.id === localId ? 0xffffff : 0xcccccc);
    v.grp.visible = p.st !== PSTATE.OUT && p.st !== PSTATE.RESPAWN;
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i]!;
    pt.life -= dt;
    pt.vy -= 12 * dt;
    pt.mesh.position.x += pt.vx * dt;
    pt.mesh.position.y += pt.vy * dt;
    pt.mesh.position.z += pt.vz * dt;
    (pt.mesh.material as MeshBasicMaterial).opacity = Math.max(0, pt.life / 0.6);
    if (pt.life <= 0) {
      scene.remove(pt.mesh);
      (pt.mesh.material as MeshBasicMaterial).dispose();
      particles.splice(i, 1);
    }
  }
  const me = local || state.players[0];
  if (me) {
    const far = cameraMode === "far" ? 1.5 : 1;
    const want = new Vector3(me.x * 0.7, 8.5 * far + me.y * 0.3, me.z - 11 * far);
    const lookAt = new Vector3(me.x * 0.85, 1.2 + me.y * 0.4, me.z + 6);
    const k = reducedMotion ? 1 : 6.5;
    const t = 1 - Math.exp(-k * dt);
    camPos.lerp(want, t);
    camTarget.lerp(lookAt, t);
    if (shakeAmp > 0.001 && !reducedMotion && camShake) {
      camPos.x += (Math.random() - 0.5) * shakeAmp;
      camPos.y += (Math.random() - 0.5) * shakeAmp * 0.6;
    }
    shakeAmp *= Math.exp(-6 * dt);
    camera.position.copy(camPos);
    camera.lookAt(camTarget);
    focus.set(me.x, 0, me.z);
    fitShadow(me.x, me.z);
    if (sky) sky.position.copy(camera.position);
  }
  ambient(dt);
}
/** Snap the follow camera to the racer (a new round starts framed, not swooping in). */
export function snapCamera(state: State, localId: string): void {
  const me = state.players.find((p) => p.id === localId) || state.players[0];
  if (!me) return;
  const far = cameraMode === "far" ? 1.5 : 1;
  camPos.set(me.x * 0.7, 8.5 * far + me.y * 0.3, me.z - 11 * far);
  camTarget.set(me.x * 0.85, 1.2 + me.y * 0.4, me.z + 6);
}
