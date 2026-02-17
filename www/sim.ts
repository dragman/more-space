import initWasm, { hex_window, init_game, revision, snapshot, submit_team_intent } from "../pkg/more_space.js";
import type { SimEvent } from "./bindings/SimEvent";
import type { LootView } from "./bindings/LootView";
import type { TeamBeliefCell } from "./bindings/TeamBeliefCell";
import type { TeamBeliefView } from "./bindings/TeamBeliefView";
import type { TeamView } from "./bindings/TeamView";
import type { TurnLog } from "./bindings/TurnLog";
import type { UnitView } from "./bindings/UnitView";
import type { WeaponType } from "./bindings/WeaponType";
import type { ExitPointView } from "./bindings/ExitPointView";
import type { CommandReply } from "./bindings/CommandReply";
import type { TeamTurnIntent } from "./bindings/TeamTurnIntent";
import type { UnitIntent } from "./bindings/UnitIntent";

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
const newSimBtn = document.getElementById("newSimBtn") as HTMLButtonElement;
const initModal = document.getElementById("initModal") as HTMLDivElement;
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
const playerTeamEl = document.getElementById("playerTeam") as HTMLDivElement;
const holdBtn = document.getElementById("holdBtn") as HTMLButtonElement;
const gridSvg = document.getElementById("gridSvg") as unknown as SVGSVGElement;
const gridWrap = gridSvg.parentElement as HTMLDivElement;
const controlTabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-control-tab]"));
const controlPanels = Array.from(document.querySelectorAll<HTMLElement>("[data-control-panel]"));

const MAX_LOGS = 60;
const HEX_SIZE = 14;
const LOOT_BELIEF_RENDER_THRESHOLD = 0.25;
const GRID_ZOOM_STEP = 1.06;
const GRID_DRAG_THRESHOLD_PX = 6;
type TeamId = number;
type ViewMode = "global" | TeamId;

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
let nextCommandId = 1n;
let selectedUnitId: number | null = null;
let hoveredCellId: string | null = null;
let plannedMoves = new Map<number, number>();
let explicitHolds = new Set<number>();
let playerTeamId = 0;
let simInitialized = false;

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

function setInitModalOpen(open: boolean): void {
    initModal.hidden = !open;
    if (open) {
        setRunning(false);
        window.setTimeout(() => seedInput.focus(), 0);
    }
}

function setControlTab(tab: "turn" | "view" | "session"): void {
    for (const btn of controlTabButtons) {
        btn.classList.toggle("active", btn.dataset.controlTab === tab);
    }
    for (const panel of controlPanels) {
        panel.hidden = panel.dataset.controlPanel !== tab;
    }
}

function updatePlayerTeamLabel(): void {
    const team = latestTeams.find((t) => t.id === playerTeamId);
    playerTeamEl.textContent = `Player team: ${team ? `${team.name} (#${team.id})` : `Team ${playerTeamId}`}`;
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
    selectedUnitId = null;
    hoveredCellId = null;
    plannedMoves.clear();
    explicitHolds.clear();
    updateViewOptions();
    updatePlayerTeamLabel();
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

function unitMaxHp(archetype: UnitView["archetype"]): number {
    if (archetype === "dreadnaught") return 32;
    return 24;
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
    if (active !== "global" && latestTeams.some((team) => team.id === active)) {
        viewModeSelect.value = viewOptionValue(active);
    } else if (latestTeams.some((team) => team.id === playerTeamId)) {
        viewModeSelect.value = viewOptionValue(playerTeamId);
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

function playerUnits(): UnitView[] {
    return latestUnits.filter((u) => u.team_id === playerTeamId && u.hp > 0);
}

function selectedPlayerUnit(): UnitView | null {
    if (selectedUnitId == null) return null;
    return latestUnits.find((u) => u.id === selectedUnitId && u.team_id === playerTeamId && u.hp > 0) ?? null;
}

function validMoveTargetsFor(unit: UnitView): Set<string> {
    const occupied = new Set(
        latestUnits
            .filter((u) => u.hp > 0 && u.id !== unit.id)
            .map((u) => u.pos.id),
    );
    const targets = new Set<string>();
    if (!gridCellMap) return targets;
    for (const [cellId, cell] of gridCellMap.entries()) {
        if (occupied.has(cellId)) continue;
        const d = cubeDistanceFromAxial(unit.pos, { q: cell.q, r: cell.r });
        if (d >= 1 && d <= unit.movement_range) {
            targets.add(cellId);
        }
    }
    return targets;
}

function cellContentsSummary(cellId: string): string {
    const coord = gridCellMap?.get(cellId);
    const where = coord ? `(${coord.q},${coord.r})` : `cell ${cellId}`;
    const aliveUnits = latestUnits.filter((u) => u.hp > 0 && u.pos.id === cellId);
    const unclaimedLoot = latestLoot.filter((l) => !l.claimed && l.pos.id === cellId);
    const exits = latestExits.filter((e) => e.pos.id === cellId);

    const unitPart =
        aliveUnits.length > 0
            ? `units: ${aliveUnits.map((u) => `#${u.id} ${teamName(u.team_id)}`).join(", ")}`
            : "units: none";
    const lootPart =
        unclaimedLoot.length > 0
            ? `loot: ${unclaimedLoot.map((l) => `#${l.id}(+${l.value})`).join(", ")}`
            : "loot: none";
    const exitPart = exits.length > 0 ? `exit: #${exits.map((e) => e.id).join(",#")}` : "exit: none";
    return `${where} | ${unitPart} | ${lootPart} | ${exitPart}`;
}

function buildPlayerTurnIntent(): TeamTurnIntent {
    const unit_intents: UnitIntent[] = playerUnits().map((unit) => {
        const toCellId = plannedMoves.get(unit.id);
        if (toCellId != null) {
            return { type: "move", unit_id: unit.id, to_cell_id: toCellId };
        }
        if (explicitHolds.has(unit.id)) {
            return { type: "hold", unit_id: unit.id };
        }
        return { type: "hold", unit_id: unit.id };
    });
    return { unit_intents };
}

function selectUnit(unitId: number): void {
    selectedUnitId = unitId;
    const unit = latestUnits.find((u) => u.id === unitId);
    const cellInfo = unit ? cellContentsSummary(unit.pos.id) : `unit ${unitId}`;
    updateStatus(
        `Selected unit ${unitId}. ${cellInfo}. Click a highlighted hex to confirm move, or use Hold selected.`,
    );
    renderPerspective();
}

function selectUnitIfOwned(unitId: number): void {
    const unit = latestUnits.find((u) => u.id === unitId && u.hp > 0);
    if (!unit) {
        updateStatus(`Unit ${unitId} is unavailable.`);
        return;
    }
    if (unit.team_id !== playerTeamId) {
        updateStatus(`Unit ${unitId} belongs to ${teamName(unit.team_id)}. You control ${teamName(playerTeamId)}.`);
        return;
    }
    selectUnit(unitId);
}

function planMoveForSelectedUnit(cellId: string): void {
    const selected = selectedPlayerUnit();
    const cellInfo = cellContentsSummary(cellId);
    if (!selected) {
        updateStatus(`Clicked ${cellInfo}. Select one of your units first.`);
        return;
    }
    const validTargets = validMoveTargetsFor(selected);
    if (!validTargets.has(cellId)) {
        updateStatus(`Clicked ${cellInfo}. Outside movement range or blocked for unit ${selected.id}.`);
        return;
    }
    const asNumber = Number(cellId);
    if (!Number.isFinite(asNumber)) {
        updateStatus(`Invalid cell id ${cellId}.`);
        return;
    }
    plannedMoves.set(selected.id, asNumber);
    explicitHolds.delete(selected.id);
    updateStatus(`Planned move for unit ${selected.id} -> ${cellInfo}.`);
    selectedUnitId = null;
    renderPerspective();
}

function setHoldForSelectedUnit(): void {
    const selected = selectedPlayerUnit();
    if (!selected) {
        updateStatus("Select one of your units from the map first.");
        return;
    }
    plannedMoves.delete(selected.id);
    explicitHolds.add(selected.id);
    selectedUnitId = null;
    updateStatus(`Set unit ${selected.id} to hold this turn.`);
    renderPerspective();
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
        gridSvg.style.cursor = "grab";
    });

    gridSvg.addEventListener("pointermove", (event) => {
        if (!gridPointer.active || gridPointer.pointerId !== event.pointerId) return;
        if (!gridSvg.hasPointerCapture(event.pointerId)) {
            const dxStart = event.clientX - gridPointer.startX;
            const dyStart = event.clientY - gridPointer.startY;
            if (Math.hypot(dxStart, dyStart) < GRID_DRAG_THRESHOLD_PX) {
                return;
            }
            gridSvg.style.cursor = "grabbing";
            gridSvg.setPointerCapture(event.pointerId);
            gridPointer.startX = event.clientX;
            gridPointer.startY = event.clientY;
            return;
        }
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
    const radius = latestGridRadius ?? 6;
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
    const selected = selectedPlayerUnit();
    const validTargets = selected ? validMoveTargetsFor(selected) : new Set<string>();
    for (const pos of positions) {
        const belief = beliefMap?.get(pos.cell.id);
        const lootBelief = belief?.loot ?? 0;
        const teamSignal = belief?.teamSignal ?? new Map<TeamId, number>();
        const renderLootBelief = lootBelief >= LOOT_BELIEF_RENDER_THRESHOLD ? lootBelief : 0;
        const fill = belief ? beliefFill(renderLootBelief, teamSignal) : "rgba(12, 18, 32, 0.8)";
        const poly = document.createElementNS(svgNs, "polygon");
        poly.setAttribute("points", hexPoints(pos.x, pos.y, HEX_SIZE));
        poly.setAttribute("fill", fill);
        const isValidTarget = validTargets.has(pos.cell.id);
        const isHovered = hoveredCellId === pos.cell.id;
        poly.setAttribute(
            "stroke",
            isHovered
                ? "rgba(232, 236, 255, 0.95)"
                : isValidTarget
                  ? "rgba(244, 201, 122, 0.95)"
                  : "rgba(94, 208, 255, 0.35)",
        );
        poly.setAttribute("stroke-width", isHovered ? "2.2" : isValidTarget ? "1.9" : "1");
        poly.style.cursor = "pointer";
        poly.addEventListener("mouseenter", () => {
            if (hoveredCellId === pos.cell.id) return;
            hoveredCellId = pos.cell.id;
            renderGrid();
        });
        poly.addEventListener("mouseleave", () => {
            if (hoveredCellId !== pos.cell.id) return;
            hoveredCellId = null;
            renderGrid();
        });
        poly.addEventListener("click", () => {
            const clickedPlayerUnit = latestUnits.find(
                (u) => u.team_id === playerTeamId && u.hp > 0 && u.pos.id === pos.cell.id,
            );
            if (clickedPlayerUnit) {
                selectUnitIfOwned(clickedPlayerUnit.id);
                return;
            }
            planMoveForSelectedUnit(pos.cell.id);
        });
        gridSvg.appendChild(poly);
    }

    const plannedCells = new Set<number>([...plannedMoves.values()]);
    for (const plannedCell of plannedCells) {
        const coord = gridCellMap?.get(plannedCell.toString());
        if (!coord) continue;
        const { x, y } = axialToPixel(coord.q, coord.r, HEX_SIZE);
        const marker = document.createElementNS(svgNs, "circle");
        marker.setAttribute("cx", x.toString());
        marker.setAttribute("cy", y.toString());
        marker.setAttribute("r", (HEX_SIZE * 0.18).toString());
        marker.setAttribute("fill", "rgba(94, 208, 255, 0.95)");
        marker.setAttribute("stroke", "rgba(6, 26, 39, 0.95)");
        marker.setAttribute("stroke-width", "1.2");
        marker.style.pointerEvents = "none";
        gridSvg.appendChild(marker);
    }

    // Planned move arrows.
    for (const [unitId, toCellId] of plannedMoves.entries()) {
        const unit = latestUnits.find((u) => u.id === unitId);
        const toCoord = gridCellMap?.get(toCellId.toString());
        if (!unit || !toCoord) continue;
        const from = axialToPixel(unit.pos.q, unit.pos.r, HEX_SIZE);
        const to = axialToPixel(toCoord.q, toCoord.r, HEX_SIZE);
        const line = document.createElementNS(svgNs, "line");
        line.setAttribute("x1", from.x.toString());
        line.setAttribute("y1", from.y.toString());
        line.setAttribute("x2", to.x.toString());
        line.setAttribute("y2", to.y.toString());
        line.setAttribute("stroke", "rgba(244, 201, 122, 0.95)");
        line.setAttribute("stroke-width", "2.2");
        line.setAttribute("stroke-dasharray", "5 3");
        line.style.pointerEvents = "none";
        gridSvg.appendChild(line);

        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        const tipX = to.x;
        const tipY = to.y;
        const leftX = tipX - 7 * Math.cos(angle - Math.PI / 7);
        const leftY = tipY - 7 * Math.sin(angle - Math.PI / 7);
        const rightX = tipX - 7 * Math.cos(angle + Math.PI / 7);
        const rightY = tipY - 7 * Math.sin(angle + Math.PI / 7);
        const head = document.createElementNS(svgNs, "polygon");
        head.setAttribute(
            "points",
            `${tipX.toFixed(2)},${tipY.toFixed(2)} ${leftX.toFixed(2)},${leftY.toFixed(2)} ${rightX.toFixed(2)},${rightY.toFixed(2)}`,
        );
        head.setAttribute("fill", "rgba(244, 201, 122, 0.95)");
        head.style.pointerEvents = "none";
        gridSvg.appendChild(head);
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

        const hpMax = Math.max(1, unitMaxHp(unit.archetype));
        const hpRatio = Math.max(0, Math.min(1, unit.hp / hpMax));
        const hpBarWidth = HEX_SIZE * 0.92;
        const hpBarHeight = 2.8;
        const hpBarX = x - hpBarWidth / 2;
        const hpBarY = y - HEX_SIZE * 0.78;

        const hpBg = document.createElementNS(svgNs, "rect");
        hpBg.setAttribute("x", hpBarX.toFixed(2));
        hpBg.setAttribute("y", hpBarY.toFixed(2));
        hpBg.setAttribute("width", hpBarWidth.toFixed(2));
        hpBg.setAttribute("height", hpBarHeight.toFixed(2));
        hpBg.setAttribute("rx", "1.1");
        hpBg.setAttribute("fill", "rgba(0, 0, 0, 0.52)");
        hpBg.setAttribute("stroke", "rgba(232, 236, 255, 0.32)");
        hpBg.setAttribute("stroke-width", "0.4");
        hpBg.style.pointerEvents = "none";
        gridSvg.appendChild(hpBg);

        const hpFg = document.createElementNS(svgNs, "rect");
        hpFg.setAttribute("x", hpBarX.toFixed(2));
        hpFg.setAttribute("y", hpBarY.toFixed(2));
        hpFg.setAttribute("width", (hpBarWidth * hpRatio).toFixed(2));
        hpFg.setAttribute("height", hpBarHeight.toFixed(2));
        hpFg.setAttribute("rx", "1.1");
        hpFg.setAttribute(
            "fill",
            hpRatio > 0.66 ? "rgba(129, 236, 162, 0.95)" : hpRatio > 0.33 ? "rgba(244, 201, 122, 0.95)" : "rgba(242, 99, 99, 0.95)",
        );
        hpFg.style.pointerEvents = "none";
        gridSvg.appendChild(hpFg);

        if (unit.archetype === "scout") {
            const tri = document.createElementNS(svgNs, "polygon");
            tri.setAttribute("points", regularPolygonPoints(x, y, HEX_SIZE * 0.45, 3));
            tri.setAttribute("fill", fill);
            tri.setAttribute("stroke", color);
            tri.setAttribute("stroke-width", strokeWidth);
            tri.style.pointerEvents = "none";
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
            box.style.pointerEvents = "none";
            gridSvg.appendChild(box);
        }

        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", x.toString());
        label.setAttribute("y", (y + 1).toString());
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.setAttribute("fill", dead ? "#c5c9d1" : "#e8ecff");
        label.textContent = `${teamBadge(unit.team_id)}${unit.id}`;
        if (selectedUnitId === unit.id) {
            label.setAttribute("font-weight", "700");
            label.setAttribute("fill", "#f4c97a");
        }
        if (unit.team_id === playerTeamId && unit.hp > 0) {
            label.style.pointerEvents = "none";
        } else {
            label.style.pointerEvents = "none";
        }
        gridSvg.appendChild(label);

        if (selectedUnitId === unit.id) {
            const rangeRing = document.createElementNS(svgNs, "circle");
            rangeRing.setAttribute("cx", x.toString());
            rangeRing.setAttribute("cy", y.toString());
            rangeRing.setAttribute("r", (HEX_SIZE * unit.movement_range + HEX_SIZE * 0.58).toString());
            rangeRing.setAttribute("fill", "none");
            rangeRing.setAttribute("stroke", "rgba(244, 201, 122, 0.55)");
            rangeRing.setAttribute("stroke-width", "1.4");
            rangeRing.setAttribute("stroke-dasharray", "6 5");
            rangeRing.style.pointerEvents = "none";
            gridSvg.appendChild(rangeRing);
        }
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
    nextCommandId = 1n;
    selectedUnitId = null;
    plannedMoves.clear();
    explicitHolds.clear();
    clearLog();
    const payload = snapshot();
    if (payload.startsWith("{")) {
        const log = JSON.parse(payload) as TurnLog;
        latestUnits = log.units ?? [];
        latestLoot = log.loot ?? [];
        latestBeliefs = log.beliefs ?? [];
        latestTeams = log.teams ?? [];
        if (latestTeams.length > 0) {
            playerTeamId = latestTeams[0].id;
        }
        latestExits = log.exits ?? [];
        latestGridRadius = typeof log.grid_radius === "number" ? log.grid_radius : null;
    }
    updateViewOptions();
    updatePlayerTeamLabel();
    simInitialized = true;
    setInitModalOpen(false);
    stepBtn.disabled = false;
    runBtn.disabled = false;
    clearBtn.disabled = false;
    holdBtn.disabled = false;
    viewModeSelect.disabled = false;
    renderPerspective();
    updateStatus(`Initialized with seed ${seed.toString()}. Plan turn 1 now.`);
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
        const plannedTo = plannedMoves.get(unit.id);
        const plannedHold = explicitHolds.has(unit.id);
        row.innerHTML = `#${unit.id} <span class="mono">${teamName(unit.team_id)}</span> <span class="mono">${unit.archetype}</span> HP ${unit.hp} @ (${unit.pos.q},${unit.pos.r}) · ${unit.weapon_type} r${unit.attack_range} d${unit.attack_damage} · move ${unit.movement_range} · inv ${unit.inventory_used}/${unit.inventory_slots}${
            unit.has_active_scan ? " · scan" : ""
        }${unit.hp <= 0 ? " · destroyed" : ""}${plannedTo ? ` · planned→${plannedTo}` : ""}${plannedHold ? " · planned hold" : ""}`;
        if (unit.id === selectedUnitId) {
            row.style.color = "#f4c97a";
        }
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
    if (!wasmReady || !simInitialized) return;
    try {
        const expectedRevision = revision();
        const intent = buildPlayerTurnIntent();
        const payload = submit_team_intent(
            nextCommandId,
            expectedRevision,
            playerTeamId,
            JSON.stringify(intent),
        );
        nextCommandId += 1n;
        if (!payload.startsWith("{")) {
            updateStatus(`Command error: ${payload}`);
            return;
        }
        const reply = JSON.parse(payload) as CommandReply;
        if (reply.status === "rejected") {
            updateStatus(
                `Command rejected (${reply.reason}), local rev=${reply.current_revision}.${reply.detail ? ` detail: ${reply.detail}` : ""}`,
            );
            return;
        }

        if (reply.pending_teams.length > 0 || !reply.resolved_turn) {
            updateStatus(
                `Accepted at rev ${reply.revision}; waiting on ${reply.pending_teams.length} teams.`,
            );
            return;
        }

        const log = reply.resolved_turn;
        for (const action of intent.unit_intents) {
            if (action.type === "move") {
                plannedMoves.delete(action.unit_id);
                explicitHolds.delete(action.unit_id);
            } else {
                explicitHolds.delete(action.unit_id);
            }
        }
        selectedUnitId = null;
        latestUnits = log.units ?? [];
        latestLoot = log.loot ?? [];
        latestBeliefs = log.beliefs ?? [];
        if (!teamOptionsLocked && (log.teams?.length ?? 0) > 0) {
            latestTeams = log.teams;
            updateViewOptions();
            updatePlayerTeamLabel();
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
        latestGridRadius = typeof log.grid_radius === "number" ? log.grid_radius : null;
        renderLog(log);
        renderPerspective();
        updateStatus(`Turn ${log.turn} resolved at revision ${reply.revision}.`);
    } catch (err) {
        updateStatus(`Command error: ${(err as Error).message}`);
        setRunning(false);
    }
}

async function boot(): Promise<void> {
    await initWasm();
    wasmReady = true;
    updateStatus("Wasm ready. Start a simulation.");
    initBtn.disabled = false;
    newSimBtn.disabled = false;
    setupGridInteractions();
    updateViewOptions();
    updatePlayerTeamLabel();
    renderPerspective();
    setInitModalOpen(true);
}

initBtn.addEventListener("click", () => initSim());
newSimBtn.addEventListener("click", () => setInitModalOpen(true));
stepBtn.addEventListener("click", () => stepSim());
runBtn.addEventListener("click", () => setRunning(!running));
clearBtn.addEventListener("click", () => {
    clearLog();
    renderPerspective();
});
holdBtn.addEventListener("click", () => setHoldForSelectedUnit());
viewModeSelect.addEventListener("change", () => renderPerspective());
speedInput.addEventListener("change", () => {
    if (running) {
        setRunning(false);
        setRunning(true);
    }
});
for (const btn of controlTabButtons) {
    btn.addEventListener("click", () => {
        const tab = btn.dataset.controlTab;
        if (tab === "turn" || tab === "view" || tab === "session") {
            setControlTab(tab);
        }
    });
}
setControlTab("turn");

initBtn.disabled = true;
newSimBtn.disabled = true;
stepBtn.disabled = true;
runBtn.disabled = true;
clearBtn.disabled = true;
holdBtn.disabled = true;
viewModeSelect.disabled = true;

boot().catch((err) => {
    updateStatus(`Failed to init wasm: ${(err as Error).message}`);
});
