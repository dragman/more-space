use super::super::protocol::TeamId;
use crate::hex::{pack_id, CubeCoord};
use serde::Serialize;
use ts_rs::TS;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum AiArchetype {
    Scout,
    Dreadnaught,
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
    pub(crate) fn from_coord(coord: &CubeCoord) -> Self {
        let (q, r) = coord.axial();
        Self {
            id: pack_id(q, r).to_string(),
            q,
            r,
        }
    }
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
