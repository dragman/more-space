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

const canvas = document.getElementById("hexCanvas") as HTMLCanvasElement;
const radiusInput = document.getElementById("radiusInput") as HTMLInputElement;
const rebuildBtn = document.getElementById("buildGrid") as HTMLButtonElement;
const infoPanel = document.getElementById("hexInfo") as HTMLDivElement;

const HEX_SIZE = 2.3;
const HEX_HEIGHT = 0.02; // effectively flat grid tiles

let engine: BABYLON.Engine | null = null;
let scene: BABYLON.Scene | null = null;
let hoverMesh: BABYLON.AbstractMesh | null = null;
let glowLayer: BABYLON.GlowLayer | null = null;
let currentGrid: HexGrid | null = null;

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

function setHover(mesh: BABYLON.AbstractMesh | null): void {
  if (hoverMesh && hoverMesh !== mesh) {
    const { highlight, fill } = hoverMesh.metadata || {};
    if (highlight) {
      highlight.isVisible = false;
    }
    if (fill) {
      const mat = fill.material as BABYLON.StandardMaterial;
      if (mat) mat.alpha = 0.0;
    }
  }
  hoverMesh = mesh;
  if (hoverMesh) {
    const { highlight, fill } = hoverMesh.metadata || {};
    if (highlight) {
      highlight.isVisible = true;
    }
    if (fill) {
      const mat = fill.material as BABYLON.StandardMaterial;
      if (mat) mat.alpha = 0.55;
    }
  }
}

function describeCell(cell: HexCell): string {
  return `ID ${cell.id} · key ${cell.key} · q${cell.q} r${cell.r} · xyz(${cell.x}, ${cell.y}, ${cell.z}) · dist ${cell.distance}`;
}

function setupPointerHandling(s: BABYLON.Scene): void {
  s.onPointerObservable.add((pointerInfo: BABYLON.PointerInfo) => {
    if (pointerInfo.type === BABYLON.PointerEventTypes.POINTERMOVE) {
      const pick = s.pick(s.pointerX, s.pointerY);
      const mesh = pick?.hit ? pick.pickedMesh : null;
      if (mesh?.metadata?.cell) {
        setHover(mesh);
        infoPanel.textContent = describeCell(mesh.metadata.cell as HexCell);
      } else {
        setHover(null);
        infoPanel.textContent = currentGrid
          ? `Radius ${currentGrid.radius} (${currentGrid.cell_count} cells)`
          : "Hover a hex to see details.";
      }
    }
  });

  canvas.addEventListener("mouseleave", () => {
    setHover(null);
    if (currentGrid) {
      infoPanel.textContent = `Radius ${currentGrid.radius} (${currentGrid.cell_count} cells)`;
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

  const camDistance = Math.max(18, grid.radius * 7);
  const camera = new BABYLON.ArcRotateCamera(
    "hex-cam",
    Math.PI / 2,
    Math.PI / 2.4,
    camDistance,
    BABYLON.Vector3.Zero(),
    scene
  );
  camera.lowerRadiusLimit = 8;
  camera.upperRadiusLimit = 220;
  camera.panningSensibility = 0;
  camera.attachControl(canvas, true);

  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
  light.intensity = 0.7;
  light.groundColor = new BABYLON.Color3(0.04, 0.07, 0.12);

  // Use the same starfield helper as the main page (defaults match main view).
  createStarfield(scene);

  const maxDist = Math.max(1, grid.radius);

  grid.cells.forEach((cell) => {
    const center = axialToWorld(cell.q, cell.r);
    const t = cell.distance / maxDist;
    const baseColor = hexToColor3(0x5ed0ff);
    const faded = BABYLON.Color3.Lerp(baseColor, new BABYLON.Color3(0.2, 0.4, 0.65), t * 0.7);
    const points: BABYLON.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
      points.push(
        new BABYLON.Vector3(
          Math.cos(angle) * HEX_SIZE,
          HEX_HEIGHT,
          Math.sin(angle) * HEX_SIZE
        )
      );
    }

    const root = new BABYLON.TransformNode(`hex-root-${cell.id}`, scene);
    root.position = center;

    const hex = BABYLON.MeshBuilder.CreateLines(
      `hex-${cell.id}`,
      { points, updatable: false },
      scene
    ) as BABYLON.LinesMesh & { baseColor?: BABYLON.Color3 };
    hex.color = faded;
    hex.baseColor = faded;
    hex.alpha = 0.9;
    hex.isPickable = false;
    hex.renderingGroupId = 1;
    hex.parent = root;

    const highlightLine = BABYLON.MeshBuilder.CreateLines(
      `hex-highlight-${cell.id}`,
      { points, updatable: false },
      scene
    );
    highlightLine.color = hexToColor3(0xffffff);
    highlightLine.alpha = 1;
    highlightLine.isVisible = false;
    highlightLine.isPickable = false;
    highlightLine.renderingGroupId = 3;
    highlightLine.parent = root;
    glowLayer?.addIncludedOnlyMesh(highlightLine);

    // Faint fill to make hover stand out.
    const highlightFill = BABYLON.MeshBuilder.CreateCylinder(
      `hex-highlight-fill-${cell.id}`,
      {
        height: HEX_HEIGHT * 0.6,
        tessellation: 6,
        diameterTop: HEX_SIZE * 1.9,
        diameterBottom: HEX_SIZE * 1.9,
      },
      scene
    );
    highlightFill.rotation.y = Math.PI / 6;
    highlightFill.position.y = HEX_HEIGHT * 0.4;
    const fillMat = new BABYLON.StandardMaterial(`hex-highlight-mat-${cell.id}`, scene);
    fillMat.diffuseColor = hexToColor3(0xaff3ff);
    fillMat.emissiveColor = hexToColor3(0xaff3ff).scale(0.8);
    fillMat.alpha = 0.0;
    fillMat.specularColor = BABYLON.Color3.Black();
    highlightFill.material = fillMat;
    highlightFill.isPickable = false;
    highlightFill.renderingGroupId = 2;
    highlightFill.parent = root;
    glowLayer?.addIncludedOnlyMesh(highlightFill);

    const pickHex = BABYLON.MeshBuilder.CreateCylinder(
      `hex-pick-${cell.id}`,
      {
        height: HEX_HEIGHT * 1.2,
        tessellation: 6,
        diameterTop: HEX_SIZE * 1.9,
        diameterBottom: HEX_SIZE * 1.9,
      },
      scene
    );
    pickHex.position = new BABYLON.Vector3(0, HEX_HEIGHT * 0.5, 0);
    pickHex.rotation.y = Math.PI / 6;
    const pickMat = new BABYLON.StandardMaterial(`hex-pick-mat-${cell.id}`, scene);
    pickMat.alpha = 0;
    pickMat.specularColor = BABYLON.Color3.Black();
    pickHex.material = pickMat;
    pickHex.isPickable = true;
    pickHex.metadata = { cell, highlight: highlightLine, fill: highlightFill };
    pickHex.parent = root;

    const label = createLabel(cell.id.toString(), scene);
    label.position.y = HEX_HEIGHT * 2;
    label.parent = root;
  });

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
