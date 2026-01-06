use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod game;
mod hex;
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
pub fn tick() -> String {
    match with_game_mut(|game| game.tick().to_string()) {
        Ok(v) => v,
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
