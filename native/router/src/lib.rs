//! Belt router: the same Dijkstra as `routeBelt` in `solver/src/layout.ts`,
//! compiled to wasm32 and fed a dense snapshot of the search box.
//!
//! The JS caller owns the `World`; this side only answers the question "which
//! run is cheapest in this box". Tile predicates arrive as four byte planes
//! (`flags`, `belt`, `end`, `under`) indexed `(y - minY) * width + (x - minX)`.
//!
//! The search is transcribed one-to-one, down to the LIFO bucket order and the
//! repeated-tile cut, so the chosen run is byte-identical to the JS router.

use std::cell::RefCell;
use std::collections::HashSet;

const PHASES: u32 = 6;
const MAX_UNDERGROUND: u32 = 4;
const INF: i32 = 0x7fff_ffff;
const DIRS: [(i32, i32); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// flags plane
const P_BLOCKED: u8 = 1;
const P_EXEMPT: u8 = 2;
const P_TUNNEL_CELL: u8 = 4;

/// request flags
const F_ALLOW_CROSS: u32 = 1;
const F_RELAX_CROSS: u32 = 2;
const F_GOAL_JOIN: u32 = 4;
const F_FRONTIER: u32 = 8;

struct Scratch {
    dist: Vec<i32>,
    from: Vec<i32>,
    ring: [Vec<u32>; 7],
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch {
        dist: Vec::new(),
        from: Vec::new(),
        ring: Default::default(),
    });
    static RESULT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Scratch buffer for the input planes; the JS side writes them in place.
#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(size, 1).expect("layout");
    unsafe { std::alloc::alloc(layout) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    let layout = std::alloc::Layout::from_size_align(size, 1).expect("layout");
    unsafe { std::alloc::dealloc(ptr, layout) }
}

/// Result layout: `[path_len][frontier_len][states][attempts]` then
/// `path_len` triples of `(cell, phase, heading)` and `frontier_len` keys.
#[no_mangle]
pub extern "C" fn result_ptr() -> usize {
    RESULT.with(|cell| cell.borrow().as_ptr() as usize)
}

#[inline]
fn relax(
    dist: &mut [i32],
    from: &mut [i32],
    ring: &mut [Vec<u32>; 7],
    max_cost: &mut i32,
    next: u32,
    total: i32,
    state: u32,
) {
    let i = next as usize;
    if total >= dist[i] {
        return;
    }
    dist[i] = total;
    from[i] = state as i32;
    ring[(total as usize) % 7].push(next);
    if total > *max_cost {
        *max_cost = total;
    }
}

/// Run the search for one request; returns the result pointer.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn route(
    input: *const u8,
    width: u32,
    height: u32,
    min_x: i32,
    min_y: i32,
    start_x: i32,
    start_y: i32,
    goal_x: i32,
    goal_y: i32,
    flags: u32,
    start_dir: i32,
    goal_dir: i32,
) -> usize {
    let w = width as usize;
    let h = height as usize;
    let size = w * h;
    let planes = std::slice::from_raw_parts(input, 4 * size);
    let p_flags = &planes[0..size];
    let p_belt = &planes[size..2 * size];
    let p_end = &planes[2 * size..3 * size];
    let p_under = &planes[3 * size..4 * size];

    let index_of =
        |x: i32, y: i32| -> usize { ((y - min_y) as usize) * w + (x - min_x) as usize };
    let key_of = |x: i32, y: i32| -> u32 { ((x + 4096) as u32) * 8192 + (y + 4096) as u32 };
    let max_x = min_x + w as i32 - 1;
    let max_y = min_y + h as i32 - 1;
    let start_index = index_of(start_x, start_y) as u32;
    let goal_index = index_of(goal_x, goal_y) as u32;

    let allow_cross = flags & F_ALLOW_CROSS != 0;
    let relax_cross = flags & F_RELAX_CROSS != 0;
    let goal_join = flags & F_GOAL_JOIN != 0;
    let want_frontier = flags & F_FRONTIER != 0;
    // negative = no direction given; out-of-range = a vector no axis matches,
    // which the JS router treats the same way (the check never passes)
    let start_dir = start_dir;
    let goal_dir = goal_dir;

    let total_states = size * PHASES as usize * 4;
    let mut forbidden: HashSet<u32> = HashSet::new();
    let mut frontier: Vec<u32> = Vec::new();
    let mut frontier_seen: HashSet<u32> = HashSet::new();
    let mut chosen: Option<Vec<u32>> = None;
    let mut attempts: u32 = 0;
    let mut states_visited: u32 = 0;

    macro_rules! blame {
        ($k:expr) => {
            if want_frontier && frontier_seen.insert($k) {
                frontier.push($k);
            }
        };
    }

    // A belt path may not visit one tile twice. When the cheapest run does,
    // forbid that edge and search again — same cut rule as the JS router.
    for _ in 0..64 {
        attempts += 1;
        let mut found: Option<Vec<u32>> = None;
        // `best < 0` = no run at all in this attempt: the JS router returns
        // null right away instead of re-searching the same exhausted box
        let mut dead_end = false;
        SCRATCH.with(|scratch| {
            let mut scratch = scratch.borrow_mut();
            let s = &mut *scratch;
            if s.dist.len() < total_states {
                s.dist.resize(total_states, INF);
                s.from.resize(total_states, -1);
            }
            let dist = &mut s.dist[..total_states];
            let from = &mut s.from[..total_states];
            dist.fill(INF);
            from.fill(-1);
            for bucket in s.ring.iter_mut() {
                bucket.clear();
            }
            let ring = &mut s.ring;
            let mut max_cost: i32 = 0;

            for d in 0..4u32 {
                let state = start_index * PHASES * 4 + d;
                dist[state as usize] = 0;
                ring[0].push(state);
            }

            // `tunnelFree` / `senderOk` read the under plane at a box index.
            let tunnel_free = |key: usize, d: usize| -> bool {
                (((p_under[key] as u32) >> d) & 1) == 0
            };
            let sender_ok = |d: usize, cell: u32, heading: u32, cur: u32| -> bool {
                let dir = DIRS[d];
                if cell == start_index {
                    if start_dir < 0 || start_dir > 3 {
                        return false;
                    }
                    if DIRS[start_dir as usize] != dir {
                        return false;
                    }
                } else if d as u32 != heading {
                    return false;
                }
                (((p_under[cur as usize] as u32) >> d) & 1) == 0
            };

            let mut best: i64 = -1;
            let mut cost: i32 = 0;
            'cost: while cost <= max_cost {
                let slot = (cost as usize) % 7;
                // drain the bucket at this cost; relaxes at the same cost land
                // in this same slot and are handled before the cost advances
                loop {
                    let state = match ring[slot].pop() {
                        Some(v) => v,
                        None => break,
                    };
                    if dist[state as usize] != cost {
                        continue;
                    }
                    states_visited += 1;
                    let cell = state / (PHASES * 4);
                    let rest = state % (PHASES * 4);
                    let phase = rest >> 2;
                    let heading = rest & 3;
                    if cell == goal_index {
                        best = state as i64;
                        break 'cost;
                    }
                    let cx = (cell as usize % w) as i32 + min_x;
                    let cy = (cell as usize / w) as i32 + min_y;
                    let cur_key = cell;
                    let prev_cell: i64 = if from[state as usize] >= 0 {
                        (from[state as usize] as u32 / (PHASES * 4)) as i64
                    } else {
                        -1
                    };

                    if phase == 0 {
                        for d in 0..4usize {
                            if forbidden.contains(&(state * 4 + d as u32)) {
                                continue;
                            }
                            let dir = DIRS[d];
                            let nx = cx + dir.0;
                            let ny = cy + dir.1;
                            if nx < min_x || nx > max_x || ny < min_y || ny > max_y {
                                continue;
                            }
                            let ni = index_of(nx, ny);
                            if ni as i64 == prev_cell {
                                continue;
                            }
                            let nk = key_of(nx, ny);
                            let is_start = nx == start_x && ny == start_y;
                            let is_goal = nx == goal_x && ny == goal_y;
                            let step = 1 + if d as u32 == heading { 0 } else { 2 };
                            let nf = p_flags[ni];
                            let blocked = !is_start
                                && !is_goal
                                && nf & P_EXEMPT == 0
                                && nf & P_BLOCKED != 0;
                            if blocked {
                                if !allow_cross
                                    || !sender_ok(d, cell, heading, cur_key)
                                    || !tunnel_free(ni, d)
                                {
                                    blame!(nk);
                                } else {
                                    relax(
                                        dist,
                                        from,
                                        ring,
                                        &mut max_cost,
                                        (ni as u32 * PHASES + 1) * 4 + d as u32,
                                        cost + step + 3,
                                        state,
                                    );
                                }
                                continue;
                            }
                            let belt = p_belt[ni];
                            if belt != 0 {
                                if is_goal {
                                    if goal_join {
                                        relax(
                                            dist,
                                            from,
                                            ring,
                                            &mut max_cost,
                                            (ni as u32 * PHASES) * 4 + d as u32,
                                            cost + step,
                                            state,
                                        );
                                    }
                                    continue;
                                }
                                // the tunnel runs under a perpendicular belt,
                                // never along one; a turn counts as crossable
                                // only for the repair pass (`relaxCross`)
                                let along = if relax_cross {
                                    belt == if d < 2 { 1 } else { 2 }
                                } else {
                                    belt != if d < 2 { 2 } else { 1 }
                                };
                                if !allow_cross || along {
                                    blame!(nk);
                                    continue;
                                }
                                if nf & P_TUNNEL_CELL != 0
                                    || !tunnel_free(ni, d)
                                    || !sender_ok(d, cell, heading, cur_key)
                                {
                                    blame!(nk);
                                    continue;
                                }
                                relax(
                                    dist,
                                    from,
                                    ring,
                                    &mut max_cost,
                                    (ni as u32 * PHASES + 1) * 4 + d as u32,
                                    cost + step + 3,
                                    state,
                                );
                                continue;
                            }
                            let end = p_end[ni];
                            if end != 0 {
                                if is_goal {
                                    continue;
                                }
                                let end_dir = (end - 1) as usize;
                                if !allow_cross
                                    || end_dir == d
                                    || !sender_ok(d, cell, heading, cur_key)
                                {
                                    continue;
                                }
                                if !tunnel_free(ni, d) {
                                    blame!(nk);
                                    continue;
                                }
                                relax(
                                    dist,
                                    from,
                                    ring,
                                    &mut max_cost,
                                    (ni as u32 * PHASES + 1) * 4 + d as u32,
                                    cost + step + 3,
                                    state,
                                );
                                continue;
                            }
                            // free ground: stay on the surface or dive under it
                            if allow_cross
                                && sender_ok(d, cell, heading, cur_key)
                                && tunnel_free(ni, d)
                            {
                                relax(
                                    dist,
                                    from,
                                    ring,
                                    &mut max_cost,
                                    (ni as u32 * PHASES + 1) * 4 + d as u32,
                                    cost + step + 3,
                                    state,
                                );
                            }
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES) * 4 + d as u32,
                                cost + step,
                                state,
                            );
                        }
                        continue;
                    }

                    if phase <= MAX_UNDERGROUND {
                        // underground: straight on only
                        let d = heading as usize;
                        if forbidden.contains(&(state * 4 + d as u32)) {
                            continue;
                        }
                        let dir = DIRS[d];
                        let nx = cx + dir.0;
                        let ny = cy + dir.1;
                        if nx < min_x || nx > max_x || ny < min_y || ny > max_y {
                            continue;
                        }
                        let ni = index_of(nx, ny);
                        if ni as i64 == prev_cell {
                            continue;
                        }
                        let nk = key_of(nx, ny);
                        let is_start = nx == start_x && ny == start_y;
                        let is_goal = nx == goal_x && ny == goal_y;
                        let nf = p_flags[ni];
                        let is_blocked = !is_start
                            && !is_goal
                            && nf & P_EXEMPT == 0
                            && nf & P_BLOCKED != 0;
                        let next_phase = phase + 1;
                        let belt = p_belt[ni];
                        let end = p_end[ni];
                        if is_goal {
                            // may surface on the goal port, but nothing may sit
                            // there and the receiver has to face the machine
                            if belt != 0 || end != 0 {
                                continue;
                            }
                            if goal_dir < 0 || goal_dir > 3 {
                                continue;
                            }
                            if DIRS[goal_dir as usize] != dir {
                                continue;
                            }
                            if (p_under[ni] as u32 >> d) & 1 != 0 {
                                continue;
                            }
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES + 5) * 4 + d as u32,
                                cost + 1,
                                state,
                            );
                            continue;
                        }
                        if belt != 0 {
                            let along = if relax_cross {
                                belt == if d < 2 { 1 } else { 2 }
                            } else {
                                belt != if d < 2 { 2 } else { 1 }
                            };
                            if along {
                                continue;
                            }
                            if nf & P_TUNNEL_CELL != 0 {
                                continue;
                            }
                            if !tunnel_free(ni, d) {
                                blame!(nk);
                                continue;
                            }
                            if next_phase > MAX_UNDERGROUND {
                                continue;
                            }
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES + next_phase) * 4 + d as u32,
                                cost + 4,
                                state,
                            );
                            continue;
                        }
                        if end != 0 {
                            let end_dir = (end - 1) as usize;
                            if !allow_cross || end_dir == d {
                                continue;
                            }
                            if !tunnel_free(ni, d) {
                                blame!(nk);
                                continue;
                            }
                            if next_phase > MAX_UNDERGROUND {
                                continue;
                            }
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES + next_phase) * 4 + d as u32,
                                cost + 4,
                                state,
                            );
                            continue;
                        }
                        if is_blocked {
                            // under a machine: no receiver can be placed here
                            if next_phase <= MAX_UNDERGROUND && tunnel_free(ni, d) {
                                relax(
                                    dist,
                                    from,
                                    ring,
                                    &mut max_cost,
                                    (ni as u32 * PHASES + next_phase) * 4 + d as u32,
                                    cost + 1,
                                    state,
                                );
                            } else {
                                blame!(nk);
                            }
                            continue;
                        }
                        // free ground: the run may surface here or stay under
                        if (p_under[ni] as u32 >> d) & 1 == 0 {
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES + 5) * 4 + d as u32,
                                cost + 1,
                                state,
                            );
                        }
                        if next_phase <= MAX_UNDERGROUND {
                            if !tunnel_free(ni, d) {
                                continue;
                            }
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES + next_phase) * 4 + d as u32,
                                cost + 1,
                                state,
                            );
                        }
                        continue;
                    }

                    // receiver: one forced straight step onto a surface tile
                    let d = heading as usize;
                    if forbidden.contains(&(state * 4 + d as u32)) {
                        continue;
                    }
                    let dir = DIRS[d];
                    let nx = cx + dir.0;
                    let ny = cy + dir.1;
                    if nx < min_x || nx > max_x || ny < min_y || ny > max_y {
                        continue;
                    }
                    let ni = index_of(nx, ny);
                    if ni as i64 == prev_cell {
                        continue;
                    }
                    let nk = key_of(nx, ny);
                    let is_start = nx == start_x && ny == start_y;
                    let is_goal = nx == goal_x && ny == goal_y;
                    let nf = p_flags[ni];
                    if !is_start && !is_goal && nf & P_EXEMPT == 0 && nf & P_BLOCKED != 0 {
                        blame!(nk);
                        continue;
                    }
                    let belt = p_belt[ni];
                    if belt != 0 {
                        if is_goal && goal_join {
                            relax(
                                dist,
                                from,
                                ring,
                                &mut max_cost,
                                (ni as u32 * PHASES) * 4 + d as u32,
                                cost + 1,
                                state,
                            );
                        }
                        continue;
                    }
                    if p_end[ni] != 0 {
                        continue;
                    }
                    relax(
                        dist,
                        from,
                        ring,
                        &mut max_cost,
                        (ni as u32 * PHASES) * 4 + d as u32,
                        cost + 1,
                        state,
                    );
                }
                cost += 1;
            }

            if best >= 0 {
                let mut states: Vec<u32> = Vec::new();
                let mut state = best;
                while state >= 0 {
                    states.push(state as u32);
                    state = from[state as usize] as i64;
                }
                states.reverse();
                let cut: i64 = {
                    let mut seen = HashSet::new();
                    let mut cut: i64 = -1;
                    for (i, st) in states.iter().enumerate() {
                        let tile = st / (PHASES * 4);
                        if !seen.insert(tile) {
                            cut = i as i64;
                            break;
                        }
                    }
                    cut
                };
                if cut < 0 {
                    found = Some(states);
                } else if cut > 0 {
                    let cut = cut as usize;
                    let heading = states[cut] & 3;
                    forbidden.insert(states[cut - 1] * 4 + heading);
                }
            } else {
                dead_end = true;
            }
        });
        if dead_end {
            break;
        }
        if found.is_some() {
            chosen = found;
            break;
        }
    }

    let path = chosen.unwrap_or_default();
    let n = path.len();
    RESULT.with(|cell| {
        let mut out = cell.borrow_mut();
        out.clear();
        out.reserve(16 + n * 12 + frontier.len() * 4);
        out.extend_from_slice(&(n as u32).to_le_bytes());
        out.extend_from_slice(&(frontier.len() as u32).to_le_bytes());
        out.extend_from_slice(&states_visited.to_le_bytes());
        out.extend_from_slice(&attempts.to_le_bytes());
        for st in &path {
            let cell_index = st / (PHASES * 4);
            out.extend_from_slice(&cell_index.to_le_bytes());
            out.extend_from_slice(&((st % (PHASES * 4)) >> 2).to_le_bytes());
            out.extend_from_slice(&(st & 3).to_le_bytes());
        }
        for key in &frontier {
            out.extend_from_slice(&key.to_le_bytes());
        }
    });
    result_ptr()
}
