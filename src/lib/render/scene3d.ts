"use client";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SceneData } from "../data/scene";
import { cellsInRect } from "../sim/model";
import type { Feature, RectFeature } from "../sim/types";
import { overlayFrag, overlayVert, rainFrag, rainVert, terrainHoleChunk, waterFrag, waterVert } from "./shaders";
import { courtTexture, grateTexture, paverTexture, strataTexture } from "./textures";

export type ViewMode = "without" | "with" | "split" | "diff";
export type Shade = "real" | "depth";
export type RunKey = "base" | "design";

const L_BASE = 1;
const L_DESIGN = 2;

interface WaterMesh {
  mesh: THREE.Mesh;
  depth: THREE.BufferAttribute;
  speed: THREE.BufferAttribute;
  other: THREE.BufferAttribute;
  ground: THREE.BufferAttribute;
}

interface SquareVisual {
  id: string;
  group: THREE.Group;
  water: THREE.Mesh;
  depthAttr: THREE.BufferAttribute;
  floor: number;
  rim: number;
  f: RectFeature;
}

export interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
}

/** Renders one area as a lit diorama: satellite-draped ground, extruded buildings, live water, rain and design features. */
export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private container: HTMLElement;
  private raf = 0;
  private clock = new THREE.Clock();
  private ro: ResizeObserver;
  private root = new THREE.Group();
  private data: SceneData | null = null;
  private S = 600;
  private groundBase = new Float32Array(0);
  private groundDesign = new Float32Array(0);
  private terrainMat: THREE.MeshStandardMaterial | null = null;
  private terrainBase: THREE.Mesh | null = null;
  private terrainDesign: THREE.Mesh | null = null;
  private water: Partial<Record<RunKey, WaterMesh>> = {};
  private waterMats: THREE.ShaderMaterial[] = [];
  private buildings: Partial<Record<RunKey, { mesh: THREE.Mesh; wet: THREE.BufferAttribute }>> = {};
  private buildingRanges: [number, number][] = [];
  private buildingMat: THREE.MeshStandardMaterial | null = null;
  private featureGroup = new THREE.Group();
  private squares: SquareVisual[] = [];
  private overlay: THREE.Mesh | null = null;
  private overlayMat: THREE.ShaderMaterial | null = null;
  private rain: THREE.LineSegments | null = null;
  private rainMat: THREE.ShaderMaterial | null = null;
  private sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  private hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a3f33, 1.1);
  private holes: { v: THREE.Vector4[]; r: number[]; n: number } = { v: Array.from({ length: 8 }, () => new THREE.Vector4()), r: new Array(8).fill(0), n: 0 };
  private animated: { obj: THREE.Object3D; kind: "pulse" | "flow"; mat?: THREE.ShaderMaterial }[] = [];
  view: ViewMode = "with";
  shade: Shade = "real";
  split = 0.5;
  private rainMmH = 0;
  private storminess = 0;
  private flash = 0;
  onWeather?: (storminess: number) => void;
  /** Time the last frame was drawn (for the overlay to sync to). */
  frameId = 0;
  onFrame?: () => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";

    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 20000);
    this.camera.layers.enable(L_BASE);
    this.camera.layers.enable(L_DESIGN);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;

    this.scene.add(this.root);
    this.root.add(this.featureGroup);
    this.featureGroup.layers.set(L_DESIGN);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.layers.enableAll();
    this.hemi.layers.enableAll();
    this.sun.shadow.camera.layers.enableAll();
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.scene.fog = new THREE.Fog(0x9fb4c4, 2000, 6000);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop();
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ── scene ─────────────────────────────────────────────────────────────────────────────
  setScene(data: SceneData) {
    this.clearScene();
    this.data = data;
    const { nx, ny, dx } = data.grid;
    const S = (this.S = data.size);
    this.groundBase = Float32Array.from(data.grid.z);
    this.groundDesign = Float32Array.from(data.grid.z);

    const tex = new THREE.CanvasTexture(data.imagery);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // part self-lit so the satellite colours read true under any sky
    this.terrainMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.42 });
    this.patchHoles(this.terrainMat, true);

    this.terrainBase = new THREE.Mesh(this.gridGeometry(this.groundBase, true), this.terrainMat);
    this.terrainBase.receiveShadow = true;
    this.terrainBase.layers.set(L_BASE);
    const matD = this.terrainMat.clone();
    this.patchHoles(matD, false);
    this.terrainDesign = new THREE.Mesh(this.gridGeometry(this.groundDesign, true), matD);
    this.terrainDesign.receiveShadow = true;
    this.terrainDesign.layers.set(L_DESIGN);
    this.root.add(this.terrainBase, this.terrainDesign);
    this.root.add(this.skirt(this.groundBase));

    this.buildBuildings(data);
    this.water.base = this.makeWater(this.groundBase, L_BASE);
    this.water.design = this.makeWater(this.groundDesign, L_DESIGN);
    this.makeOverlay(data);
    this.makeRain();

    // light and camera
    this.sun.position.set(-S * 0.6, S * 0.9, -S * 0.35);
    this.sun.target.position.set(0, 0, 0);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -S * 0.75;
    sc.right = sc.top = S * 0.75;
    sc.near = 1;
    sc.far = S * 3;
    sc.updateProjectionMatrix();
    (this.scene.fog as THREE.Fog).near = S * 1.6;
    (this.scene.fog as THREE.Fog).far = S * 5;
    this.controls.minDistance = 25;
    this.controls.maxDistance = S * 2.6;
    this.resetCamera();
    void nx;
    void ny;
    void dx;
  }

  resetCamera(top = false) {
    const S = this.S;
    if (top) {
      this.camera.position.set(0, S * 1.25, S * 0.02);
    } else {
      this.camera.position.set(S * 0.12, S * 0.62, S * 0.78);
    }
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Smoothly frame a local point (x, y metres) from a closer oblique view. */
  focus(x: number, y: number, dist = 220) {
    const target = new THREE.Vector3(x - this.S / 2, this.groundAt(x, y), y - this.S / 2);
    const from = this.controls.target.clone();
    const camFrom = this.camera.position.clone();
    const dir = camFrom.clone().sub(from).normalize();
    if (dir.y < 0.45) dir.setY(0.55).normalize();
    const camTo = target.clone().add(dir.multiplyScalar(dist));
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      this.controls.target.lerpVectors(from, target, e);
      this.camera.position.lerpVectors(camFrom, camTo, e);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  private clearScene() {
    for (const child of [...this.root.children]) {
      if (child === this.featureGroup) continue;
      this.root.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
      });
    }
    this.clearFeatures();
    this.water = {};
    this.waterMats = [];
    this.buildings = {};
  }

  /** Grid mesh with one vertex per cell centre. */
  private gridGeometry(ground: Float32Array, withNormals: boolean): THREE.BufferGeometry {
    const { nx, ny, dx } = this.data!.grid;
    const S = this.S;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        pos[c * 3] = (i + 0.5) * dx - S / 2;
        pos[c * 3 + 1] = ground[c];
        pos[c * 3 + 2] = (j + 0.5) * dx - S / 2;
        uv[c * 2] = (i + 0.5) / nx;
        uv[c * 2 + 1] = 1 - (j + 0.5) / ny;
      }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx[k++] = a;
        idx[k++] = c;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = c;
        idx[k++] = d;
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (withNormals) g.computeVertexNormals();
    return g;
  }

  /** Soil-coloured sides so the area reads as a cut-out block of ground. */
  private skirt(ground: Float32Array): THREE.Mesh {
    const { nx, ny, dx } = this.data!.grid;
    const S = this.S;
    let zmin = Infinity;
    for (const v of ground) zmin = Math.min(zmin, v);
    const bottom = zmin - Math.max(8, S * 0.025);
    const pos: number[] = [];
    const uv: number[] = [];
    const edge = (cells: number[], x: (k: number) => number, z: (k: number) => number) => {
      for (let k = 0; k + 1 < cells.length; k++) {
        const a = [x(k), ground[cells[k]], z(k)];
        const b = [x(k + 1), ground[cells[k + 1]], z(k + 1)];
        pos.push(...a, ...b, b[0], bottom, b[2], ...a, b[0], bottom, b[2], a[0], bottom, a[2]);
        uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      }
    };
    const top = Array.from({ length: nx }, (_, i) => i);
    const bot = Array.from({ length: nx }, (_, i) => (ny - 1) * nx + i);
    const left = Array.from({ length: ny }, (_, j) => j * nx);
    const right = Array.from({ length: ny }, (_, j) => j * nx + nx - 1);
    const X = (i: number) => (i + 0.5) * dx - S / 2;
    edge([...top].reverse(), (k) => X(nx - 1 - k), () => -S / 2 + dx / 2);
    edge(bot, (k) => X(k), () => S / 2 - dx / 2);
    edge(left, () => -S / 2 + dx / 2, (k) => X(k));
    edge([...right].reverse(), () => S / 2 - dx / 2, (k) => X(ny - 1 - k));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: strataTexture(), roughness: 1, side: THREE.DoubleSide }));
    m.layers.enableAll();
    return m;
  }

  private buildBuildings(data: SceneData) {
    const S = this.S;
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    this.buildingRanges = [];
    const wall = new THREE.Color();
    const roof = new THREE.Color();
    for (const b of data.buildings) {
      const start = pos.length / 3;
      let ring = b.ring.map(([x, y]) => [x - S / 2, y - S / 2] as [number, number]);
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1);
      if (ring.length < 3) {
        this.buildingRanges.push([start, 0]);
        continue;
      }
      // orientation: make it counter-clockwise seen from above (x right, z down → y up)
      let area = 0;
      for (let k = 0; k < ring.length; k++) {
        const [x0, z0] = ring[k];
        const [x1, z1] = ring[(k + 1) % ring.length];
        area += x0 * z1 - x1 * z0;
      }
      if (area > 0) ring.reverse();
      const y0 = b.base - 0.4;
      const y1 = b.base + b.height;
      const shade = 0.86 + ((b.id * 37) % 11) / 80;
      wall.setRGB(0.93 * shade, 0.9 * shade, 0.84 * shade, THREE.SRGBColorSpace);
      roof.setHex(b.roof, THREE.SRGBColorSpace);
      const hsl = { h: 0, s: 0, l: 0 };
      roof.getHSL(hsl);
      roof.setHSL(hsl.h, Math.min(1, hsl.s * 1.25), Math.min(0.62, Math.max(0.22, hsl.l * 1.1)));
      let cx = 0;
      let cz = 0;
      for (const [x, z] of ring) {
        cx += x;
        cz += z;
      }
      cx /= ring.length;
      cz /= ring.length;
      // a triangle with its normal turned away from the building's centre line (walls) or up (roofs)
      const tri = (p: number[][], color: THREE.Color, k = 1, up = false) => {
        const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
        const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
        let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map((v) => v / l);
        const mx = (p[0][0] + p[1][0] + p[2][0]) / 3 - cx;
        const mz = (p[0][2] + p[1][2] + p[2][2]) / 3 - cz;
        const flip = up ? n[1] < 0 : n[0] * mx + n[2] * mz < 0;
        const order = flip ? [p[0], p[2], p[1]] : p;
        if (flip) n = n.map((v) => -v);
        for (const q of order) {
          pos.push(q[0], q[1], q[2]);
          nor.push(n[0], n[1], n[2]);
          const sh = q[1] >= y1 - 0.01 || up ? 1 : q[1] <= y0 + 0.01 ? 0.8 : 0.92;
          col.push(color.r * sh * k, color.g * sh * k, color.b * sh * k);
        }
      };
      const quadW = (a3: number[], b3: number[], c3: number[], d3: number[], color: THREE.Color, up = false) => {
        tri([a3, b3, c3], color, 1, up);
        tri([a3, c3, d3], color, 1, up);
      };
      const lens = ring.map((p, k) => Math.hypot(ring[(k + 1) % ring.length][0] - p[0], ring[(k + 1) % ring.length][1] - p[1]));
      const pitched = ring.length === 4 && b.height <= 12;
      if (pitched) {
        // terrace house: walls to the eaves, a gabled roof along the long side
        // the ridge runs along the terrace row for detected houses, else along the longer side
        let long = lens[0] + lens[2] >= lens[1] + lens[3] ? 0 : 1;
        if (b.ridgeEdge !== undefined) long = b.ridgeEdge; // reversing a 4-gon keeps edge parity
        const short = Math.min(lens[1 - long], lens[3 - long]);
        const ridgeH = Math.min(2.4, 0.42 * short);
        const ye = y1 - ridgeH;
        const P = ring.map(([x, z]) => [x, z]);
        const mid = (a2: number[], b2: number[]) => [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
        // the two short (gable) sides are edges long+1 and long+3
        const g1 = [P[(long + 1) % 4], P[(long + 2) % 4]];
        const g2 = [P[(long + 3) % 4], P[(long + 4) % 4]];
        const r1 = mid(g1[0], g1[1]);
        const r2 = mid(g2[0], g2[1]);
        for (let k = 0; k < 4; k++) {
          const A2 = P[k];
          const B2 = P[(k + 1) % 4];
          quadW([A2[0], y0, A2[1]], [B2[0], y0, B2[1]], [B2[0], ye, B2[1]], [A2[0], ye, A2[1]], wall);
        }
        tri([[g1[0][0], ye, g1[0][1]], [g1[1][0], ye, g1[1][1]], [r1[0], y1, r1[1]]], wall);
        tri([[g2[0][0], ye, g2[0][1]], [g2[1][0], ye, g2[1][1]], [r2[0], y1, r2[1]]], wall);
        // roof planes: from each long eave up to the ridge (r2 → r1), with a little overhang
        const e1 = [P[long], P[(long + 1) % 4]];
        const e2 = [P[(long + 2) % 4], P[(long + 3) % 4]];
        quadW([e1[0][0], ye, e1[0][1]], [e1[1][0], ye, e1[1][1]], [r1[0], y1, r1[1]], [r2[0], y1, r2[1]], roof, true);
        quadW([e2[0][0], ye, e2[0][1]], [e2[1][0], ye, e2[1][1]], [r2[0], y1, r2[1]], [r1[0], y1, r1[1]], roof, true);
      } else {
        for (let k = 0; k < ring.length; k++) {
          const [ax, az] = ring[k];
          const [bx, bz] = ring[(k + 1) % ring.length];
          quadW([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], wall);
        }
        const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        for (const t of tris) tri([[ring[t[0]][0], y1, ring[t[0]][1]], [ring[t[2]][0], y1, ring[t[2]][1]], [ring[t[1]][0], y1, ring[t[1]][1]]], roof, 1, true);
      }
      this.buildingRanges.push([start, pos.length / 3 - start]);
    }
    const posA = new THREE.Float32BufferAttribute(pos, 3);
    const norA = new THREE.Float32BufferAttribute(nor, 3);
    const colA = new THREE.Float32BufferAttribute(col, 3);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = { value: 0 };
      mat.userData.shader = sh;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float wet;\nvarying float vWet;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvWet = wet;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vWet;\nuniform float uTime;")
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\nfloat pulse = 0.82 + 0.18 * sin(uTime * 3.0);\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.32, 0.18) * pulse, clamp(vWet, 0.0, 1.0) * 0.72);",
        );
    };
    this.buildingMat = mat;
    for (const [key, layer] of [["base", L_BASE], ["design", L_DESIGN]] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", posA);
      g.setAttribute("normal", norA);
      g.setAttribute("color", colA);
      const wet = new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1);
      g.setAttribute("wet", wet);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(layer);
      this.root.add(mesh);
      this.buildings[key] = { mesh, wet };
    }
  }

  /** Tint buildings whose doorstep water is over the threshold (0..1 per building). */
  setBuildingWet(key: RunKey, wet: Float32Array) {
    const b = this.buildings[key];
    if (!b) return;
    const arr = b.wet.array as Float32Array;
    this.buildingRanges.forEach(([s, n], k) => {
      const v = wet[k] ?? 0;
      if (arr[s] !== v) arr.fill(v, s, s + n);
    });
    b.wet.needsUpdate = true;
  }

  private makeWater(ground: Float32Array, layer: number): WaterMesh {
    const g = this.gridGeometry(ground, false);
    const N = ground.length;
    const depth = new THREE.BufferAttribute(new Float32Array(N), 1);
    const speed = new THREE.BufferAttribute(new Float32Array(N), 1);
    const other = new THREE.BufferAttribute(new Float32Array(N), 1);
    const groundA = new THREE.BufferAttribute(Float32Array.from(ground), 1);
    for (const a of [depth, speed, other]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("depth", depth);
    g.setAttribute("speed", speed);
    g.setAttribute("other", other);
    g.setAttribute("ground", groundA);
    const mat = this.waterMaterial(layer === L_DESIGN);
    const mesh = new THREE.Mesh(g, mat);
    mesh.layers.set(layer);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return { mesh, depth, speed, other, ground: groundA };
  }

  private waterMaterial(holes: boolean): THREE.ShaderMaterial {
    const mat = new THREE.ShaderMaterial({
      vertexShader: waterVert,
      fragmentShader: waterFrag,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uRain: { value: 0 },
        uSun: { value: new THREE.Vector3(-0.5, 0.8, -0.3) },
        uLight: { value: 1 },
        uMode: { value: 0 },
        uHoleEnable: { value: holes ? 1 : 0 },
        uHoles: { value: this.holes.v },
        uHoleRot: { value: this.holes.r },
        uHoleN: { value: 0 },
      },
    });
    this.waterMats.push(mat);
    return mat;
  }

  /** Cut square footprints out of the design ground so the sunken court shows through. */
  private patchHoles(mat: THREE.MeshStandardMaterial, base: boolean) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uHoles = { value: this.holes.v };
      sh.uniforms.uHoleRot = { value: this.holes.r };
      sh.uniforms.uHoleN = { value: base ? 0 : this.holes.n };
      mat.userData.shader = sh;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldH;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldH = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vWorldH;\n${terrainHoleChunk}`)
        .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (inHole(vWorldH.xz)) discard;");
    };
    mat.userData.base = base;
  }

  private makeOverlay(data: SceneData) {
    const { nx, ny } = data.grid;
    const mask = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) mask[(ny - 1 - j) * nx + i] = data.candidateMask[j * nx + i];
    const tex = new THREE.DataTexture(mask, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    const lifted = this.groundBase.map((v) => v + 0.25);
    const g = this.gridGeometry(lifted, false);
    this.overlayMat = new THREE.ShaderMaterial({
      vertexShader: overlayVert,
      fragmentShader: overlayFrag,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uMask: { value: tex },
        uTexel: { value: new THREE.Vector2(1 / nx, 1 / ny) },
        uActive: { value: -1 },
        uTime: { value: 0 },
        uHoleEnable: { value: 1 },
        uHoles: { value: this.holes.v },
        uHoleRot: { value: this.holes.r },
        uHoleN: { value: 0 },
      },
    });
    this.overlay = new THREE.Mesh(g, this.overlayMat);
    this.overlay.renderOrder = 3;
    this.overlay.visible = false;
    this.overlay.layers.enableAll();
    this.root.add(this.overlay);
  }

  showCandidates(on: boolean, active = -1) {
    if (!this.overlay || !this.overlayMat) return;
    this.overlay.visible = on;
    this.overlayMat.uniforms.uActive.value = active + 1;
  }

  private makeRain() {
    const n = 7000;
    const seed = new Float32Array(n * 2 * 3);
    const tip = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const s = [Math.random(), Math.random(), Math.random()];
      seed.set(s, k * 6);
      seed.set(s, k * 6 + 3);
      tip[k * 2] = 0;
      tip[k * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute("seed", new THREE.BufferAttribute(seed, 3));
    g.setAttribute("tip", new THREE.BufferAttribute(tip, 1));
    this.rainMat = new THREE.ShaderMaterial({
      vertexShader: rainVert,
      fragmentShader: rainFrag,
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uSpread: { value: 300 }, uHeight: { value: 160 }, uOpacity: { value: 0 } },
    });
    this.rain = new THREE.LineSegments(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.layers.enableAll();
    this.rain.renderOrder = 4;
    this.root.add(this.rain);
  }

  /** Rain intensity drives the drops, the ripples and how dark the sky is. */
  setRain(mmh: number) {
    this.rainMmH = mmh;
  }

  // ── water ─────────────────────────────────────────────────────────────────────────────
  setWater(key: RunKey, depth: Float32Array | null, speed?: Float32Array | null) {
    const w = this.water[key];
    if (!w) return;
    const d = w.depth.array as Float32Array;
    if (depth) d.set(depth);
    else d.fill(0);
    // square footprints are drawn by their own surface
    if (key === "design") for (const sq of this.squares) for (const c of this.squareCells(sq.f)) d[c] = 0;
    w.depth.needsUpdate = true;
    if (speed) {
      (w.speed.array as Float32Array).set(speed);
      w.speed.needsUpdate = true;
    }
    if (key === "base" && this.water.design) {
      const o = this.water.design.other.array as Float32Array;
      if (depth) o.set(depth);
      else o.fill(0);
      this.water.design.other.needsUpdate = true;
    }
    if (key === "design" && depth) {
      for (const sq of this.squares) {
        const cells = this.squareCells(sq.f);
        const level = cells.length ? depth[cells[0]] : 0;
        const arr = sq.depthAttr.array as Float32Array;
        arr.fill(level);
        sq.depthAttr.needsUpdate = true;
      }
    } else if (key === "design" && !depth) {
      for (const sq of this.squares) {
        (sq.depthAttr.array as Float32Array).fill(0);
        sq.depthAttr.needsUpdate = true;
      }
    }
  }

  private cellCache = new Map<string, number[]>();
  private squareCells(f: RectFeature): number[] {
    const key = `${f.id}:${f.cx.toFixed(2)}:${f.cy.toFixed(2)}:${f.w}:${f.l}:${f.rot.toFixed(3)}`;
    let v = this.cellCache.get(key);
    if (!v) {
      const g = this.data!.grid;
      v = cellsInRect(g, f).filter((c) => g.land[c] !== 2 && g.land[c] !== 1);
      this.cellCache.set(key, v);
    }
    return v;
  }

  setShade(shade: Shade) {
    this.shade = shade;
  }

  // ── features ──────────────────────────────────────────────────────────────────────────
  private clearFeatures() {
    for (const c of [...this.featureGroup.children]) {
      this.featureGroup.remove(c);
      c.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
    }
    this.squares = [];
    this.animated = [];
  }

  groundAt(x: number, y: number, design = false): number {
    if (!this.data) return 0;
    const { nx, ny, dx } = this.data.grid;
    const g = design ? this.groundDesign : this.groundBase;
    const fi = Math.min(nx - 1.001, Math.max(0, x / dx - 0.5));
    const fj = Math.min(ny - 1.001, Math.max(0, y / dx - 0.5));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const u = fi - i;
    const v = fj - j;
    const a = g[j * nx + i];
    const b = g[j * nx + i + 1];
    const c = g[(j + 1) * nx + i];
    const d = g[(j + 1) * nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  setFeatures(features: Feature[], selectedId: string | null) {
    if (!this.data) return;
    this.clearFeatures();
    const S = this.S;
    const grid = this.data.grid;
    // carve design ground
    this.groundDesign.set(this.groundBase);
    this.holes.n = 0;
    for (const f of features) {
      if (f.kind === "garden") for (const c of cellsInRect(grid, f)) if (grid.land[c] !== 2) this.groundDesign[c] = this.groundBase[c] - f.depth;
    }
    for (const f of features) {
      if (f.kind === "square") {
        const cells = this.squareCells(f);
        let zs = 0;
        for (const c of cells) zs += this.groundBase[c];
        const rim = cells.length ? zs / cells.length : this.groundAt(f.cx, f.cy);
        const floor = rim - f.depth;
        for (const c of cells) this.groundDesign[c] = floor;
        if (this.holes.n < 8) {
          this.holes.v[this.holes.n].set(f.cx - S / 2, f.cy - S / 2, f.w / 2, f.l / 2);
          this.holes.r[this.holes.n] = f.rot;
          this.holes.n++;
        }
        this.buildSquare(f, rim, floor, f.id === selectedId);
      }
    }
    for (const f of features) {
      if (f.kind === "garden") this.buildGarden(f, f.id === selectedId);
      else if (f.kind === "permeable") this.buildPermeable(f, f.id === selectedId);
      else if (f.kind === "drain") this.buildDrain(f, features, f.id === selectedId);
      else if (f.kind === "inlet") this.buildInlet(f, features, f.id === selectedId);
    }
    // update design ground meshes
    if (this.terrainDesign) {
      const p = this.terrainDesign.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let c = 0; c < this.groundDesign.length; c++) p.setY(c, this.groundDesign[c]);
      p.needsUpdate = true;
      this.terrainDesign.geometry.computeVertexNormals();
    }
    if (this.water.design) {
      (this.water.design.ground.array as Float32Array).set(this.groundDesign);
      this.water.design.ground.needsUpdate = true;
    }
    for (const m of this.waterMats) m.uniforms.uHoleN.value = this.holes.n;
    if (this.overlayMat) this.overlayMat.uniforms.uHoleN.value = this.holes.n;
    const dsh = (this.terrainDesign?.material as THREE.MeshStandardMaterial | undefined)?.userData.shader;
    if (dsh) dsh.uniforms.uHoleN.value = this.holes.n;
  }

  private rectGroup(f: RectFeature, y: number) {
    const g = new THREE.Group();
    g.position.set(f.cx - this.S / 2, y, f.cy - this.S / 2);
    g.rotation.y = -f.rot;
    g.layers.set(L_DESIGN);
    return g;
  }

  private outline(w: number, l: number, y: number, color: number) {
    const pts = [
      new THREE.Vector3(-w / 2, y, -l / 2),
      new THREE.Vector3(w / 2, y, -l / 2),
      new THREE.Vector3(w / 2, y, l / 2),
      new THREE.Vector3(-w / 2, y, l / 2),
    ];
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }));
    line.renderOrder = 6;
    line.layers.set(L_DESIGN);
    return line;
  }

  private buildSquare(f: RectFeature, rim: number, floor: number, selected: boolean) {
    const grp = this.rectGroup(f, 0);
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ad, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x8c8981, roughness: 0.95, side: THREE.DoubleSide });
    // floor
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.l), new THREE.MeshStandardMaterial({ map: courtTexture(f.w, f.l), roughness: 0.75 }));
    fl.rotation.x = -Math.PI / 2;
    fl.position.y = floor + 0.01;
    fl.receiveShadow = true;
    grp.add(fl);
    // inner walls (a little higher than the rim to hide the ground's small undulations)
    const H = rim - floor + 0.6;
    const walls: [number, number, number, number][] = [
      [0, -f.l / 2, f.w, 0],
      [0, f.l / 2, f.w, Math.PI],
      [-f.w / 2, 0, f.l, Math.PI / 2],
      [f.w / 2, 0, f.l, -Math.PI / 2],
    ];
    for (const [x, z, len, ry] of walls) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, H), dark);
      m.position.set(x, floor + H / 2 - 0.3, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      grp.add(m);
    }
    // terraced seating along one long side
    const steps = Math.max(2, Math.min(4, Math.round(f.depth / 0.3)));
    const along = f.w >= f.l;
    const len = along ? f.w : f.l;
    for (let s = 0; s < steps; s++) {
      const hgt = ((s + 1) * (rim - floor)) / (steps + 1);
      const dep = 0.55;
      const box = new THREE.Mesh(new THREE.BoxGeometry(along ? len : dep, hgt, along ? dep : len), concrete);
      const off = (along ? f.l : f.w) / 2 - dep * (steps - s - 0.5);
      if (along) box.position.set(0, floor + hgt / 2, -off);
      else box.position.set(-off, floor + hgt / 2, 0);
      box.castShadow = true;
      box.receiveShadow = true;
      grp.add(box);
    }
    // coping round the rim
    const cop = 0.35;
    for (const [x, z, w, l] of [
      [0, -f.l / 2 - cop / 2, f.w + 2 * cop, cop],
      [0, f.l / 2 + cop / 2, f.w + 2 * cop, cop],
      [-f.w / 2 - cop / 2, 0, cop, f.l],
      [f.w / 2 + cop / 2, 0, cop, f.l],
    ] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, l), concrete);
      m.position.set(x, rim + 0.06, z);
      m.castShadow = true;
      grp.add(m);
    }
    // water in the court
    const wg = new THREE.PlaneGeometry(f.w, f.l, 6, 6);
    wg.rotateX(-Math.PI / 2);
    const n = wg.getAttribute("position").count;
    const depthAttr = new THREE.BufferAttribute(new Float32Array(n), 1);
    wg.setAttribute("depth", depthAttr);
    wg.setAttribute("ground", new THREE.BufferAttribute(new Float32Array(n).fill(floor), 1));
    wg.setAttribute("speed", new THREE.BufferAttribute(new Float32Array(n), 1));
    wg.setAttribute("other", new THREE.BufferAttribute(new Float32Array(n), 1));
    const wm = new THREE.Mesh(wg, this.waterMaterial(false));
    wm.renderOrder = 2;
    wm.frustumCulled = false;
    grp.add(wm);
    if (selected) grp.add(this.outline(f.w + 0.8, f.l + 0.8, rim + 0.3, 0x7dd3fc));
    grp.traverse((o) => o.layers.set(L_DESIGN));
    this.featureGroup.add(grp);
    this.squares.push({ id: f.id, group: grp, water: wm, depthAttr, floor, rim, f });
  }

  private buildGarden(f: RectFeature, selected: boolean) {
    const rim = this.groundAt(f.cx, f.cy);
    const grp = this.rectGroup(f, 0);
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(f.w, f.l), new THREE.MeshStandardMaterial({ color: 0x5b6b3a, roughness: 1 }));
    bed.rotation.x = -Math.PI / 2;
    bed.position.y = rim - f.depth + 0.03;
    bed.receiveShadow = true;
    grp.add(bed);
    const shrubs = Math.min(160, Math.round((f.w * f.l) / 5));
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4f7f3a, roughness: 0.9, flatShading: true });
    const inst = new THREE.InstancedMesh(geo, mat, shrubs);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    let s = 1234 + f.id.length * 97;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < shrubs; k++) {
      const x = (rnd() - 0.5) * f.w * 0.92;
      const z = (rnd() - 0.5) * f.l * 0.92;
      const r = 0.35 + rnd() * 0.55;
      m.makeScale(r, r * (0.8 + rnd() * 0.6), r).setPosition(x, rim - f.depth + r * 0.7, z);
      inst.setMatrixAt(k, m);
      inst.setColorAt(k, col.setHSL(0.24 + rnd() * 0.08, 0.45 + rnd() * 0.2, 0.26 + rnd() * 0.14));
    }
    inst.castShadow = true;
    grp.add(inst);
    if (selected) grp.add(this.outline(f.w + 0.6, f.l + 0.6, rim + 0.4, 0x7dd3fc));
    grp.traverse((o) => o.layers.set(L_DESIGN));
    this.featureGroup.add(grp);
  }

  private buildPermeable(f: RectFeature, selected: boolean) {
    const grp = this.rectGroup(f, 0);
    const seg = Math.max(2, Math.round(Math.max(f.w, f.l) / 3));
    const g = new THREE.PlaneGeometry(f.w, f.l, Math.max(1, Math.round((seg * f.w) / Math.max(f.w, f.l))), Math.max(1, Math.round((seg * f.l) / Math.max(f.w, f.l))));
    g.rotateX(-Math.PI / 2);
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const c = Math.cos(f.rot);
    const s = Math.sin(f.rot);
    for (let k = 0; k < p.count; k++) {
      const u = p.getX(k);
      const v = p.getZ(k);
      const x = f.cx + u * c - v * s;
      const y = f.cy + u * s + v * c;
      p.setY(k, this.groundAt(x, y) + 0.05);
    }
    g.computeVertexNormals();
    const tex = paverTexture();
    tex.repeat.set(f.w / 2, f.l / 2);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.receiveShadow = true;
    grp.add(m);
    if (selected) grp.add(this.outline(f.w + 0.6, f.l + 0.6, this.groundAt(f.cx, f.cy) + 0.4, 0x7dd3fc));
    grp.traverse((o) => o.layers.set(L_DESIGN));
    this.featureGroup.add(grp);
  }

  private targetOf(pts: [number, number][], features: Feature[], reach: number): RectFeature | null {
    let best: RectFeature | null = null;
    let bd = reach;
    for (const f of features) {
      if (f.kind !== "square") continue;
      for (const [x, y] of pts) {
        const c = Math.cos(f.rot);
        const s = Math.sin(f.rot);
        const px = x - f.cx;
        const py = y - f.cy;
        const u = Math.abs(px * c + py * s) - f.w / 2;
        const v = Math.abs(-px * s + py * c) - f.l / 2;
        const d = Math.hypot(Math.max(u, 0), Math.max(v, 0));
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
    }
    return best;
  }

  private buildDrain(f: Extract<Feature, { kind: "drain" }>, features: Feature[], selected: boolean) {
    const S = this.S;
    const target = this.targetOf([f.pts[0], f.pts[f.pts.length - 1]], features, 12);
    const tex = grateTexture();
    const grp = new THREE.Group();
    const flowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(target ? 0x5eead4 : 0xcbd5e1) } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} ",
      fragmentShader:
        "uniform float uTime; uniform vec3 uColor; varying vec2 vUv; void main(){ float d = fract(vUv.x - uTime*0.6); float a = smoothstep(0.0,0.15,d)*smoothstep(0.55,0.3,d); gl_FragColor = vec4(uColor, a*0.9); }",
    });
    // order the polyline so the flow runs towards the square it feeds
    let pts = f.pts;
    if (target) {
      const dEnd = (p: [number, number]) => Math.hypot(p[0] - target.cx, p[1] - target.cy);
      if (dEnd(pts[0]) < dEnd(pts[pts.length - 1])) pts = [...pts].reverse();
    }
    let run = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [x0, y0] = pts[k];
      const [x1, y1] = pts[k + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.1) continue;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const gy = Math.max(this.groundAt(x0, y0), this.groundAt(x1, y1), this.groundAt(mx, my));
      const t2 = tex.clone();
      t2.repeat.set(len / 1.5, 1);
      t2.needsUpdate = true;
      const box = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.7), new THREE.MeshStandardMaterial({ map: t2, roughness: 0.6, metalness: 0.4 }));
      box.position.set(mx - S / 2, gy + 0.05, my - S / 2);
      box.rotation.y = -ang;
      box.receiveShadow = true;
      grp.add(box);
      const strip = new THREE.PlaneGeometry(len, 0.5);
      strip.rotateX(-Math.PI / 2);
      const uv = strip.getAttribute("uv") as THREE.BufferAttribute;
      for (let q = 0; q < uv.count; q++) uv.setX(q, (run + uv.getX(q) * len) / 6);
      const fm = new THREE.Mesh(strip, flowMat);
      fm.position.set(mx - S / 2, gy + 0.16, my - S / 2);
      fm.rotation.y = -ang;
      fm.renderOrder = 5;
      grp.add(fm);
      run += len;
    }
    if (selected) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => new THREE.Vector3(x - S / 2, this.groundAt(x, y) + 0.6, y - S / 2))),
        new THREE.LineBasicMaterial({ color: 0x7dd3fc, depthTest: false }),
      );
      line.renderOrder = 6;
      grp.add(line);
    }
    grp.traverse((o) => o.layers.set(L_DESIGN));
    this.featureGroup.add(grp);
    this.animated.push({ obj: grp, kind: "flow", mat: flowMat });
  }

  private buildInlet(f: Extract<Feature, { kind: "inlet" }>, features: Feature[], selected: boolean) {
    const S = this.S;
    const y = this.groundAt(f.x, f.y);
    const target = this.targetOf([[f.x, f.y]], features, 25);
    const grp = new THREE.Group();
    grp.position.set(f.x - S / 2, y, f.y - S / 2);
    const tex = grateTexture();
    tex.repeat.set(1.5, 4);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 1.4), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.4 }));
    box.position.y = 0.05;
    grp.add(box);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.2, 1.5, 40),
      new THREE.MeshBasicMaterial({ color: target ? 0x5eead4 : 0xcbd5e1, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    grp.add(ring);
    if (selected) {
      const sel = new THREE.Mesh(new THREE.RingGeometry(2.1, 2.4, 40), new THREE.MeshBasicMaterial({ color: 0x7dd3fc, side: THREE.DoubleSide, depthTest: false }));
      sel.rotation.x = -Math.PI / 2;
      sel.position.y = 0.4;
      sel.renderOrder = 6;
      grp.add(sel);
    }
    grp.traverse((o) => o.layers.set(L_DESIGN));
    this.featureGroup.add(grp);
    this.animated.push({ obj: ring, kind: "pulse" });
  }

  // ── interaction ───────────────────────────────────────────────────────────────────────
  /** Local metres under a screen point, or null if off the area. */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.data) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    if (d.y >= -1e-4) return null;
    let y = this.groundAt(this.S / 2, this.S / 2);
    let hit = new THREE.Vector3();
    for (let k = 0; k < 6; k++) {
      const t = (y - o.y) / d.y;
      hit = o.clone().addScaledVector(d, t);
      y = this.groundAt(hit.x + this.S / 2, hit.z + this.S / 2);
    }
    const x = hit.x + this.S / 2;
    const yy = hit.z + this.S / 2;
    if (x < 0 || yy < 0 || x > this.S || yy > this.S) return null;
    return { x, y: yy };
  }

  project(x: number, y: number, lift = 0): ProjectedPoint {
    const v = new THREE.Vector3(x - this.S / 2, this.groundAt(x, y, true) + lift, y - this.S / 2);
    const cam = v.clone().applyMatrix4(this.camera.matrixWorldInverse);
    v.project(this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, visible: cam.z < 0 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 };
  }

  /** Metres per screen pixel at a ground point (for drag-resizing). */
  metresPerPixel(x: number, y: number): number {
    const a = this.project(x, y);
    const b = this.project(x + 10, y);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return d > 0 ? 10 / d : 1;
  }

  // ── render loop ───────────────────────────────────────────────────────────────────────
  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    this.controls.update();
    // weather: ease towards the rain intensity
    const target = Math.min(1, this.rainMmH / 60);
    this.storminess += (target - this.storminess) * Math.min(1, dt * 1.5);
    const st = this.storminess;
    if (this.rainMmH > 45 && Math.random() < dt * 0.12) this.flash = 1;
    this.flash = Math.max(0, this.flash - dt * 3.5);
    const light = 1 - st * 0.55 + this.flash * 0.9;
    this.sun.intensity = 2.4 * (1 - st * 0.75) + this.flash * 3;
    this.hemi.intensity = 1.1 * (1 - st * 0.35) + this.flash * 1.5;
    this.onWeather?.(st);
    for (const t of [this.terrainBase, this.terrainDesign]) if (t) (t.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.42 * (1 - st * 0.55) + this.flash * 0.3;
    const modeIdx = this.view === "diff" ? 2 : this.shade === "depth" ? 1 : 0;
    for (const m of this.waterMats) {
      m.uniforms.uTime.value = t;
      m.uniforms.uRain.value = st;
      m.uniforms.uLight.value = light;
      m.uniforms.uSun.value.copy(this.sun.position).normalize();
      m.uniforms.uMode.value = modeIdx;
    }
    const bsh = this.buildingMat?.userData.shader;
    if (bsh) bsh.uniforms.uTime.value = t;
    if (this.overlayMat) this.overlayMat.uniforms.uTime.value = t;
    if (this.rainMat && this.rain) {
      this.rainMat.uniforms.uTime.value = t;
      this.rainMat.uniforms.uOpacity.value = Math.min(0.55, st * 0.6);
      this.rain.visible = st > 0.02;
      const tg = this.controls.target;
      const dist = this.camera.position.distanceTo(tg);
      this.rainMat.uniforms.uSpread.value = Math.max(120, dist * 1.2);
      this.rainMat.uniforms.uHeight.value = Math.max(60, dist * 0.6);
      this.rainMat.uniforms.uCenter.value.set(tg.x + (this.camera.position.x - tg.x) * 0.4, tg.y, tg.z + (this.camera.position.z - tg.z) * 0.4);
    }
    for (const a of this.animated) {
      if (a.kind === "pulse") {
        const s = 1 + ((t * 0.8) % 1) * 0.6;
        a.obj.scale.set(s, s, 1);
        ((a.obj as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - ((t * 0.8) % 1));
      } else if (a.mat) a.mat.uniforms.uTime.value = t;
    }
    this.render();
    this.frameId++;
    this.onFrame?.();
  };

  private render() {
    const r = this.renderer;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const cam = this.camera;
    r.setScissorTest(false);
    if (this.view === "split") {
      const sx = Math.round(w * this.split);
      r.setScissorTest(true);
      r.setViewport(0, 0, w, h);
      cam.layers.set(0);
      cam.layers.enable(L_BASE);
      r.setScissor(0, 0, sx, h);
      r.render(this.scene, cam);
      cam.layers.set(0);
      cam.layers.enable(L_DESIGN);
      r.setScissor(sx, 0, w - sx, h);
      r.render(this.scene, cam);
      r.setScissorTest(false);
    } else {
      cam.layers.set(0);
      cam.layers.enable(this.view === "without" ? L_BASE : L_DESIGN);
      r.setViewport(0, 0, w, h);
      r.render(this.scene, cam);
    }
  }

  /** Render one view now and return it as a PNG data URL. */
  capture(view: ViewMode): string {
    const prev = this.view;
    this.view = view;
    this.render();
    const url = this.renderer.domElement.toDataURL("image/png");
    this.view = prev;
    return url;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
