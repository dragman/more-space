use crate::hex::{pack_id, CubeCoord, HexGrid};
use rand::Rng;
use serde::Serialize;
use std::collections::HashMap;

const BASE_ENEMY_PRIOR: f64 = 0.04;
const BASE_LOOT_PRIOR: f64 = 0.08;
const EPSILON: f64 = 1e-4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Team {
    Player,
    Enemy,
}

impl Team {
    fn index(self) -> usize {
        match self {
            Team::Player => 0,
            Team::Enemy => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    Visual,
    Passive,
    Active,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimConfig {
    pub grid_radius: u32,
    pub visible_radius: u32,
    pub passive_decay: f64,
    pub passive_strength: f64,
    pub active_strength: f64,
    pub active_cooldown: u32,
    pub max_loot: usize,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            grid_radius: 12,
            visible_radius: 6,
            passive_decay: 6.0,
            passive_strength: 0.7,
            active_strength: 0.9,
            active_cooldown: 4,
            max_loot: 10,
        }
    }
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

#[derive(Debug, Clone, Serialize)]
pub struct UnitView {
    pub id: u32,
    pub team: Team,
    pub hp: i32,
    pub pos: CellRef,
    pub attack_range: u32,
    pub visible_radius: u32,
    pub has_active_scan: bool,
}

#[derive(Debug, Clone)]
struct UnitStats {
    hp_max: i32,
    attack_range: u32,
    attack_damage: i32,
    accuracy: f64,
    move_points: u32,
    scan_range: u32,
    has_active_scan: bool,
}

#[derive(Debug, Clone)]
struct Unit {
    id: u32,
    team: Team,
    pos: CubeCoord,
    hp: i32,
    stats: UnitStats,
    active_scan_cd: u32,
}

#[derive(Debug, Clone)]
struct LootNode {
    id: u32,
    pos: CubeCoord,
    value: u32,
    claimed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LootView {
    pub id: u32,
    pub pos: CellRef,
    pub value: u32,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct BeliefUpdate {
    pub cell_id: String,
    pub enemy: f64,
    pub loot: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamBeliefCell {
    pub cell_id: String,
    pub enemy: f64,
    pub loot: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamBeliefView {
    pub team: Team,
    pub cells: Vec<TeamBeliefCell>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SimEvent {
    TurnStart { turn: u32 },
    ScanResult {
        team: Team,
        mode: ScanMode,
        updates: Vec<BeliefUpdate>,
    },
    UnitMoved {
        unit_id: u32,
        from: CellRef,
        to: CellRef,
    },
    Attack {
        attacker_id: u32,
        target_id: u32,
        hit: bool,
        damage: i32,
    },
    UnitDestroyed { unit_id: u32 },
    LootRecovered { unit_id: u32, loot_id: u32, value: u32 },
    ActiveScanPing { unit_id: u32, center: CellRef },
}

#[derive(Debug, Clone, Serialize)]
pub struct TurnLog {
    pub turn: u32,
    pub events: Vec<SimEvent>,
    pub units: Vec<UnitView>,
    pub loot: Vec<LootView>,
    pub beliefs: Vec<TeamBeliefView>,
    pub grid_radius: u32,
}

pub struct SimState {
    config: SimConfig,
    grid: Grid,
    units: Vec<Unit>,
    loot: Vec<LootNode>,
    knowledge: [TeamKnowledge; 2],
    turn: u32,
    next_unit_id: u32,
    next_loot_id: u32,
}

impl SimState {
    pub fn new<R: Rng>(rng: &mut R, config: SimConfig) -> Self {
        let grid = Grid::new(config.grid_radius);
        let beliefs = vec![
            CellBelief {
                enemy: BASE_ENEMY_PRIOR,
                loot: BASE_LOOT_PRIOR,
            };
            grid.cells.len()
        ];
        let mut state = Self {
            config,
            grid,
            units: Vec::new(),
            loot: Vec::new(),
            knowledge: [
                TeamKnowledge {
                    beliefs: beliefs.clone(),
                },
                TeamKnowledge { beliefs },
            ],
            turn: 0,
            next_unit_id: 1,
            next_loot_id: 1,
        };
        state.spawn_defaults(rng);
        state
    }

    fn spawn_defaults<R: Rng>(&mut self, rng: &mut R) {
        let player_pos = self.random_cell(rng);
        self.spawn_unit(
            Team::Player,
            player_pos,
            UnitStats {
                hp_max: 20,
                attack_range: 2,
                attack_damage: 6,
                accuracy: 0.7,
                move_points: 1,
                scan_range: self.config.visible_radius,
                has_active_scan: true,
            },
        );
        let enemy_pos = self.random_far_cell(rng, &player_pos, 6);
        self.spawn_unit(
            Team::Enemy,
            enemy_pos,
            UnitStats {
                hp_max: 16,
                attack_range: 2,
                attack_damage: 5,
                accuracy: 0.6,
                move_points: 1,
                scan_range: self.config.visible_radius,
                has_active_scan: true,
            },
        );

        for _ in 0..self.config.max_loot {
            let pos = self.random_cell(rng);
            self.spawn_loot(rng, pos);
        }
    }

    fn spawn_unit(&mut self, team: Team, pos: CubeCoord, stats: UnitStats) {
        let id = self.next_unit_id;
        self.next_unit_id += 1;
        self.units.push(Unit {
            id,
            team,
            pos,
            hp: stats.hp_max,
            stats,
            active_scan_cd: 0,
        });
    }

    fn spawn_loot<R: Rng>(&mut self, rng: &mut R, pos: CubeCoord) {
        let id = self.next_loot_id;
        self.next_loot_id += 1;
        let value = rng.gen_range(10..=60);
        self.loot.push(LootNode {
            id,
            pos,
            value,
            claimed: false,
        });
    }

    fn random_cell<R: Rng>(&self, rng: &mut R) -> CubeCoord {
        let idx = rng.gen_range(0..self.grid.cells.len());
        self.grid.cells[idx].coord
    }

    fn random_far_cell<R: Rng>(
        &self,
        rng: &mut R,
        from: &CubeCoord,
        min_dist: u32,
    ) -> CubeCoord {
        for _ in 0..50 {
            let candidate = self.random_cell(rng);
            if cube_distance(from, &candidate) >= min_dist {
                return candidate;
            }
        }
        self.random_cell(rng)
    }

    pub fn tick<R: Rng>(&mut self, rng: &mut R) -> TurnLog {
        self.turn += 1;
        let mut events = vec![SimEvent::TurnStart { turn: self.turn }];

        self.apply_visual_scans(&mut events);
        self.apply_passive_scans(rng, &mut events);
        self.apply_active_scans(rng, &mut events);

        self.move_units(rng, &mut events);
        self.resolve_combat(rng, &mut events);
        self.resolve_loot(&mut events);

        let units = self
            .units
            .iter()
            .map(|unit| UnitView {
                id: unit.id,
                team: unit.team,
                hp: unit.hp,
                pos: CellRef::from_coord(&unit.pos),
                attack_range: unit.stats.attack_range,
                visible_radius: unit.stats.scan_range,
                has_active_scan: unit.stats.has_active_scan,
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

        TurnLog {
            turn: self.turn,
            events,
            units,
            loot,
            beliefs,
            grid_radius: self.config.grid_radius,
        }
    }

    fn apply_visual_scans(&mut self, events: &mut Vec<SimEvent>) {
        for team in [Team::Player, Team::Enemy] {
            let updates = self.scan_team_visual(team);
            if !updates.is_empty() {
                events.push(SimEvent::ScanResult {
                    team,
                    mode: ScanMode::Visual,
                    updates,
                });
            }
        }
    }

    fn apply_passive_scans<R: Rng>(&mut self, rng: &mut R, events: &mut Vec<SimEvent>) {
        for team in [Team::Player, Team::Enemy] {
            let updates = self.scan_team_with_rng(team, ScanMode::Passive, rng);
            if !updates.is_empty() {
                events.push(SimEvent::ScanResult {
                    team,
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
            if !self.should_active_scan(rng, &unit) {
                continue;
            }

            let center = CellRef::from_coord(&unit.pos);
            events.push(SimEvent::ActiveScanPing {
                unit_id: unit.id,
                center,
            });

            let updates = self.scan_team_with_rng(unit.team, ScanMode::Active, rng);
            if !updates.is_empty() {
                events.push(SimEvent::ScanResult {
                    team: unit.team,
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

    fn scan_team_visual(&mut self, team: Team) -> Vec<BeliefUpdate> {
        let mut updates = Vec::new();
        let team_units: Vec<&Unit> = self
            .units
            .iter()
            .filter(|u| u.team == team && u.hp > 0)
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

            let (has_enemy, has_loot) = self.cell_truth(cell.coord, team);
            let enemy_prob = if has_enemy { 1.0 } else { 0.0 };
            let loot_prob = if has_loot { 1.0 } else { 0.0 };

            let idx = self.grid.cell_index(cell.id).unwrap();
            let belief = &mut self.knowledge[team.index()].beliefs[idx];
            update_belief(belief, enemy_prob, loot_prob, &mut updates, cell.id);
        }

        updates
    }

    fn scan_team_with_rng<R: Rng>(
        &mut self,
        team: Team,
        mode: ScanMode,
        rng: &mut R,
    ) -> Vec<BeliefUpdate> {
        let mut updates = Vec::new();
        let team_units: Vec<&Unit> = self
            .units
            .iter()
            .filter(|u| u.team == team && u.hp > 0)
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

            let (has_enemy, has_loot) = self.cell_truth(cell.coord, team);
            let (p_detect, p_false) = self.scan_params(mode, distance);
            let enemy_hit = sample_detection(rng, has_enemy, p_detect, p_false);
            let loot_hit = sample_detection(rng, has_loot, p_detect, p_false);

            let idx = self.grid.cell_index(cell.id).unwrap();
            let belief = &mut self.knowledge[team.index()].beliefs[idx];
            let new_enemy = bayes_update(belief.enemy, enemy_hit, p_detect, p_false);
            let new_loot = bayes_update(belief.loot, loot_hit, p_detect, p_false);
            update_belief(belief, new_enemy, new_loot, &mut updates, cell.id);
        }

        updates
    }

    fn reveal_active_scan(&mut self, scanner: &Unit, events: &mut Vec<SimEvent>) {
        let center_id = pack_id(scanner.pos.x, scanner.pos.z);
        for team in [Team::Player, Team::Enemy] {
            if team == scanner.team {
                continue;
            }
            if let Some(idx) = self.grid.cell_index(center_id) {
                let belief = &mut self.knowledge[team.index()].beliefs[idx];
                let enemy_prob = 0.85;
                let loot_prob = belief.loot;
                let mut updates = Vec::new();
                update_belief(belief, enemy_prob, loot_prob, &mut updates, center_id);
                if !updates.is_empty() {
                    events.push(SimEvent::ScanResult {
                        team,
                        mode: ScanMode::Active,
                        updates,
                    });
                }
            }
        }
    }

    fn should_active_scan<R: Rng>(&self, rng: &mut R, unit: &Unit) -> bool {
        if self.enemy_in_visual_range(unit) {
            return false;
        }
        let best_loot = self.best_loot_belief(unit.team);
        if best_loot >= 0.6 {
            return false;
        }
        rng.gen_bool(0.45)
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

    fn cell_truth(&self, coord: CubeCoord, team: Team) -> (bool, bool) {
        let enemy_present = self
            .units
            .iter()
            .any(|unit| unit.team != team && unit.pos == coord && unit.hp > 0);
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
            let target = if self.enemy_in_visual_range(&unit) {
                self.closest_enemy_pos_from(unit.team, &unit.pos)
            } else {
                self.best_loot_target(unit.team)
            };
            let mut steps = unit.stats.move_points.max(1);
            let mut current = unit.pos;
            while steps > 0 {
                let mut candidates = self.grid.neighbors(&current);
                if candidates.is_empty() {
                    break;
                }
                let next = if let Some(target_pos) = target {
                    candidates.sort_by_key(|coord| cube_distance(coord, &target_pos));
                    candidates[0]
                } else {
                    let idx = rng.gen_range(0..candidates.len());
                    candidates[idx]
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
                });
                steps = steps.saturating_sub(1);
            }
        }
    }

    fn best_loot_target(&self, team: Team) -> Option<CubeCoord> {
        let knowledge = &self.knowledge[team.index()];
        let mut best: Option<(f64, CubeCoord)> = None;
        for (idx, belief) in knowledge.beliefs.iter().enumerate() {
            if belief.loot <= 0.2 {
                continue;
            }
            let cell = &self.grid.cells[idx];
            let score = belief.loot;
            if best.map(|(bscore, _)| score > bscore).unwrap_or(true) {
                best = Some((score, cell.coord));
            }
        }
        best.map(|(_, coord)| coord)
    }

    fn best_loot_belief(&self, team: Team) -> f64 {
        self.knowledge[team.index()]
            .beliefs
            .iter()
            .map(|belief| belief.loot)
            .fold(0.0, f64::max)
    }

    fn closest_enemy_pos_from(&self, team: Team, from: &CubeCoord) -> Option<CubeCoord> {
        let mut best: Option<(u32, CubeCoord)> = None;
        for enemy in self.units.iter().filter(|u| u.team != team && u.hp > 0) {
            let dist = cube_distance(from, &enemy.pos);
            if best.map(|(b, _)| dist < b).unwrap_or(true) {
                best = Some((dist, enemy.pos));
            }
        }
        best.map(|(_, coord)| coord)
    }

    fn enemy_in_visual_range(&self, unit: &Unit) -> bool {
        self.units.iter().any(|other| {
            other.team != unit.team
                && other.hp > 0
                && cube_distance(&unit.pos, &other.pos) <= unit.stats.scan_range
        })
    }

    fn resolve_combat<R: Rng>(&mut self, rng: &mut R, events: &mut Vec<SimEvent>) {
        let attackers = self.units.clone();
        for attacker in attackers {
            if attacker.hp <= 0 {
                continue;
            }
            let target_id = self.units.iter().find(|unit| {
                unit.team != attacker.team
                    && unit.hp > 0
                    && cube_distance(&attacker.pos, &unit.pos) <= attacker.stats.attack_range
            })
            .map(|unit| unit.id);
            if let Some(target_id) = target_id {
                let hit = rng.gen_bool(attacker.stats.accuracy);
                let damage = if hit { attacker.stats.attack_damage } else { 0 };
                events.push(SimEvent::Attack {
                    attacker_id: attacker.id,
                    target_id,
                    hit,
                    damage,
                });
                if hit {
                    if let Some(real_target) = self.units.iter_mut().find(|u| u.id == target_id) {
                        real_target.hp -= damage;
                        if real_target.hp <= 0 {
                            events.push(SimEvent::UnitDestroyed { unit_id: target_id });
                        }
                    }
                }
            }
        }
    }

    fn resolve_loot(&mut self, events: &mut Vec<SimEvent>) {
        for unit in self.units.iter() {
            if unit.hp <= 0 {
                continue;
            }
            for loot in self.loot.iter_mut() {
                if loot.claimed || loot.pos != unit.pos {
                    continue;
                }
                loot.claimed = true;
                events.push(SimEvent::LootRecovered {
                    unit_id: unit.id,
                    loot_id: loot.id,
                    value: loot.value,
                });
            }
        }
    }

    fn belief_views(&self) -> Vec<TeamBeliefView> {
        [Team::Player, Team::Enemy]
            .iter()
            .map(|team| TeamBeliefView {
                team: *team,
                cells: self.knowledge[team.index()]
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

fn cube_distance(a: &CubeCoord, b: &CubeCoord) -> u32 {
    (a.x - b.x).abs().max((a.y - b.y).abs()).max((a.z - b.z).abs()) as u32
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

fn update_belief(
    belief: &mut CellBelief,
    new_enemy: f64,
    new_loot: f64,
    updates: &mut Vec<BeliefUpdate>,
    cell_id: u64,
) -> bool {
    let changed = (belief.enemy - new_enemy).abs() > EPSILON || (belief.loot - new_loot).abs() > EPSILON;
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
