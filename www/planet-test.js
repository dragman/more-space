import * as BABYLON from "babylonjs";
import { bodyStyle, createPlanetMesh, hashString } from "./planet-helpers.js";

const canvas = document.getElementById("planetCanvas");
const scaleInput = document.getElementById("scale");
const scaleValue = document.getElementById("scaleValue");
const regenBtn = document.getElementById("regen");

const basePlanetConfigs = [
  { name: "Planetoid Prime", kind: "Planetoid", distance: 600 },
  { name: "Asteroid Belt", kind: "AsteroidBelt", distance: 300 },
  { name: "Moonlet", kind: "Moon", distance: 200 },
];

let engine = null;
let scene = null;
let camera = null;
let planetRoot = null;
let planetConfigs = [];
let planets = [];

function randomizeConfigs() {
  return basePlanetConfigs.map((cfg) => ({
    ...cfg,
    // tweak the name so palette/ring selection gets a new seed
    name: `${cfg.name} ${hashString(`${cfg.name}-${Math.random()}`) % 999}`,
  }));
}

function setupEngine() {
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

function resizeCanvas() {
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

function createScene() {
  if (scene) {
    scene.dispose();
  }

  scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.02, 0.04, 0.07, 1);

  camera = new BABYLON.ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.4,
    60,
    BABYLON.Vector3.Zero(),
    scene
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 18;
  camera.upperRadiusLimit = 140;
  camera.wheelDeltaPercentage = 0.01;
  camera.minZ = 0.5;

  // const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
  // light.intensity = 0.0;

  planetRoot = new BABYLON.TransformNode("planet-root", scene);
  buildPlanets();

  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime();
    planets.forEach((p) => {
      p.mesh.rotation.y += 0.0018 * dt;
      const mat = p.mesh.material;
      if (mat?.getClassName && mat.getClassName() === "ShaderMaterial") {
        p.shaderTime += dt * 0.001;
        mat.setFloat("u_time", p.shaderTime);
      }
    });
  });
}

function clearPlanets() {
  planets.forEach((p) => {
    p.mesh.material?.dispose();
    p.mesh.dispose();
    p.ring?.dispose();
    p.root?.dispose();
  });
  planets = [];
}

function buildPlanets() {
  clearPlanets();
  if (!scene || !planetRoot) return;

  const width = 60;
  const spacing = width / (planetConfigs.length + 1);

  planetConfigs.forEach((cfg, idx) => {
    const style = bodyStyle({ ...cfg, hazards: [] }, cfg.distance);
    const { root, mesh, ring } = createPlanetMesh(cfg, style, scene);
    root.parent = planetRoot;
    root.position = new BABYLON.Vector3(-width / 2 + spacing * (idx + 1), 0, 0);
    mesh.rotation.x = 0.25;
    mesh.rotation.z = 0.12;
    planets.push({ root, mesh, ring, shaderTime: 0 });
  });

  applyScale(parseFloat(scaleInput.value));
}

function applyScale(scale) {
  if (planetRoot) {
    planetRoot.scaling = new BABYLON.Vector3(scale, scale, scale);
  }
  scaleValue.textContent = `${scale.toFixed(1)}x`;
}

scaleInput.addEventListener("input", (e) => {
  applyScale(parseFloat(e.target.value));
});

regenBtn.addEventListener("click", () => {
  planetConfigs = randomizeConfigs();
  buildPlanets();
});

function init() {
  setupEngine();
  planetConfigs = randomizeConfigs();
  createScene();
  applyScale(parseFloat(scaleInput.value));
}

init();
