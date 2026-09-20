import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createStarfield, createEarth, createGlowSprite, createLabel,
  makeThickLine, gradientColors, createComposer, createSpaceEnvironment, frameObjects,
} from './common.js';

/**
 * Two modes in one scene:
 *   'vehicle' — a procedural Super Heavy + Ship stack, slowly rotating.
 *   'profile' — Earth with the launch site and the planned flight track.
 *
 * IMPORTANT HONESTY NOTE, reflected in the UI: there is no public live
 * telemetry feed for Starship. The track drawn here is a *planned* profile
 * computed from the published inclination and the launch site, not a downlink.
 * Launch timing and status ARE live (Launch Library 2).
 */

export const SHIP_COLORS = {
  flame: 0xff6b35,
  steel: 0xb8c0cc,
  track: 0xff8c42,
  trackDim: 0x4a2412,
  site: 0x4ade80,
};

const EARTH_R = 4; // scene units
const DEG = Math.PI / 180;

/** Geographic lat/lon (deg) + altitude (km) -> scene vector. +Z is north. */
function geo(latDeg, lonDeg, altKm = 0) {
  const r = EARTH_R * (1 + altKm / 6371);
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return new THREE.Vector3(
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.cos(lat) * Math.sin(lon),
    r * Math.sin(lat),
  );
}

/**
 * Ground track of a circular orbit, including Earth's rotation.
 *
 * For argument of latitude u and inclination i:
 *   lat = asin(sin i * sin u)
 *   Δlon = atan2(cos i * sin u, cos u)
 * then subtract Earth's rotation over the elapsed time. Standard spherical
 * geometry — this is a real ground track, not a decorative sine wave.
 */
function groundTrack({
  lat0, lon0, inclinationDeg, revolutions = 1.35, steps = 420,
  periodMin = 90, ascentFraction = 0.06, apogeeKm = 210,
}) {
  const i = inclinationDeg * DEG;
  const pts = [];

  // Argument of latitude at the launch site, so the track actually starts there.
  const sinU0 = Math.min(1, Math.max(-1, Math.sin(lat0 * DEG) / Math.sin(i)));
  const u0 = Math.asin(sinU0);

  const totalU = revolutions * 2 * Math.PI;
  const earthRateDegPerMin = 360 / (23 * 60 + 56); // sidereal day

  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const u = u0 + totalU * f;
    const tMin = periodMin * revolutions * f;

    const lat = Math.asin(Math.sin(i) * Math.sin(u)) / DEG;
    const dLon = Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u))
      - Math.atan2(Math.cos(i) * Math.sin(u0), Math.cos(u0));
    const lon = lon0 + dLon / DEG - earthRateDegPerMin * tMin;

    // Altitude: ramp up through the ascent phase, then hold.
    const alt = f < ascentFraction
      ? apogeeKm * Math.sin((f / ascentFraction) * (Math.PI / 2))
      : apogeeKm;

    pts.push(geo(lat, lon, alt));
  }
  return pts;
}

/** Procedural Super Heavy + Ship. Proportions follow the published v3 stack. */
function buildStack() {
  const g = new THREE.Group();

  const steel = new THREE.MeshStandardMaterial({
    color: SHIP_COLORS.steel, metalness: 0.88, roughness: 0.3,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f38, metalness: 0.7, roughness: 0.5 });
  const heatTile = new THREE.MeshStandardMaterial({ color: 0x17181c, metalness: 0.15, roughness: 0.92 });

  // Real dimensions, scaled: 124.4 m total, 9 m diameter.
  const U = 1 / 12; // 1 scene unit per 12 m
  const R = (9 / 2) * U;

  // --- Super Heavy booster: 71 m ---
  const boosterH = 71 * U;
  const booster = new THREE.Mesh(new THREE.CylinderGeometry(R, R, boosterH, 48), steel);
  booster.position.y = boosterH / 2;
  g.add(booster);

  // Engine skirt + 33 Raptors (3 centre, 10 mid, 20 outer)
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.02, R * 1.05, 0.5 * U * 12, 48), dark);
  skirt.position.y = 0.25 * U * 12;
  g.add(skirt);
  const bell = new THREE.ConeGeometry(R * 0.085, R * 0.2, 12, 1, true);
  const rings = [[3, R * 0.16], [10, R * 0.48], [20, R * 0.82]];
  for (const [n, rad] of rings) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const m = new THREE.Mesh(bell, dark);
      m.position.set(Math.cos(a) * rad, -R * 0.1, Math.sin(a) * rad);
      m.rotation.x = Math.PI;
      g.add(m);
    }
  }

  // Grid fins near the top of the booster
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(R * 0.9, R * 0.75, R * 0.1), dark);
    fin.position.set(Math.cos(a) * R * 1.3, boosterH - R * 0.7, Math.sin(a) * R * 1.3);
    fin.rotation.y = -a;
    g.add(fin);
  }

  // --- Ship: 52 m, tiled windward face ---
  const shipH = 45 * U;
  const ship = new THREE.Mesh(new THREE.CylinderGeometry(R, R, shipH, 48), steel);
  ship.position.y = boosterH + shipH / 2;
  g.add(ship);

  // Heat-shield tiles as a half-shell on one side
  const tiles = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.012, R * 1.012, shipH * 0.96, 48, 1, true, -Math.PI / 2, Math.PI),
    heatTile,
  );
  tiles.position.y = boosterH + shipH / 2;
  g.add(tiles);

  // Nosecone
  const nose = new THREE.Mesh(new THREE.ConeGeometry(R, 12 * U, 48), steel);
  nose.position.y = boosterH + shipH + 6 * U;
  g.add(nose);
  const noseTiles = new THREE.Mesh(
    new THREE.ConeGeometry(R * 1.012, 12 * U, 48, 1, true, -Math.PI / 2, Math.PI),
    heatTile,
  );
  noseTiles.position.copy(nose.position);
  g.add(noseTiles);

  // Flaps: two forward (near the nose), two aft
  const mkFlap = (w, h, y, ang, tilt) => {
    const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, R * 0.14), heatTile);
    f.position.set(Math.cos(ang) * R * 1.05, y, Math.sin(ang) * R * 1.05);
    f.rotation.y = -ang;
    f.rotation.z = tilt;
    g.add(f);
  };
  mkFlap(R * 1.1, R * 0.85, boosterH + shipH * 0.92, -Math.PI * 0.28, 0.22);
  mkFlap(R * 1.1, R * 0.85, boosterH + shipH * 0.92, -Math.PI * 0.72, -0.22);
  mkFlap(R * 1.5, R * 1.15, boosterH + shipH * 0.16, -Math.PI * 0.22, 0.12);
  mkFlap(R * 1.5, R * 1.15, boosterH + shipH * 0.16, -Math.PI * 0.78, -0.12);

  g.userData.totalHeight = boosterH + shipH + 12 * U;
  g.userData.separationY = boosterH;
  return g;
}

export class StarshipScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = 'vehicle';
    this._t = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 3000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 60;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;

    // The stack is near-pure metal, so almost all of its shading comes from the
    // environment map, not the lights. Without this it renders as a silhouette.
    this.scene.environment = createSpaceEnvironment(this.renderer);
    this.scene.environmentIntensity = 1.35;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    const key = new THREE.DirectionalLight(0xfff0dd, 3.2);
    key.position.set(6, 9, 8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6ea0ff, 2.0);
    rim.position.set(-8, 2, -6);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(2, -6, 4);
    this.scene.add(fill);

    this.scene.add(createStarfield({ count: 6000, radius: 700 }));

    // --- vehicle mode ---
    this.stack = buildStack();
    this.stack.visible = true;
    this.scene.add(this.stack);

    // --- profile mode ---
    this.globe = new THREE.Group();
    this.globe.visible = false;
    this.earth = createEarth(EARTH_R);
    this.earth.userData.setSunDir(new THREE.Vector3(1, 0.4, 0.3).normalize());
    this.globe.add(this.earth);
    this.scene.add(this.globe);

    this.composer = createComposer(this.renderer, this.scene, this.camera, { strength: 0.6, threshold: 0.22 });
    this._lineMaterials = [];
    this._labels = [];

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
    this.setMode('vehicle');
  }

  setData(starship) {
    this.data = starship;
    const pad = starship?.next?.pad;
    const lat = Number.isFinite(pad?.latitude) ? pad.latitude : 25.9972;
    const lon = Number.isFinite(pad?.longitude) ? pad.longitude : -97.1564;

    // Clear previous track geometry
    for (const o of [...this.globe.children]) if (o !== this.earth) this.globe.remove(o);
    this._lineMaterials.length = 0;
    this._labels.length = 0;

    // Launch-site pin
    const site = geo(lat, lon, 0);
    const pin = createGlowSprite(SHIP_COLORS.site, 0.7);
    pin.position.copy(site);
    this.globe.add(pin);
    const siteLabel = createLabel(pad?.location ?? 'Starbase, Texas', { color: '#86efac', size: 34 });
    siteLabel.position.copy(site).multiplyScalar(1.12);
    this.globe.add(siteLabel);
    this._labels.push(siteLabel);

    // Planned track. Inclination is not in the LL2 payload, so this uses the
    // launch-site latitude as the minimum-energy inclination — correct for a
    // due-east launch and clearly labelled as a planned profile in the UI.
    const track = groundTrack({
      lat0: lat, lon0: lon,
      inclinationDeg: Math.max(Math.abs(lat) + 0.5, 26.5),
      revolutions: 1.35,
    });
    const line = makeThickLine(track, {
      colors: gradientColors(track, SHIP_COLORS.trackDim, SHIP_COLORS.track),
      width: 2.8,
    });
    this.globe.add(line);
    this._lineMaterials.push(line.userData.material);
    this.track = track;

    // A travelling marker so the direction of flight is unmistakable.
    this.tracer = createGlowSprite(SHIP_COLORS.flame, 0.55);
    this.globe.add(this.tracer);

    this.resize();
    // Re-frame: the track only exists now, so the profile fit computed at
    // construction time was against an empty globe group.
    this.setMode(this.mode);
  }

  setMode(mode) {
    this.mode = mode;
    const vehicle = mode === 'vehicle';
    this.stack.visible = vehicle;
    this.globe.visible = !vehicle;

    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    const wide = w > 900;
    if (wide) this.camera.setViewOffset(w, h, -0.15 * w, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();

    if (vehicle) {
      const fit = frameObjects(this.camera, this.controls, [this.stack], {
        padding: 1.22, xBias: wide ? 0.15 : 0, aspectW: w, aspectH: h,
      });
      this.controls.minDistance = 3;
      this.controls.maxDistance = 90;
      if (fit) {
        this.controls.target.copy(fit.center);
        // Three-quarter view from slightly above the midpoint.
        this.camera.position.copy(fit.center).add(
          new THREE.Vector3(0.52, 0.30, 0.80).normalize().multiplyScalar(fit.distance),
        );
      }
    } else {
      this.controls.target.set(0, 0, 0);
      this.controls.minDistance = EARTH_R * 1.6;
      this.controls.maxDistance = 60;
      // Far enough back that the globe and the full ground track both fit.
      const fit = frameObjects(this.camera, this.controls, [this.globe], {
        padding: 1.15, xBias: wide ? 0.15 : 0, aspectW: w, aspectH: h,
      });
      const dist = fit ? fit.distance : EARTH_R * 3.4;
      this.camera.position.set(0, 0, 0).add(
        new THREE.Vector3(0.78, -0.52, 0.35).normalize().multiplyScalar(dist),
      );
    }
    this.controls.update();
  }

  resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    if (w > 900) this.camera.setViewOffset(w, h, -0.15 * w, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    for (const m of this._lineMaterials) m.resolution.set(w, h);
  }

  render(dt) {
    this._t += dt;

    if (this.mode === 'profile' && this.track?.length) {
      // Loop the tracer along the planned track, ~18 s per pass.
      const f = (this._t % 18) / 18;
      const idx = Math.min(this.track.length - 1, Math.floor(f * this.track.length));
      this.tracer.position.copy(this.track[idx]);
      this.tracer.scale.setScalar(0.55 * (1 + Math.sin(this._t * 4) * 0.12));
      this.globe.rotation.z += dt * 0.02;
    }

    for (const l of this._labels) {
      const d = this.camera.position.distanceTo(l.getWorldPosition(new THREE.Vector3()));
      const s = THREE.MathUtils.clamp(d * 0.03, 0.3, 1.6);
      l.scale.set(s * (l.userData.aspect ?? 3), s, 1);
    }

    this.controls.update();
    this.composer.render();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
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
