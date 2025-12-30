import * as BABYLON from "babylonjs";

type PlanetMaterialStyle = {
  baseColor: number;
  highlightColor: number;
  kindId: number;
};

function registerPlanetShaders(): void {
  if (BABYLON.Effect.ShadersStore.planetVertexShader) return;

  BABYLON.Effect.ShadersStore.planetVertexShader = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;

varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vPositionW;

void main(void) {
  vUV = uv;
  vNormal = normalize(mat3(world) * normal);
  vPositionW = (world * vec4(position, 1.0)).xyz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

  BABYLON.Effect.ShadersStore.planetFragmentShader = `
precision highp float;
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vPositionW;

uniform float u_time;
uniform vec3 u_base;
uniform vec3 u_accent;
uniform float u_seed;
uniform float u_kind;
uniform vec3 u_lightDir;
uniform float u_rimStrength;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453 + u_seed);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

void main(void) {
  vec3 normal = normalize(vNormal);
  vec2 uv = normal.xz * 0.5 + 0.5; // stable across the sphere, no seam discard

  float bandMix = step(u_kind, 0.5);        // stronger bands for planetoids
  float roughMix = step(1.5, u_kind);       // rougher look for asteroid belts

  float n = fbm(uv * (3.0 + bandMix * 2.0) + u_seed * 0.01 + u_time * 0.12);
  float band = fbm(vec2(normal.y * (5.0 + bandMix * 5.0) + u_seed * 0.02 + u_time * 0.05, 0.0));
  float crater = roughMix * fbm(uv * 10.0 + u_seed * 0.03);

  float shade = n * 0.6 + band * 0.4 + crater * 0.3;
  vec3 col = mix(u_base, u_accent, shade);

  vec3 lightDir = normalize(u_lightDir);
  float light = clamp(dot(normal, lightDir) * 0.7 + 0.4, 0.0, 1.0);
  vec3 lit = col * (0.35 + 0.65 * light);

  vec3 viewDir = normalize(-vPositionW);
  float rim = pow(max(1.0 - max(dot(normal, viewDir), 0.0), 0.0), 2.4) * u_rimStrength;
  vec3 rimCol = mix(u_accent, vec3(1.0), 0.4);
  lit += rimCol * rim;

  gl_FragColor = vec4(lit, 1.0);
}
`;
}

export function createPlanetMaterial(
  scene: BABYLON.Scene,
  style: PlanetMaterialStyle,
  seed: number
): BABYLON.ShaderMaterial {
  registerPlanetShaders();

  const mat = new BABYLON.ShaderMaterial(
    `planetMat-${seed}`,
    scene,
    { vertex: "planet", fragment: "planet" },
    {
      attributes: ["position", "normal", "uv"],
      uniforms: ["world", "worldViewProjection", "u_time", "u_base", "u_accent", "u_seed", "u_kind", "u_lightDir", "u_rimStrength"],
    }
  );

  const base = new BABYLON.Color3(
    ((style.baseColor >> 16) & 0xff) / 255,
    ((style.baseColor >> 8) & 0xff) / 255,
    (style.baseColor & 0xff) / 255
  );
  const accent = new BABYLON.Color3(
    ((style.highlightColor >> 16) & 0xff) / 255,
    ((style.highlightColor >> 8) & 0xff) / 255,
    (style.highlightColor & 0xff) / 255
  );

  mat.setColor3("u_base", base);
  mat.setColor3("u_accent", accent);
  mat.setFloat("u_seed", seed % 1000);
  mat.setFloat("u_kind", style.kindId);
  mat.setFloat("u_time", 0);
  mat.setVector3("u_lightDir", new BABYLON.Vector3(0.4, 0.8, 0.3));
  mat.setFloat("u_rimStrength", 0.1);
  mat.backFaceCulling = true;
  // mat.disableLighting = true;
  return mat;
}
