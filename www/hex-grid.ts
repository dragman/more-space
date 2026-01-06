import initWasm, { hex_grid } from "../pkg/more_space.js";
import * as BABYLON from "babylonjs";
import { createStarfield, hexToColor3 } from "./planet-helpers";

type HexCell = {
  id: number;
  key: string;
  x: number;
  y: number;
  z: number;
  q: number;
  r: number;
  distance: number;
};

type HexGrid = {
  radius: number;
  diameter: number;
  cell_count: number;
  cells: HexCell[];
};

const canvas = document.getElementById("hexCanvas") as unknown as HTMLCanvasElement;
const radiusInput = document.getElementById("radiusInput") as HTMLInputElement;
const rebuildBtn = document.getElementById("buildGrid") as HTMLButtonElement;
const infoPanel = document.getElementById("hexInfo") as HTMLDivElement;

const HEX_SIZE = 2.3;
const HEX_HEIGHT = 0.02; // effectively flat grid tiles

let engine: BABYLON.Engine | null = null;
let scene: BABYLON.Scene | null = null;
let hoverLine: BABYLON.LinesMesh | null = null;
let hoverFill: BABYLON.Mesh | null = null;
let hoverLabel: BABYLON.Mesh | null = null;
let glowLayer: BABYLON.GlowLayer | null = null;
let currentGrid: HexGrid | null = null;
let edgeScrollActive = false;
let edgeScrollTimer: number | null = null;
let maxPanRange = 0;
const cellLookup = new Map<string, HexCell>();

function ensureEngine(): void {
  if (engine) return;
  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  window.addEventListener("resize", () => engine?.resize());
  engine.runRenderLoop(() => {
    scene?.render();
  });
}

function axialToWorld(q: number, r: number): BABYLON.Vector3 {
  // Pointy-top axial projection to 3D world coordinates.
  const x = HEX_SIZE * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const z = HEX_SIZE * (1.5 * r);
  return new BABYLON.Vector3(x, 0, z);
}

function createLabel(text: string, s: BABYLON.Scene): BABYLON.Mesh {
  const texture = new BABYLON.DynamicTexture(
    `label-${text}`,
    { width: 256, height: 128 },
    s,
    false
  );
  texture.hasAlpha = true;
  texture.drawText(text, 20, 84, "700 72px 'Space Grotesk', sans-serif", "#e8ecff", "transparent", true, true);
  const mat = new BABYLON.StandardMaterial(`labelMat-${text}`, s);
  mat.diffuseTexture = texture;
  mat.emissiveColor = new BABYLON.Color3(0.2, 0.25, 0.3); // toned down so glow only applies to highlights
  mat.specularColor = BABYLON.Color3.Black();
  mat.backFaceCulling = false;

  const plane = BABYLON.MeshBuilder.CreatePlane(
    `label-${text}-plane`,
    { width: 1.6, height: 0.9 },
    s
  );
  plane.material = mat;
  plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
  plane.isPickable = false;
  plane.position.y = HEX_HEIGHT * 1.8;
  return plane;
}

function cubeRound(x: number, y: number, z: number): { x: number; y: number; z: number } {
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const x_diff = Math.abs(rx - x);
  const y_diff = Math.abs(ry - y);
  const z_diff = Math.abs(rz - z);

  if (x_diff > y_diff && x_diff > z_diff) {
    rx = -ry - rz;
  } else if (y_diff > z_diff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { x: rx, y: ry, z: rz };
}

function worldToCell(pos: BABYLON.Vector3): HexCell | null {
  // Inverse of axialToWorld for pointy-top orientation.
  const q = (Math.sqrt(3) / 3 * pos.x - (1.0 / 3.0) * pos.z) / HEX_SIZE;
  const r = ((2.0 / 3.0) * pos.z) / HEX_SIZE;
  const x = q;
  const z = r;
  const y = -x - z;
  const rounded = cubeRound(x, y, z);
  const key = `${rounded.x},${rounded.y},${rounded.z}`;
  return cellLookup.get(key) ?? null;
}

function setHover(cell: HexCell | null, s: BABYLON.Scene): void {
  if (!hoverLine || !hoverFill || !hoverLabel) return;
  if (!cell) {
    hoverLine.isVisible = false;
    hoverFill.isVisible = false;
    hoverLabel.isVisible = false;
    const fillMat = hoverFill.material as BABYLON.StandardMaterial;
    if (fillMat) fillMat.alpha = 0.0;
    return;
  }

  const center = axialToWorld(cell.q, cell.r);
  hoverLine.position = center;
  hoverFill.position = center.add(new BABYLON.Vector3(0, HEX_HEIGHT * 0.4, 0));
  hoverLabel.position = center.add(new BABYLON.Vector3(0, HEX_HEIGHT * 2, 0));

  const mat = hoverLabel.material as BABYLON.StandardMaterial;
  const tex = mat?.diffuseTexture as BABYLON.DynamicTexture;
  if (tex) {
    tex.clear();
    tex.drawText(cell.id.toString(), 20, 84, "700 72px 'Space Grotesk', sans-serif", "#e8ecff", "transparent", true, true);
  }
  hoverLine.isVisible = true;
  hoverFill.isVisible = true;
  const fillMat = hoverFill.material as BABYLON.StandardMaterial;
  if (fillMat) fillMat.alpha = 0.35;
  hoverLabel.isVisible = true;
}

function describeCell(cell: HexCell): string {
  return `ID ${cell.id} · key ${cell.key} · q${cell.q} r${cell.r} · xyz(${cell.x}, ${cell.y}, ${cell.z}) · dist ${cell.distance}`;
}

function setupPointerHandling(s: BABYLON.Scene): void {
  const plane = new BABYLON.Plane(0, 1, 0, 0);
  s.onPointerObservable.add((pointerInfo: BABYLON.PointerInfo) => {
    if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE) {
      const cam = s.activeCamera as BABYLON.ArcRotateCamera;
      const ray = s.createPickingRay(s.pointerX, s.pointerY, BABYLON.Matrix.Identity(), cam);
      const dist = ray.intersectsPlane(plane);
      if (dist !== null && dist !== undefined) {
        const hit = ray.origin.add(ray.direction.scale(dist));
        const cell = worldToCell(hit);
        if (cell) {
          setHover(cell, s);
          infoPanel.textContent = describeCell(cell);
          return;
        }
      }
      setHover(null, s);
      infoPanel.textContent = currentGrid
        ? `Radius ${currentGrid.radius} (${currentGrid.cell_count} cells)`
        : "Hover a hex to see details.";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    setHover(null, s);
    if (currentGrid) {
      infoPanel.textContent = `Radius ${currentGrid.radius} (${currentGrid.cell_count} cells)`;
    }
  });

  // Edge scrolling (auto-pan when the cursor is near the viewport edges).
  const EDGE_PX = 32;
  const PAN_SPEED = 0.0008;
  const clampTarget = (cam: BABYLON.ArcRotateCamera) => {
    const len = cam.target.length();
    if (len > maxPanRange) {
      cam.target.scaleInPlace(maxPanRange / len);
    }
  };
  const loop = () => {
    if (!edgeScrollActive || !scene || !scene.activeCamera) return;
    const cam = scene.activeCamera as BABYLON.ArcRotateCamera;
    const rect = canvas.getBoundingClientRect();
    const x = scene.pointerX;
    const y = scene.pointerY;
    let dx = 0;
    let dz = 0;
    if (x < EDGE_PX) dx = -1;
    else if (x > rect.width - EDGE_PX) dx = 1;
    if (y < EDGE_PX) dz = -1;
    else if (y > rect.height - EDGE_PX) dz = 1;

    if (dx !== 0 || dz !== 0) {
      const dt = scene.getEngine().getDeltaTime();
      const scale = PAN_SPEED * (cam.radius || 1) * dt;
      // Move in screen-space directions projected onto the grid plane based on current camera rotation.
      const forward = cam.getDirection(BABYLON.Axis.Z);
      const right = cam.getDirection(BABYLON.Axis.X);
      forward.y = 0;
      right.y = 0;
      forward.normalize();
      right.normalize();
      // Flip forward/backward to make edge scroll intuitive.
      const offset = right.scale(dx * scale).add(forward.scale(-dz * scale));
      cam.target.addInPlace(offset);
      clampTarget(cam);
    }
    edgeScrollTimer = requestAnimationFrame(loop) as unknown as number;
  };

  canvas.addEventListener("mouseenter", () => {
    edgeScrollActive = true;
    if (edgeScrollTimer === null) {
      edgeScrollTimer = requestAnimationFrame(loop) as unknown as number;
    }
  });
  canvas.addEventListener("mouseleave", () => {
    edgeScrollActive = false;
    if (edgeScrollTimer !== null) {
      cancelAnimationFrame(edgeScrollTimer);
      edgeScrollTimer = null;
    }
  });
}

function buildScene(grid: HexGrid): void {
  currentGrid = grid;

  if (scene) {
    scene.dispose();
  }

  scene = new BABYLON.Scene(engine as BABYLON.Engine);
  scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.08, 1);
  glowLayer = new BABYLON.GlowLayer("hex-glow", scene, { blurKernelSize: 32 });
  glowLayer.intensity = 0.9;
  // Edge fog to fade distant cells.
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.005;
  scene.fogColor = new BABYLON.Color3(0.02, 0.04, 0.08);

  const farAxial = axialToWorld(grid.radius, 0);
  const farDiag = axialToWorld(grid.radius, -grid.radius);
  const maxExtent = Math.max(farAxial.length(), farDiag.length(), HEX_SIZE * 2);
  const camDistance = 80; // fixed base distance for consistent feel
  const camera = new BABYLON.ArcRotateCamera(
    "hex-cam",
    Math.PI / 2,
    Math.PI / 3.2, // more top-down
    camDistance,
    BABYLON.Vector3.Zero(),
    scene
  );
  const minZoom = 18;
  const maxZoom = 120; // fixed zoom bounds, independent of grid radius
  camera.lowerRadiusLimit = minZoom;
  camera.upperRadiusLimit = maxZoom;
  camera.wheelDeltaPercentage = -0.01; // invert scroll direction
  camera.panningSensibility = 850; // enable smooth panning
  camera.panningDistanceLimit = maxExtent * 0.7; // keep the grid in view while allowing some travel
  camera.panningAxis = new BABYLON.Vector3(1, 0, 1); // lock panning to the grid plane (no vertical component)
  camera.lowerBetaLimit = 0.65; // keep some pitch but avoid top-down lock
  camera.upperBetaLimit = Math.PI / 2.05; // prevent rotating below the grid plane
  camera.allowUpsideDown = false;
  camera.attachControl(canvas, true);

  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
  light.intensity = 0.7;
  light.groundColor = new BABYLON.Color3(0.04, 0.07, 0.12);

  // Use the same starfield helper as the main page (defaults match main view).
  createStarfield(scene);
  // Keep starfield crisp by disabling fog on star meshes.
  scene.meshes
    .filter((m) => m.name.startsWith("star"))
    .forEach((m) => {
      m.applyFog = false;
    });

  const maxDist = Math.max(1, grid.radius);
  maxPanRange = maxExtent * 0.65;

  cellLookup.clear();
  const lines: BABYLON.Vector3[][] = [];
  const colors: BABYLON.Color4[][] = [];
  const baseColor = hexToColor3(0x5ed0ff);
  const fadeTarget = new BABYLON.Color3(0.2, 0.4, 0.65);

  grid.cells.forEach((cell) => {
    cellLookup.set(cell.key, cell);
    const center = axialToWorld(cell.q, cell.r);
    const t = cell.distance / maxDist;
    const faded = BABYLON.Color3.Lerp(baseColor, fadeTarget, t * 0.7);
    const c4 = new BABYLON.Color4(faded.r, faded.g, faded.b, 0.9);

    for (let i = 0; i < 6; i++) {
      const a1 = Math.PI / 6 + (i / 6) * Math.PI * 2;
      const a2 = Math.PI / 6 + ((i + 1) / 6) * Math.PI * 2;
      const p1 = new BABYLON.Vector3(
        center.x + Math.cos(a1) * HEX_SIZE,
        HEX_HEIGHT,
        center.z + Math.sin(a1) * HEX_SIZE
      );
      const p2 = new BABYLON.Vector3(
        center.x + Math.cos(a2) * HEX_SIZE,
        HEX_HEIGHT,
        center.z + Math.sin(a2) * HEX_SIZE
      );
      lines.push([p1, p2]);
      colors.push([c4, c4]);
    }
  });

  const GreasedLineBuilder = (BABYLON as any).GreasedLineBuilder;
  if (GreasedLineBuilder?.CreateGreasedLine) {
    const greased = GreasedLineBuilder.CreateGreasedLine(
      "grid-lines",
      {
        points: lines,
        colors,
        useColors: true,
        width: 0.05,
        multiLine: true,
      },
      scene
    );
    greased.isPickable = false;
    greased.renderingGroupId = 1;
    greased.applyFog = true;
  } else {
    const lineSystem = BABYLON.MeshBuilder.CreateLineSystem(
      "grid-lines",
      { lines, colors },
      scene
    );
    lineSystem.isPickable = false;
    lineSystem.renderingGroupId = 1;
  }

  const hexPoints: BABYLON.Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
    hexPoints.push(
      new BABYLON.Vector3(Math.cos(angle) * HEX_SIZE, HEX_HEIGHT, Math.sin(angle) * HEX_SIZE)
    );
  }

  hoverLine = BABYLON.MeshBuilder.CreateLines(
    "hover-line",
    { points: hexPoints, updatable: false },
    scene
  ) as BABYLON.LinesMesh;
  hoverLine.color = hexToColor3(0xffffff);
  hoverLine.isVisible = false;
  hoverLine.isPickable = false;
  hoverLine.renderingGroupId = 3;
  glowLayer?.addIncludedOnlyMesh(hoverLine);

  hoverFill = BABYLON.MeshBuilder.CreateCylinder(
    "hover-fill",
    {
      height: HEX_HEIGHT * 0.6,
      tessellation: 6,
      diameterTop: HEX_SIZE * 1.9,
      diameterBottom: HEX_SIZE * 1.9,
    },
    scene
  );
  hoverFill.rotation.y = Math.PI / 6;
  const fillMat = new BABYLON.StandardMaterial("hover-fill-mat", scene);
  fillMat.diffuseColor = hexToColor3(0xaff3ff);
  fillMat.emissiveColor = hexToColor3(0xaff3ff).scale(0.8);
  fillMat.alpha = 0.0;
  fillMat.specularColor = BABYLON.Color3.Black();
  hoverFill.material = fillMat;
  hoverFill.isPickable = false;
  hoverFill.renderingGroupId = 2;
  hoverFill.isVisible = false;
  glowLayer?.addIncludedOnlyMesh(hoverFill);

  hoverLabel = createLabel("", scene);
  hoverLabel.isVisible = false;
  hoverLabel.renderingGroupId = 4;

  setupPointerHandling(scene);
  infoPanel.textContent = `Radius ${grid.radius} (${grid.cell_count} cells)`;
}

function parseRadius(): number {
  const parsed = parseInt(radiusInput.value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 25);
}

async function loadGrid(): Promise<void> {
  const radius = parseRadius();
  try {
    const json = hex_grid(radius);
    const grid = JSON.parse(json) as HexGrid;
    buildScene(grid);
  } catch (err) {
    console.error(err);
    infoPanel.textContent = "Unable to build grid – check the wasm build output.";
  }
}

async function run(): Promise<void> {
  await initWasm();
  ensureEngine();
  radiusInput.value = radiusInput.value || "3";
  await loadGrid();
}

rebuildBtn.addEventListener("click", () => {
  loadGrid();
});

radiusInput.addEventListener("keydown", (evt) => {
  if (evt.key === "Enter") {
    loadGrid();
  }
});

run();
