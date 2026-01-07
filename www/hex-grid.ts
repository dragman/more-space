import {
    AbstractMesh,
    ArcRotateCamera,
    Axis,
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
} from "@babylonjs/core";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import "@babylonjs/inspector";
import initWasm, { hex_window } from "../pkg/more_space.js";
import { createNebula, createStarfield, createSystemStar, hexToColor3 } from "./planet-helpers";

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

const app = {
    engine: null as Engine | null,
    scene: null as Scene | null,
    hoverLine: null as LinesMesh | null,
    hoverFill: null as Mesh | null,
    hoverLabel: null as Mesh | null,
    glowLayer: null as GlowLayer | null,
    edgeScrollActive: false,
    edgeScrollTimer: null as number | null,
    maxPanRange: 0,
    gridLines: null as AbstractMesh | null,
    currentCenter: null as { q: number; r: number } | null,
    currentRadius: DEFAULT_RADIUS,
    nebulaCreated: false,
    systemStarCreated: false,
};

function ensureEngine(): void {
    if (app.engine) return;
    app.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    window.addEventListener("resize", () => app.engine?.resize());
    app.engine.runRenderLoop(() => {
        app.scene?.render();
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
    if (!app.hoverLine || !app.hoverFill || !app.hoverLabel) return;
    if (!cell) {
        app.hoverLine.isVisible = false;
        app.hoverFill.isVisible = false;
        app.hoverLabel.isVisible = false;
        const fillMat = app.hoverFill.material as StandardMaterial;
        if (fillMat) fillMat.alpha = 0.0;
        if (app.gridLines) {
            app.gridLines.setEnabled(false);
        }
        infoPanel.textContent = "Hover a hex to see details.";
        return;
    }

    const center = axialToWorld(cell.q, cell.r);
    app.hoverLine.position = center;
    app.hoverFill.position = center.add(new Vector3(0, HEX_HEIGHT * 0.4, 0));
    app.hoverLabel.position = center.add(new Vector3(0, HEX_HEIGHT * 2, 0));

    const mat = app.hoverLabel.material as StandardMaterial;
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
    app.hoverLine.isVisible = true;
    app.hoverFill.isVisible = true;
    const fillMat = app.hoverFill.material as StandardMaterial;
    if (fillMat) fillMat.alpha = 0.35;
    app.hoverLabel.isVisible = true;

    if (!app.currentCenter || app.currentCenter.q !== cell.q || app.currentCenter.r !== cell.r) {
        app.currentCenter = { q: cell.q, r: cell.r };
        app.currentRadius = parseRadiusCap();
        renderGrid(cell.q, cell.r, app.currentRadius, s);
    } else if (app.gridLines) {
        app.gridLines.setEnabled(true);
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
        if (!app.scene || !app.scene.activeCamera) return;
        const cam = app.scene.activeCamera as ArcRotateCamera;
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
        if (len > app.maxPanRange) {
            cam.target.scaleInPlace(app.maxPanRange / len);
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
        if (len > app.maxPanRange) {
            cam.target.scaleInPlace(app.maxPanRange / len);
        }
    };
    const loop = () => {
        if (!app.edgeScrollActive || !app.scene || !app.scene.activeCamera) return;
        const cam = app.scene.activeCamera as ArcRotateCamera;
        const rect = canvas.getBoundingClientRect();
        const x = app.scene.pointerX;
        const y = app.scene.pointerY;
        let dx = 0;
        let dz = 0;
        if (x < EDGE_PX) dx = -1;
        else if (x > rect.width - EDGE_PX) dx = 1;
        if (y < EDGE_PX) dz = -1;
        else if (y > rect.height - EDGE_PX) dz = 1;

        if (dx !== 0 || dz !== 0) {
            const dt = app.scene.getEngine().getDeltaTime();
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
        app.edgeScrollTimer = requestAnimationFrame(loop) as unknown as number;
    };

    canvas.addEventListener("mouseenter", () => {
        app.edgeScrollActive = true;
        if (app.edgeScrollTimer === null) {
            app.edgeScrollTimer = requestAnimationFrame(loop) as unknown as number;
        }
    });
    canvas.addEventListener("mouseleave", () => {
        app.edgeScrollActive = false;
        if (app.edgeScrollTimer !== null) {
            cancelAnimationFrame(app.edgeScrollTimer);
            app.edgeScrollTimer = null;
        }
    });
}

function ensureScene(): Scene {
    if (app.scene) return app.scene;

    app.scene = new Scene(app.engine as Engine);
    // app.scene.debugLayer.show({
    //     embedMode: true,
    // });
    app.scene.clearColor = new Color4(0.02, 0.04, 0.08, 1);
    app.glowLayer = new GlowLayer("hex-glow", app.scene, { blurKernelSize: 32 });
    app.glowLayer.intensity = 0.1;
    // Edge fog to fade distant cells.
    app.scene.fogMode = Scene.FOGMODE_EXP2;
    app.scene.fogDensity = 0.0005;
    app.scene.fogColor = new Color3(0.02, 0.04, 0.08);
    app.scene.fogStart = 2000;

    const camera = new ArcRotateCamera(
        "hex-cam",
        Math.PI / 2,
        Math.PI / 3.2, // more top-down
        80,
        Vector3.Zero(),
        app.scene
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

    const light = new HemisphericLight("light", new Vector3(0, 1, 0), app.scene);
    light.intensity = 0.7;
    light.groundColor = new Color3(0.04, 0.07, 0.12);

    // Single starfield with damped parallax so the distant system star feels consistent.
    createStarfield(app.scene, {
        baseName: "starfield",
        radius: 8400,
        count: 10000,
        scaleRange: [2.2, 10.6],
        tintVariance: true,
    });

    if (!app.nebulaCreated) {
        // Soft, distant nebula below the grid to give regional mood.
        createNebula(app.scene, {
            seed: 4242,
            color: new Color3(0.45, 0.72, 1.0),
            alpha: 0.45,
            y: -220,
            size: 6000,
            scale: 1.4,
            rotationSpeed: 0.0000015,
            name: "hex-nebula",
        });
        app.nebulaCreated = true;
    }

    if (!app.systemStarCreated) {
        createSystemStar(app.scene, {
            color: new Color3(1.0, 0.56, 0.58),
            intensity: 2.6,
            size: 420,
            position: new Vector3(-900, -520, -2600),
            name: "hex-system-star",
        });
        app.systemStarCreated = true;
    }

    setupPointerHandling(app.scene);
    ensureHoverMeshes(app.scene);
    return app.scene;
}

function ensureHoverMeshes(s: Scene): void {
    if (app.hoverLine && app.hoverFill && app.hoverLabel) return;

    const hexPoints: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
        const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
        hexPoints.push(new Vector3(Math.cos(angle) * HEX_SIZE, HEX_HEIGHT, Math.sin(angle) * HEX_SIZE));
    }

    app.hoverLine = MeshBuilder.CreateLines(
        "hover-line",
        { points: hexPoints, updatable: false },
        app.scene
    ) as LinesMesh;
    app.hoverLine.color = hexToColor3(0xffffff);
    app.hoverLine.isVisible = false;
    app.hoverLine.isPickable = false;
    app.hoverLine.renderingGroupId = 3;
    app.glowLayer?.addIncludedOnlyMesh(app.hoverLine);

    app.hoverFill = MeshBuilder.CreateCylinder(
        "hover-fill",
        {
            height: HEX_HEIGHT * 0.6,
            tessellation: 6,
            diameterTop: HEX_SIZE * 1.9,
            diameterBottom: HEX_SIZE * 1.9,
        },
        app.scene
    );
    app.hoverFill.rotation.y = Math.PI / 6;
    const fillMat = new StandardMaterial("hover-fill-mat", app.scene);
    fillMat.diffuseColor = hexToColor3(0xaff3ff);
    fillMat.emissiveColor = hexToColor3(0xaff3ff).scale(0.8);
    fillMat.alpha = 0.0;
    fillMat.specularColor = Color3.Black();
    app.hoverFill.material = fillMat;
    app.hoverFill.isPickable = false;
    app.hoverFill.renderingGroupId = 2;
    app.hoverFill.isVisible = false;
    app.glowLayer?.addIncludedOnlyMesh(app.hoverFill);

    app.hoverLabel = createLabel("", s);
    app.hoverLabel.isVisible = false;
    app.hoverLabel.renderingGroupId = 4;
}

function renderGrid(centerQ: number, centerR: number, radius: number, s: Scene): void {
    const json = hex_window(centerQ, centerR, radius);
    const grid = JSON.parse(json) as HexGrid;

    const polyPoints: Vector3[][] = [];
    const centerWorld = axialToWorld(centerQ, centerR);

    grid.cells.forEach((cell) => {
        const center = axialToWorld(cell.q - centerQ, cell.r - centerR); // relative to center so we can move the mesh
        const loop: Vector3[] = [];
        for (let i = 0; i <= 6; i++) {
            const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
            loop.push(
                new Vector3(center.x + Math.cos(angle) * HEX_SIZE, HEX_HEIGHT, center.z + Math.sin(angle) * HEX_SIZE)
            );
        }
        polyPoints.push(loop);
    });

    // If the radius hasn't changed, reuse the existing mesh and just move it.
    if (app.gridLines && (app.gridLines as any).metadata?.radius === radius) {
        app.gridLines.position = centerWorld;
        app.gridLines.setEnabled(true);
    } else {
        app.gridLines?.dispose(false, true);
        app.gridLines = null;

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
        app.gridLines = created || app.gridLines;
        if (app.gridLines) {
            applyGridProps(app.gridLines);
        }
    }

    // Always position to the hovered cell even when reusing geometry.
    if (app.gridLines) {
        app.gridLines.position = centerWorld;
    }

    const farAxial = axialToWorld(grid.radius, 0);
    const farDiag = axialToWorld(grid.radius, -grid.radius);
    const maxExtent = Math.max(farAxial.length(), farDiag.length(), HEX_SIZE * 2);
    app.maxPanRange = maxExtent * 0.8;
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
    if (!app.currentCenter) {
        app.gridLines?.setEnabled(false);
        return;
    }
    app.currentRadius = parseRadiusCap();
    renderGrid(app.currentCenter.q, app.currentCenter.r, app.currentRadius, s);
}

async function run(): Promise<void> {
    await initWasm();
    ensureEngine();
    ensureScene();
    radiusInput.value = radiusInput.value || `${DEFAULT_RADIUS}`;
    app.currentRadius = parseRadiusCap();
    app.currentCenter = null; // wait for hover to render
}

rebuildBtn.addEventListener("click", () => {
    app.currentRadius = parseRadiusCap();
    updateWindowFromCamera();
});

radiusInput.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
        app.currentRadius = parseRadiusCap();
        updateWindowFromCamera();
    }
});

run();
