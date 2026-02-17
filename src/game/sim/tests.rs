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

#[test]
fn new_state_applies_starting_passive_and_visual_scans() {
    let mut rng = ChaCha8Rng::seed_from_u64(1234);
    let sim = SimState::new(&mut rng, test_config());

    let any_non_prior = sim.knowledge.iter().any(|team_knowledge| {
        team_knowledge
            .beliefs
            .iter()
            .any(|belief| belief.enemy != BASE_ENEMY_PRIOR || belief.loot != BASE_LOOT_PRIOR)
    });
    assert!(
        any_non_prior,
        "expected at least one belief to differ from priors at init due to startup scans"
    );
}

#[test]
fn submit_command_rejects_revision_mismatch() {
    let mut rng = ChaCha8Rng::seed_from_u64(77);
    let mut sim = SimState::new(&mut rng, test_config());

    let reply = sim.submit_command(
        &mut rng,
        CommandEnvelope {
            command_id: 1,
            expected_revision: 9,
            command: SimCommand::SubmitTeamIntent {
                team_id: 0,
                intent: TeamTurnIntent {
                    unit_intents: vec![],
                },
            },
        },
    );

    match reply {
        CommandReply::Rejected(rej) => {
            assert_eq!(rej.reason, RejectReason::RevisionMismatch);
            assert_eq!(rej.current_revision, sim.revision());
        }
        other => panic!("expected rejection, got {other:?}"),
    }
}

#[test]
fn submit_team_intent_resolves_turn_and_increments_revision() {
    let mut rng = ChaCha8Rng::seed_from_u64(88);
    let mut sim = SimState::new(&mut rng, test_config());
    let starting_turn = sim.turn;

    let reply = sim.submit_command(
        &mut rng,
        CommandEnvelope {
            command_id: 10,
            expected_revision: 0,
            command: SimCommand::SubmitTeamIntent {
                team_id: 0,
                intent: TeamTurnIntent {
                    unit_intents: vec![],
                },
            },
        },
    );

    match reply {
        CommandReply::Accepted(ok) => {
            assert_eq!(ok.revision, 1);
            assert!(ok.pending_teams.is_empty());
            let log = ok.resolved_turn.expect("turn should resolve");
            assert_eq!(log.turn, starting_turn + 1);
        }
        other => panic!("expected acceptance, got {other:?}"),
    }
    assert_eq!(sim.revision(), 1);
}

#[test]
fn duplicate_command_id_is_idempotent() {
    let mut rng = ChaCha8Rng::seed_from_u64(99);
    let mut sim = SimState::new(&mut rng, test_config());

    let envelope = CommandEnvelope {
        command_id: 42,
        expected_revision: 0,
        command: SimCommand::SubmitTeamIntent {
            team_id: 0,
            intent: TeamTurnIntent {
                unit_intents: vec![],
            },
        },
    };

    let first = sim.submit_command(&mut rng, envelope.clone());
    let second = sim.submit_command(&mut rng, envelope);

    let first_json = serde_json::to_string(&first).expect("serialize first reply");
    let second_json = serde_json::to_string(&second).expect("serialize second reply");
    assert_eq!(first_json, second_json);
    assert_eq!(sim.revision(), 1);
}

#[test]
fn submit_team_move_intent_moves_unit() {
    let mut sim = make_test_state();
    let mut rng = ChaCha8Rng::seed_from_u64(202);
    let start = sim.units.iter().find(|u| u.id == 1).expect("unit 1").pos;
    let to = CubeCoord::new(start.x + 1, start.y - 1, start.z);
    let to_cell_id = pack_id(to.x, to.z);

    let reply = sim.submit_command(
        &mut rng,
        CommandEnvelope {
            command_id: 77,
            expected_revision: 0,
            command: SimCommand::SubmitTeamIntent {
                team_id: 0,
                intent: TeamTurnIntent {
                    unit_intents: vec![UnitIntent::Move {
                        unit_id: 1,
                        to_cell_id,
                    }],
                },
            },
        },
    );

    let CommandReply::Accepted(ok) = reply else {
        panic!("expected accepted reply");
    };
    let log = ok.resolved_turn.expect("turn should resolve");
    let moved = log.units.iter().find(|u| u.id == 1).expect("unit in log");
    assert_eq!(moved.pos.id, to_cell_id.to_string());
}
