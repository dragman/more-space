use crate::game::hazard::{
    apply_hazard, hazard_label, hazard_profile, Hazard, HazardKind, RiskChannels,
};
use crate::game::naming::{generate_nickname, generate_star_name};
use rand::{seq::SliceRandom, Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;
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
        let n = systems.len();
        if n <= 1 {
            return;
        }

        // Random spanning tree: shuffle node order and connect each new node to a random earlier node.
        let mut order: Vec<u32> = (0..n as u32).collect();
        order.shuffle(&mut self.rng);
        for window in 1..order.len() {
            let child = order[window];
            let parent_idx = self.rng.gen_range(0..window);
            let parent = order[parent_idx];
            systems[parent as usize].links.push(child);
            systems[child as usize].links.push(parent);
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

    fn maybe_nickname(&mut self, hazards: &[HazardKind]) -> Option<String> {
        let roll: f64 = self.rng.gen();
        if roll < self.config.system.nickname_chance {
            generate_nickname(&mut self.rng, &mut self.used_nicknames, hazards)
        } else {
            None
        }
    }

    fn make_star(&mut self) -> Star {
        let name = generate_star_name(&mut self.rng, &mut self.used_names);
        let nickname = self.maybe_nickname(&[]);
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
            let hazards = self.hazards_for_body();
            let nickname = self.maybe_nickname(&hazard_kinds(&hazards));
            moons.push(OrbitalBody {
                id: self.alloc_id(),
                name,
                nickname,
                distance: self.rng.gen_range(1..=20),
                hazards,
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
        let hazards = self.hazards_for_body();
        let nickname = self.maybe_nickname(&hazard_kinds(&hazards));
        let moons = self.make_moons(&name);

        OrbitalBody {
            id: self.alloc_id(),
            name,
            nickname,
            distance: self.rng.gen_range(40..=400),
            hazards,
            kind: OrbitalKind::Planetoid,
            moons,
        }
    }

    fn make_asteroid(&mut self, base_name: &str, idx: usize) -> OrbitalBody {
        let name = format!("{} Belt {}", base_name, Self::roman_numeral(idx));
        let hazards = self.hazards_for_body();
        let nickname = self.maybe_nickname(&hazard_kinds(&hazards));

        OrbitalBody {
            id: self.alloc_id(),
            name,
            nickname,
            distance: self.rng.gen_range(300..=900),
            hazards,
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

pub fn universe_json(seed: u64) -> String {
    let mut gen = UniverseGenerator::new(seed);
    let universe = gen.generate();
    let view = UniverseView::from(&universe);
    serde_json::to_string(&view).unwrap_or_else(|_| "{}".to_string())
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

fn hazard_kinds(hazards: &[Hazard]) -> Vec<HazardKind> {
    hazards.iter().map(|h| h.kind).collect()
}

#[derive(Serialize)]
struct HazardView {
    kind: &'static str,
    probe_fail: f64,
    hull_damage: f64,
    yield_penalty: f64,
}

#[derive(Serialize)]
struct OrbitalView {
    name: String,
    nickname: Option<String>,
    distance: u32,
    kind: &'static str,
    probe_failure: f64,
    hazards: Vec<HazardView>,
    moons: Vec<OrbitalView>,
}

#[derive(Serialize)]
struct StarView {
    name: String,
    nickname: Option<String>,
}

#[derive(Serialize)]
struct SystemView {
    id: u32,
    stars: Vec<StarView>,
    orbitals: Vec<OrbitalView>,
    links: Vec<u32>,
}

#[derive(Serialize)]
struct UniverseView {
    systems: Vec<SystemView>,
}

impl From<&Hazard> for HazardView {
    fn from(h: &Hazard) -> Self {
        Self {
            kind: hazard_label(h.kind),
            probe_fail: h.profile.probe_fail,
            hull_damage: h.profile.hull_damage,
            yield_penalty: h.profile.yield_penalty,
        }
    }
}

impl From<&OrbitalBody> for OrbitalView {
    fn from(body: &OrbitalBody) -> Self {
        let moons = body.moons.iter().map(OrbitalView::from).collect();
        let hazards: Vec<HazardView> = body.hazards.iter().map(HazardView::from).collect();
        Self {
            name: body.name.clone(),
            nickname: body.nickname.clone(),
            distance: body.distance,
            kind: kind_label(&body.kind),
            probe_failure: probe_failure(&body.hazards),
            hazards,
            moons,
        }
    }
}

impl From<&Star> for StarView {
    fn from(star: &Star) -> Self {
        Self {
            name: star.name.clone(),
            nickname: star.nickname.clone(),
        }
    }
}

impl From<&StarSystem> for SystemView {
    fn from(system: &StarSystem) -> Self {
        Self {
            id: system.id,
            stars: system.stars.iter().map(StarView::from).collect(),
            orbitals: system.orbitals.iter().map(OrbitalView::from).collect(),
            links: system.links.clone(),
        }
    }
}

impl From<&Universe> for UniverseView {
    fn from(universe: &Universe) -> Self {
        Self {
            systems: universe.systems.iter().map(SystemView::from).collect(),
        }
    }
}
