use super::protocol::{
    AcceptedReply, CommandEnvelope, CommandReply, RejectReason, RejectedReply, SimCommand, TeamId,
    TeamTurnIntent, UnitIntent,
};
use crate::hex::{pack_id, CubeCoord, HexGrid};
use rand::Rng;
use std::collections::HashMap;

const BASE_ENEMY_PRIOR: f64 = 0.04;
const BASE_LOOT_PRIOR: f64 = 0.08;
const EPSILON: f64 = 1e-4;

mod types;
pub use types::*;
mod ai;
use ai::{GameAi, IntentMeta, MovementDecision, MovementIntent};


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
    ("Mint", TeamColor { r: 141, g: 211, b: 80 }),
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

#[derive(Debug, Clone)]
struct CellBelief {
    enemy: f64,
    loot: f64,
}

#[derive(Debug, Clone)]
struct TeamKnowledge {
    beliefs: Vec<CellBelief>,
}

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
    revision: u64,
    next_unit_id: u32,
    next_loot_id: u32,
    pending_intents: HashMap<TeamId, TeamTurnIntent>,
    executing_intents: Option<HashMap<TeamId, TeamTurnIntent>>,
    executing_intent_meta: Option<HashMap<u32, IntentMeta>>,
    command_history: HashMap<u64, CommandReply>,
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
            revision: 0,
            next_unit_id: 1,
            next_loot_id: 1,
            pending_intents: HashMap::new(),
            executing_intents: None,
            executing_intent_meta: None,
            command_history: HashMap::new(),
        };
        state.spawn_defaults(rng);
        state.initialize_starting_beliefs(rng);
        state
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn snapshot(&self) -> TurnLog {
        self.build_turn_log(Vec::new())
    }

    pub fn submit_command<R: Rng>(&mut self, rng: &mut R, envelope: CommandEnvelope) -> CommandReply {
        if let Some(reply) = self.command_history.get(&envelope.command_id) {
            return reply.clone();
        }

        if envelope.expected_revision != self.revision {
            return CommandReply::Rejected(RejectedReply {
                current_revision: self.revision,
                reason: RejectReason::RevisionMismatch,
                detail: None,
            });
        }

        let reply = match envelope.command {
            SimCommand::SubmitTeamIntent { team_id, intent } => {
                self.submit_team_intent(rng, team_id, intent)
            }
        };
        self.command_history.insert(envelope.command_id, reply.clone());
        reply
    }

    fn submit_team_intent<R: Rng>(
        &mut self,
        rng: &mut R,
        team_id: TeamId,
        intent: TeamTurnIntent,
    ) -> CommandReply {
        if !self.teams.iter().any(|team| team.view.id == team_id) {
            return CommandReply::Rejected(RejectedReply {
                current_revision: self.revision,
                reason: RejectReason::InvalidTeam,
                detail: None,
            });
        }
        if self.pending_intents.contains_key(&team_id) {
            return CommandReply::Rejected(RejectedReply {
                current_revision: self.revision,
                reason: RejectReason::DuplicateTeamIntent,
                detail: None,
            });
        }
        if !self.validate_intent(team_id, &intent) {
            return CommandReply::Rejected(RejectedReply {
                current_revision: self.revision,
                reason: RejectReason::InvalidIntent,
                detail: None,
            });
        }

        self.pending_intents.insert(team_id, intent);
        let mut ai_intent_meta = HashMap::<u32, IntentMeta>::new();

        // Current playtest mode: one human team, AI auto-submits all others.
        for other_team in self.teams.iter().map(|team| team.view.id) {
            if !self.pending_intents.contains_key(&other_team) {
                let (ai_intent, team_meta) = self.synthesize_ai_intent(rng, other_team);
                self.pending_intents.insert(other_team, ai_intent);
                ai_intent_meta.extend(team_meta);
            }
        }

        let pending_teams: Vec<TeamId> = self
            .teams
            .iter()
            .map(|team| team.view.id)
            .filter(|id| !self.pending_intents.contains_key(id))
            .collect();

        if !pending_teams.is_empty() {
            return CommandReply::Accepted(AcceptedReply {
                revision: self.revision,
                pending_teams,
                resolved_turn: None,
            });
        }

        let intents = std::mem::take(&mut self.pending_intents);
        let mut intent_meta = self.intent_meta_from_submitted(&intents);
        intent_meta.extend(ai_intent_meta);
        self.executing_intents = Some(intents);
        self.executing_intent_meta = Some(intent_meta);
        let turn_log = self.tick(rng);
        self.executing_intents = None;
        self.executing_intent_meta = None;
        CommandReply::Accepted(AcceptedReply {
            revision: self.revision,
            pending_teams: Vec::new(),
            resolved_turn: Some(turn_log),
        })
    }

    fn validate_intent(&self, team_id: TeamId, intent: &TeamTurnIntent) -> bool {
        let mut seen = HashMap::<u32, ()>::new();
        for action in &intent.unit_intents {
            let unit_id = match action {
                UnitIntent::Hold { unit_id } => *unit_id,
                UnitIntent::Move { unit_id, to_cell_id } => {
                    if self.grid.cell_index(*to_cell_id).is_none() {
                        return false;
                    }
                    *unit_id
                }
            };
            if seen.insert(unit_id, ()).is_some() {
                return false;
            }
            let Some(unit) = self.units.iter().find(|u| u.id == unit_id) else {
                return false;
            };
            if unit.team_id != team_id || unit.hp <= 0 {
                return false;
            }
        }
        true
    }

    fn synthesize_ai_intent<R: Rng>(
        &self,
        rng: &mut R,
        team_id: TeamId,
    ) -> (TeamTurnIntent, HashMap<u32, IntentMeta>) {
        let mut unit_intents = Vec::new();
        let mut meta = HashMap::new();
        for unit in self
            .units
            .iter()
            .filter(|u| u.team_id == team_id && u.hp > 0)
        {
            let decision = self.ai.choose_movement_decision(rng, unit, self);
            let intent = self.intent_from_ai_decision(unit, decision.clone());
            meta.insert(
                unit.id,
                IntentMeta {
                    intent_kind: decision.intent_kind,
                    reason: decision.reason,
                    target: decision.target,
                },
            );
            unit_intents.push(intent);
        }
        (TeamTurnIntent { unit_intents }, meta)
    }

    fn intent_from_ai_decision(&self, unit: &Unit, decision: MovementDecision) -> UnitIntent {
        let move_target = match decision.intent {
            MovementIntent::Toward(target) => Some(target),
            MovementIntent::AwayFrom(threat_pos) => {
                let mut candidates = self.grid.neighbors(&unit.pos);
                candidates.retain(|coord| !self.is_occupied_by_unit(coord, Some(unit.id)));
                candidates.sort_by_key(|coord| std::cmp::Reverse(cube_distance(coord, &threat_pos)));
                candidates.first().copied()
            }
            MovementIntent::Hold => None,
        };

        if let Some(target) = move_target {
            UnitIntent::Move {
                unit_id: unit.id,
                to_cell_id: pack_id(target.x, target.z),
            }
        } else {
            UnitIntent::Hold { unit_id: unit.id }
        }
    }

    fn action_for_unit(&self, team_id: TeamId, unit_id: u32) -> Option<UnitIntent> {
        self.executing_intents
            .as_ref()?
            .get(&team_id)?
            .unit_intents
            .iter()
            .find(|action| match action {
                UnitIntent::Hold { unit_id: id } | UnitIntent::Move { unit_id: id, .. } => {
                    *id == unit_id
                }
            })
            .cloned()
    }

    fn intent_meta_for_unit(&self, unit_id: u32) -> Option<IntentMeta> {
        self.executing_intent_meta
            .as_ref()?
            .get(&unit_id)
            .cloned()
    }

    fn intent_meta_from_submitted(
        &self,
        intents: &HashMap<TeamId, TeamTurnIntent>,
    ) -> HashMap<u32, IntentMeta> {
        let mut meta = HashMap::new();
        for intent in intents.values() {
            for action in &intent.unit_intents {
                match action {
                    UnitIntent::Hold { unit_id } => {
                        meta.insert(
                            *unit_id,
                            IntentMeta {
                                intent_kind: DecisionIntent::Wander,
                                reason: "intent hold".to_string(),
                                target: None,
                            },
                        );
                    }
                    UnitIntent::Move { unit_id, to_cell_id } => {
                        let target = self
                            .grid
                            .cell_index(*to_cell_id)
                            .map(|idx| self.grid.cells[idx].coord);
                        meta.insert(
                            *unit_id,
                            IntentMeta {
                                intent_kind: DecisionIntent::Advance,
                                reason: "intent move".to_string(),
                                target,
                            },
                        );
                    }
                }
            }
        }
        meta
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

    fn initialize_starting_beliefs<R: Rng>(&mut self, rng: &mut R) {
        // Seed beliefs immediately so turn 0 snapshot already reflects passive + visual intel.
        let mut ignored_events = Vec::new();
        self.apply_visual_scans(&mut ignored_events);
        self.apply_passive_scans(rng, &mut ignored_events);
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
        self.revision += 1;
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

        self.build_turn_log(events)
    }

    fn build_turn_log(&self, events: Vec<SimEvent>) -> TurnLog {
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

    fn move_units<R: Rng>(&mut self, _rng: &mut R, events: &mut Vec<SimEvent>) {
        let units_snapshot = self.units.clone();
        for unit in units_snapshot {
            if unit.hp <= 0 {
                continue;
            }
            let meta = self.intent_meta_for_unit(unit.id);
            let (intent, intent_kind, reason, target) =
                if let Some(action) = self.action_for_unit(unit.team_id, unit.id) {
                    match action {
                        UnitIntent::Hold { .. } => (
                            MovementIntent::Hold,
                            meta.as_ref()
                                .map(|m| m.intent_kind)
                                .unwrap_or(DecisionIntent::Wander),
                            meta.as_ref()
                                .map(|m| m.reason.clone())
                                .unwrap_or_else(|| "intent hold".to_string()),
                            meta.and_then(|m| m.target),
                        ),
                        UnitIntent::Move { to_cell_id, .. } => {
                            if let Some(target_idx) = self.grid.cell_index(to_cell_id) {
                                let target = self.grid.cells[target_idx].coord;
                                (
                                    MovementIntent::Toward(target),
                                    meta.as_ref()
                                        .map(|m| m.intent_kind)
                                        .unwrap_or(DecisionIntent::Advance),
                                    meta.as_ref()
                                        .map(|m| m.reason.clone())
                                        .unwrap_or_else(|| "intent move".to_string()),
                                    meta.and_then(|m| m.target).or(Some(target)),
                                )
                            } else {
                                (
                                    MovementIntent::Hold,
                                    DecisionIntent::Wander,
                                    "invalid move target; holding".to_string(),
                                    None,
                                )
                            }
                        }
                    }
                } else {
                    (
                        MovementIntent::Hold,
                        DecisionIntent::Wander,
                        "implicit hold (missing intent)".to_string(),
                        None,
                    )
                };
            events.push(SimEvent::UnitDecision {
                unit_id: unit.id,
                intent: intent_kind,
                reason,
                target: target.map(|coord| CellRef::from_coord(&coord)),
            });
            let mut steps = unit.stats.movement_range.max(1);
            let mut current = unit.pos;
            while steps > 0 {
                if let MovementIntent::Toward(target_pos) = intent {
                    if current == target_pos {
                        break;
                    }
                }
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
mod tests;
