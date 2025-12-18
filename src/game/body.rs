use crate::game::hazard::Hazard;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyKind {
    Star,
    Planet,
    Moon,
    Asteroid,
    Comet,
}

#[derive(Clone, Debug)]
pub struct Body {
    pub id: u32,
    pub kind: BodyKind,
    pub name: String,
    pub distance: u32,
    pub hazards: Vec<Hazard>,
    // optional: other truth fields like yield_rate, etc.
}
