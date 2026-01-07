import {
    Color3,
    Color4,
    InstancedMesh,
    LinesMesh,
    Mesh,
    MeshBuilder,
    Scene,
    StandardMaterial,
    TransformNode,
    Vector3,
    Texture,
    DynamicTexture,
} from "@babylonjs/core";
import { createPlanetMaterial } from "./planet-shader";

export const PLANET_SCALE = 0.25;

export type OrbitLineOptions = {
    color?: Color3;
    alpha?: number;
    segments?: number;
};

export type StarfieldOptions = {
    count?: number;
    radius?: number;
    baseName?: string;
    emissive?: Color3;
    scaleRange?: [number, number];
    tintVariance?: boolean;
    lockToCamera?: boolean; // if true, stars follow camera target for zero parallax
};

export type NebulaOptions = {
    seed?: number;
    color?: Color3;
    alpha?: number;
    size?: number;
    y?: number;
    scale?: number;
    speed?: number; // legacy (kept for compatibility)
    rotationSpeed?: number;
    name?: string;
};

export type SystemStarOptions = {
    color?: Color3;
    intensity?: number;
    size?: number;
    position?: Vector3;
    name?: string;
};

export type OrbitalBody = {
    name: string;
    kind: string;
    hazards?: { kind: string }[];
    distance?: number;
};

export type BodyStyle = {
    kindId: number;
    baseColor: number;
    highlightColor: number;
    radius: number;
    ring: { color: number } | null;
    outline: number;
};

export type PlanetMesh = {
    root: TransformNode;
    mesh: Mesh;
    ring: Mesh | null;
};

export function hashString(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 131 + name.charCodeAt(i)) >>> 0;
    }
    return h;
}

export function hexToColor3(hex: number): Color3 {
    return new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

export function bodyStyle(orb: OrbitalBody, distance: number): BodyStyle {
    const hasHazard = orb.hazards && orb.hazards.length > 0;
    const h = hashString(orb.name);
    const palette = [
        { base: 0x4fa3ff, highlight: 0xa6d4ff },
        { base: 0xffb347, highlight: 0xffdfba },
        { base: 0x7bd389, highlight: 0xc5f5c3 },
        { base: 0xc9b6ff, highlight: 0xffffff },
        { base: 0x9e7a5f, highlight: 0xe6c9a8 },
    ];
    const pick = palette[h % palette.length];
    switch (orb.kind) {
        case "Planetoid":
            return {
                kindId: 0,
                baseColor: pick.base,
                highlightColor: pick.highlight,
                radius: (distance > 700 ? 11 : 9) * PLANET_SCALE,
                ring: h % 4 === 0 ? { color: 0xa79c8a } : null,
                outline: hasHazard ? 0xff6b6b : 0x0a0d1c,
            };
        case "AsteroidBelt":
            return {
                kindId: 2,
                baseColor: 0x6a5d4d,
                highlightColor: 0xb79d7a,
                radius: 8 * PLANET_SCALE,
                ring: null,
                outline: hasHazard ? 0xffd166 : 0x0a0d1c,
            };
        case "Moon":
        default:
            return {
                kindId: 1,
                baseColor: 0xcacfd6,
                highlightColor: 0xffffff,
                radius: 7 * PLANET_SCALE,
                ring: null,
                outline: hasHazard ? 0xff6b6b : 0x0a0d1c,
            };
    }
}

export function createPlanetMesh(orb: OrbitalBody, style: BodyStyle, s: Scene): PlanetMesh {
    const root = new TransformNode(`planet-root-${orb.name}`, s);

    const planet = MeshBuilder.CreateSphere(`planet-${orb.name}`, { diameter: style.radius * 2 }, s);
    const mat = createPlanetMaterial(s, style, hashString(orb.name));
    planet.material = mat;
    planet.isPickable = true;
    planet.parent = root;

    let ring: Mesh | null = null;
    if (style.ring) {
        ring = MeshBuilder.CreateTorus(
            `ring-${orb.name}`,
            {
                diameter: style.radius * 3.8,
                thickness: style.radius * 0.14,
                tessellation: 64,
            },
            s
        );
        const ringMat = new StandardMaterial(`ringMat-${orb.name}`, s);
        ringMat.diffuseColor = hexToColor3(style.ring.color);
        ringMat.emissiveColor = hexToColor3(style.ring.color).scale(0.5);
        ringMat.specularColor = new Color3(0.12, 0.12, 0.12);
        ringMat.alpha = 0.85;
        ringMat.backFaceCulling = false;
        ring.material = ringMat;
        ring.rotation.x = Math.PI / 2;
        ring.parent = root;
        ring.isPickable = false;
    }

    return { root, mesh: planet, ring };
}

export function createOrbitLine(radius: number, s: Scene, opts: OrbitLineOptions = {}): LinesMesh {
    const points = [];
    const segments = opts.segments ?? 90;
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        points.push(new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
    }
    const line = MeshBuilder.CreateLines("orbit", { points }, s);
    line.color = opts.color ?? new Color3(0.37, 0.82, 1);
    line.alpha = opts.alpha ?? 0.12;
    line.isPickable = false;
    return line;
}

export function createStarfield(scene: Scene, opts: StarfieldOptions = {}): void {
    const count = opts.count ?? 5000;
    const radius = opts.radius ?? 650;
    const emissive = opts.emissive ?? new Color3(1, 1, 1);
    const scaleRange = opts.scaleRange ?? [0.5, 1.3];
    const baseName = opts.baseName ?? "star";

    const starMaterial = new StandardMaterial(`${baseName}-mat`, scene);
    starMaterial.emissiveColor = emissive;
    starMaterial.disableLighting = true;
    const base = MeshBuilder.CreateSphere(`${baseName}-base`, { diameter: 1 }, scene);
    base.material = starMaterial;
    base.isPickable = false;
    base.setEnabled(false);

    const [minScale, maxScale] = scaleRange;
    for (let i = 0; i < count; i++) {
        const inst = base.createInstance(`${baseName}-${i}`);
        const dir = randomUnitVector();
        inst.position = dir.scale(radius * (0.6 + Math.random() * 0.4));
        inst.scaling.scaleInPlace(minScale + Math.random() * (maxScale - minScale));
        if (opts.tintVariance) {
            const sparkle = 0.65 + Math.random() * 0.9;
            const tint = 0.95 + Math.random() * 0.1;
            const instanced = inst as InstancedMesh & { color?: Color4 };
            instanced.color = new Color4(sparkle, tint, 1, 1);
        }
        inst.isPickable = false;
    }

    if (opts.lockToCamera && scene.activeCamera) {
        const baseTarget = scene.activeCamera.target.clone();
        scene.onBeforeRenderObservable.add(() => {
            const cam = scene.activeCamera;
            if (!cam) return;
            const delta = cam.target.subtract(baseTarget);
            scene.meshes
                .filter((m) => m.name.startsWith(baseName))
                .forEach((m) => {
                    m.position.subtractInPlace(delta.scale(0.9)); // dampened follow to reduce parallax
                });
            baseTarget.copyFrom(cam.target);
        });
    }
}

export function randomUnitVector(): Vector3 {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.sin(phi) * Math.sin(theta);
    const z = Math.cos(phi);
    return new Vector3(x, y, z);
}

// Simple seeded PRNG for repeatable nebula noise.
function mulberry32(seed: number): () => number {
    return () => {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function fractalNoise2D(x: number, y: number): number {
    // Basic value noise with 3 octaves for a cloudy look.
    const hash = (ix: number, iy: number) => {
        const n = ix * 374761393 + iy * 668265263;
        let t = (n ^ (n << 13)) * 1274126177;
        t = (t ^ (t >> 16)) >>> 0;
        return (t / 0xffffffff - 0.5) * 2; // [-1,1]
    };
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < 3; o++) {
        const sx = Math.floor(x * freq);
        const sy = Math.floor(y * freq);
        const fx = x * freq - sx;
        const fy = y * freq - sy;
        const h00 = hash(sx, sy);
        const h10 = hash(sx + 1, sy);
        const h01 = hash(sx, sy + 1);
        const h11 = hash(sx + 1, sy + 1);
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
        const nx0 = lerp(h00, h10, fx);
        const nx1 = lerp(h01, h11, fx);
        const nxy = lerp(nx0, nx1, fy);
        sum += nxy * amp;
        norm += amp;
        amp *= 0.55;
        freq *= 2.3;
    }
    return sum / norm; // ~[-1,1]
}

export function createNebula(scene: Scene, opts: NebulaOptions = {}): Mesh {
    const seed = opts.seed ?? 1337;
    const rng = mulberry32(seed);
    const base = opts.color ?? new Color3(0.55, 0.8, 1.0);
    const hueJitter = rng() * 0.25 - 0.125;
    const satJitter = rng() * 0.25 - 0.125;
    const color = new Color3(
        Math.min(1, Math.max(0, base.r + hueJitter)),
        Math.min(1, Math.max(0, base.g + satJitter)),
        Math.min(1, Math.max(0, base.b + satJitter * 0.8))
    );
    const alpha = opts.alpha ?? 0.6;
    const size = opts.size ?? 6000;
    const y = opts.y ?? -180;
    const scale = opts.scale ?? 1.4;
    const speed = opts.speed ?? 0.00001; // kept for compatibility, not used
    const rotationSpeed = opts.rotationSpeed ?? 0.0000025;
    const name = opts.name ?? "nebula";

    const texSize = 512;
    const tex = new StandardMaterial(`${name}-mat`, scene);
    const noiseTex = new DynamicTexture(`${name}-tex`, texSize, scene, false);
    const ctx = noiseTex.getContext();
    if (!ctx) {
        const fallback = MeshBuilder.CreatePlane(name, { size, sideOrientation: Mesh.DOUBLESIDE }, scene);
        fallback.position.y = y;
        fallback.rotation.x = Math.PI / 2;
        fallback.isPickable = false;
        fallback.applyFog = true;
        return fallback;
    }
    const texRng = mulberry32(seed ^ 0x9e3779b1);
    const img = new ImageData(texSize, texSize);
    const offsX = rng() * 1000;
    const offsY = rng() * 1000;
    for (let yPix = 0; yPix < texSize; yPix++) {
        for (let xPix = 0; xPix < texSize; xPix++) {
            const nx = xPix / texSize;
            const ny = yPix / texSize;
            const n = fractalNoise2D(nx * 4 + offsX, ny * 4 + offsY) * 0.5 + 0.5;
            const radial = Math.sqrt(Math.pow(nx - 0.5, 2) + Math.pow(ny - 0.5, 2));
            const edgeFade = Math.pow(Math.max(0, 1 - radial * 1.6), 3); // kill square seams by fading edges
            const c = Math.max(0, Math.min(1, n * edgeFade));
            const idx = (yPix * texSize + xPix) * 4;
            img.data[idx] = color.r * 255 * c;
            img.data[idx + 1] = color.g * 255 * c;
            img.data[idx + 2] = color.b * 255 * c;
            img.data[idx + 3] = c * 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    noiseTex.hasAlpha = true;
    noiseTex.update(false);
    noiseTex.wrapU = Texture.CLAMP_ADDRESSMODE;
    noiseTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    noiseTex.uScale = scale;
    noiseTex.vScale = scale;

    tex.diffuseColor = Color3.Black();
    tex.emissiveTexture = noiseTex as any;
    tex.emissiveColor = color.scale(1.1);
    tex.alpha = alpha;
    tex.alphaMode = 2; // additive to keep it visible through fog
    tex.disableLighting = true;
    tex.backFaceCulling = false;
    tex.useAlphaFromDiffuseTexture = false;
    tex.opacityTexture = noiseTex as any;
    tex.specularColor = new Color3(0, 0, 0);

    const plane = MeshBuilder.CreatePlane(
        name,
        { size, sideOrientation: Mesh.DOUBLESIDE },
        scene
    );
    plane.material = tex;
    plane.position.y = y;
    plane.rotation.x = Math.PI / 2;
    plane.isPickable = false;
    plane.applyFog = false;

    scene.onBeforeRenderObservable.add(() => {
        const dt = scene.getEngine().getDeltaTime();
        noiseTex.wAng += rotationSpeed * dt;
    });

    return plane;
}

export function createSystemStar(scene: Scene, opts: SystemStarOptions = {}): Mesh {
    const color = opts.color ?? new Color3(1.0, 0.82, 0.55);
    const intensity = opts.intensity ?? 2.2;
    const size = opts.size ?? 380;
    const name = opts.name ?? "system-star";
    const pos =
        opts.position ??
        new Vector3(0, -420, -1800); // behind and below the grid so it feels distant

    const mat = new StandardMaterial(`${name}-mat`, scene);
    mat.disableLighting = true;
    mat.emissiveColor = color.scale(intensity);
    mat.alpha = 0.95;
    mat.backFaceCulling = false;
    mat.specularColor = new Color3(0, 0, 0);

    const star = MeshBuilder.CreateSphere(name, { diameter: size, segments: 24 }, scene);
    star.material = mat;
    star.position = pos;
    star.isPickable = false;
    star.applyFog = false; // keep it bright

    // Optional billboard-ish glow: slight scaling with camera distance could be added later.
    return star;
}
