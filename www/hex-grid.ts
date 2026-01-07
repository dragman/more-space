import initWasm, { hex_window } from "../pkg/more_space.js";
import {
    AbstractMesh,
    ArcRotateCamera,
    Color3,
    Color4,
    DynamicTexture,
    Engine,
    GlowLayer,
    HemisphericLight,
    LinesMesh,
    Matrix,
    Mesh,
    MeshBuilder,
    Plane,
    PointerEventTypes,
    PointerInfo,
    Scene,
    StandardMaterial,
    TransformNode,
    Vector3,
    Axis,
} from "@babylonjs/core";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import { createStarfield, hexToColor3, createNebula, createSystemStar } from "./planet-helpers";

type HexCell = {
    id: string; // canonical packed id from Rust
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
    center_q: number;
    center_r: number;
    cells: HexCell[];
};

const canvas = document.getElementById("hexCanvas") as unknown as HTMLCanvasElement;
const radiusInput = document.getElementById("radiusInput") as HTMLInputElement;
const rebuildBtn = document.getElementById("buildGrid") as HTMLButtonElement;
const infoPanel = document.getElementById("hexInfo") as HTMLDivElement;

const HEX_SIZE = 2.3;
const HEX_HEIGHT = 0.02; // effectively flat grid tiles
const DEFAULT_RADIUS = 3; // cells around the focus to render

let engine: Engine | null = null;
let scene: Scene | null = null;
let hoverLine: LinesMesh | null = null;
let hoverFill: Mesh | null = null;
let hoverLabel: Mesh | null = null;
let glowLayer: GlowLayer | null = null;
let edgeScrollActive = false;
let edgeScrollTimer: number | null = null;
let maxPanRange = 0;
const cellLookup = new Map<string, HexCell>();
let gridLines: AbstractMesh | null = null;
let gridLinesKind: "greased" | null = null;
let currentCenter: { q: number; r: number } | null = null;
let currentRadius = DEFAULT_RADIUS;
let nebulaCreated = false;
let systemStarCreated = false;

function hashColor(key: string): Color3 {
    let h = 0;
    for (let i = 0; i < key.length; i++) {
        h = (h * 131 + key.charCodeAt(i)) >>> 0;
    }
    const r = 0.3 + ((h & 0xff) / 255) * 0.7;
    const g = 0.3 + (((h >> 8) & 0xff) / 255) * 0.7;
    const b = 0.3 + (((h >> 16) & 0xff) / 255) * 0.7;
    return new Color3(r, g, b);
}

function ensureEngine(): void {
    if (engine) return;
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    window.addEventListener("resize", () => engine?.resize());
    engine.runRenderLoop(() => {
        scene?.render();
    });
}

function axialToWorld(q: number, r: number): Vector3 {
    // Pointy-top axial projection to 3D world coordinates.
    const x = HEX_SIZE * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
    const z = HEX_SIZE * (1.5 * r);
    return new Vector3(x, 0, z);
}

function createLabel(text: string, s: Scene): Mesh {
    const texture = new DynamicTexture(`label-${text}`, { width: 256, height: 128 }, s, false);
    texture.hasAlpha = true;
    texture.drawText(text, 20, 84, "700 72px 'Space Grotesk', sans-serif", "#e8ecff", "transparent", true, true);
    const mat = new StandardMaterial(`labelMat-${text}`, s);
    mat.diffuseTexture = texture;
    mat.emissiveColor = new Color3(0.2, 0.25, 0.3); // toned down so glow only applies to highlights
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;

    const plane = MeshBuilder.CreatePlane(`label-${text}-plane`, { width: 1.6, height: 0.9 }, s);
    plane.material = mat;
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.position.y = HEX_HEIGHT * 1.8;
    return plane;
}

function zigzag(v: number): number {
    return (v << 1) ^ (v >> 31);
}

function packId(q: number, r: number): string {
    const qq = BigInt(zigzag(q));
    const rr = BigInt(zigzag(r));
    return ((qq << 32n) | rr).toString();
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

function worldToCell(pos: Vector3): HexCell | null {
    // Inverse of axialToWorld for pointy-top orientation.
    const q = ((Math.sqrt(3) / 3) * pos.x - (1.0 / 3.0) * pos.z) / HEX_SIZE;
    const r = ((2.0 / 3.0) * pos.z) / HEX_SIZE;
    const x = q;
    const z = r;
    const y = -x - z;
    const rounded = cubeRound(x, y, z);
    const key = `${rounded.x},${rounded.y},${rounded.z}`;
    const existing = cellLookup.get(key);
    if (existing) return existing;
    const id = packId(rounded.x, rounded.z);
    return {
        id,
        key,
        x: rounded.x,
        y: rounded.y,
        z: rounded.z,
        q: rounded.x,
        r: rounded.z,
        distance: Math.max(Math.abs(rounded.x), Math.abs(rounded.y), Math.abs(rounded.z)),
    };
}

function setHover(cell: HexCell | null, s: Scene): void {
    // Guarantee hover meshes exist when pointer moves.
    ensureHoverMeshes(s);
    if (!hoverLine || !hoverFill || !hoverLabel) return;
    if (!cell) {
        hoverLine.isVisible = false;
        hoverFill.isVisible = false;
        hoverLabel.isVisible = false;
        const fillMat = hoverFill.material as StandardMaterial;
        if (fillMat) fillMat.alpha = 0.0;
        cellLookup.clear();
        if (gridLines) {
            gridLines.setEnabled(false);
        }
        infoPanel.textContent = "Hover a hex to see details.";
        return;
    }

    const center = axialToWorld(cell.q, cell.r);
    hoverLine.position = center;
    hoverFill.position = center.add(new Vector3(0, HEX_HEIGHT * 0.4, 0));
    hoverLabel.position = center.add(new Vector3(0, HEX_HEIGHT * 2, 0));

    const mat = hoverLabel.material as StandardMaterial;
    const tex = mat?.diffuseTexture as DynamicTexture;
    if (tex) {
        tex.clear();
        tex.drawText(
            cell.id.toString(),
            20,
            84,
            "700 72px 'Space Grotesk', sans-serif",
            "#e8ecff",
            "transparent",
            true,
            true
        );
    }
    hoverLine.isVisible = true;
    hoverFill.isVisible = true;
    const fillMat = hoverFill.material as StandardMaterial;
    if (fillMat) fillMat.alpha = 0.35;
    hoverLabel.isVisible = true;

    if (!currentCenter || currentCenter.q !== cell.q || currentCenter.r !== cell.r) {
        currentCenter = { q: cell.q, r: cell.r };
        currentRadius = parseRadiusCap();
        renderGrid(cell.q, cell.r, currentRadius, s);
    } else if (gridLines) {
        gridLines.setEnabled(true);
    }
}

function describeCell(cell: HexCell): string {
    return `ID ${cell.id} · key ${cell.key} · q${cell.q} r${cell.r} · xyz(${cell.x}, ${cell.y}, ${cell.z}) · dist ${cell.distance}`;
}

function setupPointerHandling(s: Scene): void {
    const plane = new Plane(0, 1, 0, 0);
    const KEY_PAN_SPEED = 0.8;
    const keysDown = new Set<string>();

    s.onPointerObservable.add((pointerInfo: PointerInfo) => {
        if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
            const cam = s.activeCamera as ArcRotateCamera;
            const ray = s.createPickingRay(s.pointerX, s.pointerY, Matrix.Identity(), cam);
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
            infoPanel.textContent = "Hover a hex to see details.";
        }
    });

    const handleKeyPan = (dtMs: number) => {
        if (!scene || !scene.activeCamera) return;
        const cam = scene.activeCamera as ArcRotateCamera;
        const forward = cam.getDirection(Axis.Z);
        const right = cam.getDirection(Axis.X);
        forward.y = 0;
        right.y = 0;
        forward.normalize();
        right.normalize();

        let dx = 0;
        let dz = 0;
        if (keysDown.has("ArrowLeft") || keysDown.has("a")) dx -= 1;
        if (keysDown.has("ArrowRight") || keysDown.has("d")) dx += 1;
        if (keysDown.has("ArrowUp") || keysDown.has("w")) dz -= 1;
        if (keysDown.has("ArrowDown") || keysDown.has("s")) dz += 1;
        if (dx === 0 && dz === 0) return;

        const dt = dtMs / 1000;
        const scale = KEY_PAN_SPEED * (cam.radius || 1) * dt;
        const offset = right.scale(dx * scale).add(forward.scale(-dz * scale));
        cam.target.addInPlace(offset);
        const len = cam.target.length();
        if (len > maxPanRange) {
            cam.target.scaleInPlace(maxPanRange / len);
        }
    };

    let lastFrame = performance.now();
    const keyLoop = () => {
        const now = performance.now();
        const dt = now - lastFrame;
        lastFrame = now;
        handleKeyPan(dt);
        requestAnimationFrame(keyLoop);
    };
    keyLoop();

    window.addEventListener("keydown", (e) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "w", "a", "s", "d"].includes(e.key)) {
            e.preventDefault();
            keysDown.add(e.key);
        }
    });
    window.addEventListener("keyup", (e) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "w", "a", "s", "d"].includes(e.key)) {
            e.preventDefault();
            keysDown.delete(e.key);
        }
    });

    canvas.addEventListener("mouseleave", () => {
        setHover(null, s);
        infoPanel.textContent = "Hover a hex to see details.";
    });

    // Edge scrolling (auto-pan when the cursor is near the viewport edges).
    const EDGE_PX = 32;
    const PAN_SPEED = 0.0008;
    const clampTarget = (cam: ArcRotateCamera) => {
        const len = cam.target.length();
        if (len > maxPanRange) {
            cam.target.scaleInPlace(maxPanRange / len);
        }
    };
    const loop = () => {
        if (!edgeScrollActive || !scene || !scene.activeCamera) return;
        const cam = scene.activeCamera as ArcRotateCamera;
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
            const forward = cam.getDirection(Axis.Z);
            const right = cam.getDirection(Axis.X);
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

function ensureScene(): Scene {
    if (scene) return scene;

    scene = new Scene(engine as Engine);
    scene.clearColor = new Color4(0.02, 0.04, 0.08, 1);
    glowLayer = new GlowLayer("hex-glow", scene, { blurKernelSize: 32 });
    glowLayer.intensity = 0.9;
    // Edge fog to fade distant cells.
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.005;
    scene.fogColor = new Color3(0.02, 0.04, 0.08);

    const camera = new ArcRotateCamera(
        "hex-cam",
        Math.PI / 2,
        Math.PI / 3.2, // more top-down
        80,
        Vector3.Zero(),
        scene
    );
    camera.lowerRadiusLimit = 18;
    camera.upperRadiusLimit = 120;
    camera.wheelDeltaPercentage = -0.01; // invert scroll direction
    camera.panningSensibility = 850; // enable smooth panning
    camera.panningAxis = new Vector3(1, 0, 1); // lock panning to the grid plane (no vertical component)
    camera.lowerBetaLimit = 0.65; // keep some pitch but avoid top-down lock
    camera.upperBetaLimit = Math.PI / 2.05; // prevent rotating below the grid plane
    camera.allowUpsideDown = false;
    const kb = (camera.inputs.attached as any).keyboard;
    if (kb) {
        kb.keysUp = [];
        kb.keysDown = [];
        kb.keysLeft = [];
        kb.keysRight = [];
    }
    camera.attachControl(canvas, true);

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
    light.intensity = 0.7;
    light.groundColor = new Color3(0.04, 0.07, 0.12);

    // Use the same starfield helper as the main page (defaults match main view).
    createStarfield(scene);
    // Keep starfield crisp by disabling fog on star meshes.
    scene.meshes
        .filter((m) => m.name.startsWith("star"))
        .forEach((m) => {
            m.applyFog = false;
        });

    if (!nebulaCreated) {
        // Soft, distant nebula below the grid to give regional mood.
        createNebula(scene, {
            seed: 4242,
            color: new Color3(0.45, 0.72, 1.0),
            alpha: 0.45,
            y: -220,
            size: 6000,
            scale: 1.4,
            rotationSpeed: 0.0000015,
            name: "hex-nebula",
        });
        nebulaCreated = true;
    }

    if (!systemStarCreated) {
        createSystemStar(scene, {
            color: new Color3(1.0, 0.86, 0.58),
            intensity: 2.6,
            size: 420,
            position: new Vector3(-900, -520, -2600),
            name: "hex-system-star",
        });
        systemStarCreated = true;
    }

    setupPointerHandling(scene);
    ensureHoverMeshes(scene);
    return scene;
}

function ensureHoverMeshes(s: Scene): void {
    if (hoverLine && hoverFill && hoverLabel) return;

    const hexPoints: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
        const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
        hexPoints.push(new Vector3(Math.cos(angle) * HEX_SIZE, HEX_HEIGHT, Math.sin(angle) * HEX_SIZE));
    }

    hoverLine = MeshBuilder.CreateLines("hover-line", { points: hexPoints, updatable: false }, scene) as LinesMesh;
    hoverLine.color = hexToColor3(0xffffff);
    hoverLine.isVisible = false;
    hoverLine.isPickable = false;
    hoverLine.renderingGroupId = 3;
    glowLayer?.addIncludedOnlyMesh(hoverLine);

    hoverFill = MeshBuilder.CreateCylinder(
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
    const fillMat = new StandardMaterial("hover-fill-mat", scene);
    fillMat.diffuseColor = hexToColor3(0xaff3ff);
    fillMat.emissiveColor = hexToColor3(0xaff3ff).scale(0.8);
    fillMat.alpha = 0.0;
    fillMat.specularColor = Color3.Black();
    hoverFill.material = fillMat;
    hoverFill.isPickable = false;
    hoverFill.renderingGroupId = 2;
    hoverFill.isVisible = false;
    glowLayer?.addIncludedOnlyMesh(hoverFill);

    hoverLabel = createLabel("", s);
    hoverLabel.isVisible = false;
    hoverLabel.renderingGroupId = 4;
}

function renderGrid(centerQ: number, centerR: number, radius: number, s: Scene): void {
    const json = hex_window(centerQ, centerR, radius);
    const grid = JSON.parse(json) as HexGrid;

    const maxDist = Math.max(1, grid.radius);
    const polyPoints: Vector3[][] = [];
    const centerWorld = axialToWorld(centerQ, centerR);

    cellLookup.clear();
    grid.cells.forEach((cell) => {
        cellLookup.set(cell.key, cell);
        const center = axialToWorld(cell.q - centerQ, cell.r - centerR); // relative to center so we can move the mesh
        const loop: Vector3[] = [];
        for (let i = 0; i <= 6; i++) {
            const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
            loop.push(
                new Vector3(
                    center.x + Math.cos(angle) * HEX_SIZE,
                    HEX_HEIGHT,
                    center.z + Math.sin(angle) * HEX_SIZE
                )
            );
        }
        polyPoints.push(loop);
    });

    // If the radius hasn't changed, reuse the existing mesh and just move it.
    if (gridLines && (gridLines as any).metadata?.radius === radius) {
        gridLines.position = centerWorld;
        gridLines.setEnabled(true);
    } else {
        gridLines?.dispose(false, true);
        gridLines = null;
        gridLinesKind = null;

        const opts: any = {
            points: polyPoints,
            widths: [0.22, 0.22], // consistent stroke
        };

        const applyGridProps = (mesh: AbstractMesh) => {
            (mesh as any).isPickable = false;
            mesh.renderingGroupId = 1;
            (mesh as any).applyFog = true;
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.setEnabled(true);
            (mesh as any).metadata = { radius };
            mesh.position = centerWorld;
        };

        const created = CreateGreasedLine(`grid-${radius}`, opts, { color: new Color3(0.37, 0.82, 1), width: 0.22 }, s);
        gridLines = created || gridLines;
        gridLinesKind = "greased";
        if (gridLines) {
            applyGridProps(gridLines);
        }
    }

    // Always position to the hovered cell even when reusing geometry.
    if (gridLines) {
        gridLines.position = centerWorld;
    }

    const farAxial = axialToWorld(grid.radius, 0);
    const farDiag = axialToWorld(grid.radius, -grid.radius);
    const maxExtent = Math.max(farAxial.length(), farDiag.length(), HEX_SIZE * 2);
    maxPanRange = maxExtent * 0.8;
    infoPanel.textContent = `Center q${centerQ} r${centerR}, radius ${radius}, cells ${grid.cells.length}`;
}

function parseRadiusCap(): number {
    const parsed = parseInt(radiusInput.value, 10);
    if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_RADIUS;
    return Math.max(1, parsed);
}

async function updateWindowFromCamera(): Promise<void> {
    const s = ensureScene();
    ensureHoverMeshes(s);
    if (!currentCenter) {
        gridLines?.setEnabled(false);
        return;
    }
    currentRadius = parseRadiusCap();
    renderGrid(currentCenter.q, currentCenter.r, currentRadius, s);
}

async function run(): Promise<void> {
    await initWasm();
    ensureEngine();
    ensureScene();
    radiusInput.value = radiusInput.value || `${DEFAULT_RADIUS}`;
    currentRadius = parseRadiusCap();
    currentCenter = null; // wait for hover to render
}

rebuildBtn.addEventListener("click", () => {
    currentRadius = parseRadiusCap();
    updateWindowFromCamera();
});

radiusInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
        currentRadius = parseRadiusCap();
        updateWindowFromCamera();
    }
});

run();
