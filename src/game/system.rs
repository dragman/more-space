use crate::game::hazard::{
    apply_hazard, hazard_label, hazard_profile, Hazard, HazardKind, RiskChannels,
};
use crate::game::naming::generate_star_name;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::collections::HashSet;
use std::fmt::Write;
use std::ops::RangeInclusive;

#[derive(Clone, Debug)]
pub struct Star {
    pub id: u32,
    pub name: String,
    pub nickname: Option<String>,
}

#[derive(Clone, Debug)]
pub enum OrbitalKind {
    Planetoid,
    AsteroidBelt,
    Moon,
}

#[derive(Clone, Debug)]
pub struct OrbitalBody {
    pub id: u32,
    pub name: String,
    pub nickname: Option<String>,
    pub distance: u32,
    pub hazards: Vec<Hazard>,
    pub kind: OrbitalKind,
    pub moons: Vec<OrbitalBody>,
}

#[derive(Clone, Debug)]
pub struct StarSystem {
    pub id: u32,
    pub stars: Vec<Star>,
    pub orbitals: Vec<OrbitalBody>,
    pub links: Vec<u32>, // indices of connected systems
}

#[derive(Clone, Debug)]
pub struct SystemConfig {
    pub star_count: RangeInclusive<usize>,
    pub planetoids: RangeInclusive<usize>,
    pub asteroids: RangeInclusive<usize>,
    pub moons_per_planetoid: RangeInclusive<usize>,
    pub max_hazards_per_body: usize,
    pub nickname_chance: f64,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self {
            star_count: 1..=3,
            planetoids: 2..=4,
            asteroids: 1..=3,
            moons_per_planetoid: 0..=2,
            max_hazards_per_body: 2,
            nickname_chance: 0.2,
        }
    }
}

#[derive(Clone, Debug)]
pub struct UniverseConfig {
    pub systems: usize,
    pub extra_edges: usize,
    pub system: SystemConfig,
}

impl Default for UniverseConfig {
    fn default() -> Self {
        Self {
            systems: 4,
            extra_edges: 2,
            system: SystemConfig::default(),
        }
    }
}

pub struct Universe {
    pub systems: Vec<StarSystem>,
}

const BASE_PROBE_FAILURE: f64 = 0.05;
const NICKNAMES: &[&str] = &[
    "Dustbloom",
    "Firefly",
    "Blue Wake",
    "Iron Garden",
    "The Anvil",
    "Glass Halo",
    "Silent Drift",
    "Vagrant",
];

pub struct UniverseGenerator {
    rng: ChaCha8Rng,
    used_names: HashSet<String>,
    used_nicknames: HashSet<String>,
    next_id: u32,
    config: UniverseConfig,
}

impl UniverseGenerator {
    pub fn new(seed: u64) -> Self {
        Self::with_config(seed, UniverseConfig::default())
    }

    pub fn with_config(seed: u64, config: UniverseConfig) -> Self {
        Self {
            rng: ChaCha8Rng::seed_from_u64(seed),
            used_names: HashSet::new(),
            used_nicknames: HashSet::new(),
            next_id: 0,
            config,
        }
    }

    pub fn generate(&mut self) -> Universe {
        let mut systems = Vec::with_capacity(self.config.systems);
        for system_id in 0..self.config.systems as u32 {
            systems.push(self.generate_system(system_id));
        }
        self.connect_graph(&mut systems);

        Universe { systems }
    }

    fn connect_graph(&mut self, systems: &mut [StarSystem]) {
        // Ensure basic connectivity with a simple chain.
        for i in 0..systems.len().saturating_sub(1) {
            let a = i as u32;
            let b = (i + 1) as u32;
            systems[i].links.push(b);
            systems[i + 1].links.push(a);
        }

        // Add extra random bidirectional edges.
        for _ in 0..self.config.extra_edges {
            let a = self.rng.gen_range(0..systems.len()) as u32;
            let mut b = self.rng.gen_range(0..systems.len()) as u32;
            if a == b {
                b = ((b + 1) % systems.len() as u32) as u32;
            }
            if !systems[a as usize].links.contains(&b) {
                systems[a as usize].links.push(b);
                systems[b as usize].links.push(a);
            }
        }
    }

    fn rng_in_range(&mut self, range: RangeInclusive<usize>) -> usize {
        self.rng.gen_range(range)
    }

    fn maybe_nickname(&mut self) -> Option<String> {
        if self.used_nicknames.len() == NICKNAMES.len() {
            return None;
        }
        let roll: f64 = self.rng.gen();
        if roll < self.config.system.nickname_chance {
            // Try a few times to find an unused nickname; pool is small.
            for _ in 0..8 {
                let idx = self.rng.gen_range(0..NICKNAMES.len());
                let candidate = NICKNAMES[idx].to_string();
                if self.used_nicknames.insert(candidate.clone()) {
                    return Some(candidate);
                }
            }
            None
        } else {
            None
        }
    }

    fn make_star(&mut self) -> Star {
        let name = generate_star_name(&mut self.rng, &mut self.used_names);
        let nickname = self.maybe_nickname();
        let id = self.next_id;
        self.next_id += 1;

        Star { id, name, nickname }
    }

    fn next_hazard_kind(&mut self) -> HazardKind {
        match self.rng.gen_range(0..3) {
            0 => HazardKind::Radiation,
            1 => HazardKind::Pirates,
            _ => HazardKind::Debris,
        }
    }

    fn hazards_for_body(&mut self) -> Vec<Hazard> {
        if self.config.system.max_hazards_per_body == 0 {
            return Vec::new();
        }

        let count = self
            .rng
            .gen_range(0..=self.config.system.max_hazards_per_body as u32) as usize;

        let mut unique_kinds = HashSet::new();
        let mut hazards = Vec::with_capacity(count);
        while hazards.len() < count {
            let kind = self.next_hazard_kind();
            if unique_kinds.insert(kind) {
                hazards.push(Hazard {
                    kind,
                    profile: hazard_profile(kind),
                });
            }
        }
        hazards
    }

    fn roman_numeral(idx: usize) -> String {
        const NUMS: &[&str] = &["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
        NUMS.get(idx).unwrap_or(&"X").to_string()
    }

    fn make_moons(&mut self, parent_name: &str) -> Vec<OrbitalBody> {
        let moon_count = self.rng_in_range(self.config.system.moons_per_planetoid.clone());
        let mut moons = Vec::with_capacity(moon_count);
        for i in 0..moon_count {
            let name = format!("{} {}", parent_name, Self::roman_numeral(i));
            let nickname = self.maybe_nickname();
            moons.push(OrbitalBody {
                id: self.alloc_id(),
                name,
                nickname,
                distance: self.rng.gen_range(1..=20),
                hazards: self.hazards_for_body(),
                kind: OrbitalKind::Moon,
                moons: Vec::new(),
            });
        }
        moons
    }

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn make_planetoid(&mut self, base_name: &str, suffix: char) -> OrbitalBody {
        let name = format!("{} {}", base_name, suffix);
        let nickname = self.maybe_nickname();
        let moons = self.make_moons(&name);

        OrbitalBody {
            id: self.alloc_id(),
            name,
            nickname,
            distance: self.rng.gen_range(40..=400),
            hazards: self.hazards_for_body(),
            kind: OrbitalKind::Planetoid,
            moons,
        }
    }

    fn make_asteroid(&mut self, base_name: &str, idx: usize) -> OrbitalBody {
        let name = format!("{} Belt {}", base_name, Self::roman_numeral(idx));
        let nickname = self.maybe_nickname();

        OrbitalBody {
            id: self.alloc_id(),
            name,
            nickname,
            distance: self.rng.gen_range(300..=900),
            hazards: self.hazards_for_body(),
            kind: OrbitalKind::AsteroidBelt,
            moons: Vec::new(),
        }
    }

    fn generate_system(&mut self, system_id: u32) -> StarSystem {
        let star_count = self.rng_in_range(self.config.system.star_count.clone());
        let mut stars = Vec::with_capacity(star_count);
        for _ in 0..star_count {
            stars.push(self.make_star());
        }
        let primary_name = stars
            .first()
            .map(|s| s.name.clone())
            .unwrap_or_else(|| "Unnamed".to_string());

        let planetoid_count = self.rng_in_range(self.config.system.planetoids.clone());
        let mut orbitals = Vec::new();
        for i in 0..planetoid_count {
            let suffix = (b'b' + i as u8) as char;
            orbitals.push(self.make_planetoid(&primary_name, suffix));
        }

        let asteroid_count = self.rng_in_range(self.config.system.asteroids.clone());
        for i in 0..asteroid_count {
            orbitals.push(self.make_asteroid(&primary_name, i));
        }

        StarSystem {
            id: system_id,
            stars,
            orbitals,
            links: Vec::new(),
        }
    }
}

pub fn system_report(seed: u64) -> String {
    let mut gen = UniverseGenerator::new(seed);
    let universe = gen.generate();

    let mut output = String::new();
    let _ = writeln!(
        output,
        "Universe with {} systems (seed {})",
        universe.systems.len(),
        seed
    );

    for system in universe.systems {
        let links = if system.links.is_empty() {
            "none".to_string()
        } else {
            system
                .links
                .iter()
                .map(|l| l.to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let _ = writeln!(output, "System {} links -> {}", system.id, links);

        for star in &system.stars {
            let nick = star
                .nickname
                .as_ref()
                .map(|n| format!(" ({})", n))
                .unwrap_or_default();
            let _ = writeln!(output, "  Star: {}{}", star.name, nick);
        }

        for body in &system.orbitals {
            write_body(&mut output, body, 2);
        }
    }

    output
}

fn write_body(buf: &mut String, body: &OrbitalBody, indent: usize) {
    let pad = " ".repeat(indent);
    let probe_fail = probe_failure(body.hazards.as_slice());
    let hazard_list = if body.hazards.is_empty() {
        "none".to_string()
    } else {
        body.hazards
            .iter()
            .map(|h| hazard_label(h.kind))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let nick = body
        .nickname
        .as_ref()
        .map(|n| format!(" ({})", n))
        .unwrap_or_default();
    let _ = writeln!(
        buf,
        "{}- {} [{}] dist={} hazards={} probe_fail={:.2}%{}",
        pad,
        body.name,
        kind_label(&body.kind),
        body.distance,
        hazard_list,
        probe_fail * 100.0,
        nick
    );
    for moon in &body.moons {
        write_body(buf, moon, indent + 4);
    }
}

fn kind_label(kind: &OrbitalKind) -> &'static str {
    match kind {
        OrbitalKind::Planetoid => "Planetoid",
        OrbitalKind::AsteroidBelt => "Asteroid Belt",
        OrbitalKind::Moon => "Moon",
    }
}

fn probe_failure(hazards: &[Hazard]) -> f64 {
    let mut acc = RiskChannels::new();
    for h in hazards {
        apply_hazard(h, &mut acc);
    }
    acc.failure_prob(BASE_PROBE_FAILURE)
}
