import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/* ------------------------------------------------------------------ *
 * Starfield
 * ------------------------------------------------------------------ */

/**
 * Points on a large sphere, with a plausible stellar colour/magnitude spread.
 * Deliberately not a real catalogue — it is a backdrop, not a sky map.
 */
export function createStarfield({ count = 9000, radius = 900 } = {}) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  // Rough main-sequence colour ramp, blue-white through to orange-red.
  const palette = [
    new THREE.Color(0x9bb0ff), new THREE.Color(0xaabfff), new THREE.Color(0xcad7ff),
    new THREE.Color(0xf8f7ff), new THREE.Color(0xfff4ea), new THREE.Color(0xffd2a1),
    new THREE.Color(0xffb56c),
  ];

  for (let i = 0; i < count; i++) {
    // Uniform on a sphere
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.85 + Math.random() * 0.15);
    positions[i * 3] = r * s * Math.cos(theta);
    positions[i * 3 + 1] = r * s * Math.sin(theta);
    positions[i * 3 + 2] = r * u;

    // Heavily weighted to dim stars so the few bright ones read as bright.
    const mag = Math.pow(Math.random(), 2.6);
    const c = palette[Math.floor(Math.pow(Math.random(), 1.6) * palette.length)];
    const b = 0.28 + mag * 0.72;
    colors[i * 3] = c.r * b;
    colors[i * 3 + 1] = c.g * b;
    colors[i * 3 + 2] = c.b * b;
    sizes[i] = 0.6 + mag * 3.4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: /* glsl */ `
      attribute float aSize;
      varying vec3 vColor;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        // Soft round sprite with a tight core — reads as a star, not a square.
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d) * 2.0;
        float a = smoothstep(1.0, 0.0, r);
        a = pow(a, 2.2);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor, a);
      }`,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.userData.material = mat;
  return pts;
}

/* ------------------------------------------------------------------ *
 * Earth
 * ------------------------------------------------------------------ */

/**
 * Procedural Earth: no texture download, so the page has zero external
 * dependencies and renders identically offline. At the scale this scene works
 * at (Earth is a marble a million km from the spacecraft) a shaded globe with a
 * real terminator and an atmospheric rim reads better than a low-res texture.
 */
export function createEarth(radius = 1) {
  const group = new THREE.Group();

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 96, 96),
    new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uOcean: { value: new THREE.Color(0x0b3d7a) },
        uLand: { value: new THREE.Color(0x1f6b3a) },
        uNight: { value: new THREE.Color(0x0a1020) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW;
        varying vec3 vPos;
        varying vec3 vWorldPos;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vPos = position;
          // modelMatrix is NOT injected into three's fragment prefix (only the
          // vertex one), so world position has to come across as a varying.
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir; uniform vec3 uOcean; uniform vec3 uLand; uniform vec3 uNight;
        varying vec3 vNormalW; varying vec3 vPos; varying vec3 vWorldPos;

        // Cheap value noise — enough to suggest landmasses without pretending
        // to be cartography.
        // The palette below is written in sRGB, as picked by eye. THREE.Color
        // uniforms (uOcean, uNight) are converted to linear by three's colour
        // management, but GLSL literals are not — and the composer's OutputPass
        // treats everything as linear and re-encodes it, which lifted these
        // literals into pastel: dark forest came out mint, shelf water pale blue.
        vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }

        float hash(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float noise(vec3 p){
          vec3 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          float n = mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                            mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                        mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                            mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
          return n;
        }
        float fbm(vec3 p, int oct){
          float v = 0.0, a = 0.5;
          for(int i=0;i<7;i++){ if(i>=oct) break; v += a*noise(p); p *= 2.07; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 n = normalize(vNormalW);
          vec3 sp = normalize(vPos);
          float lat = abs(sp.z);

          // Continents: ridged low-frequency mass + higher-frequency coastline
          // detail, so edges are fractal rather than blobby.
          float base = fbm(sp * 1.7, 6);
          float detail = fbm(sp * 6.5, 5);
          float elev = base + detail * 0.16;
          float land = smoothstep(0.495, 0.545, elev);

          // Biome by latitude and a decorrelated noise field, so land is not a
          // single flat green. Desaturated on purpose: saturated green reads as
          // a toy globe, and this is a backdrop, not a basemap.
          float arid = fbm(sp * 3.1 + 17.0, 4);
          vec3 forest = vec3(0.16, 0.28, 0.15);
          vec3 steppe = vec3(0.34, 0.32, 0.20);
          vec3 desert = vec3(0.46, 0.38, 0.25);
          vec3 tundra = vec3(0.40, 0.42, 0.40);
          vec3 ground = mix(forest, steppe, smoothstep(0.42, 0.62, arid));
          ground = mix(ground, desert, smoothstep(0.58, 0.74, arid) * (1.0 - smoothstep(0.45, 0.72, lat)));
          ground = mix(ground, tundra, smoothstep(0.52, 0.76, lat));
          // Mountains catch a little more light
          ground += vec3(0.10) * smoothstep(0.60, 0.70, elev);
          ground = lin(ground);

          // Ocean deepens away from the shelf
          vec3 shelf = lin(vec3(0.07, 0.24, 0.42));
          vec3 deep  = uOcean * 0.62;
          vec3 sea = mix(deep, shelf, smoothstep(0.40, 0.495, elev));

          vec3 albedo = mix(sea, ground, land);

          // Polar ice, following the land/sea line loosely
          float ice = smoothstep(0.80, 0.955, lat + detail * 0.05);
          albedo = mix(albedo, lin(vec3(0.86, 0.90, 0.95)), ice);

          vec3 sd = normalize(uSunDir);
          float lambert = dot(n, sd);
          float day = smoothstep(-0.14, 0.26, lambert); // soft terminator

          vec3 col = mix(uNight, albedo, day);
          col += albedo * max(lambert, 0.0) * 0.5;

          // Specular glint off water only — sells it as an ocean, not paint.
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          float spec = pow(max(dot(reflect(-sd, n), viewDir), 0.0), 34.0);
          col += lin(vec3(0.55, 0.68, 0.85)) * spec * (1.0 - land) * day * 0.55;

          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  group.add(globe);

  // Atmospheric rim, additive, rendered from the back so it haloes the limb.
  const ATMO_SCALE = 1.22;
  // Where the view ray grazes the planet's limb, it meets the shell's back face
  // at this cosine to the shell normal. It is the brightest point of the halo;
  // the shell's own silhouette (cosine 0) is where the halo fades out.
  const limbFacing = Math.sqrt(1 - 1 / (ATMO_SCALE * ATMO_SCALE));
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * ATMO_SCALE, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(1, 0, 0) },
        uColor: { value: new THREE.Color(0x4aa8ff) },
        uLimbFacing: { value: limbFacing },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW; varying vec3 vViewDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform vec3 uSunDir; uniform float uLimbFacing;
        varying vec3 vNormalW; varying vec3 vViewDir;
        void main() {
          // BackSide: every visible fragment is a face pointing AWAY from the
          // camera, so dot(normal, view) is always <= 0. A front-face Fresnel
          // term, max(dot, 0), is therefore stuck at 0 and the shell rendered
          // as a flat, hard-edged ring — hidden only while heavy bloom smeared
          // it. Flip the normal and ramp from the shell edge in to the limb.
          vec3 n = normalize(vNormalW);
          float facing = max(dot(-n, normalize(vViewDir)), 0.0);
          float halo = pow(clamp(facing / uLimbFacing, 0.0, 1.0), 2.4);
          float lit = smoothstep(-0.45, 0.5, dot(n, normalize(uSunDir)));
          gl_FragColor = vec4(uColor, halo * lit * 0.95);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  group.add(atmo);

  group.userData.setSunDir = (v) => {
    globe.material.uniforms.uSunDir.value.copy(v);
    atmo.material.uniforms.uSunDir.value.copy(v);
  };
  return group;
}

/* ------------------------------------------------------------------ *
 * Markers and labels
 * ------------------------------------------------------------------ */

/** Radial-gradient sprite used for spacecraft glows and the Sun. */
export function createGlowSprite(color, size = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const col = new THREE.Color(color);
  const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(0.18, `rgba(${rgb},0.85)`);
  g.addColorStop(0.45, `rgba(${rgb},0.22)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  sprite.scale.setScalar(size);
  return sprite;
}

/** Crisp text label as a camera-facing sprite. */
export function createLabel(text, { color = '#e8ecff', size = 44, pad = 12 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `600 ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const h = size + pad * 2;
  // Extra horizontal room so the pill's rounded caps clear the first and last
  // glyphs instead of crowding them.
  const padX = pad + h / 4;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  c.width = w; c.height = h;

  const ctx2 = c.getContext('2d');

  // Backing pill. Labels already draw last with depth testing off, but bare
  // text over a trail the same colour still reads as a collision: JWST's halo
  // arc ran straight through its own tag, and Roman's cut its final letter.
  // Nudging the tag sideways only works from one camera angle, and these views
  // orbit, so the tag carries its own backdrop instead. Drawn by hand rather
  // than with roundRect() so older Safari still gets it.
  const r = h / 2;
  ctx2.beginPath();
  ctx2.moveTo(r, 0);
  ctx2.lineTo(w - r, 0);
  ctx2.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
  ctx2.lineTo(r, h);
  ctx2.arc(r, r, r, Math.PI / 2, Math.PI * 1.5);
  ctx2.closePath();
  // Near-opaque on purpose: trails are HDR-bright and then bloomed, so even a
  // 28% show-through (0.72) left JWST's arc plainly visible across its tag.
  ctx2.fillStyle = 'rgba(5, 7, 15, 0.92)';
  ctx2.fill();
  ctx2.globalAlpha = 0.35;
  ctx2.strokeStyle = color;
  ctx2.lineWidth = 2;
  ctx2.stroke();
  ctx2.globalAlpha = 1;

  ctx2.font = font;
  ctx2.textBaseline = 'middle';
  ctx2.shadowColor = 'rgba(0,0,0,0.9)';
  ctx2.shadowBlur = 10;
  ctx2.fillStyle = color;
  ctx2.fillText(text, padX, h / 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
      // Drawn straight to the screen after the composer (see renderLabels), so
      // there is no OutputPass to tone-map them — and they are already LDR.
      toneMapped: false,
    }),
  );
  sprite.userData.aspect = w / h;
  sprite.renderOrder = 10;
  sprite.layers.set(LABEL_LAYER);
  return sprite;
}

/**
 * Labels live on their own layer so the composer's RenderPass never sees them.
 * Bloom blurs the finished frame, so a bright trail passing just outside a tag
 * glowed straight across its text however opaque the tag's backdrop was —
 * JWST's halo arc still crossed its own label. Drawing labels after bloom is
 * the only order in which the backdrop actually wins.
 */
export const LABEL_LAYER = 1;

/** Draw the label layer over whatever the composer has already put on screen. */
export function renderLabels(renderer, scene, camera) {
  const mask = camera.layers.mask;
  const background = scene.background;
  const autoClear = renderer.autoClear;
  // A texture background is drawn even with autoClear off; don't repaint the sky.
  scene.background = null;
  renderer.autoClear = false;
  renderer.setRenderTarget(null);
  camera.layers.set(LABEL_LAYER);
  renderer.render(scene, camera);
  camera.layers.mask = mask;
  renderer.autoClear = autoClear;
  scene.background = background;
}

/**
 * Symbolic JWST: 18 gold hexagons in the real 3-ring layout.
 * NOT to scale — the real mirror is 6.5 m and would be sub-pixel here.
 */
export function createWebbMarker(scale = 1) {
  const g = new THREE.Group();
  const hex = new THREE.CylinderGeometry(0.5, 0.5, 0.06, 6);
  const gold = new THREE.MeshStandardMaterial({
    color: 0xffc247, metalness: 1, roughness: 0.28,
    emissive: 0xff9500, emissiveIntensity: 0.45,
  });

  // Axial hex-grid coordinates for a 3-ring flower minus the centre segment.
  const coords = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) > 2) continue;
      if (q === 0 && r === 0) continue; // centre segment is absent on JWST
      coords.push([q, r]);
    }
  }
  const W = 0.9, H = 0.78;
  for (const [q, r] of coords) {
    const m = new THREE.Mesh(hex, gold);
    m.position.set(W * (q + r / 2), H * r, 0);
    m.rotation.x = Math.PI / 2;
    g.add(m);
  }

  // Sunshield: five stacked kite-shaped layers below the mirror.
  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x8f9bd6, metalness: 0.6, roughness: 0.35,
    side: THREE.DoubleSide, transparent: true, opacity: 0.55,
  });
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(5.4 - i * 0.16, 3.6 - i * 0.12), shieldMat);
    s.position.set(0, -0.2, -1.1 - i * 0.32);
    s.rotation.x = -0.12;
    g.add(s);
  }

  g.scale.setScalar(scale);
  return g;
}

/** Symbolic Roman: 2.4 m telescope barrel with solar panels and a sunshade. */
export function createRomanMarker(scale = 1) {
  const g = new THREE.Group();

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 3.2, 32, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xd8dde8, metalness: 0.85, roughness: 0.3,
      side: THREE.DoubleSide, emissive: 0x2a3550, emissiveIntensity: 0.5,
    }),
  );
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);

  const cap = new THREE.Mesh(
    new THREE.CircleGeometry(1, 32),
    new THREE.MeshStandardMaterial({ color: 0x0c1220, metalness: 0.4, roughness: 0.9 }),
  );
  cap.position.z = 1.6;
  g.add(cap);

  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x1b3a8f, metalness: 0.7, roughness: 0.35,
    emissive: 0x11245c, emissiveIntensity: 0.6, side: THREE.DoubleSide,
  });
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.9), panelMat);
    p.position.set(s * 2.2, 0, -0.3);
    g.add(p);
  }

  const shade = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 2.8),
    new THREE.MeshStandardMaterial({
      color: 0x59637d, metalness: 0.5, roughness: 0.5,
      side: THREE.DoubleSide, transparent: true, opacity: 0.5,
    }),
  );
  shade.position.set(0, -0.6, -1.9);
  shade.rotation.x = -0.25;
  g.add(shade);

  g.scale.setScalar(scale);
  return g;
}

/* ------------------------------------------------------------------ *
 * Thick lines
 * ------------------------------------------------------------------ */

/**
 * Screen-space-width line. Plain THREE.Line ignores linewidth on nearly every
 * platform (ANGLE/D3D caps it at 1px), which is why trajectory ribbons need
 * Line2. `colors` optionally gives a per-vertex gradient.
 */
export function makeThickLine(points, { color = 0xffffff, colors = null, width = 3, opacity = 1, dashed = false } = {}) {
  const flat = [];
  for (const p of points) flat.push(p.x, p.y, p.z);

  const geo = new LineGeometry();
  geo.setPositions(flat);
  if (colors) geo.setColors(colors);

  // Only pass dash params when dashed — LineMaterial warns on explicit undefined.
  const params = {
    color: colors ? 0xffffff : color,
    linewidth: width, // in px, because worldUnits is false
    vertexColors: Boolean(colors),
    transparent: opacity < 1,
    opacity,
    dashed,
    worldUnits: false,
  };
  if (dashed) { params.dashSize = 0.6; params.gapSize = 0.4; }
  const mat = new LineMaterial(params);
  mat.resolution.set(window.innerWidth, window.innerHeight);

  const line = new Line2(geo, mat);
  if (dashed) line.computeLineDistances();
  line.userData.material = mat;
  return line;
}

/** Fade a trajectory from transparent at its oldest point to full at its newest. */
export function gradientColors(points, colorFrom, colorTo) {
  const a = new THREE.Color(colorFrom);
  const b = new THREE.Color(colorTo);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const t = points.length === 1 ? 1 : i / (points.length - 1);
    // Ease so most of the visible brightness sits near the current position.
    const e = Math.pow(t, 1.8);
    out.push(a.r + (b.r - a.r) * e, a.g + (b.g - a.g) * e, a.b + (b.b - a.b) * e);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Post-processing
 * ------------------------------------------------------------------ */

/**
 * A metal surface shows you its surroundings, so a `metalness: 1` material lit
 * only by directional lights renders essentially black — there is nothing to
 * reflect. This bakes a tiny procedural sky (warm sun above, cold earthshine
 * below, dark space around) into a PMREM cubemap so stainless steel reads as
 * stainless steel. Without it, the Starship stack is a silhouette.
 */
export function createSpaceEnvironment(renderer) {
  const scene = new THREE.Scene();

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 32),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uSun: { value: new THREE.Color(0xfff0d4) },
        uHorizon: { value: new THREE.Color(0x2a3550) },
        uGround: { value: new THREE.Color(0x0a1526) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun; uniform vec3 uHorizon; uniform vec3 uGround;
        varying vec3 vDir;
        void main() {
          float h = vDir.y * 0.5 + 0.5;
          vec3 c = mix(uGround, uHorizon, smoothstep(0.0, 0.55, h));
          // A broad warm key high on one side gives metal a directional sheen.
          float key = pow(max(dot(normalize(vDir), normalize(vec3(0.45, 0.78, 0.44))), 0.0), 7.0);
          c += uSun * key * 2.6;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  sky.geometry.dispose();
  sky.material.dispose();
  return target.texture;
}

/**
 * Point the camera at a set of objects and back off far enough to fit them.
 *
 * `xBias` shifts the framing horizontally via setViewOffset, because on desktop
 * the left third of the screen is covered by the reading panel — content
 * centred in the canvas is not centred in the *visible* canvas.
 */
export function frameObjects(camera, controls, objects, { padding = 1.25, xBias = 0, aspectW, aspectH } = {}) {
  const box = new THREE.Box3();
  for (const o of objects) {
    if (!o) continue;
    const b = new THREE.Box3().setFromObject(o);
    if (b.isEmpty()) continue;
    box.union(b);
  }
  if (box.isEmpty()) return null;

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);

  // Shifting the view right by fraction b leaves only (0.5 - b) of the width
  // on that side, so the camera has to back off by 0.5/(0.5 - b) or the
  // subject simply slides out of frame. Omitting this was why the halo arc
  // kept getting clipped.
  const bias = xBias && aspectW && aspectH ? Math.min(xBias, 0.24) : 0;
  const biasComp = bias > 0 ? 0.5 / (0.5 - bias) : 1;

  const fitV = (sphere.radius * padding) / Math.sin(vFov / 2);
  const fitH = (sphere.radius * padding * biasComp) / Math.sin(hFov / 2);
  const dist = Math.max(fitV, fitH);

  if (bias > 0) {
    // Render a window shifted left within a virtual viewport, which pushes the
    // subject right on screen, clear of the panel.
    camera.setViewOffset(aspectW, aspectH, -bias * aspectW, 0, aspectW, aspectH);
  } else {
    camera.clearViewOffset();
  }

  return { center: sphere.center.clone(), distance: dist };
}

/** Bloom is what makes this read as "space" rather than "coloured lines". */
export function createComposer(renderer, scene, camera, { strength = 0.85, radius = 0.5, threshold = 0.16 } = {}) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight), strength, radius, threshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.userData = { bloom };
  return composer;
}
