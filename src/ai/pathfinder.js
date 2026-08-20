/**
 * @file pathfinder.js
 * @description A* pathfinding di atas world model RichVoxelSpatialEngine (data blok nyata dari
 * chunk cache). Berbeda dari findOptimalClearanceStep/findWideEscapeRoute (greedy, mengevaluasi
 * satu langkah lalu maju, gampang buntu di rintangan besar) - ini mencari RUTE LENGKAP dulu
 * sebelum bergerak, sehingga bisa memutar mengelilingi dinding/jurang besar sekalipun.
 *
 * Area yang belum ter-cache (chunk belum dimuat, worldAccessor mengembalikan null) diperlakukan
 * sebagai bisa dilewati (lihat getBlockCollisionType: blockName falsy -> AIR_PASSABLE) - konsisten
 * dengan cara computeNavigationVector menangani area belum diketahui.
 */

const HORIZONTAL_DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1]
];

// Turun maksimal 8 blok (selaras dengan MAX_DESCENT_BUDGET di runWalkToBaseBot.js - kebijakan
// turun keseluruhan yang sudah ada), naik maksimal 1 blok per langkah (butuh lompat kalau lebih,
// di luar kemampuan gerak normal). Sebelumnya dibatasi -3 saja - ditemukan dari bug live nyata:
// bot berdiri di tepi tebing gua yang curam (>3 blok), satu-satunya pijakan valid ada di luar
// jangkauan -3 itu, jadi SELURUH kolom itu dianggap tidak punya tetangga valid sama sekali ->
// getNeighbors mengembalikan array kosong dari posisi itu, findPath gagal total, dan bot terjebak
// "terkurung total" padahal jalur turunnya sah. Turun >3 blok memang kena damage jatuh ringan di
// Minecraft asli (1 damage/blok di luar 3 blok pertama) - itu trade-off yang diterima di sini,
// jauh lebih baik daripada macet permanen. Urutan di sini TIDAK menentukan prioritas (lihat
// getNeighbors - semua offset yang passable dievaluasi, bukan cuma yang pertama ketemu) - biaya
// asli (moveCost, termasuk DROP_COST_PER_BLOCK) yang menentukan mana yang dipilih A*.
const VERTICAL_OFFSETS = [0, 1, -1, -2, -3, -4, -5, -6, -7, -8];

// Melompat naik 1 blok BUKAN cuma "jarak + sedikit lebih jauh" seperti turun/jalan datar - itu
// gerakan aktif yang butuh timing pas (lihat physicsController: trigger lompat baru terjadi
// reaktif saat nabrak dinding, gampang gagal berulang & bikin bot macet nabrak-nabrak di tempat
// yang sama). Makanya lompat naik dikasih penalti tetap yang jauh lebih besar daripada turun,
// supaya A* lebih suka jalur memutar yang lebih jauh tapi datar/turun kalau itu tersedia, dan
// cuma benar-benar lompat kalau memang satu-satunya jalan.
const JUMP_UP_PENALTY = 3.0;
const DROP_COST_PER_BLOCK = 0.3;

function nodeKey(n) {
  return `${n.x},${n.y},${n.z}`;
}

function heuristic(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function moveCost(dx, dy, dz) {
  const horizontal = Math.hypot(dx, dz);
  if (dy > 0) return horizontal + JUMP_UP_PENALTY;
  if (dy < 0) return horizontal + Math.abs(dy) * DROP_COST_PER_BLOCK;
  return horizontal;
}

function getNeighbors(engine, node) {
  const neighbors = [];

  for (const [dx, dz] of HORIZONTAL_DIRS) {
    for (const dy of VERTICAL_OFFSETS) {
      const nx = node.x + dx;
      const ny = node.y + dy;
      const nz = node.z + dz;

      const check = engine.evaluateNodePassability(nx, ny, nz);
      if (!check.passable) continue;

      // Cegah "memotong sudut" diagonal lewat pojok solid: salah satu dari dua sel ortogonal
      // di sampingnya (pada level Y yang sama) harus juga bisa dilewati.
      if (dx !== 0 && dz !== 0) {
        const sideA = engine.evaluateNodePassability(node.x + dx, ny, node.z);
        const sideB = engine.evaluateNodePassability(node.x, ny, node.z + dz);
        if (!sideA.passable && !sideB.passable) continue;
      }

      // Evaluasi SEMUA offset vertikal yang passable di kolom ini, bukan cuma yang pertama ketemu
      // - kolom yang sama bisa punya lebih dari satu pijakan valid (mis. ceruk di bawah tebing +
      // ledge di atasnya), dan A* baru bisa memilih yang termurah kalau semuanya diberi tahu.
      neighbors.push({ x: nx, y: ny, z: nz, dy });
    }
  }

  return neighbors;
}

function reconstructPath(cameFrom, current) {
  const path = [current];
  let key = nodeKey(current);
  while (cameFrom.has(key)) {
    current = cameFrom.get(key);
    path.push(current);
    key = nodeKey(current);
  }
  return path.reverse();
}

/**
 * Mencari jalur A* dari start ke goal (dibulatkan ke koordinat blok integer).
 * @param {import('./richVoxelSpatialEngine').RichVoxelSpatialEngine} engine
 * @param {{x:number,y:number,z:number}} start
 * @param {{x:number,y:number,z:number}} goal
 * @param {{ maxNodes?: number }} [options]
 * @returns {Array<{x:number,y:number,z:number}>|null} array waypoint dari start ke goal (termasuk
 * keduanya), atau null kalau tidak ditemukan jalur dalam anggaran node (maxNodes).
 */
function findPath(engine, start, goal, options = {}) {
  const maxNodes = options.maxNodes ?? 4000;

  const startNode = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const goalNode = { x: Math.floor(goal.x), y: Math.floor(goal.y), z: Math.floor(goal.z) };
  const startKey = nodeKey(startNode);
  const goalKey = nodeKey(goalNode);

  if (startKey === goalKey) {
    return [startNode];
  }

  const open = [startNode];
  const gScore = new Map([[startKey, 0]]);
  const fScore = new Map([[startKey, heuristic(startNode, goalNode)]]);
  const cameFrom = new Map();
  const visited = new Set();

  let expanded = 0;
  // Flood-fill "terbaik sejauh ini": kalau anggaran node habis sebelum benar-benar sampai goal,
  // jangan buang semua hasil eksplorasi (return null) - kembalikan jalur menuju node yang paling
  // dekat ke goal dari yang sempat disapu. Ini progres NYATA dan tersambung (bukan tebakan garis
  // lurus/ray-cast yang bisa menembus rintangan tak diketahui), cuma belum genap sampai tujuan.
  let bestNode = startNode;
  let bestH = heuristic(startNode, goalNode);

  while (open.length > 0) {
    let bestIdx = 0;
    let bestF = fScore.get(nodeKey(open[0])) ?? Infinity;
    for (let i = 1; i < open.length; i++) {
      const f = fScore.get(nodeKey(open[i])) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        bestIdx = i;
      }
    }
    const current = open.splice(bestIdx, 1)[0];
    const currentKey = nodeKey(current);

    if (visited.has(currentKey)) continue;
    visited.add(currentKey);

    if (currentKey === goalKey) {
      return reconstructPath(cameFrom, current);
    }

    const currentH = heuristic(current, goalNode);
    if (currentH < bestH) {
      bestH = currentH;
      bestNode = current;
    }

    expanded++;
    if (expanded > maxNodes) return reconstructPath(cameFrom, bestNode);

    for (const neighbor of getNeighbors(engine, current)) {
      const nKey = nodeKey(neighbor);
      if (visited.has(nKey)) continue;

      const cost = moveCost(neighbor.x - current.x, neighbor.y - current.y, neighbor.z - current.z);
      const tentativeG = (gScore.get(currentKey) ?? Infinity) + cost;

      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + heuristic(neighbor, goalNode));
        if (!open.some((n) => nodeKey(n) === nKey)) open.push(neighbor);
      }
    }
  }

  return null;
}

/**
 * Mencari Y yang bisa dipijak (evaluateNodePassability passable) di sekitar (x,z), dimulai dari
 * hintY dan melebar ke atas/bawah bergantian. Dibutuhkan karena target A* jarak jauh sering
 * ditebak pakai Y posisi bot SAAT INI, padahal permukaan sebenarnya di titik tujuan bisa jauh
 * lebih tinggi/rendah (bukit, jurang) - tanpa ini goal node yang dicari A* tidak akan pernah valid.
 * @returns {number|null} Y yang valid, atau null kalau tidak ketemu dalam maxSearch.
 */
function findGroundY(engine, x, z, hintY, maxSearch = 32) {
  if (engine.evaluateNodePassability(x, hintY, z).passable) return hintY;

  for (let dy = 1; dy <= maxSearch; dy++) {
    if (engine.evaluateNodePassability(x, hintY + dy, z).passable) return hintY + dy;
    if (engine.evaluateNodePassability(x, hintY - dy, z).passable) return hintY - dy;
  }

  return null;
}

module.exports = { findPath, findGroundY };
