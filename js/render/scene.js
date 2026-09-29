// Three.js presentation. Consumes immutable sim snapshots + tick clock;
// every moving obstacle's transform is a pure function of (tick, seed), so
// visuals never diverge from rules. Deterministic decor from the decor
// stream. Graphics settings (js/render/gfx.js) control pixel ratio, shadows,
// image-based lighting, post-processing, surface detail, particles and
// ambient background motion — never gameplay visibility.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Rng } from '../rules/rng.js';
import { moverTransform, spinnerOmega, buildCourse } from '../rules/course.js';
import { themeById } from '../content/themes.js';
import { PSTATE } from '../rules/sim.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';

const TAU = Math.PI * 2;

// Color-vision-safe gameplay palettes (shape/label also reinforce meaning)
const PALETTES = {
  standard: {},
  deuteranopia: { checkpoint: 0x56b4e9, finish: 0xf0e442, hazard: 0xd55e00 },
  protanopia: { checkpoint: 0x56b4e9, finish: 0xf0e442, hazard: 0x0072b2 },
  tritanopia: { checkpoint: 0x009e73, finish: 0xf0e442, hazard: 0xcc79a7 },
};

// Colour grade + vignette, applied after tone mapping (display-space in and out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      // gentle S-curve contrast, a little saturation, warm highlights / cool shadows
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.25, 0.85, l));
      c = mix(c, s, uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Bloom limited to glowing pieces: the pass first renders the scene with every
// non-glow surface in flat black (keeping depth occlusion), and only that
// glow image feeds the bright-pass, blur and additive composite. White
// sunlit platforms therefore never bloom.
class GlowBloomPass extends UnrealBloomPass {
  constructor(resolution, strength, radius, threshold, scene, camera) {
    super(resolution, strength, radius, threshold);
    this.glowScene = scene;
    this.glowCamera = camera;
    this.glowTarget = new THREE.WebGLRenderTarget(resolution.x, resolution.y, { type: THREE.HalfFloatType });
    const glowTex = () => this.glowTarget.texture;
    Object.defineProperty(this.highPassUniforms.tDiffuse, 'value', { get: glowTex, set: () => {} });
    this.black = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
    this._mats = new Map();
    this._vis = new Map();
    this._clear = new THREE.Color();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this.glowTarget?.setSize(w, h);
  }

  dispose() {
    super.dispose();
    this.glowTarget.dispose();
    this.black.dispose();
  }

  render(renderer, writeBuffer, readBuffer, dt, maskActive) {
    const scene = this.glowScene;
    const mats = this._mats, vis = this._vis;
    scene.traverse(o => {
      if (o.userData.glow || !(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
      const m = o.material;
      if (o.isMesh && !(Array.isArray(m) ? m[0].transparent : m.transparent) && !m.isShaderMaterial) {
        mats.set(o, m); o.material = this.black;
      } else { vis.set(o, o.visible); o.visible = false; }
    });
    const bg = scene.background;
    scene.background = null;
    renderer.getClearColor(this._clear);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(this.glowTarget);
    renderer.clear();
    renderer.render(scene, this.glowCamera);
    renderer.setClearColor(this._clear, alpha);
    scene.background = bg;
    for (const [o, m] of mats) o.material = m;
    for (const [o, v] of vis) o.visible = v;
    mats.clear(); vis.clear();
    super.render(renderer, writeBuffer, readBuffer, dt, maskActive);
  }
}

export class GameScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.reducedMotion = false;
    this.palette = 'standard';
    this.cameraMode = 'follow';
    this.camShake = true;
    this.courseGroup = null;
    this.playerViews = new Map();
    this.obstacleViews = [];
    this.moverViews = [];
    this.zoneViews = [];
    this.cpViews = [];
    this.decorGroup = null;
    this.decorAnim = [];
    this.motes = null;
    this.particles = [];
    this.shakeAmp = 0;
    this.theme = null;
    this.themeId = null;
    this.course = null;
    this.hidden = false;
    // graphics state
    this.gpu = '';
    this.mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
      ((navigator.maxTouchPoints || 0) > 0 && !!window.matchMedia && matchMedia('(pointer: coarse)').matches);
    this.detected = 'balanced';
    this.saved = {};
    this.q = resolve({}, 'low');
    this.canvasAA = true;
    this.composer = null;
    this.gradePass = null;
    this.postKey = null;
    this.postFailed = false;
    this.envTex = null;
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this._last = 0;
    this.fps = 0;
    this.ambientT = 0;
    this.osReduced = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.burstGeo = new THREE.SphereGeometry(0.09, 6, 5);
    this.ok = this.initGL();
  }

  initGL() {
    if (!this._makeRenderer(true)) return false;
    this.gpu = readGpu(this.renderer);
    this.detected = detectPreset(this.gpu, this.mobile);
    this.q = resolve({}, this.detected);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camTarget = new THREE.Vector3();
    this.camPos = new THREE.Vector3(0, 9, -10);
    this.focus = new THREE.Vector3();
    this.resize();
    return true;
  }

  _makeRenderer(antialias) {
    let r;
    try {
      r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias, powerPreference: 'high-performance' });
    } catch (e) {
      return false;
    }
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = r;
    this.canvasAA = antialias;
    return true;
  }

  // Canvas MSAA is fixed when a WebGL context is created, so toggling it swaps
  // in a fresh canvas + renderer. Scene resources re-upload on first use.
  _swapRenderer(antialias) {
    const old = this.renderer;
    const fresh = document.createElement('canvas');
    fresh.id = this.canvas.id;
    fresh.className = this.canvas.className;
    fresh.setAttribute('aria-hidden', 'true');
    const prevCanvas = this.canvas;
    this.canvas = fresh;
    if (!this._makeRenderer(antialias)) { this.canvas = prevCanvas; this.renderer = old; return; }
    prevCanvas.replaceWith(fresh);
    this.composer?.dispose();
    this.composer = null;
    this.postKey = null;
    if (this.envTex) { this.envTex.dispose(); this.envTex = null; }
    old.dispose();
    try { old.getContext().getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) { /* already gone */ }
    this.size = [0, 0];
  }

  // ---------------------------------------------------------------------
  // Graphics settings
  // ---------------------------------------------------------------------

  /** Apply saved graphics settings (object from the settings store; {} = auto). */
  setGraphics(saved) {
    const key = JSON.stringify(saved || {});
    if (key === this._gfxKey) return;
    this._gfxKey = key;
    this.saved = saved || {};
    const prev = this.q;
    const g = resolve(this.saved, this.detected);
    this.q = g;
    if (!this.renderer) return;
    const wantAA = g.antialias === 'msaa' && !g.post;
    if (wantAA !== this.canvasAA) this._swapRenderer(wantAA);
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    if (this.sun) this._applyShadowSize();
    this._applyEnvironment();
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    document.body.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxAuto = g.auto ? '1' : '0';
    // detail / particle / background tiers change what is built: rebuild the course
    const rebuild = prev && (prev.detail !== g.detail || prev.particles !== g.particles || prev.background !== g.background);
    if (rebuild && this.course) this.rebuild();
    else this._refreshMaterials();
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px),
      pixels: px,
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  rebuild() {
    if (this.course) this.buildCourse(this.course, this.themeId);
  }

  _applyShadowSize() {
    const size = SHADOW_MAP[this.q.shadows];
    this.sun.castShadow = size > 0;
    if (size > 0 && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  _applyEnvironment() {
    if (!this.scene) return;
    const on = this.q.reflections === 'on';
    if (on && !this.envTex) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this.envTex = pmrem.fromScene(room, 0.04).texture;
      room.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      pmrem.dispose();
    }
    this.scene.environment = on ? this.envTex : null;
    // IBL replaces part of the flat hemisphere fill so surfaces keep their value
    if (this.hemi && this.theme) this.hemi.intensity = this.theme.hemi.intensity * (on ? 0.5 : 1);
  }

  _refreshMaterials() {
    if (!this.scene) return;
    this.scene.traverse(o => {
      if (o.isMesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      }
    });
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.getElementById('app')?.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    this.gradePass = null;
    if (!g.post || this.postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        // name labels, sky and translucent decor never occlude
        const hide = ao.overrideVisibility.bind(ao);
        ao.overrideVisibility = () => {
          hide();
          this.scene.traverse(o => { if (o.isSprite || o.userData.noAO) o.visible = false; });
        };
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.7;
        ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // only emissive rings, gates, pads and sparkles glow
        composer.addPass(new GlowBloomPass(new THREE.Vector2(pw, ph), 0.4, 0.25, 0.2, this.scene, this.camera));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') {
        this.gradePass = new ShaderPass(GradeShader);
        composer.addPass(this.gradePass);
      }
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch (e) {
      // Post-processing is an enhancement: render directly if the chain cannot be built.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dt) {
    const f = this._frames;
    f.push(dt);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  resize() {
    this.size = [0, 0]; // re-measured on the next frame
  }

  // Size, adaptive scale, post chain, then draw.
  _present() {
    const now = performance.now();
    const dt = this._last ? Math.min(250, now - this._last) : 16;
    this._last = now;
    const rescale = this._adapt(dt);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try { this.composer.render(dt / 1000); return; } catch (e) {
        this.postFailed = true; this.composer = null; this.postKey = null;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  // Ambient decorative motion: clouds drift, balloons bob, aurora shimmers,
  // motes float. Frozen with reduced motion or a static background.
  _ambient(dt) {
    const moving = !this.reducedMotion && !this.osReduced?.matches && this.q.background === 'animated';
    if (moving) this.ambientT += dt;
    const t = this.ambientT;
    if (this.sky) this.sky.material.uniforms.uTime.value = t;
    for (const a of this.decorAnim) {
      if (a.kind === 'drift') a.obj.position.x = Math.sin(t * 0.02 + a.phase) * 10;
      else if (a.kind === 'bob') a.obj.position.y = Math.sin(t * 0.5 + a.phase) * 0.8;
      else if (a.kind === 'shimmer') a.obj.material.opacity = a.base * (0.75 + 0.25 * Math.sin(t * 0.4 + a.phase));
    }
    if (this.motes) {
      const pos = this.motes.geometry.attributes.position;
      const base = this.motes.userData.base;
      const fx = this.focus.x, fz = this.focus.z + 6;
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
        // wrap each mote inside a 40×14×40 box around the focus point
        const x = fx + wrap(bx + Math.sin(t * 0.3 + i) * 0.6 - fx, 40);
        const y = 1 + wrap(by + t * 0.35 - 1, 14);
        const z = fz + wrap(bz - fz, 40);
        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;
    }
  }

  // Shadow box fitted to the play area around the focus point, snapped to
  // whole texels so the camera follow does not shimmer.
  _fitShadow(fx, fz) {
    if (!this.sun || !this.theme) return;
    const sp = this.theme.sun.pos;
    const half = Math.min(24, Math.max(14, (this.course?.width || 16) / 2 + 8));
    const size = SHADOW_MAP[this.q.shadows] || 1024;
    const texel = (half * 2) / size;
    const cx = Math.round(fx / texel) * texel, cz = Math.round((fz + 5) / texel) * texel;
    const len = Math.hypot(sp[0], sp[1], sp[2]) || 1;
    const dist = 60;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + sp[0] / len * dist, sp[1] / len * dist, cz + sp[2] / len * dist);
    const c = this.sun.shadow.camera;
    if (c.right !== half) {
      c.left = -half; c.right = half; c.top = half; c.bottom = -half;
      c.near = dist - 30; c.far = dist + 40;
      c.updateProjectionMatrix();
    }
  }

  // ---------------------------------------------------------------------
  // Course construction (called once per round; disposes the previous one)
  // ---------------------------------------------------------------------
  buildCourse(course, themeId) {
    this.disposeCourse();
    this.course = course;
    this.themeId = themeId;
    const theme = themeById(themeId);
    this.theme = theme;
    const pal = PALETTES[this.palette] || {};
    const C = (k) => pal[k] != null ? pal[k] : theme[k];
    const detailed = this.q.detail === 'detailed';
    const shadows = SHADOW_MAP[this.q.shadows] > 0;

    // sky dome (gradient + sun glow + drifting high haze) + fog + lights
    this.scene.fog = new THREE.FogExp2(theme.fog.color, theme.fog.density);
    const sunDir = new THREE.Vector3(...theme.sun.pos).normalize();
    const skyGeo = new THREE.SphereGeometry(320, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(theme.sky.top) },
        horizon: { value: new THREE.Color(theme.sky.horizon) },
        ground: { value: new THREE.Color(theme.sky.ground) },
        sunColor: { value: new THREE.Color(theme.sun.color) },
        sunDir: { value: sunDir },
        uTime: { value: 0 },
        uDetail: { value: detailed ? 1 : 0 },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
        uniform vec3 sunColor; uniform vec3 sunDir; uniform float uTime; uniform float uDetail;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        void main(){
          vec3 d = normalize(vP); float h = d.y;
          vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, ground, pow(-h, 0.5));
          float s = max(dot(d, sunDir), 0.0);
          c += sunColor * (pow(s, 12.0) * 0.18 + pow(s, 400.0) * 0.9) * uDetail;
          if (uDetail > 0.5 && h > 0.02) {
            vec2 uv = d.xz / (h + 0.25) * 1.6 + vec2(uTime * 0.01, uTime * 0.004);
            float n = noise(uv) * 0.6 + noise(uv * 2.3) * 0.3 + noise(uv * 5.1) * 0.1;
            float wisp = smoothstep(0.55, 0.85, n) * smoothstep(0.02, 0.25, h) * (1.0 - smoothstep(0.5, 0.9, h));
            c = mix(c, mix(c, vec3(1.0), 0.55), wisp * 0.5);
          }
          // theme sky colours are authored as display colours: linearize so
          // tone mapping + output encoding reproduce them on every tier
          gl_FragColor = vec4(pow(c, vec3(2.2)) * 1.12, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.userData.noAO = true;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    const hemi = new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity);
    this.hemi = hemi;
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(theme.sun.color, theme.sun.intensity);
    sun.position.set(...theme.sun.pos);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    this._applyShadowSize();
    this._fitShadow(0, 10);
    this.scene.add(sun);
    this.scene.add(sun.target);
    this._applyEnvironment();

    const g = new THREE.Group();
    this.courseGroup = g;
    this.scene.add(g);

    // Toy-plastic surfaces: tiled tops and soft clearcoat on moving pieces at
    // the detailed tier; plain PBR otherwise. Gameplay colours are unchanged.
    const tex = detailed ? this._surfaceTextures() : null;
    const glossy = (color, extra = {}) => detailed
      ? new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.2, envMapIntensity: 0.3, ...extra })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.45, envMapIntensity: 0.3, ...extra });
    const box = (w, h, d) => detailed
      ? new RoundedBoxGeometry(w, h, d, 3, Math.min(0.22, w * 0.2, h * 0.3, d * 0.2))
      : new THREE.BoxGeometry(w, h, d);

    const matTop = new THREE.MeshStandardMaterial({ color: theme.platform.top, roughness: 0.78, metalness: 0.02, envMapIntensity: 0.2, map: tex?.tiles || null });
    const matSide = new THREE.MeshStandardMaterial({ color: theme.platform.side, roughness: 0.85, envMapIntensity: 0.5, map: tex?.stripes || null });
    const matEdge = new THREE.MeshStandardMaterial({ color: theme.platform.edge, roughness: 0.45, emissive: theme.platform.edge, emissiveIntensity: 0.3, envMapIntensity: 0.3 });
    const matUnder = new THREE.MeshStandardMaterial({ color: theme.platform.under, roughness: 1, envMapIntensity: 0.4 });

    // platforms: slab with edge trim and underside skirt
    for (const p of course.platforms) {
      if (p.disc) {
        const geo = new THREE.CylinderGeometry(p.r, p.r * 0.82, 1.6, 48);
        if (tex) scaleUv(geo, p.r / 2, p.r / 2, true);
        const mesh = new THREE.Mesh(geo, [matSide, matTop, matUnder]);
        mesh.position.set(course.arena.cx, -0.8, course.arena.cz);
        mesh.receiveShadow = true;
        g.add(mesh);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r - 0.1, 0.14, 10, 64), matEdge);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(course.arena.cx, 0.02, course.arena.cz);
        g.add(rim);
        continue;
      }
      const w = p.x1 - p.x0, d = p.z1 - p.z0;
      const geo = new THREE.BoxGeometry(w, 1.2, d);
      if (tex) scaleUv(geo, w / 4, d / 4, false);
      const mesh = new THREE.Mesh(geo, [matSide, matSide, matTop, matUnder, matSide, matSide]);
      mesh.position.set((p.x0 + p.x1) / 2, p.y - 0.6, (p.z0 + p.z1) / 2);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      g.add(mesh);
      if (p.finish) {
        // finish pad: the whole top reads as the goal colour
        const edge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.12, d + 0.08),
          new THREE.MeshStandardMaterial({ color: C('finish'), emissive: C('finish'), emissiveIntensity: 0.5, roughness: 0.4 }));
        edge.position.set((p.x0 + p.x1) / 2, p.y + 0.02, (p.z0 + p.z1) / 2);
        edge.receiveShadow = true;
        g.add(edge);
      } else {
        // raised trim around the rim so the drop-off edge is always visible
        const t = 0.35, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
        for (const [ex, ez, ew, ed] of [[cx, p.z0 + t / 2, w, t], [cx, p.z1 - t / 2, w, t], [p.x0 + t / 2, cz, t, d - 2 * t], [p.x1 - t / 2, cz, t, d - 2 * t]]) {
          if (ew <= 0 || ed <= 0) continue;
          const edge = new THREE.Mesh(box(ew + 0.04, 0.14, ed + 0.04), matEdge);
          edge.position.set(ex, p.y, ez);
          edge.receiveShadow = true;
          g.add(edge);
        }
      }
    }

    // moving platforms
    for (const m of course.movers) {
      const mesh = new THREE.Mesh(box(m.w, 0.7, m.d),
        glossy(theme.obstacle.block, { emissive: theme.obstacle.block, emissiveIntensity: 0.15 }));
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      g.add(mesh);
      // travel lane hint (visual only)
      const laneLen = m.A * 2 + (m.axis === 'x' ? m.w : m.d);
      const lane = new THREE.Mesh(
        new THREE.BoxGeometry(m.axis === 'x' ? laneLen : 0.3, 0.06, m.axis === 'z' ? laneLen : 0.3),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
      lane.position.set(m.cx, 0.05, m.cz);
      lane.userData.noAO = true;
      g.add(lane);
      this.moverViews.push({ m, mesh });
    }

    // obstacles
    const barMat = glossy(theme.obstacle.bar, { emissive: theme.obstacle.bar, emissiveIntensity: 0.3 });
    const poleMat = new THREE.MeshStandardMaterial({ color: theme.obstacle.pole, roughness: 0.5, metalness: detailed ? 0.2 : 0, envMapIntensity: 0.4 });
    for (const ob of course.obstacles) {
      if (ob.kind === 'spinner') {
        const grp = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, ob.h + 1.4, 16), poleMat);
        pole.position.y = (ob.h + 1.4) / 2 - 0.6;
        grp.add(pole);
        if (detailed) {
          const hub = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), barMat);
          hub.position.y = ob.h;
          grp.add(hub);
        }
        const arms = [];
        for (let k = 0; k < ob.arms; k++) {
          const bar = new THREE.Mesh(new THREE.CapsuleGeometry(ob.barR, ob.L, 8, 16), barMat);
          bar.rotation.z = Math.PI / 2;
          const holder = new THREE.Group();
          bar.position.x = ob.L / 2;
          holder.add(bar);
          holder.position.y = ob.h;
          holder.rotation.y = (k * TAU) / ob.arms;
          grp.add(holder);
          arms.push(holder);
        }
        grp.position.set(ob.cx, 0, ob.cz);
        grp.traverse(o => { o.castShadow = shadows; });
        g.add(grp);
        this.obstacleViews.push({ ob, kind: 'spinner', grp, arms });
      } else if (ob.kind === 'pendulum') {
        const grp = new THREE.Group();
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, ob.L, 10), poleMat);
        arm.position.y = -ob.L / 2;
        const bob = new THREE.Mesh(new THREE.SphereGeometry(ob.bobR, 28, 20),
          glossy(theme.obstacle.bob, { emissive: theme.obstacle.bob, emissiveIntensity: 0.2 }));
        bob.position.y = -ob.L;
        grp.add(arm); grp.add(bob);
        // gantry beam
        const beam = new THREE.Mesh(box(course.width + 2, 0.4, 0.4), poleMat);
        beam.position.set(0, ob.py + 0.2, ob.pz);
        beam.castShadow = shadows;
        g.add(beam);
        grp.position.set(ob.px, ob.py, ob.pz);
        grp.traverse(o => { o.castShadow = shadows; });
        g.add(grp);
        this.obstacleViews.push({ ob, kind: 'pendulum', grp });
      } else if (ob.kind === 'piston') {
        const block = new THREE.Mesh(box(2.0, ob.h, ob.z1 - ob.z0), glossy(theme.obstacle.block, { roughness: 0.5 }));
        block.position.y = ob.h / 2;
        block.castShadow = shadows;
        block.receiveShadow = true;
        g.add(block);
        this.obstacleViews.push({ ob, kind: 'piston', mesh: block });
      } else if (ob.kind === 'bumper') {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(ob.r, ob.r * 1.1, ob.h, 24),
          glossy(theme.obstacle.bumper, { emissive: theme.obstacle.bumper, emissiveIntensity: 0.25 }));
        mesh.position.set(ob.x, ob.h / 2, ob.z);
        mesh.castShadow = shadows;
        g.add(mesh);
        this.obstacleViews.push({ ob, kind: 'bumper', mesh });
      } else if (ob.kind === 'weave') {
        const wallMat = glossy(theme.obstacle.bar, { roughness: 0.5, emissive: theme.obstacle.bar, emissiveIntensity: 0.2 });
        const grp = new THREE.Group();
        const totalW = course.width;
        const gapW = ob.gapW;
        const sideW = (totalW - gapW) / 2;
        for (const s of [-1, 1]) {
          const wmesh = new THREE.Mesh(box(sideW, ob.h, 0.7), wallMat);
          wmesh.position.x = s * (gapW / 2 + sideW / 2);
          wmesh.position.y = ob.h / 2;
          wmesh.castShadow = shadows;
          wmesh.receiveShadow = true;
          grp.add(wmesh);
        }
        grp.position.z = ob.wz;
        g.add(grp);
        this.obstacleViews.push({ ob, kind: 'weave', grp });
      }
    }

    // zones: bounce pads, conveyor arrows, fan streams
    for (const zn of course.zones) {
      if (zn.kind === 'bounce') {
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(zn.r, zn.r, 0.25, 28),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: theme.checkpoint, emissiveIntensity: 0.8 }));
        pad.position.set(zn.x, 0.12, zn.z);
        pad.userData.glow = true;
        g.add(pad);
        this.zoneViews.push({ zn, mesh: pad, kind: 'bounce' });
      } else if (zn.kind === 'conveyor') {
        const dir = Math.atan2(zn.vx, zn.vz);
        const speed = Math.hypot(zn.vx, zn.vz);
        const n = Math.max(2, Math.floor((zn.z1 - zn.z0) / 4));
        for (let i = 0; i < n; i++) {
          const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 4),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
          arrow.rotation.x = Math.PI / 2;
          arrow.rotation.y = dir;
          arrow.rotation.order = 'YXZ';
          arrow.position.set((zn.x0 + zn.x1) / 2, 0.06, zn.z0 + (i + 0.5) * (zn.z1 - zn.z0) / n);
          arrow.userData.noAO = true;
          g.add(arrow);
          this.zoneViews.push({ zn, mesh: arrow, kind: 'conveyor', speed, phase: i * 0.7 });
        }
      } else if (zn.kind === 'wind') {
        // translucent stream bands showing push direction
        const dir = Math.atan2(zn.vx, zn.vz);
        for (let i = 0; i < 3; i++) {
          const band = new THREE.Mesh(new THREE.PlaneGeometry(0.3, Math.max(4, Math.hypot(zn.x1 - zn.x0, zn.z1 - zn.z0) * 0.8)),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
          band.rotation.x = -Math.PI / 2;
          band.position.set((zn.x0 + zn.x1) / 2 + (i - 1) * 2, 1.2 + i * 0.8, (zn.z0 + zn.z1) / 2);
          band.rotation.z = -dir;
          band.userData.noAO = true;
          g.add(band);
          this.zoneViews.push({ zn, mesh: band, kind: 'wind', phase: i * 1.3 });
        }
      }
    }

    // checkpoint rings + finish gate (emissive: these are what bloom picks up)
    for (let i = 0; i < course.checkpoints.length; i++) {
      const cp = course.checkpoints[i];
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.16, 12, 64),
        new THREE.MeshStandardMaterial({ color: C('checkpoint'), emissive: C('checkpoint'), emissiveIntensity: 1.0, roughness: 0.35 }));
      ring.position.set(cp.x, 3.4, cp.z);
      ring.userData.glow = true;
      g.add(ring);
      this.cpViews.push({ mesh: ring, index: i, z: cp.z });
    }
    if (course.kind === 'race') {
      const gate = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: C('finish'), emissive: C('finish'), emissiveIntensity: 1.0, roughness: 0.3 });
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6.4, 16), mat);
        post.position.set(s * (course.width / 2), 3.2, course.finishZ);
        gate.add(post);
      }
      const top = new THREE.Mesh(box(course.width + 0.5, 0.5, 0.5), mat);
      top.position.set(0, 6.4, course.finishZ);
      gate.add(top);
      if (detailed) {
        // chequered banner under the top beam
        const banner = new THREE.Mesh(new THREE.PlaneGeometry(course.width, 0.9),
          new THREE.MeshStandardMaterial({ map: tex.checker, side: THREE.DoubleSide, roughness: 0.6 }));
        scaleUv(banner.geometry, course.width / 1.8, 1, false);
        banner.position.set(0, 5.65, course.finishZ);
        gate.add(banner);
      }
      gate.traverse(o => { o.castShadow = shadows; if (o.material === mat) o.userData.glow = true; });
      g.add(gate);
      this.finishGate = gate;
    } else {
      this.finishGate = null;
    }

    this.buildDecor(course, theme);
    this.renderer.compile(this.scene, this.camera); // prewarm shaders
  }

  // Procedural surface textures (shared, built once).
  _surfaceTextures() {
    if (this._tex) return this._tex;
    const make = (draw) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      draw(c.getContext('2d'));
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      t.userData.shared = true;
      return t;
    };
    const rng = new Rng(7, 'decor');
    const speckle = (ctx, n, a) => {
      for (let i = 0; i < n; i++) {
        const v = rng.range(0, 1) < 0.5 ? 0 : 255;
        ctx.fillStyle = `rgba(${v},${v},${v},${rng.range(0, a)})`;
        ctx.fillRect(rng.range(0, 256), rng.range(0, 256), 2, 2);
      }
    };
    this._tex = {
      tiles: make((ctx) => {
        // four soft tiles with rounded grout, subtle alternating value
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#e9e9e9' : '#ffffff';
          ctx.fillRect(x * 128, y * 128, 128, 128);
        }
        speckle(ctx, 2600, 0.08);
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 5;
        for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
          ctx.beginPath(); ctx.roundRect(x * 128 + 3, y * 128 + 3, 122, 122, 14); ctx.stroke();
        }
      }),
      stripes: make((ctx) => {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        for (let x = 0; x < 256; x += 32) ctx.fillRect(x, 0, 14, 256);
        speckle(ctx, 1600, 0.05);
      }),
      checker: make((ctx) => {
        for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
          ctx.fillStyle = (x + y) % 2 ? '#1c2233' : '#ffffff';
          ctx.fillRect(x * 64, y * 128, 64, 128);
        }
      }),
    };
    return this._tex;
  }

  buildDecor(course, theme) {
    const rng = new Rng(course.seed, 'decor');
    const grp = new THREE.Group();
    this.decorGroup = grp;
    this.decorAnim = [];
    const detailed = this.q.detail === 'detailed';
    const kinds = theme.decor || ['cloud', 'island'];
    const density = detailed ? 1 : 0.35;
    const count = Math.round(26 * density);
    // floating islands + clouds, deterministic
    const islandGeo = detailed ? new THREE.DodecahedronGeometry(1, 1) : new THREE.DodecahedronGeometry(1, 0);
    if (detailed) jitter(islandGeo, new Rng(course.seed, 'decor-rock'), 0.12);
    const islandMat = new THREE.MeshStandardMaterial({ color: theme.platform.under, roughness: 1, flatShading: true, envMapIntensity: 0.4 });
    const storm = kinds.includes('storm');
    const cloudMat = new THREE.MeshStandardMaterial({
      color: storm ? 0x8d99ae : 0xffffff, roughness: 1, envMapIntensity: 0.3,
      emissive: storm ? 0x3a4458 : new THREE.Color(theme.sky.horizon).lerp(new THREE.Color(0xffffff), 0.5),
      emissiveIntensity: detailed ? 0.35 : 0,
      transparent: true, opacity: storm ? 0.95 : 0.88,
    });
    const puffs = detailed ? 5 : 1;
    const cloudGeo = new THREE.SphereGeometry(1, detailed ? 16 : 10, detailed ? 12 : 8);
    const islands = new THREE.InstancedMesh(islandGeo, islandMat, count);
    const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, count * 3 * puffs);
    clouds.userData.noAO = true;
    const mtx = new THREE.Matrix4();
    let ci = 0;
    for (let i = 0; i < count; i++) {
      const ang = rng.range(0, TAU), rad = rng.range(40, 130);
      const x = Math.cos(ang) * rad, z = rng.range(-30, (course.length || 60) + 60) + Math.sin(ang) * 20;
      const y = rng.range(-24, -6);
      const sc = rng.range(2, 7);
      mtx.makeRotationY(rng.range(0, TAU));
      mtx.scale(new THREE.Vector3(sc, sc * 0.5, sc));
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
          // cumulus cluster: a wide flat base plus rounder puffs on top
          for (let j = 0; j < puffs; j++) {
            const ps = cs * (j === 0 ? 1 : rng.range(0.55, 0.85));
            mtx.makeScale(ps * (j === 0 ? 1.9 : 1.1), ps * (j === 0 ? 0.55 : 0.8), ps * (j === 0 ? 1.1 : 0.9));
            mtx.setPosition(cx + (j === 0 ? 0 : rng.range(-1.4, 1.4) * cs), cy + (j === 0 ? 0 : rng.range(0.1, 0.5) * cs), cz + (j === 0 ? 0 : rng.range(-0.6, 0.6) * cs));
            clouds.setMatrixAt(ci++, mtx);
          }
        }
      }
    }
    islands.instanceMatrix.needsUpdate = true;
    clouds.instanceMatrix.needsUpdate = true;
    grp.add(islands); grp.add(clouds);
    this.decorAnim.push({ kind: 'drift', obj: clouds, phase: 0 });

    // theme decor kinds beyond the base islands + clouds
    if (kinds.includes('star')) {
      // distant pinprick stars (night themes)
      const n = Math.round(240 * density);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const ang = rng.range(0, TAU), rad = rng.range(150, 300);
        pos[i * 3] = Math.cos(ang) * rad;
        pos[i * 3 + 1] = rng.range(30, 170);
        pos[i * 3 + 2] = Math.sin(ang) * rad;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      grp.add(new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9,
      })));
    }
    if (kinds.includes('balloon')) {
      const n = Math.max(2, Math.round(6 * density));
      const mesh = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshPhysicalMaterial({ color: theme.accent, roughness: 0.35, clearcoat: detailed ? 0.8 : 0, emissive: theme.accent, emissiveIntensity: 0.15 }), n);
      for (let i = 0; i < n; i++) {
        const ang = rng.range(0, TAU), rad = rng.range(28, 90);
        const sc = rng.range(1.1, 2.1);
        mtx.makeScale(sc, sc * 1.3, sc);
        mtx.setPosition(Math.cos(ang) * rad, rng.range(10, 28), rng.range(-20, (course.length || 60) + 40));
        mesh.setMatrixAt(i, mtx);
      }
      mesh.instanceMatrix.needsUpdate = true;
      grp.add(mesh);
      this.decorAnim.push({ kind: 'bob', obj: mesh, phase: 1.3 });
    }
    if (kinds.includes('kite')) {
      const n = Math.max(2, Math.round(5 * density));
      const mesh = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1, 0.5, 4),
        new THREE.MeshStandardMaterial({ color: theme.hazard, roughness: 0.6, emissive: theme.hazard, emissiveIntensity: 0.2 }), n);
      const rot = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const ang = rng.range(0, TAU), rad = rng.range(24, 80);
        rot.makeRotationFromEuler(new THREE.Euler(rng.range(-0.5, 0.5), rng.range(0, TAU), Math.PI));
        rot.scale(new THREE.Vector3(1.4, 1.4, 0.25));
        rot.setPosition(Math.cos(ang) * rad, rng.range(12, 30), rng.range(-16, (course.length || 60) + 36));
        mesh.setMatrixAt(i, rot);
      }
      mesh.instanceMatrix.needsUpdate = true;
      grp.add(mesh);
      this.decorAnim.push({ kind: 'bob', obj: mesh, phase: 0.4 });
    }
    if (kinds.includes('aurora')) {
      // slow additive sky ribbons (aurora themes)
      for (let i = 0; i < 3; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: theme.checkpoint, transparent: true, opacity: 0.14,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
        });
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(rng.range(30, 60), rng.range(40, 70)), mat);
        ribbon.position.set(rng.range(-130, 130), rng.range(42, 72), rng.range(60, 170));
        ribbon.rotation.y = rng.range(0, TAU);
        ribbon.userData.noAO = true;
        grp.add(ribbon);
        this.decorAnim.push({ kind: 'shimmer', obj: ribbon, base: 0.14, phase: i * 2.1 });
      }
    }
    // floating light motes near the course (high particle tier)
    this.motes = null;
    if (this.q.particles === 'high') {
      const n = 140;
      const base = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        base[i * 3] = rng.range(-20, 20);
        base[i * 3 + 1] = rng.range(1, 15);
        base[i * 3 + 2] = rng.range(-14, 26);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(base.slice(), 3));
      const motes = new THREE.Points(geo, new THREE.PointsMaterial({
        color: new THREE.Color(theme.accent).lerp(new THREE.Color(0xffffff), 0.5), size: 0.16, map: this._softDot(),
        transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      motes.frustumCulled = false;
      motes.userData.base = base;
      motes.userData.glow = true;
      grp.add(motes);
      this.motes = motes;
    }
    this.scene.add(grp);
  }

  _softDot() {
    if (this._dot) return this._dot;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d');
    const gr = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 32, 32);
    this._dot = new THREE.CanvasTexture(c);
    this._dot.userData.shared = true;
    return this._dot;
  }

  disposeCourse() {
    if (this.courseGroup) { this.scene.remove(this.courseGroup); disposeDeep(this.courseGroup); this.courseGroup = null; }
    if (this.decorGroup) { this.scene.remove(this.decorGroup); disposeDeep(this.decorGroup); this.decorGroup = null; }
    if (this.sky) { this.scene.remove(this.sky); this.sky.geometry.dispose(); this.sky.material.dispose(); this.sky = null; }
    if (this.sun) { this.scene.remove(this.sun); this.scene.remove(this.sun.target); this.sun.dispose(); this.sun = null; }
    if (this.hemi) { this.scene.remove(this.hemi); this.hemi.dispose(); this.hemi = null; }
    this.motes = null;
    this.decorAnim = [];
    this.obstacleViews = []; this.moverViews = []; this.zoneViews = []; this.cpViews = [];
    for (const [, v] of this.playerViews) { this.scene.remove(v.grp); disposeDeep(v.grp); }
    this.playerViews.clear();
    for (const pt of this.particles) { this.scene.remove(pt.mesh); pt.mesh.material.dispose(); }
    this.particles = [];
  }

  // ---------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------
  ensurePlayers(players) {
    const detailed = this.q.detail === 'detailed';
    const shadows = SHADOW_MAP[this.q.shadows] > 0;
    for (const p of players) {
      if (this.playerViews.has(p.id)) continue;
      const grp = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.5, 0.7, 8, detailed ? 24 : 16),
        detailed
          ? new THREE.MeshPhysicalMaterial({ color: p.color, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.2, envMapIntensity: 0.4 })
          : new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.45 }));
      body.position.y = 0.85;
      body.castShadow = shadows;
      grp.add(body);
      // face marker (direction cue readable without color)
      const face = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 }));
      face.position.set(0, 1.15, 0.42);
      grp.add(face);
      // grounded ring marker (selection/state layer)
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.72, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      ring.userData.noAO = true;
      grp.add(ring);
      // name sprite for opponents
      const label = makeNameSprite(p.name, p.color);
      label.position.y = 2.1;
      grp.add(label);
      this.scene.add(grp);
      this.playerViews.set(p.id, { grp, body, ring, label, stunned: false });
    }
  }

  spawnBurst(x, y, z, color, n = 10) {
    const high = this.q.particles === 'high';
    const count = Math.round(n * (high ? 1 : 0.3));
    for (let i = 0; i < count; i++) {
      // high tier: over-bright sparkles so bloom catches them
      const c = new THREE.Color(color);
      if (high && i % 3 === 0) c.multiplyScalar(2.2);
      const mesh = new THREE.Mesh(this.burstGeo, new THREE.MeshBasicMaterial({ color: c, transparent: true }));
      mesh.position.set(x, y, z);
      mesh.userData.noAO = true;
      mesh.userData.glow = true;
      const a = Math.random() * TAU, v = 2 + Math.random() * 4;
      this.scene.add(mesh);
      this.particles.push({ mesh, vx: Math.cos(a) * v, vy: 2 + Math.random() * 4, vz: Math.sin(a) * v, life: 0.6 });
    }
  }

  onEvent(e, localId) {
    const tierLocal = e.p === localId;
    switch (e.t) {
      case 'knock':
        this.spawnBurst(e.x, e.y + 1, e.z, 0xffffff, 14);
        if (tierLocal && !this.reducedMotion && this.camShake) this.shakeAmp = Math.min(0.5, this.shakeAmp + 0.3);
        break;
      case 'fall': if (tierLocal && !this.reducedMotion && this.camShake) this.shakeAmp = Math.min(0.4, this.shakeAmp + 0.2); break;
      case 'checkpoint': this.spawnBurst(e.x != null ? e.x : 0, 3.4, e.z || 0, 0x06d6a0, 8); break;
      case 'bounce': this.spawnBurst(e.x, e.y, e.z, 0xffffff, 8); break;
      case 'finish': if (tierLocal) this.spawnBurst(e.x || 0, 2, e.z || 0, 0xffd166, 24); break;
    }
  }

  // Title-screen backdrop: build the course, no players, slow authored pan.
  buildAttractCourse(def) {
    this.buildCourse(buildCourse(def), def.theme);
  }

  renderAttract(t) {
    if (!this.ok || this.hidden || !this.course) return;
    // tick the obstacle animation slowly so the scene feels alive
    const tick = t * 20;
    for (const v of this.obstacleViews) {
      const ob = v.ob;
      if (v.kind === 'spinner') {
        const w = spinnerOmega(ob, tick);
        const th = ob.phase + w * tick;
        for (let k = 0; k < v.arms.length; k++) v.arms[k].rotation.y = th + (k * TAU) / ob.arms;
      } else if (v.kind === 'pendulum') {
        v.grp.rotation[ob.plane === 'x' ? 'z' : 'x'] = ob.A * Math.sin(ob.omega * tick + ob.phase);
      } else if (v.kind === 'piston') {
        v.mesh.position.x = ob.baseX + ob.A * Math.sin(ob.omega * tick + ob.phase);
      } else if (v.kind === 'weave') {
        v.grp.position.x = ob.A * Math.sin(ob.omega * tick + ob.phase);
      }
    }
    for (const v of this.moverViews) {
      const mt = moverTransform(v.m, tick);
      v.mesh.position.set(mt.x, v.m.y - 0.35, mt.z);
    }
    const cz = 10 + 8 * Math.sin(t * 0.05);
    this.camera.position.set(14 * Math.sin(t * 0.04), 12, cz - 16);
    this.camera.lookAt(0, 0, cz + 8);
    this.focus.set(0, 0, cz);
    this._fitShadow(0, cz);
    if (this.sky) this.sky.position.copy(this.camera.position);
    this._ambient(1 / 60);
    this._present();
  }

  // ---------------------------------------------------------------------
  // Per-frame render from a sim snapshot
  // ---------------------------------------------------------------------
  render(state, alpha, localId, dt) {
    if (!this.ok || this.hidden) return;
    const tick = state.tick + alpha;

    // obstacles: pure functions of tick
    for (const v of this.obstacleViews) {
      const ob = v.ob;
      if (v.kind === 'spinner') {
        const w = spinnerOmega(ob, tick);
        const th = ob.phase + w * tick;
        for (let k = 0; k < v.arms.length; k++) {
          v.arms[k].rotation.y = th + (k * TAU) / ob.arms;
        }
      } else if (v.kind === 'pendulum') {
        const th = ob.A * Math.sin(ob.omega * tick + ob.phase);
        v.grp.rotation[ob.plane === 'x' ? 'z' : 'x'] = th;
      } else if (v.kind === 'piston') {
        v.mesh.position.x = ob.baseX + ob.A * Math.sin(ob.omega * tick + ob.phase);
        v.mesh.position.z = (ob.z0 + ob.z1) / 2;
      } else if (v.kind === 'weave') {
        v.grp.position.x = ob.A * Math.sin(ob.omega * tick + ob.phase);
      }
    }
    for (const v of this.moverViews) {
      const t = moverTransform(v.m, tick);
      v.mesh.position.set(t.x, v.m.y - 0.35, t.z);
    }
    for (const v of this.zoneViews) {
      if (v.kind === 'bounce') {
        v.mesh.scale.y = 1 + 0.25 * Math.sin(tick * 0.12 + v.zn.z);
      } else if (v.kind === 'conveyor') {
        v.mesh.position.z = v.zn.z0 + ((tick * v.speed * 0.06 + v.phase) % 1) * (v.zn.z1 - v.zn.z0);
        v.mesh.material.opacity = 0.2 + 0.18 * Math.sin(tick * 0.1 + v.phase);
      } else if (v.kind === 'wind') {
        v.mesh.material.opacity = 0.1 + 0.08 * Math.sin(tick * 0.15 + v.phase);
      }
    }
    const local = state.players.find(p => p.id === localId);
    for (const cp of this.cpViews) {
      cp.mesh.rotation.y = tick * 0.02;
      const passed = local && state.kind === 'race' && local.cp > cp.index;
      cp.mesh.material.emissiveIntensity = passed ? 0.15 : 1.0;
    }

    // players: interpolate prev -> cur
    this.ensurePlayers(state.players);
    for (const p of state.players) {
      const v = this.playerViews.get(p.id);
      if (!v) continue;
      const x = p.px + (p.x - p.px) * alpha;
      const y = p.py + (p.y - p.py) * alpha;
      const z = p.pz + (p.z - p.pz) * alpha;
      v.grp.position.set(x, y, z);
      v.grp.rotation.y = Math.atan2(p.vx, p.vz || 0.0001);
      const squash = p.st === PSTATE.DIVE ? 0.55 : p.st === PSTATE.STUN ? 0.7 : 1;
      const stretch = p.st === PSTATE.AIR && p.vy > 2 ? 1.12 : 1;
      if (!this.reducedMotion) v.body.scale.set(1, squash * stretch, 1);
      if (p.st === PSTATE.DIVE) v.body.rotation.x = Math.PI / 2.3;
      else v.body.rotation.x = 0;
      v.stunned = p.st === PSTATE.STUN;
      v.ring.material.opacity = p.id === localId ? 0.7 : 0.3;
      v.ring.material.color.setHex(p.invulnT > 0 ? 0xffff66 : (p.id === localId ? 0xffffff : 0xcccccc));
      v.grp.visible = p.st !== PSTATE.OUT && !(p.st === PSTATE.RESPAWN);
    }

    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      pt.vy -= 12 * dt;
      pt.mesh.position.x += pt.vx * dt;
      pt.mesh.position.y += pt.vy * dt;
      pt.mesh.position.z += pt.vz * dt;
      pt.mesh.material.opacity = Math.max(0, pt.life / 0.6);
      if (pt.life <= 0) {
        this.scene.remove(pt.mesh); pt.mesh.material.dispose();
        this.particles.splice(i, 1);
      }
    }

    // camera: authored follow framing, critically damped toward target
    const me = local || state.players[0];
    if (me) {
      const fx = me.px + (me.x - me.px) * alpha;
      const fy = me.py + (me.y - me.py) * alpha;
      const fz = me.pz + (me.z - me.pz) * alpha;
      const far = this.cameraMode === 'far' ? 1.5 : 1;
      const want = new THREE.Vector3(fx * 0.7, 8.5 * far + fy * 0.3, fz - 11 * far);
      const look = new THREE.Vector3(fx * 0.85, 1.2 + fy * 0.4, fz + 6);
      // critically damped spring (frame-rate independent, interruptible)
      const k = this.reducedMotion ? 1 : 6.5;
      const t = 1 - Math.exp(-k * dt);
      this.camPos.lerp(want, t);
      this.camTarget.lerp(look, t);
      if (this.shakeAmp > 0.001 && !this.reducedMotion && this.camShake) {
        this.camPos.x += (Math.random() - 0.5) * this.shakeAmp;
        this.camPos.y += (Math.random() - 0.5) * this.shakeAmp * 0.6;
      }
      this.shakeAmp *= Math.exp(-6 * dt);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.focus.set(fx, 0, fz);
      this._fitShadow(fx, fz);
      if (this.sky) this.sky.position.copy(this.camera.position);
    }

    this._ambient(dt);
    this._present();
  }
}

// GPU name for Auto detection; Firefox already reports the unmasked renderer.
function readGpu(renderer) {
  try {
    const gl = renderer.getContext();
    if (/firefox/i.test(navigator.userAgent || '')) return String(gl.getParameter(gl.RENDERER) || '');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch (e) {
    return '';
  }
}

function wrap(v, size) {
  return ((v % size) + size) % size - size / 2;
}

// Scale a geometry's UVs so tiled textures keep a world-space size.
function scaleUv(geo, su, sv, centered) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, centered ? (u - 0.5) * su : u * su, centered ? (v - 0.5) * sv : v * sv);
  }
  uv.needsUpdate = true;
}

// Deterministic vertex jitter for rock silhouettes (keeps shared vertices welded).
function jitter(geo, rng, amt) {
  const pos = geo.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let f = seen.get(key);
    if (f == null) { f = 1 + rng.range(-amt, amt); seen.set(key, f); }
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i) * f);
  }
  geo.computeVertexNormals();
}

function disposeDeep(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.map && !m.map.userData.shared) m.map.dispose();
        m.dispose();
      }
    }
  });
}

function makeNameSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,28,0.9)'; // near-opaque: reads the same with linear-space (post) blending
  ctx.beginPath(); ctx.roundRect(24, 8, 208, 44, 12); ctx.fill();
  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(name.slice(0, 12), 128, 31);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.4, 0.6, 1);
  return sprite;
}
