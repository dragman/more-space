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

#[derive(Debug, Clone)]
struct HexCell {
    id: u32,
    coord: CubeCoord,
}

pub struct HexGrid {
    radius: u32,
    cells: Vec<HexCell>,
}

impl HexGrid {
    pub fn new(radius: u32) -> Self {
        let r = radius as i32;
        let mut cells = Vec::new();
        let mut id = 0;

        // Build a hexagon of radius r around the origin using cube coordinates.
        for x in -r..=r {
            for y in -r..=r {
                let z = -x - y;
                if z.abs() <= r {
                    cells.push(HexCell {
                        id,
                        coord: CubeCoord::new(x, y, z),
                    });
                    id += 1;
                }
            }
        }

        Self { radius, cells }
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
                    id: cell.id,
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
            cells,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HexCellView {
    pub id: u32,
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
    pub cells: Vec<HexCellView>,
}

pub fn grid_json(radius: u32) -> String {
    let grid = HexGrid::new(radius);
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
}
