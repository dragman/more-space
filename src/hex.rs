use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct CubeCoord {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

impl CubeCoord {
    pub fn new(x: i32, y: i32, z: i32) -> Self {
        debug_assert!(x + y + z == 0, "cube coordinates must sum to zero");
        Self { x, y, z }
    }

    pub fn axial(&self) -> (i32, i32) {
        // Pointy-top orientation: q -> x, r -> z.
        (self.x, self.z)
    }

    pub fn distance_from_origin(&self) -> u32 {
        self.x.abs().max(self.y.abs()).max(self.z.abs()) as u32
    }

    pub fn key(&self) -> String {
        format!("{},{},{}", self.x, self.y, self.z)
    }
}

fn zigzag(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

fn pack_id(q: i32, r: i32) -> u64 {
    ((zigzag(q) as u64) << 32) | zigzag(r) as u64
}

fn unpack_id(id: u64) -> (i32, i32) {
    fn unzigzag(v: u32) -> i32 {
        ((v >> 1) as i32) ^ -((v & 1) as i32)
    }
    let q = unzigzag((id >> 32) as u32);
    let r = unzigzag(id as u32);
    (q, r)
}

#[derive(Debug, Clone)]
struct HexCell {
    id: u64,
    coord: CubeCoord,
}

pub struct HexGrid {
    radius: u32,
    center_q: i32,
    center_r: i32,
    cells: Vec<HexCell>,
}

impl HexGrid {
    pub fn new(radius: u32) -> Self {
        Self::window(0, 0, radius)
    }

    pub fn window(center_q: i32, center_r: i32, radius: u32) -> Self {
        let r = radius as i32;
        let center_y = -center_q - center_r;
        let mut cells = Vec::new();

        for dx in -r..=r {
            for dy in -r..=r {
                let dz = -dx - dy;
                if dz.abs() <= r {
                    let x = center_q + dx;
                    let y = center_y + dy;
                    let z = center_r + dz;
                    let coord = CubeCoord::new(x, y, z);
                    let (q, r_axial) = coord.axial();
                    cells.push(HexCell {
                        id: pack_id(q, r_axial),
                        coord,
                    });
                }
            }
        }

        Self {
            radius,
            center_q,
            center_r,
            cells,
        }
    }

    pub fn diameter(&self) -> u32 {
        self.radius.saturating_mul(2).saturating_add(1)
    }

    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn view(&self) -> HexGridView {
        let cells = self
            .cells
            .iter()
            .map(|cell| {
                let (q, r) = cell.coord.axial();
                HexCellView {
                    id: cell.id.to_string(),
                    key: cell.coord.key(),
                    x: cell.coord.x,
                    y: cell.coord.y,
                    z: cell.coord.z,
                    q,
                    r,
                    distance: cell.coord.distance_from_origin(),
                }
            })
            .collect();

        HexGridView {
            radius: self.radius,
            diameter: self.diameter(),
            cell_count: self.cell_count(),
            center_q: self.center_q,
            center_r: self.center_r,
            cells,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HexCellView {
    pub id: String,
    pub key: String,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub q: i32,
    pub r: i32,
    pub distance: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct HexGridView {
    pub radius: u32,
    pub diameter: u32,
    pub cell_count: usize,
    pub center_q: i32,
    pub center_r: i32,
    pub cells: Vec<HexCellView>,
}

pub fn grid_json(radius: u32) -> String {
    let grid = HexGrid::new(radius);
    let view = grid.view();
    serde_json::to_string(&view).unwrap_or_else(|_| "{}".to_string())
}

pub fn window_json(center_q: i32, center_r: i32, radius: u32) -> String {
    let grid = HexGrid::window(center_q, center_r, radius);
    let view = grid.view();
    serde_json::to_string(&view).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_grid_counts_match_formula() {
        for radius in 0..=3 {
            let grid = HexGrid::new(radius);
            let expected = 1 + 3 * radius * (radius + 1);
            assert_eq!(
                grid.cell_count(),
                expected as usize,
                "radius {} should yield {} cells",
                radius,
                expected
            );

            for cell in grid.cells.iter() {
                assert_eq!(cell.coord.x + cell.coord.y + cell.coord.z, 0);
                assert!(
                    cell.coord.distance_from_origin() <= radius,
                    "cell {:?} outside radius {}",
                    cell.coord,
                    radius
                );
            }
        }
    }

    #[test]
    fn axial_projection_matches_cube() {
        let grid = HexGrid::new(2);
        let view = grid.view();

        for (cell, view_cell) in grid.cells.iter().zip(view.cells.iter()) {
            let (q, r) = cell.coord.axial();
            assert_eq!(q, view_cell.q);
            assert_eq!(r, view_cell.r);
            assert_eq!(cell.coord.key(), view_cell.key);
        }
    }

    #[test]
    fn packed_ids_round_trip() {
        let id = pack_id(-3, 7);
        let (q, r) = unpack_id(id);
        assert_eq!((q, r), (-3, 7));
    }
}
