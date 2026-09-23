import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createStarfield, createEarth, createGlowSprite, createLabel, renderLabels,
  createWebbMarker, createRomanMarker, makeThickLine, gradientColors, createComposer,
  createSpaceEnvironment, frameObjects,
} from './common.js';

/**
 * The Sun–Earth–L2 neighbourhood with both observatories on their real
 * trajectories, from JPL Horizons.
 *
 * Coordinates: Ecliptic of J2000.0, Earth at the origin, kilometres.
 * SCALE maps that to scene units — 1 unit = 100,000 km, so L2 sits ~15 units
 * out and the whole system fits a comfortable camera frustum.
 *
 * Honest about exaggeration: Earth is drawn ~8.6x oversized and the spacecraft
 * are symbolic markers many orders of magnitude too large. At true scale both
 * telescopes would be invisible sub-pixel specks. The *positions and paths*
 * are real; the object sizes are not, and the UI says so.
 */

const KM_PER_UNIT = 100_000;
const SCALE = 1 / KM_PER_UNIT;

const EARTH_RADIUS_KM = 6371;
const EARTH_DRAW_RADIUS = 0.55; // units
export const EARTH_EXAGGERATION = EARTH_DRAW_RADIUS / (EARTH_RADIUS_KM * SCALE);

export const COLORS = {
  jwst: 0xffb347,
  jwstDim: 0x5a3a12,
  roman: 0x4fd1c5,
  romanDim: 0x12403c,
  l2: 0xa78bfa,
  sun: 0xfff0c0,
  axis: 0x33405e,
};

const v = (p) => new THREE.Vector3(p.x * SCALE, p.y * SCALE, p.z * SCALE);

export class L2Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.focus = 'both';
    this.disposed = false;
    this._t = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
    this.camera.position.set(19, -24, 13);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.5;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 140;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.18;
    // Any interaction stops the idle drift; it resumes after a pause.
    this._idleTimer = null;
    const nudge = () => {
      this.controls.autoRotate = false;
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => { this.controls.autoRotate = true; }, 6000);
    };
    canvas.addEventListener('pointerdown', nudge);
    canvas.addEventListener('wheel', nudge, { passive: true });

    this.scene.environment = createSpaceEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.55;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.16));
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 2.6);
    this.scene.add(this.sunLight);

    this.stars = createStarfield();
    this.scene.add(this.stars);

    this.earth = createEarth(EARTH_DRAW_RADIUS);
    this.scene.add(this.earth);

    this.sunGlow = createGlowSprite(COLORS.sun, 26);
    this.scene.add(this.sunGlow);

    this.dynamic = new THREE.Group(); // everything rebuilt on data refresh
    this.scene.add(this.dynamic);

    // Modest bloom: strong bloom on additive sprites erases the geometry under
    // them. Threshold is above the starfield so stars stay crisp points.
    this.composer = createComposer(this.renderer, this.scene, this.camera, {
      strength: 0.52, radius: 0.62, threshold: 0.28,
    });

    this._lineMaterials = [];
    this._labels = [];
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /** Rebuild all data-driven geometry. Safe to call repeatedly. */
  setData(data) {
    this.data = data;
    this.dynamic.clear();
    this._lineMaterials.length = 0;
    this._labels.length = 0;

    const sunDir = new THREE.Vector3(data.sun.x, data.sun.y, data.sun.z).normalize();
    this.sunLight.position.copy(sunDir).multiplyScalar(400);
    this.sunGlow.position.copy(sunDir).multiplyScalar(300);
    this.earth.userData.setSunDir(sunDir);

    const l2 = v(data.l2);

    // --- Sun–Earth–L2 axis ---------------------------------------------------
    const axis = makeThickLine(
      [sunDir.clone().multiplyScalar(-6), l2.clone().multiplyScalar(1.45)],
      { color: COLORS.axis, width: 1.4, opacity: 0.75, dashed: true },
    );
    this.dynamic.add(axis);
    this._lineMaterials.push(axis.userData.material);

    // --- L2 marker -----------------------------------------------------------
    const l2Group = new THREE.Group();
    l2Group.position.copy(l2);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.58, 0.66, 64),
      new THREE.MeshBasicMaterial({
        color: COLORS.l2, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
      }),
    );
    l2Group.add(ring);
    this.l2Ring = ring;
    const l2Glow = createGlowSprite(COLORS.l2, 2.4);
    l2Group.add(l2Glow);
    const l2Label = createLabel('L2', { color: '#c4b5fd', size: 38 });
    l2Label.userData.anchor = l2.clone();
    l2Group.add(l2Label);
    l2Label.position.set(0, 0, 0); // resolved in render()
    this._labels.push(l2Label);
    this.dynamic.add(l2Group);

    // --- Observatories -------------------------------------------------------
    this.markers = {};
    this.trails = {};

    this._addBody('jwst', data.bodies.jwst, {
      color: COLORS.jwst, dim: COLORS.jwstDim,
      build: () => createWebbMarker(0.16),
      label: 'JWST',
    });

    this._addBody('roman', data.bodies.roman, {
      color: COLORS.roman, dim: COLORS.romanDim,
      build: () => createRomanMarker(0.15),
      label: 'Roman',
    });

    this.applyFocus(this.focus);
    this.resize(); // refresh LineMaterial resolutions for the new lines
  }

  _addBody(key, body, { color, dim, build, label }) {
    const group = new THREE.Group();
    const pts = (body.arc ?? []).map(v);

    if (pts.length > 1) {
      const trail = makeThickLine(pts, {
        colors: gradientColors(pts, dim, color),
        width: 3.1,
      });
      group.add(trail);
      this._lineMaterials.push(trail.userData.material);
      this.trails[key] = trail;
    }

    const pos = v(body.position);
    const craft = build();
    craft.position.copy(pos);
    group.add(craft);

    // Kept small: a large additive sprite plus bloom washes the craft out
    // completely, which is what happened in the first pass.
    const glow = createGlowSprite(color, 1.1);
    glow.position.copy(pos);
    group.add(glow);
    glow.userData.baseScale = 1.1;

    const tag = createLabel(label, { color: `#${new THREE.Color(color).getHexString()}`, size: 40 });
    tag.userData.anchor = pos.clone();
    tag.position.copy(pos);
    group.add(tag);
    this._labels.push(tag);

    // A thin dashed tie-line to the ecliptic plane makes the 3D offset legible;
    // without it, depth is ambiguous on a flat screen.
    const drop = makeThickLine(
      [pos, new THREE.Vector3(pos.x, pos.y, 0)],
      { color, width: 1, opacity: 0.3, dashed: true },
    );
    group.add(drop);
    this._lineMaterials.push(drop.userData.material);

    this.dynamic.add(group);
    this.markers[key] = { group, craft, glow, tag, pos };
  }

  /** 'jwst' | 'roman' | 'both' — dims the other body and reframes the camera. */
  applyFocus(which) {
    this.focus = which;
    if (!this.markers) return;

    for (const [key, m] of Object.entries(this.markers)) {
      const active = which === 'both' || which === key;
      m.glow.material.opacity = active ? 1 : 0.25;
      m.tag.material.opacity = active ? 1 : 0.3;
      m.craft.traverse((o) => {
        if (o.material && 'opacity' in o.material) {
          o.material.transparent = true;
          o.material.opacity = active ? (o.material.userData.baseOpacity ?? 1) : 0.2;
        }
      });
      const trail = this.trails[key];
      if (trail) {
        trail.userData.material.opacity = active ? 1 : 0.18;
        trail.userData.material.transparent = true;
      }
    }

    // Frame to the actual geometry rather than a guessed distance — the halo
    // arc is ~34 units across and a fixed camera distance cropped it badly.
    const subjects = which === 'both'
      ? [this.earth, ...Object.values(this.markers).map((m) => m.group)]
      : [this.earth, this.markers[which].group];

    const el = this.canvas.parentElement ?? this.canvas;
    const wide = el.clientWidth > 900;
    const fit = frameObjects(this.camera, this.controls, subjects, {
      padding: 1.18,
      // On desktop the left ~30% of the canvas sits under the reading panel.
      xBias: wide ? 0.15 : 0,
      aspectW: el.clientWidth,
      aspectH: el.clientHeight,
    });
    if (fit) this._flyTo(fit.center, fit.distance);
  }

  _flyTo(target, distance) {
    this._fly = {
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      fromDist: this.camera.position.distanceTo(this.controls.target),
      toDist: distance,
      t: 0,
    };
  }

  resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // The view offset is in pixels, so it has to be rebuilt on every resize or
    // the framing drifts (and breaks entirely when crossing the mobile bp).
    if (w > 900) this.camera.setViewOffset(w, h, -0.15 * w, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    for (const m of this._lineMaterials) m.resolution.set(w, h);
    if (this.stars.userData.material) {
      this.stars.userData.material.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
    }
  }

  render(dt) {
    this._t += dt;

    // Camera flight
    if (this._fly) {
      const f = this._fly;
      f.t = Math.min(1, f.t + dt * 1.4);
      const e = 1 - Math.pow(1 - f.t, 3); // easeOutCubic
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      const want = f.fromDist + (f.toDist - f.fromDist) * e;
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(this.controls.target).add(dir.multiplyScalar(want));
      if (f.t >= 1) this._fly = null;
    }

    // Gentle life: pulse the glows and spin the L2 ring to face the camera.
    const pulse = 1 + Math.sin(this._t * 1.6) * 0.07;
    if (this.markers) {
      for (const m of Object.values(this.markers)) {
        m.glow.scale.setScalar((m.glow.userData.baseScale ?? 1.1) * pulse);
        m.craft.rotation.z += dt * 0.12;
      }
    }
    if (this.l2Ring) this.l2Ring.lookAt(this.camera.position);

    // Labels are sprites: keep their on-screen size roughly constant, and lift
    // them clear of the marker by an amount proportional to that size — a fixed
    // world offset puts the text on top of the marker once you zoom out.
    const up = new THREE.Vector3();
    for (const l of this._labels) {
      const anchor = l.userData.anchor;
      const d = this.camera.position.distanceTo(anchor ?? l.getWorldPosition(new THREE.Vector3()));
      const s = THREE.MathUtils.clamp(d * 0.028, 0.45, 2.2);
      l.scale.set(s * (l.userData.aspect ?? 3), s, 1);
      if (anchor) {
        // Offset along the camera's own up axis so it reads as "above" the
        // marker from any orbit angle.
        up.set(0, 1, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(s * 1.15);
        l.position.copy(anchor).add(up);
        if (l.parent && l.parent !== this.dynamic) l.parent.worldToLocal(l.position);
      }
    }

    this.controls.update();
    this.composer.render();
    renderLabels(this.renderer, this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('resize', this._onResize);
    clearTimeout(this._idleTimer);
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
    });
    this.composer.dispose?.();
    this.renderer.dispose();
  }
}
