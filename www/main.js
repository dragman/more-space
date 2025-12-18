import init, { generate_universe } from "../pkg/more_space.js";

const canvas = document.getElementById("graph");
const tooltip = document.getElementById("tooltip");
const seedInput = document.getElementById("seedInput");
const regenBtn = document.getElementById("regen");
const randomBtn = document.getElementById("randomSeed");

const NODE_RADIUS = 20;
const ORBIT_BASE = 22;
const CANVAS_HEIGHT = 1400;

let universeData = null;
let layout = null;
let hover = null;
let ctx = null;
let pan = { x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

function randomSeed() {
  const upper = BigInt(Number.MAX_SAFE_INTEGER);
  const low = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  return (BigInt(Date.now()) ^ low) % upper;
}

function parseSeed() {
  const text = seedInput.value.trim();
  if (!text) return randomSeed();
  try {
    return BigInt(text);
  } catch {
    return randomSeed();
  }
}

function setupCanvas() {
  if (!ctx) {
    ctx = canvas.getContext("2d");
  }
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = CANVAS_HEIGHT;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}

function angleForBody(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return (hash % 360) * (Math.PI / 180);
}

function systemLabel(sys) {
  if (!sys) return "";
  const first = sys.stars && sys.stars[0];
  return first ? first.name : `System ${sys.id}`;
}

function prepareLayout(universe) {
  const { width, height } = setupCanvas();
  const cx = width / 2 + pan.x;
  const cy = height / 2 + pan.y;
  const ringRadius = Math.min(width, height) / 2 - 100;

  const positions = universe.systems.map((sys, idx) => {
    const angle = (idx / universe.systems.length) * Math.PI * 2;
    return {
      id: sys.id,
      label: systemLabel(sys),
      sys,
      x: cx + Math.cos(angle) * ringRadius,
      y: cy + Math.sin(angle) * ringRadius,
    };
  });

  const maxDistance =
    universe.systems
      .flatMap((s) => s.orbitals.map((o) => o.distance))
      .reduce((a, b) => Math.max(a, b), 1) || 1;
  const scale = (ringRadius * 0.5) / maxDistance;

  const systems = positions.map((pos) => {
    const orbitals = pos.sys.orbitals.map((orb) => {
      const radius = ORBIT_BASE + orb.distance * scale;
      const angle = angleForBody(orb.name);
      const bx = pos.x + Math.cos(angle) * radius;
      const by = pos.y + Math.sin(angle) * radius;
      return { orb, radius, bx, by, angle };
    });
    return { ...pos, orbitals };
  });

  const edges = new Set();
  universe.systems.forEach((sys) => {
    sys.links.forEach((link) => {
      const key = [Math.min(sys.id, link), Math.max(sys.id, link)].join("-");
      edges.add(key);
    });
  });

  layout = { systems, edges, scale };
}

function clearCanvas() {
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, canvas.clientWidth, CANVAS_HEIGHT);
}

function drawScene() {
  if (!layout) return;
  clearCanvas();

  // edges
  ctx.strokeStyle = "rgba(94,208,255,0.25)";
  ctx.lineWidth = 2;
  layout.edges.forEach((key) => {
    const [a, b] = key.split("-").map(Number);
    const pa = layout.systems.find((s) => s.id === a);
    const pb = layout.systems.find((s) => s.id === b);
    if (!pa || !pb) return;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  });

  // orbits + bodies
  layout.systems.forEach((s) => {
    s.orbitals.forEach((o) => {
      const active =
        hover &&
        hover.systemId === s.id &&
        hover.orbName === o.orb.name;
      ctx.strokeStyle = active ? "rgba(94,208,255,0.6)" : "rgba(255,255,255,0.08)";
      ctx.lineWidth = active ? 3 : 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, o.radius, 0, Math.PI * 2);
      ctx.stroke();

      const bodyActive =
        hover &&
        hover.type === "body" &&
        hover.systemId === s.id &&
        hover.orbName === o.orb.name;
      ctx.fillStyle = o.orb.kind === "Moon" ? "#d77bff" : "#5ed0ff";
      ctx.strokeStyle = "#0a0d1c";
      ctx.lineWidth = bodyActive ? 3 : 2;
      ctx.beginPath();
      ctx.arc(o.bx, o.by, bodyActive ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  });

  // systems
  layout.systems.forEach((s) => {
    const active = hover && hover.type === "system" && hover.systemId === s.id;
    ctx.fillStyle = "url(#)";
    ctx.beginPath();
    ctx.fillStyle = active ? "#5ed0ff" : "#d77bff";
    ctx.strokeStyle = "#0a0d1c";
    ctx.lineWidth = active ? 3 : 2;
    ctx.arc(s.x, s.y, NODE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#0a0d1c";
    ctx.font = "700 12px 'Space Grotesk', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.label.slice(0, 12), s.x, s.y + 1);
  });
}

function hazardSummary(hazards) {
  if (!hazards.length) return "hazards: none";
  const labels = hazards.map((h) => h.kind).join(", ");
  return `hazards: ${labels}`;
}

function handleHover(evt) {
  if (!layout) return;
  const rect = canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;

  let hit = null;

  // bodies
  for (const s of layout.systems) {
    for (const o of s.orbitals) {
      const dx = x - o.bx;
      const dy = y - o.by;
      if (Math.hypot(dx, dy) <= 8) {
        hit = { type: "body", systemId: s.id, orbName: o.orb.name, sys: s, orb: o.orb };
        break;
      }
    }
    if (hit) break;
  }

  // systems (if still none)
  if (!hit) {
    for (const s of layout.systems) {
      const dx = x - s.x;
      const dy = y - s.y;
      if (Math.hypot(dx, dy) <= NODE_RADIUS) {
        hit = { type: "system", systemId: s.id, sys: s.sys };
        break;
      }
    }
  }

  hover = hit;
  if (hit) {
    if (hit.type === "system") {
      showSystemInfo(hit.sys, evt);
    } else {
      showOrbitInfo(hit.sys, hit.orb, evt);
    }
  } else {
    hideTooltip();
  }
  drawScene();
}

function showSystemInfo(sys, evt) {
  if (!sys) return;
  const stars = sys.stars
    .map((s) => `${s.name}${s.nickname ? ` (${s.nickname})` : ""}`)
    .join(", ");
  const links = sys.links.length ? sys.links.join(", ") : "none";
  showTooltip(
    `
    <strong>${systemLabel(sys)}</strong><br/>
    Stars: ${stars}<br/>
    Links: ${links}<br/>
    Orbits: ${sys.orbitals.length}
  `,
    evt
  );
}

function showOrbitInfo(sys, orb, evt) {
  const hazards = orb.hazards.length
    ? orb.hazards.map((h) => h.kind).join(", ")
    : "none";
  showTooltip(
    `
    <strong>${orb.name}${orb.nickname ? ` (${orb.nickname})` : ""}</strong><br/>
    System: ${systemLabel(sys)}<br/>
    Kind: ${orb.kind}<br/>
    Distance: ${orb.distance}<br/>
    Probe fail: ${(orb.probe_failure * 100).toFixed(1)}%<br/>
    Hazards: ${hazards}
  `,
    evt
  );
}

function showTooltip(content, evt) {
  tooltip.innerHTML = content;
  tooltip.style.display = "block";
  moveTooltip(evt);
}

function hideTooltip() {
  tooltip.style.display = "none";
}

function moveTooltip(evt) {
  if (!evt) return;
  const padding = 6;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + padding;
  let y = evt.clientY + padding;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + rect.width + padding > vw) x = evt.clientX - rect.width - padding;
  if (y + rect.height + padding > vh) y = evt.clientY - rect.height - padding;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

async function renderUniverse(seed) {
  try {
    const json = generate_universe(seed);
    universeData = JSON.parse(json);
    prepareLayout(universeData);
    drawScene();
  } catch (err) {
    console.error(err);
  }
}

async function run() {
  await init();
  const seed = randomSeed();
  seedInput.value = seed.toString();
  renderUniverse(seed);
}

canvas.addEventListener("mousemove", handleHover);
canvas.addEventListener("mouseleave", () => {
  hover = null;
  hideTooltip();
  drawScene();
});
canvas.addEventListener("mousedown", (e) => {
  pan.dragging = true;
  pan.lastX = e.clientX;
  pan.lastY = e.clientY;
});

window.addEventListener("mouseup", () => {
  pan.dragging = false;
});

canvas.addEventListener("mousemove", (e) => {
  if (!pan.dragging) return;
  const dx = e.clientX - pan.lastX;
  const dy = e.clientY - pan.lastY;
  pan.lastX = e.clientX;
  pan.lastY = e.clientY;
  pan.x += dx;
  pan.y += dy;
  if (universeData) {
    prepareLayout(universeData);
    drawScene();
  }
});

regenBtn.addEventListener("click", () => {
  const seed = parseSeed();
  seedInput.value = seed.toString();
  renderUniverse(seed);
});

randomBtn.addEventListener("click", () => {
  const seed = randomSeed();
  seedInput.value = seed.toString();
  renderUniverse(seed);
});

run();
