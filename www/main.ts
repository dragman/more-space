import initWasm, { generate_universe } from "../pkg/more_space.js";
import * as BABYLON from "babylonjs";
import { bodyStyle, createPlanetMesh, hashString, hexToColor3 } from "./planet-helpers";

const canvas = document.getElementById("graph") as HTMLCanvasElement;
const tooltip = document.getElementById("tooltip") as HTMLDivElement;
const seedInput = document.getElementById("seedInput") as HTMLInputElement;
const regenBtn = document.getElementById("regen") as HTMLButtonElement;
const randomBtn = document.getElementById("randomSeed") as HTMLButtonElement;

const VIEW_HEIGHT = 1400;
const PIXEL_TO_WORLD = 0.14;
const NODE_RADIUS = 22;
const ORBIT_BASE = 22;
const MIN_CAMERA_RADIUS = 45;
const MAX_CAMERA_RADIUS = 320;

let engine: BABYLON.Engine | null = null;
let scene: BABYLON.Scene | null = null;
let camera: BABYLON.ArcRotateCamera | null = null;
let glowLayer: BABYLON.GlowLayer | null = null;
let universeData: any = null;
let layout: any = null;
let bodyAnims: {
  root: BABYLON.TransformNode;
  mesh: BABYLON.AbstractMesh;
  ring?: BABYLON.AbstractMesh | null;
  radius: number;
  angle: number;
  speed: number;
  shaderTime: number;
}[] = [];

function randomSeed() {
  const upper = BigInt(Number.MAX_SAFE_INTEGER);
  const low = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  return (BigInt(Date.now()) ^ low) % upper;
}

function parseSeed() {
  const text = seedInput.value.trim();
  if (!text) return randomSeed();
  try {
    return BigInt(text);
  } catch {
    return randomSeed();
  }
}

function angleForBody(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return (hash % 360) * (Math.PI / 180);
}

function hazardSummary(hazards) {
  if (!hazards.length) return "hazards: none";
  const labels = hazards.map((h) => h.kind).join(", ");
  return `hazards: ${labels}`;
}

function systemLabel(sys) {
  if (!sys) return "";
  const first = sys.stars && sys.stars[0];
  return first ? first.name : `System ${sys.id}`;
}

function prepareLayout(universe) {
  const width = canvas.clientWidth || 1200;
  const height = VIEW_HEIGHT;
  const viewRadius = Math.min(width, height) / 2;
  const padding = 140;
  const maxRadius = Math.max(viewRadius - padding, 120);
  const ringRadius = maxRadius * 0.55;

  const positions = universe.systems.map((sys, idx) => {
    const angle = (idx / universe.systems.length) * Math.PI * 2;
    return {
      id: sys.id,
      label: systemLabel(sys),
      sys,
      x: Math.cos(angle) * ringRadius * PIXEL_TO_WORLD,
      y: Math.sin(angle) * ringRadius * PIXEL_TO_WORLD,
      tilt: {
        x: (hashString(sys.name || `${sys.id}-tilt-x`) % 1000) / 1000 - 0.5,
        z: (hashString(sys.name || `${sys.id}-tilt-z`) % 1000) / 1000 - 0.5,
      },
    };
  });

  const maxDistance =
    universe.systems
      .flatMap((s) => s.orbitals.map((o) => o.distance))
      .reduce((a, b) => Math.max(a, b), 1) || 1;
  const orbitRoom = Math.max(maxRadius - ringRadius - NODE_RADIUS - ORBIT_BASE, 30);
  const orbitScale = (orbitRoom / maxDistance) * PIXEL_TO_WORLD;

  const systems = positions.map((pos) => {
    const orbitals = pos.sys.orbitals.map((orb) => {
      const angle = angleForBody(orb.name);
      const baseDistance = orb.distance;
      return { orb, angle, baseDistance, radius: 0 };
    });
    return { ...pos, orbitals };
  });

  const edges = new Set();
  universe.systems.forEach((sys) => {
    sys.links.forEach((link) => {
      const key = [Math.min(sys.id, link), Math.max(sys.id, link)].join("-");
      edges.add(key);
    });
  });

  layout = { systems, edges, orbitScale, maxDistance };
}

function setupEngine() {
  if (engine) return;
  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  engine.runRenderLoop(() => {
    if (scene) {
      scene.render();
    }
  });
  window.addEventListener("resize", () => engine.resize());
}

function createBaseScene() {
  const s = new BABYLON.Scene(engine);
  s.clearColor = new BABYLON.Color4(0.02, 0.04, 0.07, 1);

  camera = new BABYLON.ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.4,
    140,
    BABYLON.Vector3.Zero(),
    s
  );
  camera.lowerRadiusLimit = MIN_CAMERA_RADIUS;
  camera.upperRadiusLimit = MAX_CAMERA_RADIUS;
  camera.wheelDeltaPercentage = 0.01;
  camera.panningSensibility = 850;
  camera.attachControl(canvas, true);
  camera.minZ = 0.5;

  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), s);
  light.intensity = 0.05;
  light.groundColor = new BABYLON.Color3(0.03, 0.05, 0.08);

  glowLayer = new BABYLON.GlowLayer("glow", s, { blurKernelSize: 24 });
  glowLayer.intensity = 0.15;
  createStarfield(s);
  setupPointerHandling(s);

  return s;
}

function createStarfield(s) {
  const starMaterial = new BABYLON.StandardMaterial("starMat", s);
  starMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
  starMaterial.disableLighting = true;
  const base = BABYLON.MeshBuilder.CreateSphere("star-base", { diameter: 1 }, s);
  base.material = starMaterial;
  base.isPickable = false;
  base.setEnabled(false);

  const radius = 650;
  for (let i = 0; i < 5000 ; i++) {
    const inst = base.createInstance(`star-${i}`);
    const dir = randomUnitVector();
    inst.position = dir.scale(radius * (0.6 + Math.random() * 0.4));
    inst.scaling.scaleInPlace(0.5 + Math.random() * 0.8);
    inst.isPickable = false;
  }
}

function randomUnitVector() {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const x = Math.sin(phi) * Math.cos(theta);
  const y = Math.sin(phi) * Math.sin(theta);
  const z = Math.cos(phi);
  return new BABYLON.Vector3(x, y, z);
}

function createLabel(text, s) {
  const texture = new BABYLON.DynamicTexture(
    `label-${text}`,
    { width: 512, height: 128 },
    s,
    false
  );
  texture.hasAlpha = true;
  texture.drawText(text, 10, 86, "700 64px 'Space Grotesk', sans-serif", "#e8ecff", "transparent", true, true);
  const mat = new BABYLON.StandardMaterial(`labelMat-${text}`, s);
  mat.diffuseTexture = texture;
  mat.emissiveColor = new BABYLON.Color3(0.91, 0.93, 1.0);
  mat.backFaceCulling = false;

  const plane = BABYLON.MeshBuilder.CreatePlane(
    `labelPlane-${text}`,
    { width: 7, height: 1.8 },
    s
  );
  plane.material = mat;
  plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  plane.isPickable = false;
  plane.position.y = 4.5;
  return plane;
}

function createStarMesh(sys, s) {
  const starPalette = [
    { glow: 0x9bd4ff, core: 0xbfe2ff },
    { glow: 0xffd79b, core: 0xfff0b5 },
    { glow: 0xff9b9b, core: 0xffc4c4 },
    { glow: 0xb3a5ff, core: 0xd7ceff },
  ];
  const name = sys?.stars?.[0]?.name || sys?.name || "";
  const idx = name ? hashString(name) % starPalette.length : 0;
  const colors = starPalette[idx];
  const core = BABYLON.MeshBuilder.CreateSphere("star-core", { diameter: NODE_RADIUS * PIXEL_TO_WORLD }, s);
  const mat = new BABYLON.StandardMaterial("starMat-core", s);
  mat.emissiveColor = hexToColor3(colors.core);
  mat.diffuseColor = hexToColor3(colors.core);
  mat.specularColor = hexToColor3(colors.glow);
  mat.alpha = 0.95;
  core.material = mat;
  core.isPickable = true;
  glowLayer.addIncludedOnlyMesh(core);
  glowLayer.intensity = 0.5;
  return { mesh: core, colors };
}

function createOrbitLine(radius, s) {
  const points = [];
  const segments = 90;
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(new BABYLON.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  const line = BABYLON.MeshBuilder.CreateLines("orbit", { points }, s);
  line.color = new BABYLON.Color3(0.37, 0.82, 1);
  line.alpha = 0.12;
  line.isPickable = false;
  return line;
}

function buildScene(universe) {
  // setupEngine();
  prepareLayout(universe);

  if (scene) {
    scene.dispose();
  }

  scene = createBaseScene();
  bodyAnims = [];

  const edgeColor = new BABYLON.Color3(0.37, 0.82, 1);
  layout.edges.forEach((key) => {
    const [a, b] = key.split("-").map(Number);
    const pa = layout.systems.find((s) => s.id === a);
    const pb = layout.systems.find((s) => s.id === b);
    if (!pa || !pb) return;
    const line = BABYLON.MeshBuilder.CreateLines(
      `edge-${a}-${b}`,
      {
        points: [
          new BABYLON.Vector3(pa.x, 0, pa.y),
          new BABYLON.Vector3(pb.x, 0, pb.y),
        ],
      },
      scene
    );
    line.color = edgeColor;
    line.alpha = 0.28;
    line.isPickable = false;
  });

  layout.systems.forEach((s) => {
    const systemRoot = new BABYLON.TransformNode(`system-${s.id}`, scene);
    systemRoot.position = new BABYLON.Vector3(s.x, 0, s.y);
    systemRoot.rotation = new BABYLON.Vector3(s.tilt.x * 0.3, 0, s.tilt.z * 0.3);

    const { mesh: star, colors: starColors } = createStarMesh(s.sys, scene);
    star.parent = systemRoot;
    star.metadata = {
      type: "system",
      onHover: (evt) => showSystemInfo(s.sys, evt),
    };

    const starLight = new BABYLON.PointLight(
      `star-light-${s.id}`,
      BABYLON.Vector3.Zero(),
      scene
    );
    starLight.diffuse = hexToColor3(starColors.core);
    starLight.specular = hexToColor3(starColors.glow);
    starLight.intensity = 0.0;
    starLight.range = 1;
    starLight.parent = systemRoot;

    const label = createLabel(s.label.slice(0, 18), scene);
    label.parent = systemRoot;

    s.orbitals.forEach((o) => {
      const radius = ORBIT_BASE * PIXEL_TO_WORLD + o.baseDistance * layout.orbitScale;
      o.radius = radius;
      const orbit = createOrbitLine(radius, scene);
      orbit.parent = systemRoot;

      const style = bodyStyle(o.orb, o.baseDistance);
      const { root, mesh: planetMesh, ring } = createPlanetMesh(o.orb, style, scene);
      root.parent = systemRoot;
      root.position = new BABYLON.Vector3(
        Math.cos(o.angle) * radius,
        0,
        Math.sin(o.angle) * radius
      );
      planetMesh.metadata = {
        type: "orbital",
        onHover: (evt) => showOrbitInfo(s.sys, o.orb, evt),
      };

      bodyAnims.push({
        root,
        mesh: planetMesh,
        ring,
        radius,
        angle: o.angle,
        speed: 0.00035 + Math.random() * 0.00025,
        shaderTime: 0,
      });
    });
  });

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime();
    bodyAnims.forEach((b) => {
      b.angle += b.speed * dt;
      b.root.position.x = Math.cos(b.angle) * b.radius;
      b.root.position.z = Math.sin(b.angle) * b.radius;
      b.mesh.rotation.y += 0.002 * dt;
      const mat = b.mesh.material;
      if (mat?.getClassName && mat.getClassName() === "ShaderMaterial") {
        b.shaderTime += dt * 0.001;
        mat.setFloat("u_time", b.shaderTime);
      }
    });
  });
}

function setupPointerHandling(s) {
  s.skipPointerMovePicking = false;
  s.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE) {
      // Manual pick keeps hover working even when Babylon skips pickInfo on some pointer events.
      const pick = s.pick(s.pointerX, s.pointerY);
      const mesh = pick?.hit ? pick.pickedMesh : null;
      if (mesh?.metadata?.onHover) {
        mesh.metadata.onHover(pointerInfo.event);
      } else {
        hideTooltip();
      }
    }
    if (
      pointerInfo.type === BABYLON.PointerEventTypes.POINTERUP ||
      pointerInfo.type === BABYLON.PointerEventTypes.POINTEROUT
    ) {
      hideTooltip();
    }
  });

  canvas.addEventListener("mouseleave", hideTooltip);
}

async function renderUniverse(seed) {
  try {
    const json = generate_universe(seed);
    universeData = JSON.parse(json);
    buildScene(universeData);
  } catch (err) {
    console.error(err);
  }
}

function showSystemInfo(sys, evt) {
  if (!sys) return;
  const stars = sys.stars
    .map((s) => `${s.name}${s.nickname ? ` (${s.nickname})` : ""}`)
    .join(", ");
  const links = sys.links.length ? sys.links.join(", ") : "none";
  showTooltip(
    `
    <strong>${systemLabel(sys)}</strong><br/>
    Stars: ${stars}<br/>
    Links: ${links}<br/>
    Orbits: ${sys.orbitals.length}
  `,
    evt
  );
}

function showOrbitInfo(sys, orb, evt) {
  const hazards = orb.hazards.length
    ? orb.hazards.map((h) => h.kind).join(", ")
    : "none";
  showTooltip(
    `
    <strong>${orb.name}${orb.nickname ? ` (${orb.nickname})` : ""}</strong><br/>
    System: ${systemLabel(sys)}<br/>
    Kind: ${orb.kind}<br/>
    Distance: ${orb.distance}<br/>
    Probe fail: ${(orb.probe_failure * 100).toFixed(1)}%<br/>
    Hazards: ${hazards}<br/>
    ${hazardSummary(orb.hazards)}
  `,
    evt
  );
}

function showTooltip(content, evt) {
  tooltip.innerHTML = content;
  tooltip.style.display = "block";
  moveTooltip(evt);
}

function hideTooltip() {
  tooltip.style.display = "none";
}

function moveTooltip(evt) {
  if (!evt) return;
  const padding = 6;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + padding;
  let y = evt.clientY + padding;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + rect.width + padding > vw) x = evt.clientX - rect.width - padding;
  if (y + rect.height + padding > vh) y = evt.clientY - rect.height - padding;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

async function run() {
  await initWasm();
  setupEngine();
  const seed = randomSeed();
  seedInput.value = seed.toString();
  renderUniverse(seed);
}

regenBtn.addEventListener("click", () => {
  const seed = parseSeed();
  seedInput.value = seed.toString();
  renderUniverse(seed);
});

randomBtn.addEventListener("click", () => {
  const seed = randomSeed();
  seedInput.value = seed.toString();
  renderUniverse(seed);
});

run();
