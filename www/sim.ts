import initWasm, { hex_window, init_game, tick } from "../pkg/more_space.js";
import type { SimEvent } from "./bindings/SimEvent";
import type { LootView } from "./bindings/LootView";
import type { TeamBeliefCell } from "./bindings/TeamBeliefCell";
import type { TeamBeliefView } from "./bindings/TeamBeliefView";
import type { TeamView } from "./bindings/TeamView";
import type { TurnLog } from "./bindings/TurnLog";
import type { UnitView } from "./bindings/UnitView";
import type { WeaponType } from "./bindings/WeaponType";
import type { ExitPointView } from "./bindings/ExitPointView";

type HexCell = {
    id: string;
    q: number;
    r: number;
    x: number;
    y: number;
    z: number;
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

const seedInput = document.getElementById("seedInput") as HTMLInputElement;
const initBtn = document.getElementById("initBtn") as HTMLButtonElement;
const stepBtn = document.getElementById("stepBtn") as HTMLButtonElement;
const runBtn = document.getElementById("runBtn") as HTMLButtonElement;
const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;
const speedInput = document.getElementById("speedInput") as HTMLInputElement;
const viewModeSelect = document.getElementById("viewMode") as HTMLSelectElement;
const logList = document.getElementById("logList") as HTMLDivElement;
const unitList = document.getElementById("unitList") as HTMLDivElement;
const lootList = document.getElementById("lootList") as HTMLDivElement;
const beliefList = document.getElementById("beliefList") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const gridRadiusInput = document.getElementById("gridRadius") as HTMLInputElement;
const gridBtn = document.getElementById("gridBtn") as HTMLButtonElement;
const gridSvg = document.getElementById("gridSvg") as unknown as SVGSVGElement;
const gridWrap = gridSvg.parentElement as HTMLDivElement;

const MAX_LOGS = 60;
const HEX_SIZE = 14;
const LOOT_BELIEF_RENDER_THRESHOLD = 0.25;
const GRID_ZOOM_STEP = 1.06;
type TeamId = number;
type ViewMode = "global" | TeamId;
type ColorRGB = { r: number; g: number; b: number };
let running = false;
let timer: number | null = null;
let wasmReady = false;
let beliefMap: Map<string, { loot: number; teamSignal: Map<TeamId, number> }> | null = null;
let latestUnits: UnitView[] = [];
let displayedUnits: UnitView[] = [];
let latestLoot: LootView[] = [];
let displayedLoot: LootView[] = [];
let latestBeliefs: TeamBeliefView[] = [];
let latestTeams: TeamView[] = [];
let teamOptionsLocked = false;
let latestAttacks: { attackerId: number; targetId: number; weaponType: WeaponType; hit: boolean }[] = [];
let latestExits: ExitPointView[] = [];
let latestGridRadius: number | null = null;
let gridCellMap: Map<string, { q: number; r: number; x: number; y: number; z: number }> | null = null;
let gridBaseView: { x: number; y: number; width: number; height: number } | null = null;
let gridCamera = { zoom: 1, panX: 0, panY: 0 };
let gridPointer: { active: boolean; pointerId: number | null; startX: number; startY: number } = {
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
};
let gridInteractionsBound = false;

function randomSeed(): bigint {
    const upper = BigInt(Number.MAX_SAFE_INTEGER);
    const low = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    return (BigInt(Date.now()) ^ low) % upper;
}

function parseSeed(): bigint {
    const text = seedInput.value.trim();
    if (!text) return randomSeed();
    try {
        return BigInt(text);
    } catch {
        return randomSeed();
    }
}

function updateStatus(text: string): void {
    statusEl.textContent = text;
}

function setRunning(next: boolean): void {
    running = next;
    runBtn.classList.toggle("active", running);
    runBtn.textContent = running ? "Running" : "Auto";
    if (!running && timer) {
        window.clearInterval(timer);
        timer = null;
    }
    if (running) {
        const speed = parseInt(speedInput.value, 10) || 900;
        timer = window.setInterval(() => stepSim(), Math.max(200, speed));
    }
}

function clearLog(): void {
    logList.innerHTML = "";
    unitList.innerHTML = "";
    lootList.innerHTML = "";
    beliefList.innerHTML = "";
    beliefMap = null;
    latestUnits = [];
    displayedUnits = [];
    latestLoot = [];
    displayedLoot = [];
    latestBeliefs = [];
    latestTeams = [];
    teamOptionsLocked = false;
    latestAttacks = [];
    latestExits = [];
    latestGridRadius = null;
    gridCellMap = null;
    gridRadiusInput.disabled = false;
    gridBtn.disabled = false;
    updateViewOptions();
}

function teamById(teamId: TeamId): TeamView | null {
    return latestTeams.find((team) => team.id === teamId) ?? null;
}

function teamName(teamId: TeamId): string {
    return teamById(teamId)?.name ?? `Team ${teamId}`;
}

function teamColor(teamId: TeamId, alpha = 1): string {
    const color = teamById(teamId)?.color ?? { r: 150, g: 160, b: 180 };
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function teamBadge(teamId: TeamId): string {
    const name = teamName(teamId);
    return name.length > 0 ? name[0].toUpperCase() : "?";
}

function viewOptionValue(teamId: TeamId): string {
    return `team:${teamId}`;
}

function updateViewOptions(): void {
    const active = currentViewMode();
    viewModeSelect.innerHTML = "";
    const globalOption = document.createElement("option");
    globalOption.value = "global";
    globalOption.textContent = "View: Global";
    viewModeSelect.appendChild(globalOption);
    for (const team of latestTeams) {
        const opt = document.createElement("option");
        opt.value = viewOptionValue(team.id);
        opt.textContent = `View: ${team.name}`;
        viewModeSelect.appendChild(opt);
    }
    if (active === "global") {
        viewModeSelect.value = "global";
    } else if (latestTeams.some((team) => team.id === active)) {
        viewModeSelect.value = viewOptionValue(active);
    } else {
        viewModeSelect.value = "global";
    }
}

function weaponLineColor(weaponType: WeaponType): string {
    switch (weaponType) {
        case "railgun":
            return "rgba(255, 126, 89, 0.9)";
        case "pulse_laser":
            return "rgba(94, 208, 255, 0.9)";
        default:
            return "rgba(232, 236, 255, 0.75)";
    }
}

function currentViewMode(): ViewMode {
    const raw = viewModeSelect.value;
    if (raw.startsWith("team:")) {
        const id = Number(raw.slice("team:".length));
        if (Number.isFinite(id)) {
            return id;
        }
    }
    return "global";
}

function cubeDistanceFromAxial(a: { q: number; r: number }, b: { q: number; r: number }): number {
    const ax = a.q;
    const az = a.r;
    const ay = -ax - az;
    const bx = b.q;
    const bz = b.r;
    const by = -bx - bz;
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

function filterUnitsForView(units: UnitView[], view: ViewMode): UnitView[] {
    if (view === "global") return units;
    const allies = units.filter((unit) => unit.team_id === view);
    const allyVision = allies.filter((unit) => unit.hp > 0);
    return units.filter((unit) => {
        if (unit.team_id === view) return true;
        return allyVision.some((ally) => cubeDistanceFromAxial(ally.pos, unit.pos) <= ally.visible_radius);
    });
}

function filterLootForView(loot: LootView[], units: UnitView[], view: ViewMode): LootView[] {
    if (view === "global") return loot;
    const allyVision = units.filter((unit) => unit.team_id === view && unit.hp > 0);
    return loot.filter((node) =>
        allyVision.some((ally) => cubeDistanceFromAxial(ally.pos, node.pos) <= ally.visible_radius),
    );
}

function renderPerspective(): void {
    const view = currentViewMode();
    displayedUnits = filterUnitsForView(latestUnits, view);
    displayedLoot = filterLootForView(latestLoot, latestUnits, view);
    renderUnits(displayedUnits);
    renderLoot(displayedLoot);
    renderBeliefs(latestBeliefs, view);
    renderGrid();
}

function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
    const x = size * Math.sqrt(3) * (q + r / 2);
    const y = size * 1.5 * r;
    return { x, y };
}

function hexPoints(x: number, y: number, size: number): string {
    const points: string[] = [];
    for (let i = 0; i < 6; i += 1) {
        const angle = ((60 * i - 30) * Math.PI) / 180;
        const px = x + size * Math.cos(angle);
        const py = y + size * Math.sin(angle);
        points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    }
    return points.join(" ");
}

function regularPolygonPoints(x: number, y: number, size: number, sides: number, rotateDeg = -90): string {
    const points: string[] = [];
    for (let i = 0; i < sides; i += 1) {
        const angle = ((360 / sides) * i + rotateDeg) * (Math.PI / 180);
        const px = x + size * Math.cos(angle);
        const py = y + size * Math.sin(angle);
        points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
    }
    return points.join(" ");
}

function clearSvg(svg: SVGSVGElement): void {
    while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
    }
}

function currentSvgViewBox(): { x: number; y: number; width: number; height: number } | null {
    const attr = gridSvg.getAttribute("viewBox");
    if (!attr) return null;
    const values = attr
        .split(/\s+/)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
    if (values.length !== 4) return null;
    const [x, y, width, height] = values;
    return { x, y, width, height };
}

function applyGridCamera(): void {
    if (!gridBaseView) return;
    const zoom = Math.max(0.5, Math.min(6.0, gridCamera.zoom));
    gridCamera.zoom = zoom;
    const base = gridBaseView;
    const width = base.width / zoom;
    const height = base.height / zoom;
    const centerX = base.x + base.width / 2 + gridCamera.panX;
    const centerY = base.y + base.height / 2 + gridCamera.panY;
    const x = centerX - width / 2;
    const y = centerY - height / 2;
    gridSvg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
}

function zoomGridAt(clientX: number, clientY: number, scale: number): void {
    if (!gridBaseView) return;
    const rect = gridSvg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const view = currentSvgViewBox();
    if (!view) return;

    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const worldX = view.x + px * view.width;
    const worldY = view.y + py * view.height;

    const nextZoom = Math.max(0.5, Math.min(6.0, gridCamera.zoom * scale));
    if (Math.abs(nextZoom - gridCamera.zoom) < 1e-6) return;
    gridCamera.zoom = nextZoom;

    const nextWidth = gridBaseView.width / nextZoom;
    const nextHeight = gridBaseView.height / nextZoom;
    const nextX = worldX - px * nextWidth;
    const nextY = worldY - py * nextHeight;
    const nextCenterX = nextX + nextWidth / 2;
    const nextCenterY = nextY + nextHeight / 2;

    gridCamera.panX = nextCenterX - (gridBaseView.x + gridBaseView.width / 2);
    gridCamera.panY = nextCenterY - (gridBaseView.y + gridBaseView.height / 2);
    applyGridCamera();
}

function setupGridInteractions(): void {
    if (gridInteractionsBound) return;
    gridInteractionsBound = true;
    gridSvg.style.cursor = "grab";
    gridSvg.style.touchAction = "none";

    gridSvg.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        gridPointer.active = true;
        gridPointer.pointerId = event.pointerId;
        gridPointer.startX = event.clientX;
        gridPointer.startY = event.clientY;
        gridSvg.style.cursor = "grabbing";
        gridSvg.setPointerCapture(event.pointerId);
    });

    gridSvg.addEventListener("pointermove", (event) => {
        if (!gridPointer.active || gridPointer.pointerId !== event.pointerId) return;
        const rect = gridSvg.getBoundingClientRect();
        const view = currentSvgViewBox();
        if (!view || rect.width <= 0 || rect.height <= 0) return;
        const dxPx = event.clientX - gridPointer.startX;
        const dyPx = event.clientY - gridPointer.startY;
        const worldPerPxX = view.width / rect.width;
        const worldPerPxY = view.height / rect.height;
        gridCamera.panX -= dxPx * worldPerPxX;
        gridCamera.panY -= dyPx * worldPerPxY;
        gridPointer.startX = event.clientX;
        gridPointer.startY = event.clientY;
        applyGridCamera();
    });

    const endPan = (event: PointerEvent) => {
        if (gridPointer.pointerId !== event.pointerId) return;
        gridPointer.active = false;
        gridPointer.pointerId = null;
        gridSvg.style.cursor = "grab";
        if (gridSvg.hasPointerCapture(event.pointerId)) {
            gridSvg.releasePointerCapture(event.pointerId);
        }
    };
    gridSvg.addEventListener("pointerup", endPan);
    gridSvg.addEventListener("pointercancel", endPan);

    gridWrap.addEventListener(
        "wheel",
        (event) => {
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                const scale = event.deltaY < 0 ? GRID_ZOOM_STEP : 1 / GRID_ZOOM_STEP;
                zoomGridAt(event.clientX, event.clientY, scale);
                return;
            }
            const view = currentSvgViewBox();
            const rect = gridSvg.getBoundingClientRect();
            if (!view || rect.width <= 0 || rect.height <= 0) return;
            event.preventDefault();
            const worldPerPxX = view.width / rect.width;
            const worldPerPxY = view.height / rect.height;
            gridCamera.panX += event.deltaX * worldPerPxX;
            gridCamera.panY += event.deltaY * worldPerPxY;
            applyGridCamera();
        },
        { passive: false },
    );
}

function renderGrid(): void {
    if (!wasmReady) return;
    const radiusInput = parseInt(gridRadiusInput.value, 10) || 6;
    const radius = latestGridRadius ?? Math.max(1, Math.min(12, radiusInput));
    const json = hex_window(0, 0, radius);
    const grid = JSON.parse(json) as HexGrid;
    gridCellMap = new Map(
        grid.cells.map((cell) => [cell.id, { q: cell.q, r: cell.r, x: cell.x, y: cell.y, z: cell.z }]),
    );

    clearSvg(gridSvg);
    const positions = grid.cells.map((cell) => ({
        cell,
        ...axialToPixel(cell.q, cell.r, HEX_SIZE),
    }));
    const xs = positions.map((pos) => pos.x);
    const ys = positions.map((pos) => pos.y);
    const minX = Math.min(...xs) - HEX_SIZE * 1.4;
    const maxX = Math.max(...xs) + HEX_SIZE * 1.4;
    const minY = Math.min(...ys) - HEX_SIZE * 1.4;
    const maxY = Math.max(...ys) + HEX_SIZE * 1.4;
    gridBaseView = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
    applyGridCamera();

    const svgNs = "http://www.w3.org/2000/svg";
    for (const pos of positions) {
        const belief = beliefMap?.get(pos.cell.id);
        const lootBelief = belief?.loot ?? 0;
        const teamSignal = belief?.teamSignal ?? new Map<TeamId, number>();
        const renderLootBelief = lootBelief >= LOOT_BELIEF_RENDER_THRESHOLD ? lootBelief : 0;
        const fill = belief ? beliefFill(renderLootBelief, teamSignal) : "rgba(12, 18, 32, 0.8)";
        const poly = document.createElementNS(svgNs, "polygon");
        poly.setAttribute("points", hexPoints(pos.x, pos.y, HEX_SIZE));
        poly.setAttribute("fill", fill);
        poly.setAttribute("stroke", "rgba(94, 208, 255, 0.35)");
        poly.setAttribute("stroke-width", "1");
        gridSvg.appendChild(poly);
    }

    for (const loot of displayedLoot.filter((node) => !node.claimed)) {
        const { x, y } = axialToPixel(loot.pos.q, loot.pos.r, HEX_SIZE);
        const marker = document.createElementNS(svgNs, "polygon");
        marker.setAttribute("points", regularPolygonPoints(x, y, HEX_SIZE * 0.28, 4, 45));
        marker.setAttribute("fill", "rgba(244, 201, 122, 0.95)");
        marker.setAttribute("stroke", "rgba(35, 23, 8, 0.95)");
        marker.setAttribute("stroke-width", "1.4");
        gridSvg.appendChild(marker);
    }

    for (const exit of latestExits) {
        const { x, y } = axialToPixel(exit.pos.q, exit.pos.r, HEX_SIZE);
        const marker = document.createElementNS(svgNs, "polygon");
        marker.setAttribute("points", regularPolygonPoints(x, y, HEX_SIZE * 0.34, 3, 90));
        marker.setAttribute("fill", "rgba(129, 236, 162, 0.95)");
        marker.setAttribute("stroke", "rgba(12, 57, 26, 0.95)");
        marker.setAttribute("stroke-width", "1.6");
        gridSvg.appendChild(marker);
    }

    const unitById = new Map(displayedUnits.map((unit) => [unit.id, unit]));
    for (const attack of latestAttacks) {
        const attacker = unitById.get(attack.attackerId);
        const target = unitById.get(attack.targetId);
        if (!attacker || !target) {
            continue;
        }
        const from = axialToPixel(attacker.pos.q, attacker.pos.r, HEX_SIZE);
        const to = axialToPixel(target.pos.q, target.pos.r, HEX_SIZE);
        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", from.x.toString());
        line.setAttribute("y1", from.y.toString());
        line.setAttribute("x2", to.x.toString());
        line.setAttribute("y2", to.y.toString());
        line.setAttribute("stroke", weaponLineColor(attack.weaponType));
        line.setAttribute("stroke-width", attack.hit ? "2.4" : "1.6");
        if (!attack.hit) {
            line.setAttribute("stroke-dasharray", "4 3");
            line.setAttribute("opacity", "0.75");
        }
        gridSvg.appendChild(line);
    }

    for (const unit of displayedUnits) {
        const { x, y } = axialToPixel(unit.pos.q, unit.pos.r, HEX_SIZE);
        const dead = unit.hp <= 0;
        const color = dead ? "#8b94a1" : teamColor(unit.team_id, 0.95);
        const fill = dead ? "rgba(95, 103, 118, 0.45)" : "rgba(10, 16, 30, 0.75)";
        const strokeWidth = dead ? "1.6" : "2";

        if (unit.archetype === "scout") {
            const tri = document.createElementNS(svgNs, "polygon");
            tri.setAttribute("points", regularPolygonPoints(x, y, HEX_SIZE * 0.45, 3));
            tri.setAttribute("fill", fill);
            tri.setAttribute("stroke", color);
            tri.setAttribute("stroke-width", strokeWidth);
            gridSvg.appendChild(tri);
        } else {
            const box = document.createElementNS(svgNs, "rect");
            const size = HEX_SIZE * 0.75;
            box.setAttribute("x", (x - size / 2).toString());
            box.setAttribute("y", (y - size / 2).toString());
            box.setAttribute("width", size.toString());
            box.setAttribute("height", size.toString());
            box.setAttribute("rx", "2");
            box.setAttribute("fill", fill);
            box.setAttribute("stroke", color);
            box.setAttribute("stroke-width", strokeWidth);
            gridSvg.appendChild(box);
        }

        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", x.toString());
        label.setAttribute("y", (y + 1).toString());
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.setAttribute("fill", dead ? "#c5c9d1" : "#e8ecff");
        label.textContent = `${teamBadge(unit.team_id)}${unit.id}`;
        gridSvg.appendChild(label);
    }
}

function clamp01(v: number): number {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function mixChannel(a: number, b: number, t: number): number {
    return Math.round(a + (b - a) * t);
}

function beliefFill(loot: number, teamSignal: Map<TeamId, number>): string {
    const lootT = clamp01((loot - 0.2) / 0.8);

    const base = { r: 12, g: 18, b: 32 };
    const lootColor = { r: 244, g: 201, b: 122 };

    let mixed = {
        r: mixChannel(base.r, lootColor.r, lootT),
        g: mixChannel(base.g, lootColor.g, lootT),
        b: mixChannel(base.b, lootColor.b, lootT),
    };
    let strongestSignal = 0;
    for (const [teamId, rawSignal] of teamSignal.entries()) {
        const signal = clamp01(rawSignal);
        if (signal <= 0) continue;
        strongestSignal = Math.max(strongestSignal, signal);
        const colorRef = teamById(teamId)?.color ?? { r: 150, g: 160, b: 180 };
        const teamMix = {
            r: mixChannel(base.r, colorRef.r, signal),
            g: mixChannel(base.g, colorRef.g, signal),
            b: mixChannel(base.b, colorRef.b, signal),
        };
        mixed = {
            r: mixChannel(mixed.r, teamMix.r, signal),
            g: mixChannel(mixed.g, teamMix.g, signal),
            b: mixChannel(mixed.b, teamMix.b, signal),
        };
    }

    const fillAlpha = 0.55 + 0.35 * Math.max(lootT, strongestSignal);
    return `rgba(${mixed.r}, ${mixed.g}, ${mixed.b}, ${fillAlpha.toFixed(2)})`;
}

function initSim(): void {
    if (!wasmReady) return;
    const seed = parseSeed();
    init_game(seed);
    clearLog();
    updateViewOptions();
    renderPerspective();
    updateStatus(`Initialized with seed ${seed.toString()}`);
}

function describeEvent(event: SimEvent): string {
    switch (event.type) {
        case "turn_start":
            return `Turn ${event.turn} begins.`;
        case "scan_result": {
            const tag = `${teamName(event.team_id)} ${event.mode}`;
            return `${tag} scan updated ${event.updates.length} cells.`;
        }
        case "unit_decision": {
            const target = event.target ? ` toward (${event.target.q},${event.target.r})` : "";
            return `Unit ${event.unit_id} decision ${event.intent}${target}: ${event.reason}`;
        }
        case "unit_moved":
            return `Unit ${event.unit_id} moved (${event.from.q},${event.from.r}) → (${event.to.q},${event.to.r}) [move ${event.movement_range}].`;
        case "attack":
            return `Unit ${event.attacker_id} attacked ${event.target_id} with ${event.weapon_type} (r${event.weapon_range}, base ${event.base_damage}) (${event.hit ? "hit" : "miss"}) for ${event.damage}.`;
        case "unit_destroyed":
            return `Unit ${event.unit_id} destroyed.`;
        case "loot_recovered":
            return `Unit ${event.unit_id} recovered loot ${event.loot_id} (+${event.value}).`;
        case "loot_dropped":
            return `Unit ${event.unit_id} dropped loot ${event.loot_id} (+${event.value}) at (${event.pos.q},${event.pos.r}).`;
        case "unit_exited":
            return `Unit ${event.unit_id} exited the map via exit ${event.exit_id}.`;
        case "active_scan_ping":
            return `Active scan ping by ${event.unit_id} at (${event.center.q},${event.center.r}).`;
        default:
            return "Unknown event.";
    }
}

function renderLog(log: TurnLog): void {
    const entry = document.createElement("div");
    entry.className = "log-entry";

    const header = document.createElement("h3");
    const eventCount = log.events ? log.events.length : 0;
    header.innerHTML = `<span class="tag">Turn ${log.turn ?? "?"}</span>${eventCount} events`;
    entry.appendChild(header);

    const events = log.events && log.events.length ? log.events : [{ type: "turn_start", turn: log.turn } as SimEvent];
    for (const event of events) {
        const row = document.createElement("div");
        row.className = "event";
        row.textContent = describeEvent(event);
        entry.appendChild(row);
    }

    logList.appendChild(entry);
    while (logList.children.length > MAX_LOGS) {
        logList.removeChild(logList.firstChild as ChildNode);
    }
    logList.scrollTop = logList.scrollHeight;
}

function renderUnits(units: UnitView[]): void {
    unitList.innerHTML = "";
    if (!units.length) {
        unitList.textContent = "No units yet.";
        return;
    }
    for (const unit of units) {
        const row = document.createElement("div");
        row.innerHTML = `#${unit.id} <span class="mono">${teamName(unit.team_id)}</span> <span class="mono">${unit.archetype}</span> HP ${unit.hp} @ (${unit.pos.q},${unit.pos.r}) · ${unit.weapon_type} r${unit.attack_range} d${unit.attack_damage} · move ${unit.movement_range} · inv ${unit.inventory_used}/${unit.inventory_slots}${
            unit.has_active_scan ? " · scan" : ""
        }${unit.hp <= 0 ? " · destroyed" : ""}`;
        unitList.appendChild(row);
    }
}

function renderLoot(loot: LootView[]): void {
    lootList.innerHTML = "";
    const available = loot.filter((node) => !node.claimed);
    const summary = document.createElement("div");
    summary.textContent = `${available.length} unclaimed / ${loot.length} total`;
    lootList.appendChild(summary);

    const top = [...available].sort((a, b) => b.value - a.value).slice(0, 4);
    for (const node of top) {
        const row = document.createElement("div");
        row.textContent = `Loot ${node.id} (+${node.value}) at (${node.pos.q},${node.pos.r})`;
        lootList.appendChild(row);
    }
}

function pickTopCells(
    cells: TeamBeliefCell[],
    key: "loot" | "enemy",
    count: number,
): TeamBeliefCell[] {
    const minConfidence = key === "loot" ? LOOT_BELIEF_RENDER_THRESHOLD : 0.05;
    return [...cells]
        .filter((cell) => cell[key] > minConfidence)
        .sort((a, b) => b[key] - a[key])
        .slice(0, count);
}

function renderBeliefs(beliefs: TeamBeliefView[], view: ViewMode): void {
    beliefList.innerHTML = "";
    beliefMap = null;
    if (!beliefs.length) {
        beliefList.textContent = "No belief data yet.";
        return;
    }
    const scopedBeliefs = view === "global" ? beliefs : beliefs.filter((teamBelief) => teamBelief.team_id === view);
    if (!scopedBeliefs.length) {
        beliefList.textContent = "No belief data yet for selected view.";
        return;
    }
    if (view === "global") {
        const merged = new Map<string, { loot: number; teamSignal: Map<TeamId, number> }>();
        for (const teamBelief of beliefs) {
            for (const cell of teamBelief.cells) {
                const prev = merged.get(cell.cell_id);
                merged.set(cell.cell_id, {
                    loot: Math.max(prev?.loot ?? 0, cell.loot),
                    // Hostile belief is observer-team specific in this model.
                    teamSignal: new Map([...(prev?.teamSignal.entries() ?? []), [teamBelief.team_id, cell.enemy]]),
                });
            }
        }
        beliefMap = merged;
    } else {
        const activeBelief = scopedBeliefs[0];
        beliefMap = new Map(
            activeBelief.cells.map((cell) => [
                cell.cell_id,
                {
                    loot: cell.loot,
                    teamSignal: new Map([[activeBelief.team_id, cell.enemy]]),
                },
            ]),
        );
    }

    for (const team of scopedBeliefs) {
        const header = document.createElement("div");
        header.innerHTML = `<span class="tag">${teamName(team.team_id)}</span> top cells`;
        beliefList.appendChild(header);

        const lootTop = pickTopCells(team.cells, "loot", 3);
        const hostileTop = pickTopCells(team.cells, "enemy", 3);

        for (const cell of lootTop) {
            const coord = gridCellMap?.get(cell.cell_id);
            const label = coord ? `${coord.q},${coord.r}` : cell.cell_id;
            const row = document.createElement("div");
            row.textContent = `loot ${label} → ${(cell.loot * 100).toFixed(0)}%`;
            beliefList.appendChild(row);
        }
        for (const cell of hostileTop) {
            const coord = gridCellMap?.get(cell.cell_id);
            const label = coord ? `${coord.q},${coord.r}` : cell.cell_id;
            const row = document.createElement("div");
            row.textContent = `hostile ${label} → ${(cell.enemy * 100).toFixed(0)}%`;
            beliefList.appendChild(row);
        }
    }
}

function stepSim(): void {
    if (!wasmReady) return;
    try {
        const payload = tick();
        if (!payload.startsWith("{")) {
            const numericTurn = Number(payload);
            if (Number.isFinite(numericTurn)) {
                updateStatus("Tick returned a numeric turn. Rebuild wasm to get JSON logs.");
                const log = {
                    turn: numericTurn,
                    events: [{ type: "turn_start", turn: numericTurn } as SimEvent],
                    units: [],
                    loot: [],
                    beliefs: [],
                } as TurnLog;
                renderLog(log);
                latestUnits = [];
                latestLoot = [];
                displayedLoot = [];
                latestBeliefs = [];
                latestTeams = [];
                teamOptionsLocked = false;
                latestAttacks = [];
                latestExits = [];
                updateViewOptions();
                renderPerspective();
                return;
            }
            updateStatus(`Tick error: ${payload}`);
            return;
        }
        const log = JSON.parse(payload) as TurnLog;
        latestUnits = log.units ?? [];
        latestLoot = log.loot ?? [];
        latestBeliefs = log.beliefs ?? [];
        if (!teamOptionsLocked && (log.teams?.length ?? 0) > 0) {
            latestTeams = log.teams;
            updateViewOptions();
            teamOptionsLocked = true;
        }
        latestExits = log.exits ?? [];
        latestAttacks = (log.events ?? [])
            .filter((event): event is Extract<SimEvent, { type: "attack" }> => event.type === "attack")
            .map((event) => ({
                attackerId: event.attacker_id,
                targetId: event.target_id,
                weaponType: event.weapon_type,
                hit: event.hit,
            }));
        if (typeof log.grid_radius === "number") {
            latestGridRadius = log.grid_radius;
            gridRadiusInput.value = log.grid_radius.toString();
            gridRadiusInput.disabled = true;
            gridBtn.disabled = true;
        } else {
            latestGridRadius = null;
            gridRadiusInput.disabled = false;
            gridBtn.disabled = false;
        }
        renderLog(log);
        renderPerspective();
    } catch (err) {
        updateStatus(`Tick error: ${(err as Error).message}`);
        setRunning(false);
    }
}

async function boot(): Promise<void> {
    await initWasm();
    wasmReady = true;
    updateStatus("Wasm ready.");
    initBtn.disabled = false;
    stepBtn.disabled = false;
    runBtn.disabled = false;
    clearBtn.disabled = false;
    setupGridInteractions();
    updateViewOptions();
    renderPerspective();
}

initBtn.addEventListener("click", () => initSim());
stepBtn.addEventListener("click", () => stepSim());
runBtn.addEventListener("click", () => setRunning(!running));
clearBtn.addEventListener("click", () => {
    clearLog();
    renderPerspective();
});
gridBtn.addEventListener("click", () => renderGrid());
viewModeSelect.addEventListener("change", () => renderPerspective());
speedInput.addEventListener("change", () => {
    if (running) {
        setRunning(false);
        setRunning(true);
    }
});

initBtn.disabled = true;
stepBtn.disabled = true;
runBtn.disabled = true;
clearBtn.disabled = true;

boot().catch((err) => {
    updateStatus(`Failed to init wasm: ${(err as Error).message}`);
});
