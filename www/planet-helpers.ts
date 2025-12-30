import * as BABYLON from "babylonjs";
import { createPlanetMaterial } from "./planet-shader";

export const PLANET_SCALE = 0.25;

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
  root: BABYLON.TransformNode;
  mesh: BABYLON.Mesh;
  ring: BABYLON.Mesh | null;
};

export function hashString(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 131 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function hexToColor3(hex: number) {
  return new BABYLON.Color3(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255
  );
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

export function createPlanetMesh(
  orb: OrbitalBody,
  style: BodyStyle,
  s: BABYLON.Scene
): PlanetMesh {
  const root = new BABYLON.TransformNode(`planet-root-${orb.name}`, s);

  const planet = BABYLON.MeshBuilder.CreateSphere(
    `planet-${orb.name}`,
    { diameter: style.radius * 2 },
    s
  );
  const mat = createPlanetMaterial(s, style, hashString(orb.name));
  planet.material = mat;
  planet.isPickable = true;
  planet.parent = root;

  let ring: BABYLON.Mesh | null = null;
  if (style.ring) {
    ring = BABYLON.MeshBuilder.CreateTorus(
      `ring-${orb.name}`,
      {
        diameter: style.radius * 3.8,
        thickness: style.radius * 0.14,
        tessellation: 64,
      },
      s
    );
    const ringMat = new BABYLON.StandardMaterial(`ringMat-${orb.name}`, s);
    ringMat.diffuseColor = hexToColor3(style.ring.color);
    ringMat.emissiveColor = hexToColor3(style.ring.color).scale(0.5);
    ringMat.specularColor = new BABYLON.Color3(0.12, 0.12, 0.12);
    ringMat.alpha = 0.85;
    ringMat.backFaceCulling = false;
    ring.material = ringMat;
    ring.rotation.x = Math.PI / 2;
    ring.parent = root;
    ring.isPickable = false;
  }

  return { root, mesh: planet, ring };
}
