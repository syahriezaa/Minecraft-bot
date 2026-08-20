/**
 * @file chunkConnectivityGraph.js
 * @description Lapisan graf konektivitas PERSISTEN, satu tingkat lebih kasar dari findPath
 * (pathfinder.js). Perbedaan mendasar dari findPath:
 *
 *  - findPath STATELESS: tiap dipanggil, menyapu ulang dunia dari nol (dibatasi maxNodes), lalu
 *    membuang seluruh hasil eksplorasi begitu selesai. Recompute berikutnya mulai dari nol lagi,
 *    walau area yang sama sudah pernah dijelajahi - inilah sumber banyak masalah nyata sepanjang
 *    proyek ini (rencana "1 waypoint" berulang, target escape bolak-balik, dst).
 *  - Modul ini PERSISTEN: tiap chunk yang sudah dimuat (chunk_loaded event dari client) di-"scan"
 *    SEKALI lewat ingestChunk - satu simpul per kolom (x,z) memakai ground Y yang ditemukan
 *    (findGroundY), bukan satu simpul per voxel (x,y,z) seperti findPath. Hasilnya disimpan
 *    selamanya (sampai proses berhenti) - findPath berikutnya di atas graf ini memakai ulang semua
 *    yang sudah diketahui, cuma perlu mengeksplorasi bagian yang benar-benar baru.
 *
 * Trade-off yang disengaja: satu simpul per kolom tidak bisa merepresentasikan dua level bertumpuk
 * di kolom yang sama (mis. ceruk di bawah tebing + ledge di atasnya) - itu tetap tugas findPath
 * (pathfinder.js) yang beresolusi voxel penuh. Graf ini untuk ROUTING JARAK JAUH yang cepat &
 * persisten; navigasi presisi lokal tetap lewat findPath/findWideEscapeRoute seperti biasa.
 */

const { getBlockCollisionType, BLOCK_COLLISION_TYPES } = require('./richVoxelSpatialEngine');

const HORIZONTAL_DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1]
];

const JUMP_UP_PENALTY = 3.0;
const DROP_COST_PER_BLOCK = 0.3;
const MAX_STEP_UP = 1;
// Selaras dengan MAX_DESCENT_BUDGET di runWalkToBaseBot.js dan VERTICAL_OFFSETS di pathfinder.js
// (keduanya sudah diperluas ke 8 blok) - sebelumnya cuma 3, jauh lebih ketat, sehingga graf
// konektivitas terputus-putus di banyak titik sepanjang korridor jarak jauh (ditemukan dari sapuan
// offline nyata: data node lengkap tanpa celah, tapi findPath tetap gagal total karena tetangga
// dengan selisih elevasi 4-8 blok ditolak begitu saja di sini).
const MAX_STEP_DOWN = 8;

function moveCost(dx, dy, dz) {
  const horizontal = Math.hypot(dx, dz);
  if (dy > 0) return horizontal + JUMP_UP_PENALTY;
  if (dy < 0) return horizontal + Math.abs(dy) * DROP_COST_PER_BLOCK;
  return horizontal;
}

function nodeKey(x, z) {
  return `${x},${z}`;
}

function chunkKey(chunkX, chunkZ) {
  return `${chunkX},${chunkZ}`;
}

function createConnectivityGraph(engine) {
  const nodes = new Map(); // "x,z" -> {x,y,z,block}
  const ingestedChunks = new Set();

  function ingestColumn(x, z, hintY) {
    const key = nodeKey(x, z);
    if (nodes.has(key)) return;
    const y = findGroundYLocal(x, z, hintY);
    if (y === null) return;
    // Simpan juga JENIS blok tanah di posisi ini (bukan cuma ketinggian) - selain berguna untuk
    // visualisasi/analisis (warna per jenis blok, bukan cuma elevasi), ini juga yang membongkar bug
    // nyata: ribuan blok di server ini resolve jadi "unknown_state_XXXX" (versi minecraft-data kita
    // tidak cocok dengan versi server) - tanpa menyimpan nama blok, gejala itu (simpul palsu rata di
    // Y=-64) sulit dibedakan dari data yang genuinely valid.
    const block = engine.world(x, y - 1, z);
    nodes.set(key, { x, y, z, block: block || 'unknown' });
  }

  // Sama seperti findGroundY di pathfinder.js (dihindari import silang supaya modul ini tidak
  // bergantung pada detail internal pathfinder.js) - dimulai dari hintY, melebar bergantian.
  //
  // Kalau pencarian di sekitar hintY "kosong" (tidak ketemu dalam maxSearch), TURUN TERUS satu blok
  // demi satu blok sampai benar-benar ketemu permukaannya, di level berapapun itu - jangan langsung
  // membuang kolom itu. Kasus nyata: chunk jauh yang baru dimuat lewat siklus refresh-reconnect
  // (lihat runWalkToBaseBot.js) memakai hintY dari posisi bot SEKARANG, bukan elevasi asli chunk
  // yang baru itu (bisa gua dalam vs gunung, selisihnya jauh lebih dari maxSearch) - tanpa fallback
  // ini, kolom-kolom valid di chunk baru itu dibuang begitu saja dan graf jadi berlubang. Turun
  // sampai batas dasar dunia Minecraft modern (Y=-64) supaya benar-benar menyerah HANYA kalau memang
  // tidak ada permukaan sama sekali (lubang/jurang tak berdasar sungguhan), bukan cuma karena hintY
  // meleset jauh.
  const WORLD_MIN_Y = -64;

  // Kanopi pohon (daun) dan blok menggantung sejenis TIDAK BOLEH dianggap "tanah" oleh graf kasar
  // ini - ditemukan dari kekhawatiran nyata: "satu Y per kolom" salah baca kanopi sebagai permukaan,
  // padahal tanah asli jauh di bawahnya. `getBlockCollisionType` menganggap daun SOLID_FULL (benar
  // untuk collision voxel presisi di richVoxelSpatialEngine, dipakai gerakan real-time), tapi salah
  // untuk tujuan "cari permukaan tanah sungguhan" di sini - jadi dicek terpisah, khusus modul ini.
  function isCanopyBlock(name) {
    return typeof name === 'string' && /leaves|vine/i.test(name);
  }

  function isGenuineGroundAt(x, y, z) {
    if (!engine.evaluateNodePassability(x, y, z).passable) return false;
    return !isCanopyBlock(engine.world(x, y - 1, z));
  }

  function findGroundYLocal(x, z, hintY, maxSearch = 32) {
    if (isGenuineGroundAt(x, hintY, z)) return hintY;
    for (let dy = 1; dy <= maxSearch; dy++) {
      if (isGenuineGroundAt(x, hintY + dy, z)) return hintY + dy;
      if (isGenuineGroundAt(x, hintY - dy, z)) return hintY - dy;
    }
    // Fallback DALAM (sampai dasar dunia) HARUS mensyaratkan dasar yang benar-benar PADAT - bukan
    // cuma "passable" biasa. evaluateNodePassability menerima "mengambang di air" sebagai passable
    // (wajar untuk berenang normal), tapi itu SALAH untuk pencarian tanah putus asa ini - ditemukan
    // dari bug live nyata: server ini pakai versi blok yang tidak dikenali minecraft-data kita,
    // ribuan blok di kedalaman resolve jadi "unknown_state_XXXX" (diklasifikasi SOLID_FULL, jadi
    // pencarian normal gagal total di sana), lalu fallback ini turun sampai ke dasar dunia dan
    // menemukan KOLAM AIR tanpa dasar padat sama sekali (cuma void di bawahnya) - "mengambang"
    // diterima sebagai tanah, menghasilkan ratusan ribu simpul palsu rata di Y=-64.
    for (let y = hintY - maxSearch - 1; y >= WORLD_MIN_Y; y--) {
      const check = engine.evaluateNodePassability(x, y, z);
      if (!check.passable) continue;
      const groundBlock = engine.world(x, y - 1, z);
      if (isCanopyBlock(groundBlock)) continue;
      if (getBlockCollisionType(groundBlock) === BLOCK_COLLISION_TYPES.SOLID_FULL) return y;
    }
    return null;
  }

  // Naik HANYA saat chunk baru sungguhan menambah data - caller (mis. loop navigasi) memakai ini
  // untuk tahu kapan benar-benar perlu tebak ulang rute, bukan lewat timer buta yang re-planning
  // walau tidak ada informasi baru sama sekali (buang waktu menjelajah ulang data yang sudah
  // diketahui persis, alih-alih benar-benar berjalan maju).
  let version = 0;

  function ingestChunk(chunkX, chunkZ, hintY) {
    const key = chunkKey(chunkX, chunkZ);
    if (ingestedChunks.has(key)) return;
    ingestedChunks.add(key);
    version++;
    const baseX = chunkX * 16;
    const baseZ = chunkZ * 16;
    for (let dx = 0; dx < 16; dx++) {
      for (let dz = 0; dz < 16; dz++) {
        ingestColumn(baseX + dx, baseZ + dz, hintY);
      }
    }
  }

  // Isi graf langsung dari data yang sudah dikumpulkan SEBELUMNYA (mis. hasil sapuan offline lewat
  // RCON - lihat sweepChunksViaRcon.js), tanpa perlu ingest ulang lewat engine/dunia nyata. TIDAK
  // boleh menimpa simpul yang sudah ada dari ingest langsung (dunia nyata lebih dipercaya daripada
  // data seed lama, yang bisa saja sudah usang kalau terrain berubah sejak sapuan terakhir).
  function seedNodes(seedList) {
    let addedAny = false;
    for (const n of seedList) {
      const key = nodeKey(n.x, n.z);
      if (nodes.has(key)) continue;
      nodes.set(key, { x: n.x, y: n.y, z: n.z });
      addedAny = true;
    }
    if (addedAny) version++;
  }

  function getVersion() {
    return version;
  }

  function getNode(x, z) {
    return nodes.get(nodeKey(x, z)) ?? null;
  }

  function nodeCount() {
    return nodes.size;
  }

  // Snapshot penuh seluruh simpul yang sudah di-ingest - dipakai visualizer "chunk matrix" untuk
  // menampilkan seluruh area yang sudah "dibaca" bot (bukan cuma query satu kolom lewat getNode).
  function getAllNodes() {
    return Array.from(nodes.values());
  }

  // Tetangga HANYA di antara simpul yang SUDAH di-ingest - findPath di graf ini tidak pernah
  // "menebak" lewat kolom yang belum pernah discan (beda dari evaluateNodePassability mentah yang
  // menganggap data tak dikenal sebagai bisa dilewati).
  function getGraphNeighbors(node) {
    const neighbors = [];
    for (const [dx, dz] of HORIZONTAL_DIRS) {
      const n = getNode(node.x + dx, node.z + dz);
      if (!n) continue;
      const dy = n.y - node.y;
      if (dy > MAX_STEP_UP || dy < -MAX_STEP_DOWN) continue;
      if (dx !== 0 && dz !== 0) {
        const sideA = getNode(node.x + dx, node.z);
        const sideB = getNode(node.x, node.z + dz);
        if (!sideA && !sideB) continue;
      }
      neighbors.push(n);
    }
    return neighbors;
  }

  function heuristic(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }

  function reconstructPath(cameFrom, current) {
    const path = [current];
    let key = nodeKey(current.x, current.z);
    while (cameFrom.has(key)) {
      current = cameFrom.get(key);
      path.push(current);
      key = nodeKey(current.x, current.z);
    }
    return path.reverse();
  }

  function findPath(start, goal, options = {}) {
    const maxNodes = options.maxNodes ?? 20000;

    const startNode = getNode(Math.floor(start.x), Math.floor(start.z));
    const goalNode = getNode(Math.floor(goal.x), Math.floor(goal.z));
    if (!startNode || !goalNode) return null;

    const startKey = nodeKey(startNode.x, startNode.z);
    const goalKey = nodeKey(goalNode.x, goalNode.z);
    if (startKey === goalKey) return [startNode];

    const open = [startNode];
    const gScore = new Map([[startKey, 0]]);
    const fScore = new Map([[startKey, heuristic(startNode, goalNode)]]);
    const cameFrom = new Map();
    const visited = new Set();
    let expanded = 0;
    let bestNode = startNode;
    let bestH = heuristic(startNode, goalNode);

    while (open.length > 0) {
      let bestIdx = 0;
      let bestF = fScore.get(nodeKey(open[0].x, open[0].z)) ?? Infinity;
      for (let i = 1; i < open.length; i++) {
        const f = fScore.get(nodeKey(open[i].x, open[i].z)) ?? Infinity;
        if (f < bestF) { bestF = f; bestIdx = i; }
      }
      const current = open.splice(bestIdx, 1)[0];
      const currentKey = nodeKey(current.x, current.z);
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);

      if (currentKey === goalKey) return reconstructPath(cameFrom, current);

      const currentH = heuristic(current, goalNode);
      if (currentH < bestH) { bestH = currentH; bestNode = current; }

      expanded++;
      if (expanded > maxNodes) return reconstructPath(cameFrom, bestNode);

      for (const neighbor of getGraphNeighbors(current)) {
        const nKey = nodeKey(neighbor.x, neighbor.z);
        if (visited.has(nKey)) continue;
        const cost = moveCost(neighbor.x - current.x, neighbor.y - current.y, neighbor.z - current.z);
        const tentativeG = (gScore.get(currentKey) ?? Infinity) + cost;
        if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
          cameFrom.set(nKey, current);
          gScore.set(nKey, tentativeG);
          fScore.set(nKey, tentativeG + heuristic(neighbor, goalNode));
          if (!open.some((n) => n.x === neighbor.x && n.z === neighbor.z)) open.push(neighbor);
        }
      }
    }

    return null;
  }

  // Keputusan "dorong ke area belum dikenal": kalau goal ASLI tidak bisa dijangkau lewat findPath
  // di atas (di luar peta yang sudah diketahui - server ini terbukti cuma streaming area terbatas
  // di sekitar posisi bot, chunk baru cuma muncul kalau benar-benar bergerak jauh ke arah itu),
  // reaktif murni (STALL/escape/wall-follow) cuma mengoptimalkan RUTE DI DALAM bubble yang sudah
  // dikenal - tidak pernah sengaja mendorong ke TEPI bubble supaya chunk baru terbuka.

  function findFrontierTowardGoal(fromPos, goal) {
    // Kalau start & goal SAMA-SAMA sudah punya simpul di graf, goal ada di dalam peta yang dikenal
    // (baik terhubung atau tidak - kalau terputus, itu urusan findPath biasa mengembalikan jalur
    // parsial, bukan urusan frontier-seeking) - tidak perlu mencari frontier.
    const startNode = getNode(Math.floor(fromPos.x), Math.floor(fromPos.z));
    const goalNode = getNode(Math.floor(goal.x), Math.floor(goal.z));
    if (startNode && goalNode) return null; // goal sudah dalam peta yang dikenal - findPath biasa cukup
    if (!startNode) return null; // posisi sendiri saja belum dikenal - tidak ada basis untuk mencari frontier
    if (nodes.size === 0) return null;

    // Bug nyata (dilihat langsung dari trail bot di visualizer): memilih "simpul tepi individual
    // paling searah goal" gampang terjebak pada tonjolan/celah LOKAL (mis. satu kolom yang kebetulan
    // punya tetangga X kosong) padahal batas SEBENARNYA dari seluruh area dikenal ada di sumbu lain
    // (Z, kalau goal jauh lebih condong ke arah Z) - hasilnya bot bolak-balik di satu baris tanpa
    // pernah mendekati batas Z yang sesungguhnya. Pendekatan lebih kokoh: hitung kotak pembatas
    // (bounding box) SELURUH area dikenal, lalu cari di titik mana garis lurus dari posisi sekarang
    // ke goal benar-benar KELUAR dari kotak itu - itu batas peta yang sesungguhnya searah goal,
    // bukan sekadar celah lokal terdekat.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const node of nodes.values()) {
      if (node.x < minX) minX = node.x;
      if (node.x > maxX) maxX = node.x;
      if (node.z < minZ) minZ = node.z;
      if (node.z > maxZ) maxZ = node.z;
    }

    const dirDx = goal.x - fromPos.x;
    const dirDz = goal.z - fromPos.z;

    // Parameter t sepanjang sinar fromPos -> arah goal untuk masing-masing sisi kotak, cuma sisi
    // yang searah pergerakan (t positif) yang relevan sebagai batas keluar.
    let tExit = Infinity;
    if (dirDx > 0) tExit = Math.min(tExit, (maxX - fromPos.x) / dirDx);
    else if (dirDx < 0) tExit = Math.min(tExit, (minX - fromPos.x) / dirDx);
    if (dirDz > 0) tExit = Math.min(tExit, (maxZ - fromPos.z) / dirDz);
    else if (dirDz < 0) tExit = Math.min(tExit, (minZ - fromPos.z) / dirDz);

    if (!Number.isFinite(tExit) || tExit <= 0) return null; // goal persis di dalam/sejajar kotak - findPath biasa cukup

    const exitX = fromPos.x + dirDx * tExit;
    const exitZ = fromPos.z + dirDz * tExit;

    // Dorong beberapa blok LEBIH JAUH dari titik keluar kotak, searah goal, supaya benar-benar
    // melangkah ke chunk yang belum dimuat (chunk baru cuma dikirim server begitu koordinat chunk
    // pemain BERUBAH, bukan cuma karena dekat dengan batasnya). evaluateNodePassability memperlakukan
    // blok tak dikenal sebagai bisa dilewati secara default, jadi target di luar kotak ini aman dicoba.
    const PUSH_PAST_EDGE = 3;
    const dirDist = Math.hypot(dirDx, dirDz) || 1;
    const pushedX = exitX + (dirDx / dirDist) * PUSH_PAST_EDGE;
    const pushedZ = exitZ + (dirDz / dirDist) * PUSH_PAST_EDGE;

    // Y target: pakai ketinggian simpul dikenal TERDEKAT dengan titik keluar sebagai tebakan wajar
    // (tanah nyata di wilayah belum dikenal akan divalidasi ulang begitu benar-benar didekati).
    let nearestY = fromPos.y;
    let nearestD = Infinity;
    for (const node of nodes.values()) {
      const d = Math.hypot(node.x - exitX, node.z - exitZ);
      if (d < nearestD) { nearestD = d; nearestY = node.y; }
    }

    return { x: Math.round(pushedX), y: nearestY, z: Math.round(pushedZ) };
  }

  return { ingestColumn, ingestChunk, seedNodes, getNode, nodeCount, getAllNodes, getVersion, findPath, findFrontierTowardGoal };
}

module.exports = { createConnectivityGraph };
