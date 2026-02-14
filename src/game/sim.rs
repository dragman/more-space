use crate::hex::{pack_id, CubeCoord, HexGrid};
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;
use ts_rs::TS;

const BASE_ENEMY_PRIOR: f64 = 0.04;
const BASE_LOOT_PRIOR: f64 = 0.08;
const EPSILON: f64 = 1e-4;

type TeamId = u8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum ScanMode {
    Visual,
    Passive,
    Active,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum DecisionIntent {
    Advance,
    Retreat,
    SeekLoot,
    Wander,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct SimConfig {
    pub grid_radius: u32,
    pub visible_radius: u32,
    pub passive_decay: f64,
    pub passive_strength: f64,
    pub active_strength: f64,
    pub active_cooldown: u32,
    pub belief_decay_rate: f64,
    pub team_count: usize,
    pub min_units_per_team: usize,
    pub max_units_per_team: usize,
    pub exit_points_count: usize,
    pub max_loot: usize,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            grid_radius: 16,
            visible_radius: 4,
            passive_decay: 6.0,
            passive_strength: 0.7,
            active_strength: 0.9,
            active_cooldown: 4,
            belief_decay_rate: 0.05,
            team_count: 3,
            min_units_per_team: 2,
            max_units_per_team: 5,
            exit_points_count: 4,
            max_loot: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct TeamColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct TeamView {
    pub id: TeamId,
    pub name: String,
    pub color: TeamColor,
}

#[derive(Debug, Clone)]
struct GridCell {
    id: u64,
    coord: CubeCoord,
}

#[derive(Debug, Clone)]
struct Grid {
    radius: u32,
    cells: Vec<GridCell>,
    id_to_index: HashMap<u64, usize>,
}

impl Grid {
    fn new(radius: u32) -> Self {
        let grid = HexGrid::new(radius);
        let cells: Vec<GridCell> = grid
            .cell_positions()
            .into_iter()
            .map(|pos| GridCell {
                id: pos.id,
                coord: pos.coord,
            })
            .collect();
        let id_to_index = cells
            .iter()
            .enumerate()
            .map(|(idx, cell)| (cell.id, idx))
            .collect();
        Self {
            radius,
            cells,
            id_to_index,
        }
    }

    fn in_bounds(&self, coord: &CubeCoord) -> bool {
        coord.distance_from_origin() <= self.radius
    }

    fn cell_index(&self, id: u64) -> Option<usize> {
        self.id_to_index.get(&id).copied()
    }

    fn neighbors(&self, coord: &CubeCoord) -> Vec<CubeCoord> {
        const DIRS: [(i32, i32, i32); 6] = [
            (1, -1, 0),
            (1, 0, -1),
            (0, 1, -1),
            (-1, 1, 0),
            (-1, 0, 1),
            (0, -1, 1),
        ];
        DIRS.iter()
            .filter_map(|(dx, dy, dz)| {
                let next = CubeCoord::new(coord.x + dx, coord.y + dy, coord.z + dz);
                if self.in_bounds(&next) {
                    Some(next)
                } else {
                    None
                }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct UnitView {
    pub id: u32,
    pub team_id: TeamId,
    pub archetype: AiArchetype,
    pub hp: i32,
    pub pos: CellRef,
    pub attack_range: u32,
    pub attack_damage: i32,
    pub movement_range: u32,
    pub weapon_type: WeaponType,
    pub inventory_slots: u32,
    pub inventory_used: u32,
    pub visible_radius: u32,
    pub has_active_scan: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum WeaponType {
    PulseLaser,
    Railgun,
}

#[derive(Debug, Clone, Copy)]
struct WeaponProfile {
    range: u32,
    damage: i32,
    accuracy: f64,
}

impl WeaponType {
    fn profile(self) -> WeaponProfile {
        match self {
            WeaponType::PulseLaser => WeaponProfile {
                range: 2,
                damage: 4,
                accuracy: 0.68,
            },
            WeaponType::Railgun => WeaponProfile {
                range: 3,
                damage: 5,
                accuracy: 0.54,
            },
        }
    }
}

#[derive(Debug, Clone)]
struct UnitStats {
    hp_max: i32,
    movement_range: u32,
    weapon: WeaponType,
    inventory_slots: u32,
    scan_range: u32,
    has_active_scan: bool,
}

#[derive(Debug, Clone)]
struct Unit {
    id: u32,
    team_id: TeamId,
    archetype: AiArchetype,
    pos: CubeCoord,
    hp: i32,
    spawn_turn: u32,
    inventory_used: u32,
    stats: UnitStats,
    active_scan_cd: u32,
}

impl Unit {
    fn weapon_profile(&self) -> WeaponProfile {
        self.stats.weapon.profile()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum AiArchetype {
    Scout,
    Dreadnaught,
}

fn unit_stats_for(archetype: AiArchetype, visible_radius: u32) -> UnitStats {
    match archetype {
        AiArchetype::Scout => UnitStats {
            hp_max: 24,
            movement_range: 2,
            weapon: WeaponType::PulseLaser,
            inventory_slots: 2,
            scan_range: visible_radius,
            has_active_scan: true,
        },
        AiArchetype::Dreadnaught => UnitStats {
            hp_max: 32,
            movement_range: 1,
            weapon: WeaponType::Railgun,
            inventory_slots: 4,
            scan_range: visible_radius,
            has_active_scan: true,
        },
    }
}

fn random_archetype_for_team<R: Rng>(team_id: TeamId, rng: &mut R) -> AiArchetype {
    let dread_chance = if team_id % 2 == 0 { 0.4 } else { 0.3 };
    if rng.gen_bool(dread_chance) {
        AiArchetype::Dreadnaught
    } else {
        AiArchetype::Scout
    }
}

const TEAM_PALETTE: [(&str, TeamColor); 8] = [
    ("Verdant", TeamColor { r: 0, g: 158, b: 115 }),
    ("Coral", TeamColor { r: 213, g: 94, b: 0 }),
    ("Cobalt", TeamColor { r: 0, g: 114, b: 178 }),
    ("Amber", TeamColor { r: 230, g: 159, b: 0 }),
    ("Orchid", TeamColor { r: 204, g: 121, b: 167 }),
    ("Sky", TeamColor { r: 86, g: 180, b: 233 }),
    ("Crimson", TeamColor { r: 220, g: 50, b: 47 }),
    ("Mint", TeamColor { r: 102, g: 194, b: 165 }),
];

fn build_team_states<R: Rng>(rng: &mut R, config: &SimConfig) -> Vec<TeamState> {
    let desired = config.team_count.clamp(2, TEAM_PALETTE.len());
    let mut pool: Vec<(&str, TeamColor)> = TEAM_PALETTE.to_vec();
    for i in (1..pool.len()).rev() {
        let j = rng.gen_range(0..=i);
        pool.swap(i, j);
    }
    let min_units = config.min_units_per_team.max(1);
    let max_units = config.max_units_per_team.max(min_units);
    (0..desired)
        .map(|idx| {
            let (name, color) = pool[idx].clone();
            TeamState {
                view: TeamView {
                    id: idx as TeamId,
                    name: name.to_string(),
                    color,
                },
                unit_count: rng.gen_range(min_units..=max_units),
            }
        })
        .collect()
}

#[derive(Debug, Clone)]
struct LootNode {
    id: u32,
    pos: CubeCoord,
    value: u32,
    claimed: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct LootView {
    pub id: u32,
    pub pos: CellRef,
    pub value: u32,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct CellRef {
    pub id: String,
    pub q: i32,
    pub r: i32,
}

impl CellRef {
    fn from_coord(coord: &CubeCoord) -> Self {
        let (q, r) = coord.axial();
        Self {
            id: pack_id(q, r).to_string(),
            q,
            r,
        }
    }
}

#[derive(Debug, Clone)]
struct CellBelief {
    enemy: f64,
    loot: f64,
}

#[derive(Debug, Clone)]
struct TeamKnowledge {
    beliefs: Vec<CellBelief>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct BeliefUpdate {
    pub cell_id: String,
    pub enemy: f64,
    pub loot: f64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct TeamBeliefCell {
    pub cell_id: String,
    pub enemy: f64,
    pub loot: f64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct TeamBeliefView {
    pub team_id: TeamId,
    pub cells: Vec<TeamBeliefCell>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct ExitPointView {
    pub id: u32,
    pub pos: CellRef,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum SimEvent {
    TurnStart {
        turn: u32,
    },
    ScanResult {
        team_id: TeamId,
        mode: ScanMode,
        updates: Vec<BeliefUpdate>,
    },
    UnitDecision {
        unit_id: u32,
        intent: DecisionIntent,
        reason: String,
        target: Option<CellRef>,
    },
    UnitMoved {
        unit_id: u32,
        from: CellRef,
        to: CellRef,
        movement_range: u32,
    },
    Attack {
        attacker_id: u32,
        target_id: u32,
        weapon_type: WeaponType,
        weapon_range: u32,
        base_damage: i32,
        hit: bool,
        damage: i32,
    },
    UnitDestroyed {
        unit_id: u32,
    },
    LootRecovered {
        unit_id: u32,
        loot_id: u32,
        value: u32,
    },
    LootDropped {
        unit_id: u32,
        loot_id: u32,
        value: u32,
        pos: CellRef,
    },
    UnitExited {
        unit_id: u32,
        exit_id: u32,
    },
    ActiveScanPing {
        unit_id: u32,
        center: CellRef,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct TurnLog {
    pub turn: u32,
    pub events: Vec<SimEvent>,
    pub units: Vec<UnitView>,
    pub loot: Vec<LootView>,
    pub beliefs: Vec<TeamBeliefView>,
    pub teams: Vec<TeamView>,
    pub exits: Vec<ExitPointView>,
    pub grid_radius: u32,
}

#[derive(Debug, Clone)]
struct TeamState {
    view: TeamView,
    unit_count: usize,
}

pub struct SimState {
    config: SimConfig,
    grid: Grid,
    ai: GameAi,
    units: Vec<Unit>,
    loot: Vec<LootNode>,
    exits: Vec<CubeCoord>,
    teams: Vec<TeamState>,
    knowledge: Vec<TeamKnowledge>,
    turn: u32,
    next_unit_id: u32,
    next_loot_id: u32,
}

impl SimState {
    pub fn new<R: Rng>(rng: &mut R, config: SimConfig) -> Self {
        let grid = Grid::new(config.grid_radius);
        let teams = build_team_states(rng, &config);
        let beliefs = vec![
            CellBelief {
                enemy: BASE_ENEMY_PRIOR,
                loot: BASE_LOOT_PRIOR,
            };
            grid.cells.len()
        ];
        let knowledge = (0..teams.len())
            .map(|_| TeamKnowledge {
                beliefs: beliefs.clone(),
            })
            .collect();
        let mut state = Self {
            config,
            grid,
            ai: GameAi::default(),
            units: Vec::new(),
            loot: Vec::new(),
            exits: Vec::new(),
            teams,
            knowledge,
            turn: 0,
            next_unit_id: 1,
            next_loot_id: 1,
        };
        state.spawn_defaults(rng);
        state
    }

    fn spawn_defaults<R: Rng>(&mut self, rng: &mut R) {
        self.spawn_exit_points(rng);
        let mut anchors: Vec<CubeCoord> = Vec::new();
        let team_spawns: Vec<(TeamId, usize)> = self
            .teams
            .iter()
            .map(|team| (team.view.id, team.unit_count.max(1)))
            .collect();
        for (team_idx, (team_id, unit_count)) in team_spawns.iter().enumerate() {
            let anchor = self.pick_team_anchor(rng, &anchors);
            anchors.push(anchor);
            let mut has_dread = false;
            for idx in 0..*unit_count {
                let mut archetype = random_archetype_for_team(*team_id, rng);
                if idx == *unit_count - 1 && !has_dread {
                    archetype = AiArchetype::Dreadnaught;
                }
                if archetype == AiArchetype::Dreadnaught {
                    has_dread = true;
                }
                let stats = unit_stats_for(archetype, self.config.visible_radius);
                let pos = if idx == 0 {
                    anchor
                } else if team_idx == 0 {
                    self.random_empty_cell_for_unit(rng)
                } else {
                    self.random_far_empty_cell(rng, &anchor, 2)
                };
                self.spawn_unit(*team_id, archetype, pos, stats);
            }
        }

        for _ in 0..self.config.max_loot {
            let pos = self.random_cell(rng);
            self.spawn_loot(rng, pos);
        }
    }

    fn spawn_unit(
        &mut self,
        team_id: TeamId,
        archetype: AiArchetype,
        pos: CubeCoord,
        stats: UnitStats,
    ) {
        let id = self.next_unit_id;
        self.next_unit_id += 1;
        self.units.push(Unit {
            id,
            team_id,
            archetype,
            pos,
            hp: stats.hp_max,
            spawn_turn: self.turn,
            inventory_used: 0,
            stats,
            active_scan_cd: 0,
        });
    }

    fn pick_team_anchor<R: Rng>(&self, rng: &mut R, existing: &[CubeCoord]) -> CubeCoord {
        if existing.is_empty() {
            return self.random_empty_cell_for_unit(rng);
        }
        let min_sep = (self.grid.radius / 2).max(3);
        for _ in 0..128 {
            let candidate = self.random_empty_cell_for_unit(rng);
            let far = existing
                .iter()
                .all(|anchor| cube_distance(anchor, &candidate) >= min_sep);
            if far {
                return candidate;
            }
        }
        self.random_empty_cell_for_unit(rng)
    }

    fn spawn_loot<R: Rng>(&mut self, rng: &mut R, pos: CubeCoord) {
        let value = rng.gen_range(10..=60);
        self.spawn_loot_with_value(pos, value);
    }

    fn spawn_loot_with_value(&mut self, pos: CubeCoord, value: u32) -> u32 {
        let id = self.next_loot_id;
        self.next_loot_id += 1;
        self.loot.push(LootNode {
            id,
            pos,
            value,
            claimed: false,
        });
        id
    }

    fn spawn_exit_points<R: Rng>(&mut self, rng: &mut R) {
        let mut edge_cells: Vec<CubeCoord> = self
            .grid
            .cells
            .iter()
            .filter(|cell| cell.coord.distance_from_origin() == self.grid.radius)
            .map(|cell| cell.coord)
            .collect();
        if edge_cells.is_empty() {
            return;
        }
        let desired = self.config.exit_points_count.max(1).min(edge_cells.len());
        self.exits.clear();
        while self.exits.len() < desired && !edge_cells.is_empty() {
            let idx = rng.gen_range(0..edge_cells.len());
            let candidate = edge_cells.swap_remove(idx);
            if self.exits.is_empty() {
                self.exits.push(candidate);
                continue;
            }
            let min_sep = ((self.grid.radius as f64) * 0.9).round() as u32;
            let far_enough = self
                .exits
                .iter()
                .all(|existing| cube_distance(existing, &candidate) >= min_sep.max(3));
            if far_enough || edge_cells.is_empty() {
                self.exits.push(candidate);
            }
        }
        if self.exits.len() < desired {
            for cell in self
                .grid
                .cells
                .iter()
                .filter(|cell| cell.coord.distance_from_origin() == self.grid.radius)
                .map(|cell| cell.coord)
            {
                if self.exits.len() >= desired {
                    break;
                }
                if !self.exits.contains(&cell) {
                    self.exits.push(cell);
                }
            }
        }
    }

    fn random_cell<R: Rng>(&self, rng: &mut R) -> CubeCoord {
        let idx = rng.gen_range(0..self.grid.cells.len());
        self.grid.cells[idx].coord
    }

    fn random_far_cell<R: Rng>(&self, rng: &mut R, from: &CubeCoord, min_dist: u32) -> CubeCoord {
        for _ in 0..50 {
            let candidate = self.random_cell(rng);
            if cube_distance(from, &candidate) >= min_dist {
                return candidate;
            }
        }
        self.random_cell(rng)
    }

    fn random_empty_cell_for_unit<R: Rng>(&self, rng: &mut R) -> CubeCoord {
        let free_cells: Vec<CubeCoord> = self
            .grid
            .cells
            .iter()
            .map(|cell| cell.coord)
            .filter(|coord| !self.is_occupied_by_unit(coord, None))
            .collect();
        if !free_cells.is_empty() {
            let idx = rng.gen_range(0..free_cells.len());
            return free_cells[idx];
        }

        for _ in 0..64 {
            let candidate = self.random_cell(rng);
            if !self.is_occupied_by_unit(&candidate, None) {
                return candidate;
            }
        }
        self.random_cell(rng)
    }

    fn random_far_empty_cell<R: Rng>(
        &self,
        rng: &mut R,
        from: &CubeCoord,
        min_dist: u32,
    ) -> CubeCoord {
        for _ in 0..64 {
            let candidate = self.random_far_cell(rng, from, min_dist);
            if !self.is_occupied_by_unit(&candidate, None) {
                return candidate;
            }
        }
        self.random_far_cell(rng, from, min_dist)
    }

    fn is_occupied_by_unit(&self, coord: &CubeCoord, except_unit_id: Option<u32>) -> bool {
        self.units
            .iter()
            .any(|unit| unit.hp > 0 && Some(unit.id) != except_unit_id && unit.pos == *coord)
    }

    pub fn tick<R: Rng>(&mut self, rng: &mut R) -> TurnLog {
        self.turn += 1;
        let mut events = vec![SimEvent::TurnStart { turn: self.turn }];

        self.decay_beliefs();
        self.apply_visual_scans(&mut events);
        self.apply_passive_scans(rng, &mut events);
        self.apply_active_scans(rng, &mut events);

        self.move_units(rng, &mut events);
        self.resolve_combat(rng, &mut events);
        self.remove_destroyed_units();
        self.resolve_loot(&mut events);
        self.resolve_exits(&mut events);

        let units = self
            .units
            .iter()
            .map(|unit| {
                let weapon = unit.weapon_profile();
                UnitView {
                    id: unit.id,
                    team_id: unit.team_id,
                    archetype: unit.archetype,
                    hp: unit.hp,
                    pos: CellRef::from_coord(&unit.pos),
                    attack_range: weapon.range,
                    attack_damage: weapon.damage,
                    movement_range: unit.stats.movement_range,
                    weapon_type: unit.stats.weapon,
                    inventory_slots: unit.stats.inventory_slots,
                    inventory_used: unit.inventory_used,
                    visible_radius: unit.stats.scan_range,
                    has_active_scan: unit.stats.has_active_scan,
                }
            })
            .collect();
        let loot = self
            .loot
            .iter()
            .map(|node| LootView {
                id: node.id,
                pos: CellRef::from_coord(&node.pos),
                value: node.value,
                claimed: node.claimed,
            })
            .collect();
        let beliefs = self.belief_views();
        let exits = self
            .exits
            .iter()
            .enumerate()
            .map(|(idx, pos)| ExitPointView {
                id: (idx + 1) as u32,
                pos: CellRef::from_coord(pos),
            })
            .collect();

        TurnLog {
            turn: self.turn,
            events,
            units,
            loot,
            beliefs,
            teams: self.teams.iter().map(|team| team.view.clone()).collect(),
            exits,
            grid_radius: self.config.grid_radius,
        }
    }

    fn decay_beliefs(&mut self) {
        let rate = self.config.belief_decay_rate.clamp(0.0, 1.0);
        if rate <= 0.0 {
            return;
        }
        for team_id in self.teams.iter().map(|team| team.view.id) {
            for belief in &mut self.knowledge[team_id as usize].beliefs {
                belief.enemy = decay_toward_prior(belief.enemy, BASE_ENEMY_PRIOR, rate);
                belief.loot = decay_toward_prior(belief.loot, BASE_LOOT_PRIOR, rate);
            }
        }
    }

    fn apply_visual_scans(&mut self, events: &mut Vec<SimEvent>) {
        let team_ids: Vec<TeamId> = self.teams.iter().map(|team| team.view.id).collect();
        for team_id in team_ids {
            let updates = self.scan_team_visual(team_id);
            if !updates.is_empty() {
                events.push(SimEvent::ScanResult {
                    team_id,
                    mode: ScanMode::Visual,
                    updates,
                });
            }
        }
    }

    fn apply_passive_scans<R: Rng>(&mut self, rng: &mut R, events: &mut Vec<SimEvent>) {
        let team_ids: Vec<TeamId> = self.teams.iter().map(|team| team.view.id).collect();
        for team_id in team_ids {
            let updates = self.scan_team_with_rng(team_id, ScanMode::Passive, rng);
            if !updates.is_empty() {
                events.push(SimEvent::ScanResult {
                    team_id,
                    mode: ScanMode::Passive,
                    updates,
                });
            }
        }
    }

    fn apply_active_scans<R: Rng>(&mut self, rng: &mut R, events: &mut Vec<SimEvent>) {
        let units = self.units.clone();
        for unit in units {
            if unit.hp <= 0 || unit.active_scan_cd > 0 || !unit.stats.has_active_scan {
                continue;
            }
            if !self.ai.should_active_scan(rng, &unit, self) {
                continue;
            }

            let center = CellRef::from_coord(&unit.pos);
            events.push(SimEvent::ActiveScanPing {
                unit_id: unit.id,
                center,
            });

            let updates = self.scan_team_with_rng(unit.team_id, ScanMode::Active, rng);
            if !updates.is_empty() {
                events.push(SimEvent::ScanResult {
                    team_id: unit.team_id,
                    mode: ScanMode::Active,
                    updates,
                });
            }

            self.reveal_active_scan(&unit, events);
            if let Some(real_unit) = self.units.iter_mut().find(|u| u.id == unit.id) {
                real_unit.active_scan_cd = self.config.active_cooldown;
            }
        }

        for unit in self.units.iter_mut() {
            if unit.active_scan_cd > 0 {
                unit.active_scan_cd -= 1;
            }
        }
    }

    fn scan_team_visual(&mut self, team_id: TeamId) -> Vec<BeliefUpdate> {
        let mut updates = Vec::new();
        let team_units: Vec<&Unit> = self
            .units
            .iter()
            .filter(|u| u.team_id == team_id && u.hp > 0)
            .collect();
        if team_units.is_empty() {
            return updates;
        }

        for cell in &self.grid.cells {
            let distance = team_units
                .iter()
                .map(|unit| cube_distance(&unit.pos, &cell.coord))
                .min()
                .unwrap_or(self.grid.radius);
            if distance > self.config.visible_radius {
                continue;
            }

            let (has_enemy, has_loot) = self.cell_truth(cell.coord, team_id);
            let enemy_prob = if has_enemy { 1.0 } else { 0.0 };
            let loot_prob = if has_loot { 1.0 } else { 0.0 };

            let idx = self.grid.cell_index(cell.id).unwrap();
            let belief = &mut self.knowledge[team_id as usize].beliefs[idx];
            update_belief(belief, enemy_prob, loot_prob, &mut updates, cell.id);
        }

        updates
    }

    fn scan_team_with_rng<R: Rng>(
        &mut self,
        team_id: TeamId,
        mode: ScanMode,
        rng: &mut R,
    ) -> Vec<BeliefUpdate> {
        let mut updates = Vec::new();
        let team_units: Vec<&Unit> = self
            .units
            .iter()
            .filter(|u| u.team_id == team_id && u.hp > 0)
            .collect();
        if team_units.is_empty() {
            return updates;
        }

        for cell in &self.grid.cells {
            let distance = team_units
                .iter()
                .map(|unit| cube_distance(&unit.pos, &cell.coord))
                .min()
                .unwrap_or(self.grid.radius);
            if distance <= self.config.visible_radius {
                continue;
            }

            let (has_enemy, has_loot) = self.cell_truth(cell.coord, team_id);
            let (p_detect, p_false) = self.scan_params(mode, distance);
            let enemy_hit = sample_detection(rng, has_enemy, p_detect, p_false);
            let loot_hit = sample_detection(rng, has_loot, p_detect, p_false);

            let idx = self.grid.cell_index(cell.id).unwrap();
            let belief = &mut self.knowledge[team_id as usize].beliefs[idx];
            let new_enemy = bayes_update(belief.enemy, enemy_hit, p_detect, p_false);
            let new_loot = bayes_update(belief.loot, loot_hit, p_detect, p_false);
            update_belief(belief, new_enemy, new_loot, &mut updates, cell.id);
        }

        updates
    }

    fn reveal_active_scan(&mut self, scanner: &Unit, events: &mut Vec<SimEvent>) {
        let center_id = pack_id(scanner.pos.x, scanner.pos.z);
        for team_id in self.teams.iter().map(|team| team.view.id) {
            if team_id == scanner.team_id {
                continue;
            }
            let team_has_living_unit = self
                .units
                .iter()
                .any(|unit| unit.team_id == team_id && unit.hp > 0);
            if !team_has_living_unit {
                continue;
            }
            if let Some(idx) = self.grid.cell_index(center_id) {
                let belief = &mut self.knowledge[team_id as usize].beliefs[idx];
                let enemy_prob = 0.85;
                let loot_prob = belief.loot;
                let mut updates = Vec::new();
                update_belief(belief, enemy_prob, loot_prob, &mut updates, center_id);
                if !updates.is_empty() {
                    events.push(SimEvent::ScanResult {
                        team_id,
                        mode: ScanMode::Active,
                        updates,
                    });
                }
            }
        }
    }

    fn scan_params(&self, mode: ScanMode, distance: u32) -> (f64, f64) {
        let dist = distance as f64;
        let strength = match mode {
            ScanMode::Active => self.config.active_strength,
            _ => self.config.passive_strength,
        };
        let falloff = (-dist / self.config.passive_decay).exp();
        let mut p_detect = strength * falloff;
        if p_detect < 0.05 {
            p_detect = 0.05;
        }
        if p_detect > 0.95 {
            p_detect = 0.95;
        }
        let mut p_false = 0.02 + (1.0 - p_detect) * 0.12;
        if p_false > 0.25 {
            p_false = 0.25;
        }
        (p_detect, p_false)
    }

    fn cell_truth(&self, coord: CubeCoord, team_id: TeamId) -> (bool, bool) {
        let enemy_present = self
            .units
            .iter()
            .any(|unit| unit.team_id != team_id && unit.pos == coord && unit.hp > 0);
        let loot_present = self
            .loot
            .iter()
            .any(|loot| !loot.claimed && loot.pos == coord);
        (enemy_present, loot_present)
    }

    fn move_units<R: Rng>(&mut self, rng: &mut R, events: &mut Vec<SimEvent>) {
        let units_snapshot = self.units.clone();
        for unit in units_snapshot {
            if unit.hp <= 0 {
                continue;
            }
            let decision = self.ai.choose_movement_decision(rng, &unit, self);
            let intent = decision.intent;
            events.push(SimEvent::UnitDecision {
                unit_id: unit.id,
                intent: decision.intent_kind,
                reason: decision.reason,
                target: decision.target.map(|coord| CellRef::from_coord(&coord)),
            });
            let mut steps = unit.stats.movement_range.max(1);
            let mut current = unit.pos;
            while steps > 0 {
                let mut candidates = self.grid.neighbors(&current);
                if candidates.is_empty() {
                    break;
                }
                candidates.retain(|coord| !self.is_occupied_by_unit(coord, Some(unit.id)));
                if candidates.is_empty() {
                    break;
                }
                let next = match intent {
                    MovementIntent::Toward(target_pos) => {
                        candidates.sort_by_key(|coord| cube_distance(coord, &target_pos));
                        candidates[0]
                    }
                    MovementIntent::AwayFrom(threat_pos) => {
                        candidates.sort_by_key(|coord| {
                            std::cmp::Reverse(cube_distance(coord, &threat_pos))
                        });
                        candidates[0]
                    }
                    MovementIntent::Random => {
                        let idx = rng.gen_range(0..candidates.len());
                        candidates[idx]
                    }
                    MovementIntent::Hold => break,
                };
                if next == current {
                    break;
                }
                let from = CellRef::from_coord(&current);
                let to = CellRef::from_coord(&next);
                current = next;
                if let Some(real_unit) = self.units.iter_mut().find(|u| u.id == unit.id) {
                    real_unit.pos = current;
                }
                events.push(SimEvent::UnitMoved {
                    unit_id: unit.id,
                    from,
                    to,
                    movement_range: unit.stats.movement_range,
                });
                steps = steps.saturating_sub(1);
            }
        }
    }

    fn resolve_combat<R: Rng>(&mut self, rng: &mut R, events: &mut Vec<SimEvent>) {
        let attackers = self.units.clone();
        for attacker in attackers {
            if attacker.hp <= 0 {
                continue;
            }
            let target_id = self
                .units
                .iter()
                .find(|unit| {
                    let weapon = attacker.weapon_profile();
                    unit.team_id != attacker.team_id
                        && unit.hp > 0
                        && cube_distance(&attacker.pos, &unit.pos) <= weapon.range
                })
                .map(|unit| unit.id);
            if let Some(target_id) = target_id {
                let weapon = attacker.weapon_profile();
                let hit = rng.gen_bool(weapon.accuracy);
                let damage = if hit { weapon.damage } else { 0 };
                events.push(SimEvent::Attack {
                    attacker_id: attacker.id,
                    target_id,
                    weapon_type: attacker.stats.weapon,
                    weapon_range: weapon.range,
                    base_damage: weapon.damage,
                    hit,
                    damage,
                });
                if hit {
                    if let Some(real_target) = self.units.iter_mut().find(|u| u.id == target_id) {
                        real_target.hp -= damage;
                        if real_target.hp <= 0 {
                            events.push(SimEvent::UnitDestroyed { unit_id: target_id });
                            let drop_value =
                                (real_target.stats.hp_max.max(4) as u32) + rng.gen_range(4..=14);
                            let drop_pos = real_target.pos;
                            let loot_id = self.spawn_loot_with_value(drop_pos, drop_value);
                            events.push(SimEvent::LootDropped {
                                unit_id: target_id,
                                loot_id,
                                value: drop_value,
                                pos: CellRef::from_coord(&drop_pos),
                            });
                        }
                    }
                }
            }
        }
    }

    fn resolve_loot(&mut self, events: &mut Vec<SimEvent>) {
        for unit in self.units.iter_mut() {
            if unit.hp <= 0 {
                continue;
            }
            for loot in self.loot.iter_mut() {
                if loot.claimed || loot.pos != unit.pos {
                    continue;
                }
                if unit.inventory_used >= unit.stats.inventory_slots {
                    continue;
                }
                loot.claimed = true;
                unit.inventory_used += 1;
                events.push(SimEvent::LootRecovered {
                    unit_id: unit.id,
                    loot_id: loot.id,
                    value: loot.value,
                });
            }
        }
    }

    fn resolve_exits(&mut self, events: &mut Vec<SimEvent>) {
        let mut exited: Vec<(u32, u32)> = Vec::new();
        for unit in &self.units {
            if !self.ai.inventory_full(unit) {
                continue;
            }
            if let Some(exit_idx) = self.exits.iter().position(|exit_pos| *exit_pos == unit.pos) {
                exited.push((unit.id, (exit_idx + 1) as u32));
            }
        }
        if exited.is_empty() {
            return;
        }
        for (unit_id, exit_id) in &exited {
            events.push(SimEvent::UnitExited {
                unit_id: *unit_id,
                exit_id: *exit_id,
            });
        }
        self.units
            .retain(|unit| !exited.iter().any(|(id, _)| *id == unit.id));
    }

    fn remove_destroyed_units(&mut self) {
        self.units.retain(|unit| unit.hp > 0);
    }

    fn belief_views(&self) -> Vec<TeamBeliefView> {
        self.teams
            .iter()
            .map(|team| TeamBeliefView {
                team_id: team.view.id,
                cells: self.knowledge[team.view.id as usize]
                    .beliefs
                    .iter()
                    .enumerate()
                    .map(|(idx, belief)| {
                        let cell = &self.grid.cells[idx];
                        TeamBeliefCell {
                            cell_id: cell.id.to_string(),
                            enemy: belief.enemy,
                            loot: belief.loot,
                        }
                    })
                    .collect(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct GameAi;

#[derive(Debug, Clone, Copy)]
struct AiProfile {
    aggression: f64,
    caution: f64,
    scan_bias: f64,
    loot_bias: f64,
    retreat_hp_ratio: f64,
}

#[derive(Debug, Clone, Copy)]
enum MovementIntent {
    Toward(CubeCoord),
    AwayFrom(CubeCoord),
    Random,
    Hold,
}

struct MovementDecision {
    intent: MovementIntent,
    intent_kind: DecisionIntent,
    reason: String,
    target: Option<CubeCoord>,
}

#[derive(Debug, Clone, Copy)]
struct EnemyContext {
    id: u32,
    pos: CubeCoord,
    dist: u32,
    threat_ratio: f64,
    confidence: f64,
    pressured: bool,
    weak: bool,
}

#[derive(Debug, Clone, Copy)]
struct AiContext {
    hp_ratio: f64,
    full_inventory: bool,
    nearly_full_inventory: bool,
    turns_on_map: u32,
    best_loot_signal: f64,
    best_hostile_signal: f64,
    has_living_enemy: bool,
    exit_pos: Option<CubeCoord>,
    enemy: Option<EnemyContext>,
}

struct ScoredDecision {
    score: f64,
    decision: MovementDecision,
}

impl GameAi {
    fn should_active_scan<R: Rng>(&self, rng: &mut R, unit: &Unit, sim: &SimState) -> bool {
        let profile = self.profile_for(unit.archetype);
        let hp_ratio = self.hp_ratio(unit);
        if self.enemy_in_visual_range(unit, &sim.units) {
            let panic_scan = hp_ratio < 0.45 && profile.caution > 0.6;
            return panic_scan && rng.gen_bool((profile.scan_bias + 0.15).clamp(0.1, 0.9));
        }
        let best_loot = self.best_loot_belief(unit.team_id, &sim.knowledge);
        let loot_threshold = (0.75 - profile.loot_bias * 0.2).clamp(0.4, 0.8);
        if best_loot >= loot_threshold {
            return false;
        }
        let desperation = (1.0 - hp_ratio) * 0.35;
        let chance = (profile.scan_bias + desperation).clamp(0.1, 0.9);
        rng.gen_bool(chance)
    }

    fn choose_movement_decision<R: Rng>(
        &self,
        _rng: &mut R,
        unit: &Unit,
        sim: &SimState,
    ) -> MovementDecision {
        let profile = self.profile_for(unit.archetype);
        let ctx = self.build_context(unit, sim);
        let mut candidates: Vec<ScoredDecision> = Vec::new();

        if let Some(exit_pos) = ctx.exit_pos {
            let inventory_pressure: f64 = if ctx.full_inventory {
                1.0
            } else if ctx.nearly_full_inventory {
                0.78
            } else {
                0.0
            };
            let survival_pressure: f64 =
                if ctx.hp_ratio <= profile.retreat_hp_ratio && ctx.enemy.is_some() {
                0.86
            } else {
                0.0
            };
            let stale_pressure: f64 = if ctx.turns_on_map >= 12
                && ctx.best_loot_signal < 0.45
                && ctx.best_hostile_signal < 0.45
            {
                0.72
            } else {
                0.0
            };
            let exfil_score = inventory_pressure.max(survival_pressure).max(stale_pressure);
            if exfil_score > 0.0 {
                let reason = if inventory_pressure >= survival_pressure && inventory_pressure >= stale_pressure {
                    format!(
                        "exfil score {:.2}: inventory pressure {}/{}",
                        exfil_score, unit.inventory_used, unit.stats.inventory_slots
                    )
                } else if survival_pressure >= stale_pressure {
                    format!(
                        "exfil score {:.2}: low hp ({:.0}%) with nearby threat",
                        exfil_score,
                        ctx.hp_ratio * 100.0
                    )
                } else {
                    format!(
                        "exfil score {:.2}: {} turns with weak signals (loot {:.0}%, hostile {:.0}%)",
                        exfil_score,
                        ctx.turns_on_map,
                        ctx.best_loot_signal * 100.0,
                        ctx.best_hostile_signal * 100.0
                    )
                };
                candidates.push(ScoredDecision {
                    score: exfil_score,
                    decision: MovementDecision {
                        intent: MovementIntent::Toward(exit_pos),
                        intent_kind: DecisionIntent::Retreat,
                        reason,
                        target: Some(exit_pos),
                    },
                });
            }
        }

        if let Some(enemy) = ctx.enemy {
            let threat_term = ((enemy.threat_ratio - 0.9) / 0.8).clamp(0.0, 1.0);
            let low_hp_term = if ctx.hp_ratio <= profile.retreat_hp_ratio { 1.0 } else { 0.0 };
            let pressure_term = if enemy.pressured { 1.0 } else { 0.25 };
            let caution_term = ((profile.caution - profile.aggression) + 1.0).clamp(0.0, 2.0) * 0.5;
            let mut retreat_score =
                pressure_term * 0.34 + threat_term * 0.38 + low_hp_term * 0.16 + caution_term * 0.12;
            if enemy.weak {
                retreat_score *= 0.45;
            }
            if retreat_score >= 0.55 {
                candidates.push(ScoredDecision {
                    score: retreat_score,
                    decision: MovementDecision {
                        intent: MovementIntent::AwayFrom(enemy.pos),
                        intent_kind: DecisionIntent::Retreat,
                        reason: format!(
                            "retreat score {:.2}: threat {:.2}, dist {}, hp {:.0}%",
                            retreat_score,
                            enemy.threat_ratio,
                            enemy.dist,
                            ctx.hp_ratio * 100.0
                        ),
                        target: Some(enemy.pos),
                    },
                });
            }

            let confidence_term = enemy.confidence.clamp(0.0, 1.0);
            let range_term = if enemy.dist > unit.weapon_profile().range {
                1.0
            } else {
                0.35
            };
            let safety_term = (1.2 - enemy.threat_ratio).clamp(0.0, 1.0);
            let advance_score = confidence_term * 0.45
                + profile.aggression * 0.25
                + range_term * 0.2
                + safety_term * 0.1;
            if advance_score >= 0.55 {
                candidates.push(ScoredDecision {
                    score: advance_score,
                    decision: MovementDecision {
                        intent: MovementIntent::Toward(enemy.pos),
                        intent_kind: DecisionIntent::Advance,
                        reason: format!(
                            "advance score {:.2}: enemy {} conf {:.2} threat {:.2}",
                            advance_score, enemy.id, enemy.confidence, enemy.threat_ratio
                        ),
                        target: Some(enemy.pos),
                    },
                });
            }
        }

        if let Some(loot_pos) = self.best_loot_target(unit, sim, profile) {
            let safety_term = match ctx.enemy {
                Some(enemy) if enemy.pressured => 0.1,
                Some(_) => 0.75,
                None => 0.95,
            };
            let mut loot_score = ctx.best_loot_signal * 0.45 + profile.loot_bias * 0.35 + safety_term * 0.2;
            if !ctx.has_living_enemy {
                loot_score = loot_score.max(0.7);
            }
            if loot_score >= 0.45 {
                candidates.push(ScoredDecision {
                    score: loot_score,
                    decision: MovementDecision {
                        intent: MovementIntent::Toward(loot_pos),
                        intent_kind: DecisionIntent::SeekLoot,
                        reason: format!(
                            "loot score {:.2}: signal {:.0}% safety {:.2}",
                            loot_score,
                            ctx.best_loot_signal * 100.0,
                            safety_term
                        ),
                        target: Some(loot_pos),
                    },
                });
            }
        }

        if !ctx.has_living_enemy {
            if let Some(loot_pos) = self.closest_unclaimed_loot_pos(&unit.pos, &sim.loot) {
                candidates.push(ScoredDecision {
                    score: 0.8,
                    decision: MovementDecision {
                        intent: MovementIntent::Toward(loot_pos),
                        intent_kind: DecisionIntent::SeekLoot,
                        reason: "mop-up score 0.80: nearest unclaimed loot".to_string(),
                        target: Some(loot_pos),
                    },
                });
            }
            if let Some((belief, loot_pos)) =
                self.highest_loot_belief_target(unit.team_id, &sim.knowledge, &sim.grid)
            {
                if belief >= 0.35 {
                    candidates.push(ScoredDecision {
                        score: 0.5 + belief * 0.4,
                        decision: MovementDecision {
                            intent: MovementIntent::Toward(loot_pos),
                            intent_kind: DecisionIntent::SeekLoot,
                            reason: format!(
                                "mop-up score {:.2}: strongest loot belief {:.0}%",
                                0.5 + belief * 0.4,
                                belief * 100.0
                            ),
                            target: Some(loot_pos),
                        },
                    });
                }
            }
        }

        if let Some(best) = candidates
            .into_iter()
            .max_by(|a, b| a.score.total_cmp(&b.score))
        {
            return best.decision;
        }

        MovementDecision {
            intent: MovementIntent::Hold,
            intent_kind: DecisionIntent::Wander,
            reason: "hold: no high-confidence action candidate".to_string(),
            target: None,
        }
    }

    fn build_context(&self, unit: &Unit, sim: &SimState) -> AiContext {
        let hp_ratio = self.hp_ratio(unit);
        let weapon = unit.weapon_profile();
        let closest_enemy = self.closest_enemy_from(unit.team_id, &unit.pos, &sim.units);
        let enemy = closest_enemy.map(|enemy| {
            let enemy_weapon = enemy.weapon_profile();
            let enemy_hp_ratio = self.hp_ratio(enemy);
            let dist = cube_distance(&unit.pos, &enemy.pos);
            let own_power = (weapon.damage as f64 * weapon.range as f64) * (0.4 + hp_ratio);
            let enemy_power =
                (enemy_weapon.damage as f64 * enemy_weapon.range as f64) * (0.35 + enemy_hp_ratio);
            let threat_ratio = if own_power <= 0.0 {
                1.0
            } else {
                enemy_power / own_power
            };
            EnemyContext {
                id: enemy.id,
                pos: enemy.pos,
                dist,
                threat_ratio,
                confidence: self.enemy_belief_at(unit.team_id, &enemy.pos, &sim.grid, &sim.knowledge),
                pressured: dist <= weapon.range + 1,
                weak: enemy.archetype == AiArchetype::Scout && threat_ratio < 0.95,
            }
        });

        AiContext {
            hp_ratio,
            full_inventory: self.inventory_full(unit),
            nearly_full_inventory: self.inventory_nearly_full(unit),
            turns_on_map: sim.turn.saturating_sub(unit.spawn_turn),
            best_loot_signal: self.best_loot_belief(unit.team_id, &sim.knowledge),
            best_hostile_signal: self.best_enemy_belief(unit.team_id, &sim.knowledge),
            has_living_enemy: sim.units.iter().any(|u| u.team_id != unit.team_id && u.hp > 0),
            exit_pos: self.closest_exit_pos(&unit.pos, &sim.exits),
            enemy,
        }
    }

    fn best_loot_target(
        &self,
        unit: &Unit,
        sim: &SimState,
        profile: AiProfile,
    ) -> Option<CubeCoord> {
        let team_knowledge = &sim.knowledge[unit.team_id as usize];
        let hp_ratio = self.hp_ratio(unit);
        let mut best: Option<(f64, CubeCoord)> = None;
        for (idx, belief) in team_knowledge.beliefs.iter().enumerate() {
            if belief.loot <= 0.2 {
                continue;
            }
            let cell = &sim.grid.cells[idx];
            let distance = cube_distance(&unit.pos, &cell.coord) as f64;
            let travel_cost = distance * (0.02 + (1.0 - hp_ratio) * 0.02 * profile.caution);
            let camp_penalty = self.loot_camp_penalty(unit, &cell.coord, &sim.units);
            if camp_penalty >= 0.55 && belief.loot < 0.9 {
                continue;
            }
            let score = belief.loot * profile.loot_bias - travel_cost - camp_penalty;
            if best.map(|(bscore, _)| score > bscore).unwrap_or(true) {
                best = Some((score, cell.coord));
            }
        }
        best.and_then(|(score, coord)| if score > 0.08 { Some(coord) } else { None })
    }

    fn best_loot_belief(&self, team_id: TeamId, knowledge: &[TeamKnowledge]) -> f64 {
        knowledge[team_id as usize]
            .beliefs
            .iter()
            .map(|belief| belief.loot)
            .fold(0.0, f64::max)
    }

    fn highest_loot_belief_target(
        &self,
        team_id: TeamId,
        knowledge: &[TeamKnowledge],
        grid: &Grid,
    ) -> Option<(f64, CubeCoord)> {
        let team_knowledge = &knowledge[team_id as usize];
        team_knowledge
            .beliefs
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.loot.total_cmp(&b.loot))
            .map(|(idx, belief)| (belief.loot, grid.cells[idx].coord))
    }

    fn enemy_belief_at(
        &self,
        team_id: TeamId,
        coord: &CubeCoord,
        grid: &Grid,
        knowledge: &[TeamKnowledge],
    ) -> f64 {
        let cell_id = pack_id(coord.x, coord.z);
        if let Some(idx) = grid.cell_index(cell_id) {
            knowledge[team_id as usize].beliefs[idx].enemy
        } else {
            BASE_ENEMY_PRIOR
        }
    }

    fn closest_enemy_from<'a>(
        &self,
        team_id: TeamId,
        from: &CubeCoord,
        units: &'a [Unit],
    ) -> Option<&'a Unit> {
        let mut best: Option<(u32, &Unit)> = None;
        for enemy in units.iter().filter(|u| u.team_id != team_id && u.hp > 0) {
            let dist = cube_distance(from, &enemy.pos);
            if best.map(|(b, _)| dist < b).unwrap_or(true) {
                best = Some((dist, enemy));
            }
        }
        best.map(|(_, enemy)| enemy)
    }

    fn closest_unclaimed_loot_pos(
        &self,
        from: &CubeCoord,
        loot_nodes: &[LootNode],
    ) -> Option<CubeCoord> {
        let mut best: Option<(u32, CubeCoord)> = None;
        for loot in loot_nodes.iter().filter(|node| !node.claimed) {
            let dist = cube_distance(from, &loot.pos);
            if best.map(|(b, _)| dist < b).unwrap_or(true) {
                best = Some((dist, loot.pos));
            }
        }
        best.map(|(_, coord)| coord)
    }

    fn closest_exit_pos(&self, from: &CubeCoord, exits: &[CubeCoord]) -> Option<CubeCoord> {
        let mut best: Option<(u32, CubeCoord)> = None;
        for exit in exits {
            let dist = cube_distance(from, exit);
            if best.map(|(b, _)| dist < b).unwrap_or(true) {
                best = Some((dist, *exit));
            }
        }
        best.map(|(_, coord)| coord)
    }

    fn inventory_full(&self, unit: &Unit) -> bool {
        unit.inventory_used >= unit.stats.inventory_slots
    }

    fn inventory_nearly_full(&self, unit: &Unit) -> bool {
        if self.inventory_full(unit) {
            return true;
        }
        let remaining = unit.stats.inventory_slots.saturating_sub(unit.inventory_used);
        remaining <= 1 && unit.inventory_used > 0
    }

    fn best_enemy_belief(&self, team_id: TeamId, knowledge: &[TeamKnowledge]) -> f64 {
        knowledge[team_id as usize]
            .beliefs
            .iter()
            .map(|belief| belief.enemy)
            .fold(0.0, f64::max)
    }

    fn loot_camp_penalty(&self, unit: &Unit, loot_pos: &CubeCoord, units: &[Unit]) -> f64 {
        let own_weapon = unit.weapon_profile();
        let own_power =
            (own_weapon.damage as f64 * own_weapon.range as f64) * (0.4 + self.hp_ratio(unit));
        let mut worst: f64 = 0.0;
        for enemy in units
            .iter()
            .filter(|other| other.team_id != unit.team_id && other.hp > 0)
        {
            let dist = cube_distance(loot_pos, &enemy.pos);
            if dist > 1 {
                continue;
            }
            let enemy_weapon = enemy.weapon_profile();
            let enemy_power = (enemy_weapon.damage as f64 * enemy_weapon.range as f64)
                * (0.35 + self.hp_ratio(enemy));
            let threat_ratio = if own_power <= 0.0 {
                1.0
            } else {
                enemy_power / own_power
            };
            let dist_multiplier = if dist == 0 { 1.0 } else { 0.8 };
            worst = worst.max(threat_ratio * 0.35 * dist_multiplier);
        }
        worst.clamp(0.0, 0.85)
    }

    fn enemy_in_visual_range(&self, unit: &Unit, units: &[Unit]) -> bool {
        units.iter().any(|other| {
            other.team_id != unit.team_id
                && other.hp > 0
                && cube_distance(&unit.pos, &other.pos) <= unit.stats.scan_range
        })
    }

    fn hp_ratio(&self, unit: &Unit) -> f64 {
        if unit.stats.hp_max <= 0 {
            return 0.0;
        }
        (unit.hp.max(0) as f64 / unit.stats.hp_max as f64).clamp(0.0, 1.0)
    }

    fn profile_for(&self, archetype: AiArchetype) -> AiProfile {
        match archetype {
            AiArchetype::Scout => AiProfile {
                aggression: 0.35,
                caution: 0.85,
                scan_bias: 0.65,
                loot_bias: 0.55,
                retreat_hp_ratio: 0.72,
            },
            AiArchetype::Dreadnaught => AiProfile {
                aggression: 0.9,
                caution: 0.2,
                scan_bias: 0.25,
                loot_bias: 0.3,
                retreat_hp_ratio: 0.25,
            },
        }
    }
}

fn cube_distance(a: &CubeCoord, b: &CubeCoord) -> u32 {
    (a.x - b.x)
        .abs()
        .max((a.y - b.y).abs())
        .max((a.z - b.z).abs()) as u32
}

fn sample_detection<R: Rng>(rng: &mut R, is_present: bool, p_detect: f64, p_false: f64) -> bool {
    if is_present {
        rng.gen_bool(p_detect)
    } else {
        rng.gen_bool(p_false)
    }
}

fn bayes_update(prior: f64, observed: bool, p_detect: f64, p_false: f64) -> f64 {
    if observed {
        let numerator = p_detect * prior;
        let denominator = numerator + p_false * (1.0 - prior);
        if denominator <= 0.0 {
            prior
        } else {
            numerator / denominator
        }
    } else {
        let numerator = (1.0 - p_detect) * prior;
        let denominator = numerator + (1.0 - p_false) * (1.0 - prior);
        if denominator <= 0.0 {
            prior
        } else {
            numerator / denominator
        }
    }
}

fn decay_toward_prior(value: f64, prior: f64, rate: f64) -> f64 {
    (value + (prior - value) * rate).clamp(0.0, 1.0)
}

fn update_belief(
    belief: &mut CellBelief,
    new_enemy: f64,
    new_loot: f64,
    updates: &mut Vec<BeliefUpdate>,
    cell_id: u64,
) -> bool {
    let changed =
        (belief.enemy - new_enemy).abs() > EPSILON || (belief.loot - new_loot).abs() > EPSILON;
    if changed {
        belief.enemy = new_enemy.clamp(0.0, 1.0);
        belief.loot = new_loot.clamp(0.0, 1.0);
        updates.push(BeliefUpdate {
            cell_id: cell_id.to_string(),
            enemy: belief.enemy,
            loot: belief.loot,
        });
    }
    changed
}

#[cfg(test)]
mod sim_tests {
    use super::*;
    use rand::SeedableRng;
    use rand_chacha::ChaCha8Rng;
    use std::collections::HashSet;

    fn test_config() -> SimConfig {
        SimConfig {
            grid_radius: 5,
            visible_radius: 3,
            passive_decay: 6.0,
            passive_strength: 0.7,
            active_strength: 0.9,
            active_cooldown: 4,
            belief_decay_rate: 0.05,
            team_count: 2,
            min_units_per_team: 1,
            max_units_per_team: 1,
            exit_points_count: 3,
            max_loot: 0,
        }
    }

    fn make_test_state() -> SimState {
        let mut rng = ChaCha8Rng::seed_from_u64(11);
        let mut sim = SimState::new(&mut rng, test_config());
        sim.turn = 0;
        sim.loot.clear();
        sim.units.clear();
        sim.teams = vec![
            TeamState {
                view: TeamView {
                    id: 0,
                    name: "Verdant".to_string(),
                    color: TeamColor {
                        r: 0,
                        g: 158,
                        b: 115,
                    },
                },
                unit_count: 1,
            },
            TeamState {
                view: TeamView {
                    id: 1,
                    name: "Coral".to_string(),
                    color: TeamColor {
                        r: 213,
                        g: 94,
                        b: 0,
                    },
                },
                unit_count: 1,
            },
        ];
        let base_beliefs = vec![
            CellBelief {
                enemy: BASE_ENEMY_PRIOR,
                loot: BASE_LOOT_PRIOR,
            };
            sim.grid.cells.len()
        ];
        sim.knowledge = sim
            .teams
            .iter()
            .map(|_| TeamKnowledge {
                beliefs: base_beliefs.clone(),
            })
            .collect();

        let center = CubeCoord::new(0, 0, 0);
        let enemy = CubeCoord::new(3, -3, 0);
        let exits: Vec<CubeCoord> = sim
            .grid
            .cells
            .iter()
            .filter(|cell| cell.coord.distance_from_origin() == sim.grid.radius)
            .take(3)
            .map(|cell| cell.coord)
            .collect();
        sim.exits = exits;
        sim.units.push(Unit {
            id: 1,
            team_id: 0,
            archetype: AiArchetype::Scout,
            pos: center,
            hp: 16,
            spawn_turn: 0,
            inventory_used: 0,
            stats: unit_stats_for(AiArchetype::Scout, sim.config.visible_radius),
            active_scan_cd: 0,
        });
        sim.units.push(Unit {
            id: 2,
            team_id: 1,
            archetype: AiArchetype::Scout,
            pos: enemy,
            hp: 16,
            spawn_turn: 0,
            inventory_used: 0,
            stats: unit_stats_for(AiArchetype::Scout, sim.config.visible_radius),
            active_scan_cd: 0,
        });
        sim
    }

    fn set_belief(sim: &mut SimState, team_id: TeamId, coord: CubeCoord, enemy: f64, loot: f64) {
        let cell_id = pack_id(coord.x, coord.z);
        let idx = sim.grid.cell_index(cell_id).expect("cell exists");
        sim.knowledge[team_id as usize].beliefs[idx].enemy = enemy;
        sim.knowledge[team_id as usize].beliefs[idx].loot = loot;
    }

    #[test]
    fn turn_log_reports_requested_team_count() {
        let mut cfg = test_config();
        cfg.team_count = 4;
        cfg.min_units_per_team = 1;
        cfg.max_units_per_team = 1;
        let mut rng = ChaCha8Rng::seed_from_u64(99);
        let mut sim = SimState::new(&mut rng, cfg);
        let log = sim.tick(&mut rng);
        assert_eq!(log.teams.len(), 4);
        let ids: HashSet<u8> = log.teams.iter().map(|t| t.id).collect();
        assert_eq!(ids.len(), 4);
        assert!(log.units.iter().all(|u| ids.contains(&u.team_id)));
    }

    #[test]
    fn tick_never_produces_unit_collisions() {
        let mut cfg = test_config();
        cfg.team_count = 4;
        cfg.min_units_per_team = 2;
        cfg.max_units_per_team = 3;
        cfg.max_loot = 8;
        let mut rng = ChaCha8Rng::seed_from_u64(1234);
        let mut sim = SimState::new(&mut rng, cfg);

        for _ in 0..30 {
            let log = sim.tick(&mut rng);
            let positions: HashSet<(i32, i32)> = log.units.iter().map(|u| (u.pos.q, u.pos.r)).collect();
            assert_eq!(
                positions.len(),
                log.units.len(),
                "two living units occupied the same tile"
            );
        }
    }

    #[test]
    fn ai_exfils_when_inventory_nearly_full() {
        let mut sim = make_test_state();
        let unit = sim.units.iter_mut().find(|u| u.id == 1).expect("unit 1");
        unit.inventory_used = unit.stats.inventory_slots.saturating_sub(1);
        let enemy_pos = sim.units.iter().find(|u| u.id == 2).unwrap().pos;
        set_belief(&mut sim, 0, enemy_pos, 0.1, 0.1);

        let unit_snapshot = sim.units.iter().find(|u| u.id == 1).unwrap().clone();
        let mut rng = ChaCha8Rng::seed_from_u64(5);
        let decision = sim.ai.choose_movement_decision(&mut rng, &unit_snapshot, &sim);

        assert_eq!(decision.intent_kind, DecisionIntent::Retreat);
        assert!(matches!(decision.intent, MovementIntent::Toward(_)));
        assert!(decision.reason.contains("exfil score"));
    }

    #[test]
    fn ai_exfils_after_long_time_with_weak_signals() {
        let mut sim = make_test_state();
        sim.turn = 18;
        sim.units.retain(|u| u.id == 1);
        let unit = sim.units.iter_mut().find(|u| u.id == 1).expect("unit 1");
        unit.spawn_turn = 0;
        unit.inventory_used = 0;

        // Keep all beliefs weak so stale-exfil dominates and mop-up is not triggered.
        for team_knowledge in &mut sim.knowledge {
            for belief in &mut team_knowledge.beliefs {
                belief.loot = 0.12;
                belief.enemy = 0.12;
            }
        }

        let unit_snapshot = sim.units.iter().find(|u| u.id == 1).unwrap().clone();
        let mut rng = ChaCha8Rng::seed_from_u64(6);
        let decision = sim.ai.choose_movement_decision(&mut rng, &unit_snapshot, &sim);

        assert_eq!(decision.intent_kind, DecisionIntent::Retreat);
        assert!(matches!(decision.intent, MovementIntent::Toward(_)));
        assert!(decision.reason.contains("weak signals"));
    }
}
