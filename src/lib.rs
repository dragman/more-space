use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod game;
mod hex;
use game::protocol::{CommandReply, RejectReason, RejectedReply, TeamTurnIntent};
use game::system::universe_json;
use game::Game;

thread_local! {
    static GAME: RefCell<Option<Game>> = RefCell::new(None);
}

fn with_game_mut<R>(f: impl FnOnce(&mut Game) -> R) -> Result<R, &'static str> {
    GAME.with(|cell| {
        let mut opt = cell.borrow_mut();
        match opt.as_mut() {
            Some(game) => Ok(f(game)),
            None => Err("game not initialized"),
        }
    })
}

#[wasm_bindgen]
pub fn init_game(seed: u64) {
    GAME.with(|g| {
        *g.borrow_mut() = Some(Game::new(seed));
    });
}

#[wasm_bindgen]
pub fn revision() -> u64 {
    with_game_mut(|game| game.revision()).unwrap_or_default()
}

#[wasm_bindgen]
pub fn snapshot() -> String {
    match with_game_mut(|game| serde_json::to_string(&game.snapshot())) {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => "{}".to_string(),
        Err(e) => e.to_string(),
    }
}

#[wasm_bindgen]
pub fn submit_team_intent(
    command_id: u64,
    expected_revision: u64,
    team_id: u8,
    intent_json: &str,
) -> String {
    let intent: TeamTurnIntent = match serde_json::from_str(intent_json) {
        Ok(v) => v,
        Err(err) => {
            let current_revision = with_game_mut(|game| game.revision()).unwrap_or_default();
            let reply = CommandReply::Rejected(RejectedReply {
                current_revision,
                reason: RejectReason::InvalidIntent,
                detail: Some(err.to_string()),
            });
            return serde_json::to_string(&reply).unwrap_or_else(|_| "{}".to_string());
        }
    };
    match with_game_mut(|game| {
        serde_json::to_string(&game.submit_team_intent(command_id, expected_revision, team_id, intent))
    }) {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => "{}".to_string(),
        Err(e) => e.to_string(),
    }
}

#[wasm_bindgen]
pub fn greeting() -> String {
    match with_game_mut(|game| game::greeting_for(game)) {
        Ok(v) => v,
        Err(e) => e.to_string(),
    }
}

#[wasm_bindgen]
pub fn generate_universe(seed: u64) -> String {
    universe_json(seed)
}

#[wasm_bindgen]
pub fn hex_grid(radius: u32) -> String {
    hex::grid_json(radius)
}

#[wasm_bindgen]
pub fn hex_window(center_q: i32, center_r: i32, radius: u32) -> String {
    hex::window_json(center_q, center_r, radius)
}
