use super::sim::TurnLog;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type TeamId = u8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum UnitIntent {
    Hold { unit_id: u32 },
    Move {
        unit_id: u32,
        #[ts(type = "number")]
        to_cell_id: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct TeamTurnIntent {
    pub unit_intents: Vec<UnitIntent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum SimCommand {
    SubmitTeamIntent {
        team_id: TeamId,
        intent: TeamTurnIntent,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct CommandEnvelope {
    #[ts(type = "number")]
    pub command_id: u64,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub command: SimCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum RejectReason {
    RevisionMismatch,
    InvalidTeam,
    DuplicateTeamIntent,
    InvalidIntent,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct AcceptedReply {
    #[ts(type = "number")]
    pub revision: u64,
    pub pending_teams: Vec<TeamId>,
    pub resolved_turn: Option<TurnLog>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../www/bindings/")]
pub struct RejectedReply {
    #[ts(type = "number")]
    pub current_revision: u64,
    pub reason: RejectReason,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export, export_to = "../www/bindings/")]
pub enum CommandReply {
    Accepted(AcceptedReply),
    Rejected(RejectedReply),
}
