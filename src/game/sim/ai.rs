use super::*;

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct GameAi;

#[derive(Debug, Clone, Copy)]
struct AiProfile {
    aggression: f64,
    caution: f64,
    scan_bias: f64,
    loot_bias: f64,
    retreat_hp_ratio: f64,
}

#[derive(Debug, Clone, Copy)]
pub(super) enum MovementIntent {
    Toward(CubeCoord),
    AwayFrom(CubeCoord),
    Hold,
}

#[derive(Clone)]
pub(super) struct MovementDecision {
    pub(super) intent: MovementIntent,
    pub(super) intent_kind: DecisionIntent,
    pub(super) reason: String,
    pub(super) target: Option<CubeCoord>,
}

#[derive(Clone)]
pub(super) struct IntentMeta {
    pub(super) intent_kind: DecisionIntent,
    pub(super) reason: String,
    pub(super) target: Option<CubeCoord>,
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
    pub(super) fn should_active_scan<R: Rng>(&self, rng: &mut R, unit: &Unit, sim: &SimState) -> bool {
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

    pub(super) fn choose_movement_decision<R: Rng>(
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

    pub(super) fn inventory_full(&self, unit: &Unit) -> bool {
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
