import * as BABYLON from "babylonjs";
import { bodyStyle, createOrbitLine, createPlanetMesh, createStarfield, hashString, OrbitalBody } from "./planet-helpers";

const canvas = document.getElementById("planetCanvas") as unknown as HTMLCanvasElement;
const scaleInput = document.getElementById("scale") as HTMLInputElement;
const scaleValue = document.getElementById("scaleValue") as HTMLSpanElement;
const regenBtn = document.getElementById("regen") as HTMLButtonElement;

const basePlanetConfigs: OrbitalBody[] = [
    { name: "Planetoid Prime", kind: "Planetoid", distance: 600 },
    { name: "Asteroid Belt", kind: "AsteroidBelt", distance: 300 },
    { name: "Moonlet", kind: "Moon", distance: 200 },
];

let engine: BABYLON.Engine | null = null;
let scene: BABYLON.Scene | null = null;
let camera: BABYLON.ArcRotateCamera | null = null;
let glowLayer: BABYLON.GlowLayer | null = null;
let planetRoot: BABYLON.TransformNode | null = null;
let orbitLines: BABYLON.LinesMesh[] = [];
let starMesh: BABYLON.Mesh | null = null;
let planetConfigs: OrbitalBody[] = [];
let planets: {
    root: BABYLON.TransformNode;
    mesh: BABYLON.AbstractMesh;
    ring?: BABYLON.AbstractMesh | null;
    shaderTime: number;
}[] = [];

function randomizeConfigs(): OrbitalBody[] {
    return basePlanetConfigs.map((cfg) => ({
        ...cfg,
        // tweak the name so palette/ring selection gets a new seed
        name: `${cfg.name} ${hashString(`${cfg.name}-${Math.random()}`) % 999}`,
    }));
}

function setupEngine(): void {
    if (engine) return;
    engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    engine.runRenderLoop(() => {
        if (scene) {
            scene.render();
        }
    });
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
}

function resizeCanvas(): void {
    if (!engine) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth * ratio;
    const height = canvas.clientHeight * ratio;
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    engine.resize();
}

function createScene(): void {
    if (scene) {
        scene.dispose();
    }

    scene = new BABYLON.Scene(engine);
    glowLayer = new BABYLON.GlowLayer("glow", scene, { blurKernelSize: 18 });
    glowLayer.intensity = 0.38;
    scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.07, 1);

    camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 2, Math.PI / 2.4, 60, BABYLON.Vector3.Zero(), scene);
    camera.attachControl(canvas, true);
    camera.lowerRadiusLimit = 18;
    camera.upperRadiusLimit = 140;
    camera.wheelDeltaPercentage = 0.01;
    camera.minZ = 0.5;

    const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
    light.intensity = 0.05;

    createStarfield(scene, {
        count: 3200,
        radius: 340,
        emissive: new BABYLON.Color3(1.35, 1.35, 1.3),
        scaleRange: [0.35, 1.25],
        tintVariance: true,
    });
    starMesh = createCenterStar(scene);

    planetRoot = new BABYLON.TransformNode("planet-root", scene);
    buildPlanets();

    scene.onBeforeRenderObservable.add(() => {
        const dt = scene.getEngine().getDeltaTime();
        planets.forEach((p) => {
            p.mesh.rotation.y += 0.0018 * dt;
            const mat = p.mesh.material;
            if (mat?.getClassName && mat.getClassName() === "ShaderMaterial") {
                p.shaderTime += dt * 0.001;
                // mat.setFloat("u_time", p.shaderTime);
            }
        });
    });
}

function clearPlanets(): void {
    planets.forEach((p) => {
        p.mesh.material?.dispose();
        p.mesh.dispose();
        p.ring?.dispose();
        p.root?.dispose();
    });
    orbitLines.forEach((o) => o.dispose());
    orbitLines = [];
    planets = [];
}

function buildPlanets(): void {
    clearPlanets();
    if (!scene || !planetRoot) return;

    const maxDistance = planetConfigs.reduce((m, c) => Math.max(m, c.distance || 1), 1);
    const orbitBase = 10;
    const orbitRoom = 18;

    planetConfigs.forEach((cfg, idx) => {
        const angle = (idx / planetConfigs.length) * Math.PI * 2;
        const radius = orbitBase + ((cfg.distance || (idx + 1) * 100) / maxDistance) * orbitRoom;
        const orbit = createOrbitLine(radius, scene, { alpha: 0.18 });
        orbit.parent = planetRoot;
        orbitLines.push(orbit);

        const style = bodyStyle({ ...cfg, hazards: [] }, cfg.distance);
        const { root, mesh, ring } = createPlanetMesh(cfg, style, scene);
        root.parent = planetRoot;
        root.position = new BABYLON.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        mesh.rotation.x = 0.25;
        mesh.rotation.z = 0.12;
        planets.push({ root, mesh, ring, shaderTime: 0 });
    });

    applyScale(parseFloat(scaleInput.value));
}

function applyScale(scale: number): void {
    if (planetRoot) {
        planetRoot.scaling = new BABYLON.Vector3(scale, scale, scale);
    }
    scaleValue.textContent = `${scale.toFixed(1)}x`;
}

scaleInput.addEventListener("input", () => {
    applyScale(parseFloat(scaleInput.value));
});

regenBtn.addEventListener("click", () => {
    planetConfigs = randomizeConfigs();
    buildPlanets();
});

function createCenterStar(s: BABYLON.Scene): BABYLON.Mesh {
    const star = BABYLON.MeshBuilder.CreateSphere("center-star", { diameter: 6 }, s);
    const mat = new BABYLON.StandardMaterial("center-star-mat", s);
    mat.emissiveColor = new BABYLON.Color3(1.2, 1, 0.78);
    mat.diffuseColor = mat.emissiveColor;
    mat.specularColor = new BABYLON.Color3(1, 0.88, 0.7);
    mat.alpha = 0.99;
    star.material = mat;
    const light = new BABYLON.PointLight("center-star-light", BABYLON.Vector3.Zero(), s);
    light.diffuse = mat.emissiveColor;
    light.specular = mat.specularColor;
    light.intensity = 0.55;
    light.range = 140;
    glowLayer?.addIncludedOnlyMesh(star);
    return star;
}

function init(): void {
    setupEngine();
    planetConfigs = randomizeConfigs();
    createScene();
    applyScale(parseFloat(scaleInput.value));
}

init();
