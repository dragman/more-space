pub mod body;
pub mod hazard;
pub mod naming;
pub mod system;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

pub struct Game {
    turn: u32,
    rng: ChaCha8Rng,
}

impl Game {
    pub fn new(seed: u64) -> Self {
        Self {
            turn: 0,
            rng: ChaCha8Rng::seed_from_u64(seed),
        }
    }

    pub fn next_f64(&mut self) -> f64 {
        self.rng.gen()
    }

    pub fn next_u32(&mut self) -> u32 {
        self.rng.gen()
    }

    pub fn tick(&mut self) -> u32 {
        self.turn += 1;
        self.turn
    }
}

pub fn greeting_for(game: &mut Game) -> String {
    let number = game.next_u32();
    format!("Hello, more-space2! My random number is: {}", number)
}

#[cfg(test)]
mod tests {
    use super::hazard::{
        apply_hazard, hazard_profile, Hazard, HazardKind, RiskChannels,
    };
    use super::naming::generate_star_name;
    use super::system::{UniverseConfig, UniverseGenerator};
    use super::Game;
    use rand::SeedableRng;
    use rand_chacha::ChaCha8Rng;
    use std::collections::HashSet;

    #[test]
    fn deterministic_with_same_seed() {
        let mut g1 = Game::new(42);
        let mut g2 = Game::new(42);

        // Advance state and sample numbers; sequences should match.
        assert_eq!(g1.tick(), g2.tick());
        assert_eq!(g1.next_u32(), g2.next_u32());
        assert_eq!(g1.tick(), g2.tick());
        assert_eq!(g1.next_u32(), g2.next_u32());
    }

    #[test]
    fn risk_channels_yield_expected_failure_probability() {
        let mut acc = RiskChannels::new();
        let hazards = [
            Hazard {
                kind: HazardKind::Radiation,
                profile: hazard_profile(HazardKind::Radiation),
            },
            Hazard {
                kind: HazardKind::Debris,
                profile: hazard_profile(HazardKind::Debris),
            },
        ];

        for hazard in hazards.iter() {
            apply_hazard(hazard, &mut acc);
        }

        let probability = acc.failure_prob(0.05);
        let expected = 0.43; // 0.05 base + 0.1 additive hull + 0.28 noisy-or
        assert!(
            (probability - expected).abs() < 1e-12,
            "expected {expected}, got {probability}"
        );
    }

    #[test]
    fn star_name_generation_is_deterministic_and_unique() {
        let mut rng = ChaCha8Rng::seed_from_u64(7);
        let mut used = HashSet::new();
        let names: Vec<String> = (0..5)
            .map(|_| generate_star_name(&mut rng, &mut used))
            .collect();

        assert_eq!(
            names,
            vec![
                "Staisen".to_string(),
                "Voenm".to_string(),
                "Driis".to_string(),
                "Kraearr".to_string(),
                "Zaerun".to_string()
            ]
        );
        assert_eq!(used.len(), names.len());
    }

    #[test]
    fn generates_many_unique_names_without_collision() {
        let mut rng = ChaCha8Rng::seed_from_u64(99);
        let mut used = HashSet::new();
        for _ in 0..64 {
            generate_star_name(&mut rng, &mut used);
        }
        assert_eq!(used.len(), 64);
    }

    #[test]
    fn system_generation_is_deterministic() {
        let config = UniverseConfig::default();
        let mut g1 = UniverseGenerator::with_config(123, config.clone());
        let mut g2 = UniverseGenerator::with_config(123, config);

        let sys1 = g1.generate();
        let sys2 = g2.generate();

        assert_eq!(sys1.systems.len(), sys2.systems.len());
        assert_eq!(sys1.systems[0].stars[0].name, sys2.systems[0].stars[0].name);
    }

    #[test]
    fn system_generator_respects_uniqueness_and_hazard_limits() {
        let config = UniverseConfig::default();
        let max_hazards = config.system.max_hazards_per_body;
        let mut gen = UniverseGenerator::with_config(321, config);
        let universe = gen.generate();

        let mut names = HashSet::new();
        for sys in &universe.systems {
            for star in &sys.stars {
                assert!(names.insert(star.name.clone()));
            }
            for body in &sys.orbitals {
                assert!(
                    body.hazards.len() <= max_hazards,
                    "too many hazards on {}",
                    body.name
                );
                assert!(names.insert(body.name.clone()));
                for moon in &body.moons {
                    assert!(names.insert(moon.name.clone()));
                }
            }
        }
    }

    #[test]
    fn naming_is_hierarchical() {
        let mut config = UniverseConfig::default();
        config.systems = 1;
        config.extra_edges = 0;
        config.system.star_count = 1..=1;
        config.system.planetoids = 1..=1;
        config.system.asteroids = 0..=0;
        config.system.moons_per_planetoid = 1..=1;

        let mut gen = UniverseGenerator::with_config(111, config);
        let universe = gen.generate();
        let system = &universe.systems[0];
        let primary = &system.stars[0].name;
        let planet = &system.orbitals[0];

        assert!(planet.name.starts_with(primary));
        assert_eq!(planet.name, format!("{} b", primary));
        let moon = planet.moons.first().expect("moon present");
        assert!(moon.name.starts_with(&planet.name));
    }

    #[test]
    fn nicknames_are_unique() {
        let mut config = UniverseConfig::default();
        config.systems = 3;
        config.system.star_count = 1..=2;
        config.system.planetoids = 2..=3;
        config.system.asteroids = 1..=1;
        config.system.moons_per_planetoid = 1..=1;
        config.system.nickname_chance = 1.0; // force nickname attempts

        let mut gen = UniverseGenerator::with_config(555, config);
        let universe = gen.generate();

        let mut seen = HashSet::new();
        for sys in &universe.systems {
            for star in &sys.stars {
                if let Some(nick) = &star.nickname {
                    assert!(seen.insert(nick.clone()), "duplicate nickname {}", nick);
                }
            }
            for body in &sys.orbitals {
                if let Some(nick) = &body.nickname {
                    assert!(seen.insert(nick.clone()), "duplicate nickname {}", nick);
                }
                for moon in &body.moons {
                    if let Some(nick) = &moon.nickname {
                        assert!(seen.insert(nick.clone()), "duplicate nickname {}", nick);
                    }
                }
            }
        }
    }
}
