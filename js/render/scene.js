// Three.js presentation. Consumes immutable sim snapshots + tick clock;
// every moving obstacle's transform is a pure function of (tick, seed), so
// visuals never diverge from rules. Deterministic decor from the decor
// stream. Quality tiers control pixel ratio, shadows, decor, particles —
// never gameplay visibility.

import * as THREE from 'three';
import { Rng } from '../rules/rng.js';
import { moverTransform, spinnerOmega, buildCourse, KILL_Y } from '../rules/course.js';
import { themeById } from '../content/themes.js';
import { PSTATE } from '../rules/sim.js';

const TAU = Math.PI * 2;

const QUALITY = {
  high: { dpr: 2.0, shadows: true, decor: 1.0, particles: 1.0 },
  medium: { dpr: 1.5, shadows: true, decor: 0.6, particles: 0.6 },
  low: { dpr: 1.0, shadows: false, decor: 0.3, particles: 0.3 },
};

// Color-vision-safe gameplay palettes (shape/label also reinforce meaning)
const PALETTES = {
  standard: {},
  deuteranopia: { checkpoint: 0x56b4e9, finish: 0xf0e442, hazard: 0xd55e00 },
  protanopia: { checkpoint: 0x56b4e9, finish: 0xf0e442, hazard: 0x0072b2 },
  tritanopia: { checkpoint: 0x009e73, finish: 0xf0e442, hazard: 0xcc79a7 },
};

export class GameScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.quality = QUALITY.medium;
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
    this.particles = [];
    this.shakeAmp = 0;
    this.theme = null;
    this.course = null;
    this.hidden = false;
    this.frameCost = 16;
    this.autoTier = 'medium';
    this.ok = this.initGL();
  }

  initGL() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
      });
    } catch (e) {
      return false;
    }
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camTarget = new THREE.Vector3();
    this.camPos = new THREE.Vector3(0, 9, -10);
    this.resize();
    return true;
  }

  setQuality(tier) {
    this.quality = QUALITY[tier] || QUALITY.medium;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.dpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    if (this.sun) this.sun.castShadow = this.quality.shadows;
    if (this.decorGroup) this.decorGroup.visible = this.quality.decor > 0.05;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------
  // Course construction (called once per round; disposes the previous one)
  // ---------------------------------------------------------------------
  buildCourse(course, themeId) {
    this.disposeCourse();
    this.course = course;
    const theme = themeById(themeId);
    this.theme = theme;
    const pal = PALETTES[this.palette] || {};
    const C = (k) => pal[k] != null ? pal[k] : theme[k];

    // sky dome + fog + lights
    this.scene.fog = new THREE.FogExp2(theme.fog.color, theme.fog.density);
    const skyGeo = new THREE.SphereGeometry(320, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(theme.sky.top) },
        horizon: { value: new THREE.Color(theme.sky.horizon) },
        ground: { value: new THREE.Color(theme.sky.ground) },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
        void main(){ float h = normalize(vP).y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, ground, pow(-h, 0.5));
        gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.sky);

    const hemi = new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(theme.sun.color, theme.sun.intensity);
    sun.position.set(...theme.sun.pos);
    sun.castShadow = this.quality.shadows;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
    const S = 26;
    sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
    sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);

    const g = new THREE.Group();
    this.courseGroup = g;
    this.scene.add(g);

    const matTop = new THREE.MeshStandardMaterial({ color: theme.platform.top, roughness: 0.85, metalness: 0.02 });
    const matSide = new THREE.MeshStandardMaterial({ color: theme.platform.side, roughness: 0.9 });
    const matEdge = new THREE.MeshStandardMaterial({ color: theme.platform.edge, roughness: 0.6, emissive: theme.platform.edge, emissiveIntensity: 0.25 });
    const matUnder = new THREE.MeshStandardMaterial({ color: theme.platform.under, roughness: 1 });

    // platforms: slab with edge trim and underside skirt
    for (const p of course.platforms) {
      if (p.disc) {
        const geo = new THREE.CylinderGeometry(p.r, p.r * 0.82, 1.6, 40);
        const mesh = new THREE.Mesh(geo, [matSide, matTop, matUnder]);
        mesh.position.set(course.arena.cx, -0.8, course.arena.cz);
        mesh.receiveShadow = true;
        g.add(mesh);
        const rim = new THREE.Mesh(new THREE.TorusGeometry(p.r - 0.1, 0.14, 8, 48), matEdge);
        rim.rotation.x = Math.PI / 2;
        rim.position.set(course.arena.cx, 0.02, course.arena.cz);
        g.add(rim);
        continue;
      }
      const w = p.x1 - p.x0, d = p.z1 - p.z0;
      const geo = new THREE.BoxGeometry(w, 1.2, d);
      const mesh = new THREE.Mesh(geo, [matSide, matSide, matTop, matUnder, matSide, matSide]);
      mesh.position.set((p.x0 + p.x1) / 2, p.y - 0.6, (p.z0 + p.z1) / 2);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      g.add(mesh);
      const edgeGeo = new THREE.BoxGeometry(w + 0.08, 0.12, d + 0.08);
      const edge = new THREE.Mesh(edgeGeo, p.finish
        ? new THREE.MeshStandardMaterial({ color: C('finish'), emissive: C('finish'), emissiveIntensity: 0.5, roughness: 0.5 })
        : matEdge);
      edge.position.set((p.x0 + p.x1) / 2, p.y + 0.02, (p.z0 + p.z1) / 2);
      edge.receiveShadow = true;
      g.add(edge);
    }

    // moving platforms
    for (const m of course.movers) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(m.w, 0.7, m.d),
        new THREE.MeshStandardMaterial({ color: theme.obstacle.block, roughness: 0.5, emissive: theme.obstacle.block, emissiveIntensity: 0.15 }));
      mesh.castShadow = this.quality.shadows;
      mesh.receiveShadow = true;
      g.add(mesh);
      // travel lane hint (visual only)
      const laneLen = m.A * 2 + (m.axis === 'x' ? m.w : m.d);
      const lane = new THREE.Mesh(
        new THREE.BoxGeometry(m.axis === 'x' ? laneLen : 0.3, 0.06, m.axis === 'z' ? laneLen : 0.3),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
      lane.position.set(m.cx, 0.05, m.cz);
      g.add(lane);
      this.moverViews.push({ m, mesh });
    }

    // obstacles
    const barMat = new THREE.MeshStandardMaterial({ color: theme.obstacle.bar, roughness: 0.4, emissive: theme.obstacle.bar, emissiveIntensity: 0.3 });
    const poleMat = new THREE.MeshStandardMaterial({ color: theme.obstacle.pole, roughness: 0.6 });
    for (const ob of course.obstacles) {
      if (ob.kind === 'spinner') {
        const grp = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, ob.h + 1.4, 12), poleMat);
        pole.position.y = (ob.h + 1.4) / 2 - 0.6;
        grp.add(pole);
        const arms = [];
        for (let k = 0; k < ob.arms; k++) {
          const bar = new THREE.Mesh(new THREE.CapsuleGeometry(ob.barR, ob.L, 6, 12), barMat);
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
        grp.traverse(o => { o.castShadow = this.quality.shadows; });
        g.add(grp);
        this.obstacleViews.push({ ob, kind: 'spinner', grp, arms });
      } else if (ob.kind === 'pendulum') {
        const grp = new THREE.Group();
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, ob.L, 8), poleMat);
        arm.position.y = -ob.L / 2;
        const bob = new THREE.Mesh(new THREE.SphereGeometry(ob.bobR, 18, 14),
          new THREE.MeshStandardMaterial({ color: theme.obstacle.bob, roughness: 0.35, emissive: theme.obstacle.bob, emissiveIntensity: 0.2 }));
        bob.position.y = -ob.L;
        grp.add(arm); grp.add(bob);
        // gantry beam
        const beam = new THREE.Mesh(new THREE.BoxGeometry(course.width + 2, 0.4, 0.4), poleMat);
        beam.position.set(0, ob.py + 0.2, ob.pz);
        g.add(beam);
        grp.position.set(ob.px, ob.py, ob.pz);
        grp.traverse(o => { o.castShadow = this.quality.shadows; });
        g.add(grp);
        this.obstacleViews.push({ ob, kind: 'pendulum', grp });
      } else if (ob.kind === 'piston') {
        const block = new THREE.Mesh(new THREE.BoxGeometry(2.0, ob.h, ob.z1 - ob.z0),
          new THREE.MeshStandardMaterial({ color: theme.obstacle.block, roughness: 0.5 }));
        block.position.y = ob.h / 2;
        block.castShadow = this.quality.shadows;
        g.add(block);
        this.obstacleViews.push({ ob, kind: 'piston', mesh: block });
      } else if (ob.kind === 'bumper') {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(ob.r, ob.r * 1.1, ob.h, 16),
          new THREE.MeshStandardMaterial({ color: theme.obstacle.bumper, roughness: 0.35, emissive: theme.obstacle.bumper, emissiveIntensity: 0.25 }));
        mesh.position.set(ob.x, ob.h / 2, ob.z);
        mesh.castShadow = this.quality.shadows;
        g.add(mesh);
        this.obstacleViews.push({ ob, kind: 'bumper', mesh });
      } else if (ob.kind === 'weave') {
        const wallMat = new THREE.MeshStandardMaterial({ color: theme.obstacle.bar, roughness: 0.5, emissive: theme.obstacle.bar, emissiveIntensity: 0.2 });
        const grp = new THREE.Group();
        const totalW = course.width;
        const gapW = ob.gapW;
        const sideW = (totalW - gapW) / 2;
        for (const s of [-1, 1]) {
          const wmesh = new THREE.Mesh(new THREE.BoxGeometry(sideW, ob.h, 0.7), wallMat);
          wmesh.position.x = s * (gapW / 2 + sideW / 2);
          wmesh.position.y = ob.h / 2;
          wmesh.castShadow = this.quality.shadows;
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
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(zn.r, zn.r, 0.25, 20),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: theme.checkpoint, emissiveIntensity: 0.5 }));
        pad.position.set(zn.x, 0.12, zn.z);
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
          g.add(band);
          this.zoneViews.push({ zn, mesh: band, kind: 'wind', phase: i * 1.3 });
        }
      }
    }

    // checkpoint rings + finish gate
    for (let i = 0; i < course.checkpoints.length; i++) {
      const cp = course.checkpoints[i];
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.16, 10, 36),
        new THREE.MeshStandardMaterial({ color: C('checkpoint'), emissive: C('checkpoint'), emissiveIntensity: 0.6, roughness: 0.4 }));
      ring.position.set(cp.x, 3.4, cp.z);
      g.add(ring);
      this.cpViews.push({ mesh: ring, index: i, z: cp.z });
    }
    if (course.kind === 'race') {
      const gate = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: C('finish'), emissive: C('finish'), emissiveIntensity: 0.7, roughness: 0.3 });
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6.4, 10), mat);
        post.position.set(s * (course.width / 2), 3.2, course.finishZ);
        gate.add(post);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(course.width + 0.5, 0.5, 0.5), mat);
      top.position.set(0, 6.4, course.finishZ);
      gate.add(top);
      g.add(gate);
      this.finishGate = gate;
    } else {
      this.finishGate = null;
    }

    this.buildDecor(course, theme);
    this.renderer.compile(this.scene, this.camera); // prewarm shaders
  }

  buildDecor(course, theme) {
    const rng = new Rng(course.seed, 'decor');
    const grp = new THREE.Group();
    this.decorGroup = grp;
    const count = Math.round(26 * this.quality.decor);
    // floating islands + clouds, deterministic
    const islandGeo = new THREE.DodecahedronGeometry(1, 0);
    const islandMat = new THREE.MeshStandardMaterial({ color: theme.platform.under, roughness: 1 });
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.85 });
    const cloudGeo = new THREE.SphereGeometry(1, 10, 8);
    const islands = new THREE.InstancedMesh(islandGeo, islandMat, count);
    const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, count * 3);
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
        mtx.makeScale(cs * 1.8, cs * 0.7, cs);
        mtx.setPosition(x + rng.range(-14, 14), rng.range(6, 30), z + rng.range(-14, 14));
        clouds.setMatrixAt(ci++, mtx);
      }
    }
    islands.instanceMatrix.needsUpdate = true;
    clouds.instanceMatrix.needsUpdate = true;
    grp.add(islands); grp.add(clouds);
    this.scene.add(grp);
  }

  disposeCourse() {
    if (this.courseGroup) { this.scene.remove(this.courseGroup); disposeDeep(this.courseGroup); this.courseGroup = null; }
    if (this.decorGroup) { this.scene.remove(this.decorGroup); disposeDeep(this.decorGroup); this.decorGroup = null; }
    if (this.sky) { this.scene.remove(this.sky); this.sky.geometry.dispose(); this.sky.material.dispose(); this.sky = null; }
    this.obstacleViews = []; this.moverViews = []; this.zoneViews = []; this.cpViews = [];
    for (const [, v] of this.playerViews) { this.scene.remove(v.grp); disposeDeep(v.grp); }
    this.playerViews.clear();
    for (const pt of this.particles) { this.scene.remove(pt.mesh); pt.mesh.geometry.dispose(); pt.mesh.material.dispose(); }
    this.particles = [];
  }

  // ---------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------
  ensurePlayers(players) {
    for (const p of players) {
      if (this.playerViews.has(p.id)) continue;
      const grp = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.5, 0.7, 8, 16),
        new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.45 }));
      body.position.y = 0.85;
      body.castShadow = this.quality.shadows;
      grp.add(body);
      // face marker (direction cue readable without color)
      const face = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
      face.position.set(0, 1.15, 0.42);
      grp.add(face);
      // grounded ring marker (selection/state layer)
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.72, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
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
    if (this.quality.particles < 0.1) return;
    const count = Math.round(n * this.quality.particles);
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5),
        new THREE.MeshBasicMaterial({ color, transparent: true }));
      mesh.position.set(x, y, z);
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
    if (this.sky) this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
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
    for (const cp of this.cpViews) {
      cp.mesh.rotation.y = tick * 0.02;
      const local = state.players.find(p => p.id === localId);
      const passed = local && state.kind === 'race' && local.cp > cp.index;
      cp.mesh.material.emissiveIntensity = passed ? 0.15 : 0.6;
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
        this.scene.remove(pt.mesh); pt.mesh.geometry.dispose(); pt.mesh.material.dispose();
        this.particles.splice(i, 1);
      }
    }

    // camera: authored follow framing, critically damped toward target
    const me = state.players.find(p => p.id === localId) || state.players[0];
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
      if (this.sun) { this.sun.target.position.set(fx, 0, fz); this.sun.position.set(fx + this.theme.sun.pos[0] * 0.4, this.theme.sun.pos[1], fz + this.theme.sun.pos[2] * 0.4); }
      if (this.sky) this.sky.position.copy(this.camera.position);
    }

    this.renderer.render(this.scene, this.camera);
  }
}

function disposeDeep(obj) {
  obj.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

function makeNameSprite(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,28,0.65)';
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
