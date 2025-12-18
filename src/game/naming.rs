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
