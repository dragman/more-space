import initWasm, { hex_window, init_game, tick } from "../pkg/more_space.js";

type Team = "player" | "enemy";
type ScanMode = "visual" | "passive" | "active";

type BeliefUpdate = {
    cell_id: string;
    enemy: number;
    loot: number;
};

type SimEvent =
    | { type: "turn_start"; turn: number }
    | { type: "scan_result"; team: Team; mode: ScanMode; updates: BeliefUpdate[] }
    | { type: "unit_moved"; unit_id: number; from: CellRef; to: CellRef }
    | { type: "attack"; attacker_id: number; target_id: number; hit: boolean; damage: number }
    | { type: "unit_destroyed"; unit_id: number }
    | { type: "loot_recovered"; unit_id: number; loot_id: number; value: number }
    | { type: "active_scan_ping"; unit_id: number; center: CellRef };

type CellRef = {
    id: string;
    q: number;
    r: number;
};

type UnitView = {
    id: number;
    team: Team;
    hp: number;
    pos: CellRef;
    attack_range: number;
    visible_radius: number;
    has_active_scan: boolean;
};

type LootView = {
    id: number;
    pos: CellRef;
    value: number;
    claimed: boolean;
};

type TeamBeliefCell = {
    cell_id: string;
    enemy: number;
    loot: number;
};

type TeamBeliefView = {
    team: Team;
    cells: TeamBeliefCell[];
};

type TurnLog = {
    turn: number;
    events: SimEvent[];
    units: UnitView[];
    loot: LootView[];
    beliefs: TeamBeliefView[];
    grid_radius: number;
};

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
const logList = document.getElementById("logList") as HTMLDivElement;
const unitList = document.getElementById("unitList") as HTMLDivElement;
const lootList = document.getElementById("lootList") as HTMLDivElement;
const beliefList = document.getElementById("beliefList") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const gridRadiusInput = document.getElementById("gridRadius") as HTMLInputElement;
const gridBtn = document.getElementById("gridBtn") as HTMLButtonElement;
const gridSvg = document.getElementById("gridSvg") as unknown as SVGSVGElement;

const MAX_LOGS = 60;
const HEX_SIZE = 14;
let running = false;
let timer: number | null = null;
let wasmReady = false;
let beliefMap: Map<string, { loot: number; enemy: number }> | null = null;
let latestUnits: UnitView[] = [];
let latestGridRadius: number | null = null;
let gridCellMap: Map<string, { q: number; r: number; x: number; y: number; z: number }> | null = null;

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
    latestGridRadius = null;
    gridCellMap = null;
    gridRadiusInput.disabled = false;
    gridBtn.disabled = false;
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

function clearSvg(svg: SVGSVGElement): void {
    while (svg.firstChild) {
        svg.removeChild(svg.firstChild);
    }
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
    gridSvg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);

    const svgNs = "http://www.w3.org/2000/svg";
    for (const pos of positions) {
        const belief = beliefMap?.get(pos.cell.id);
        const fill = belief ? beliefFill(belief.loot, belief.enemy) : "rgba(12, 18, 32, 0.8)";
        const poly = document.createElementNS(svgNs, "polygon");
        poly.setAttribute("points", hexPoints(pos.x, pos.y, HEX_SIZE));
        poly.setAttribute("fill", fill);
        poly.setAttribute("stroke", "rgba(94, 208, 255, 0.35)");
        poly.setAttribute("stroke-width", "1");
        gridSvg.appendChild(poly);

        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", pos.x.toString());
        label.setAttribute("y", pos.y.toString());
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.textContent = `${pos.cell.q},${pos.cell.r}`;
        gridSvg.appendChild(label);
    }

    for (const unit of latestUnits) {
        const { x, y } = axialToPixel(unit.pos.q, unit.pos.r, HEX_SIZE);
        const color = unit.team === "player" ? "#5ed0ff" : "#ff6a5e";
        const ring = document.createElementNS(svgNs, "circle");
        ring.setAttribute("cx", x.toString());
        ring.setAttribute("cy", y.toString());
        ring.setAttribute("r", (HEX_SIZE * 0.42).toString());
        ring.setAttribute("fill", "rgba(10, 16, 30, 0.75)");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "2");
        gridSvg.appendChild(ring);

        const label = document.createElementNS(svgNs, "text");
        label.setAttribute("x", x.toString());
        label.setAttribute("y", (y + 1).toString());
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("dominant-baseline", "middle");
        label.setAttribute("fill", "#e8ecff");
        label.textContent = `${unit.team[0].toUpperCase()}${unit.id}`;
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

function beliefFill(loot: number, enemy: number): string {
    const lootT = clamp01((loot - 0.2) / 0.8);
    const enemyT = clamp01((enemy - 0.2) / 0.8);

    const base = { r: 12, g: 18, b: 32 };
    const lootColor = { r: 244, g: 201, b: 122 };
    const enemyColor = { r: 255, g: 106, b: 94 };

    const mixLoot = {
        r: mixChannel(base.r, lootColor.r, lootT),
        g: mixChannel(base.g, lootColor.g, lootT),
        b: mixChannel(base.b, lootColor.b, lootT),
    };
    const mixEnemy = {
        r: mixChannel(base.r, enemyColor.r, enemyT),
        g: mixChannel(base.g, enemyColor.g, enemyT),
        b: mixChannel(base.b, enemyColor.b, enemyT),
    };

    const final = {
        r: mixChannel(mixLoot.r, mixEnemy.r, enemyT),
        g: mixChannel(mixLoot.g, mixEnemy.g, enemyT),
        b: mixChannel(mixLoot.b, mixEnemy.b, enemyT),
    };

    const alpha = 0.55 + 0.35 * Math.max(lootT, enemyT);
    return `rgba(${final.r}, ${final.g}, ${final.b}, ${alpha.toFixed(2)})`;
}

function initSim(): void {
    if (!wasmReady) return;
    const seed = parseSeed();
    init_game(seed);
    clearLog();
    updateStatus(`Initialized with seed ${seed.toString()}`);
}

function describeEvent(event: SimEvent): string {
    switch (event.type) {
        case "turn_start":
            return `Turn ${event.turn} begins.`;
        case "scan_result": {
            const tag = `${event.team} ${event.mode}`;
            return `${tag} scan updated ${event.updates.length} cells.`;
        }
        case "unit_moved":
            return `Unit ${event.unit_id} moved (${event.from.q},${event.from.r}) → (${event.to.q},${event.to.r}).`;
        case "attack":
            return `Unit ${event.attacker_id} attacked ${event.target_id} (${event.hit ? "hit" : "miss"}) for ${event.damage}.`;
        case "unit_destroyed":
            return `Unit ${event.unit_id} destroyed.`;
        case "loot_recovered":
            return `Unit ${event.unit_id} recovered loot ${event.loot_id} (+${event.value}).`;
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
        row.innerHTML = `#${unit.id} <span class="mono">${unit.team}</span> HP ${unit.hp} @ (${unit.pos.q},${unit.pos.r})${
            unit.has_active_scan ? " · scan" : ""
        }`;
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
    return [...cells]
        .filter((cell) => cell[key] > 0.15)
        .sort((a, b) => b[key] - a[key])
        .slice(0, count);
}

function renderBeliefs(beliefs: TeamBeliefView[]): void {
    beliefList.innerHTML = "";
    if (!beliefs.length) {
        beliefList.textContent = "No belief data yet.";
        return;
    }
    const player = beliefs.find((team) => team.team === "player");
    if (player) {
        beliefMap = new Map(player.cells.map((cell) => [cell.cell_id, { loot: cell.loot, enemy: cell.enemy }]));
    }
    for (const team of beliefs) {
        const header = document.createElement("div");
        header.innerHTML = `<span class="tag">${team.team}</span> top cells`;
        beliefList.appendChild(header);

        const lootTop = pickTopCells(team.cells, "loot", 3);
        const enemyTop = pickTopCells(team.cells, "enemy", 3);

        for (const cell of lootTop) {
            const coord = gridCellMap?.get(cell.cell_id);
            const label = coord ? `${coord.q},${coord.r}` : cell.cell_id;
            const row = document.createElement("div");
            row.textContent = `loot ${label} → ${(cell.loot * 100).toFixed(0)}%`;
            beliefList.appendChild(row);
        }
        for (const cell of enemyTop) {
            const coord = gridCellMap?.get(cell.cell_id);
            const label = coord ? `${coord.q},${coord.r}` : cell.cell_id;
            const row = document.createElement("div");
            row.textContent = `enemy ${label} → ${(cell.enemy * 100).toFixed(0)}%`;
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
                return;
            }
            updateStatus(`Tick error: ${payload}`);
            return;
        }
        const log = JSON.parse(payload) as TurnLog;
        latestUnits = log.units ?? [];
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
        renderUnits(log.units);
        renderLoot(log.loot);
        renderBeliefs(log.beliefs ?? []);
        renderGrid();
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
    renderGrid();
}

initBtn.addEventListener("click", () => initSim());
stepBtn.addEventListener("click", () => stepSim());
runBtn.addEventListener("click", () => setRunning(!running));
clearBtn.addEventListener("click", () => clearLog());
gridBtn.addEventListener("click", () => renderGrid());
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
