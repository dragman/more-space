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
}

export function randomUnitVector(): Vector3 {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const x = Math.sin(phi) * Math.cos(theta);
    const y = Math.sin(phi) * Math.sin(theta);
    const z = Math.cos(phi);
    return new Vector3(x, y, z);
}
