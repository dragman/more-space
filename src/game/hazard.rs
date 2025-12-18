#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HazardKind {
    Radiation,
    Pirates,
    Debris,
}

#[derive(Clone, Copy, Debug)]
pub struct HazardProfile {
    pub probe_fail: f64,
    pub hull_damage: f64,
    pub yield_penalty: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Hazard {
    pub kind: HazardKind,
    pub profile: HazardProfile,
}

pub fn hazard_profile(kind: HazardKind) -> HazardProfile {
    match kind {
        HazardKind::Pirates => HazardProfile {
            probe_fail: 0.4,
            yield_penalty: 0.1,
            hull_damage: 0.5,
        },
        HazardKind::Radiation => HazardProfile {
            probe_fail: 0.1,
            yield_penalty: 0.4,
            hull_damage: 0.0,
        },
        HazardKind::Debris => HazardProfile {
            probe_fail: 0.2,
            yield_penalty: 0.1,
            hull_damage: 0.1,
        },
    }
}

pub fn hazard_label(kind: HazardKind) -> &'static str {
    match kind {
        HazardKind::Radiation => "Radiation",
        HazardKind::Pirates => "Pirates",
        HazardKind::Debris => "Debris",
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RiskChannels {
    pub additive: f64,
    pub noisy_or_survival: f64, // stored as Π(1 - p)
    pub multiplier: f64,
    pub max: f64,
}

impl RiskChannels {
    pub fn new() -> Self {
        Self {
            additive: 0.0,
            noisy_or_survival: 1.0,
            multiplier: 1.0,
            max: 0.0,
        }
    }

    pub fn failure_prob(&self, base: f64) -> f64 {
        let noisyor = 1.0 - self.noisy_or_survival;
        (base + self.additive + noisyor).clamp(0.0, 0.95)
    }
}

pub fn apply_hazard(h: &Hazard, acc: &mut RiskChannels) {
    match h.kind {
        HazardKind::Radiation => {
            acc.additive += h.profile.hull_damage;
            acc.noisy_or_survival *= 1.0 - h.profile.probe_fail;
            acc.multiplier *= 1.0 - h.profile.yield_penalty;
        }
        HazardKind::Pirates => {
            acc.additive += h.profile.hull_damage;
            acc.noisy_or_survival *= 1.0 - h.profile.probe_fail;
            acc.multiplier *= 1.0 - h.profile.yield_penalty;
        }
        HazardKind::Debris => {
            acc.additive += h.profile.hull_damage;
            acc.noisy_or_survival *= 1.0 - h.profile.probe_fail;
            acc.multiplier *= 1.0 - h.profile.yield_penalty;
        }
    }
}
