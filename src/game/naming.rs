use crate::game::hazard::HazardKind;
use rand::Rng;
use rand_chacha::ChaCha8Rng;
use std::collections::HashSet;

const NAME_ONSETS: &[&str] = &[
    "st", "dr", "kr", "m", "n", "v", "th", "z", "gl", "pr", "t", "k", "r", "s", "l",
];
const NAME_VOWELS: &[&str] = &["a", "e", "i", "o", "u", "ae", "ia", "ai", "oo"];
const NAME_CODAS: &[&str] = &["n", "r", "s", "th", "l", "x", "k", "m", "sh"];
const NAME_ENDINGS: &[&str] = &["os", "ar", "en", "ion", "is", "or", "un", "eth", "eus"];

fn pick<'a>(rng: &mut ChaCha8Rng, options: &'a [&str]) -> &'a str {
    let idx = rng.gen_range(0..options.len());
    options[idx]
}

fn build_star_name_candidate(rng: &mut ChaCha8Rng) -> String {
    // A few hand-rolled phoneme patterns to keep names pronounceable.
    match rng.gen_range(0..4) {
        0 => format!(
            "{}{}{}",
            pick(rng, NAME_ONSETS),
            pick(rng, NAME_VOWELS),
            pick(rng, NAME_ENDINGS)
        ),
        1 => format!(
            "{}{}{}{}",
            pick(rng, NAME_ONSETS),
            pick(rng, NAME_VOWELS),
            pick(rng, NAME_CODAS),
            pick(rng, NAME_ENDINGS)
        ),
        2 => format!(
            "{}{}{}{}{}",
            pick(rng, NAME_ONSETS),
            pick(rng, NAME_VOWELS),
            pick(rng, NAME_ONSETS),
            pick(rng, NAME_VOWELS),
            pick(rng, NAME_ENDINGS)
        ),
        _ => format!(
            "{}{}{}{}",
            pick(rng, NAME_ONSETS),
            pick(rng, NAME_VOWELS),
            pick(rng, NAME_ENDINGS),
            pick(rng, NAME_CODAS)
        ),
    }
}

pub fn generate_star_name(rng: &mut ChaCha8Rng, used: &mut HashSet<String>) -> String {
    for _ in 0..500 {
        let candidate = build_star_name_candidate(rng);
        let mut chars = candidate.chars();
        let capitalized = match chars.next() {
            Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.collect::<String>()),
            None => continue,
        };

        if used.insert(capitalized.clone()) {
            return capitalized;
        }
    }

    panic!("exhausted attempts to generate a unique star name");
}

const ARTICLES: &[&str] = &["The", "A", "This", "That"];
const ADJECTIVES: &[&str] = &[
    "Silent",
    "Vagrant",
    "Crimson",
    "Iron",
    "Glass",
    "Blue",
    "Fallen",
    "Wandering",
    "Hidden",
    "Verdant",
    "Ashen",
    "Amber",
    "Sable",
    "Gilded",
    "Fractured",
    "Distant",
    "Last",
    "First",
    "Forgotten",
    "Radiant",
    "Cold",
    "Crowned",
    "Broken",
    "Lonely",
    "Burning",
    "Restless",
    "Sleeping",
    "Shattered",
    "Veiled",
    "Northern",
    "Southern",
    "Eastern",
    "Western",
    "Drifting",
    "Silver",
];
const NOUNS: &[&str] = &[
    "Garden",
    "Anvil",
    "Wake",
    "Halo",
    "Drifter",
    "Chorus",
    "Spire",
    "Tide",
    "Beacon",
    "Crown",
    "Forge",
    "Harbor",
    "Passage",
    "Pilgrim",
    "Pilgrimage",
    "Whisper",
    "Ember",
    "Comet",
    "Siren",
    "Step",
    "Gate",
    "Veil",
    "Crossing",
    "Hearth",
    "Dawn",
    "Dusk",
    "Eclipse",
    "Bridge",
    "Hollow",
    "Gulf",
    "Ridge",
    "Memory",
];
const VERBS: &[&str] = &[
    "Waits",
    "Sleeps",
    "Echoes",
    "Burns",
    "Drifts",
    "Remains",
    "Flickers",
    "Stands",
    "Watches",
    "Fades",
];

fn maybe<'a>(rng: &mut ChaCha8Rng, options: &'a [&str], chance: f64) -> Option<&'a str> {
    (rng.gen::<f64>() < chance).then(|| pick(rng, options))
}

fn themed_adjective(rng: &mut ChaCha8Rng, hazards: &[HazardKind]) -> Option<&'static str> {
    let themed: &[&str] = match hazards.iter().next() {
        Some(HazardKind::Radiation) => &["Irradiated", "Ionic", "Radiant", "Searing"],
        Some(HazardKind::Pirates) => &["Corsair", "Rogue", "Scarred", "Bloodied"],
        Some(HazardKind::Debris) => &["Shattered", "Broken", "Sundered", "Twisted"],
        None => &[],
    };
    if !themed.is_empty() && rng.gen::<f64>() < 0.35 {
        return Some(pick(rng, themed));
    }
    Some(pick(rng, ADJECTIVES))
}

fn themed_noun(rng: &mut ChaCha8Rng, hazards: &[HazardKind]) -> Option<&'static str> {
    let themed: &[&str] = match hazards.iter().next() {
        Some(HazardKind::Radiation) => &["Flare", "Pulse", "Glow"],
        Some(HazardKind::Pirates) => &["Cutlass", "Raid", "Corsair", "Marauder"],
        Some(HazardKind::Debris) => &["Wreck", "Shard", "Graveyard"],
        None => &[],
    };
    if !themed.is_empty() && rng.gen::<f64>() < 0.35 {
        return Some(pick(rng, themed));
    }
    Some(pick(rng, NOUNS))
}

pub fn generate_nickname(
    rng: &mut ChaCha8Rng,
    used: &mut HashSet<String>,
    hazards: &[HazardKind],
) -> Option<String> {
    #[derive(Clone, Copy)]
    enum Token {
        Article,
        Adjective,
        Noun,
        Verb,
    }

    const PATTERNS: &[(&[Token], u32)] = &[
        (&[Token::Noun], 4),
        (&[Token::Adjective, Token::Noun], 4),
        (&[Token::Article, Token::Noun], 3),
        (&[Token::Article, Token::Adjective, Token::Noun], 2),
        (&[Token::Adjective, Token::Adjective, Token::Noun], 1),
        (&[Token::Article, Token::Noun, Token::Verb], 1),
        (&[Token::Adjective, Token::Noun, Token::Verb], 1),
        (&[Token::Article, Token::Adjective, Token::Noun, Token::Verb], 1),
    ];

    let total_weight: u32 = PATTERNS.iter().map(|(_, w)| w).sum();

    for _ in 0..120 {
        let mut roll = rng.gen_range(0..total_weight);
        let mut chosen: &[Token] = PATTERNS[0].0;
        for (tokens, weight) in PATTERNS {
            if roll < *weight {
                chosen = tokens;
                break;
            }
            roll -= *weight;
        }

        let mut parts = Vec::new();
        for token in chosen {
            match token {
                Token::Article => {
                    if let Some(article) = maybe(rng, ARTICLES, 0.85) {
                        parts.push(article);
                    }
                }
                Token::Adjective => {
                    if let Some(adj) = themed_adjective(rng, hazards) {
                        parts.push(adj);
                    }
                }
                Token::Noun => {
                    if let Some(noun) = themed_noun(rng, hazards) {
                        parts.push(noun);
                    }
                }
                Token::Verb => {
                    if let Some(verb) = maybe(rng, VERBS, 0.35) {
                        parts.push(verb);
                    }
                }
            }
        }

        if parts.is_empty() {
            continue;
        }

        let nickname = parts.join(" ");
        if used.insert(nickname.clone()) {
            return Some(nickname);
        }
    }

    None
}
