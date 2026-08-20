/**
 * @file gridSweepViaRcon.js
 * @description Sapuan GRID (bukan cuma satu garis/pita korridor seperti sweepChunksViaRcon.js) -
 * terbang lewat RCON ke tiap titik grid yang menutupi area persegi sekitar pusat tertentu, memutus
 * & menyambung ulang koneksi di tiap titik untuk memaksa burst chunk baru (satu-satunya cara yang
 * terbukti bekerja - lihat catatan di runWalkToBaseBot.js), dan ingest semuanya ke SATU peta simpul
 * bersama yang terus bertambah. Dipakai untuk memetakan area luas (mis. 1000x1000 blok) secara
 * sistematis, dengan progres yang bisa di-stream live ke pemanggil (mis. dashboard web).
 *
 * Mendukung BANYAK bot paralel (workerCount) - tiap worker koneksi Minecraft TERPISAH (username
 * pendek berbeda, lihat buildWorkerBotName) dengan connectivityGraph MILIKNYA SENDIRI (terikat ke
 * client & getBlockName-nya sendiri - PENTING: satu graf bersama dengan satu engine dummy TIDAK
 * BISA menemukan permukaan sungguhan dari worker manapun, itu bug nyata yang pernah terjadi - tiap
 * worker butuh engine yang benar-benar terikat ke koneksinya sendiri). Simpul baru yang ditemukan
 * tiap worker digabung ke `sharedNodes` (Map bersama) tiap kali satu titik selesai disapu.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { LiveProtocolClient } = require('../network/liveProtocolClient');
const { RichVoxelSpatialEngine } = require('./richVoxelSpatialEngine');
const { createConnectivityGraph } = require('./chunkConnectivityGraph');
const { rconExec } = require('./sweepChunksViaRcon');

// Jauh lebih pendek kalau dijalankan LOKAL di mesin server Minecraft sendiri (lihat
// runLocalGridSweep.js) - koneksi localhost praktis instan, delay yang dulu perlu untuk menahan
// hiccup jaringan jarak jauh (tunnel playit.gg) cuma buang-buang waktu di sini.
const IS_LOCAL = process.env.MC_RCON_LOCAL === 'true';
const CHUNK_SETTLE_MS = IS_LOCAL ? 500 : 2000;
const TELEPORT_SETTLE_MS = IS_LOCAL ? 100 : 400;
const DISCONNECT_SETTLE_MS = IS_LOCAL ? 200 : 700;

function buildGridPoints(center, sizeBlocks, spacing) {
  const half = sizeBlocks / 2;
  const points = [];
  for (let x = -half; x <= half; x += spacing) {
    for (let z = -half; z <= half; z += spacing) {
      points.push({ x: center.x + x, z: center.z + z });
    }
  }
  // Urutkan seperti "ular" (snake) baris demi baris - tiap teleport berikutnya jadi tetangga
  // terdekat dari titik sebelumnya (bukan lompat jauh bolak-balik antar baris), sedikit lebih hemat
  // walau spectator tidak kena biaya jarak - lebih penting untuk progres yang enak diikuti live.
  const byX = new Map();
  for (const p of points) {
    const key = p.x;
    if (!byX.has(key)) byX.set(key, []);
    byX.get(key).push(p);
  }
  const ordered = [];
  let flip = false;
  for (const [, col] of [...byX.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = col.sort((a, b) => (flip ? b.z - a.z : a.z - b.z));
    ordered.push(...sorted);
    flip = !flip;
  }
  return ordered;
}

// Nama akun Minecraft dibatasi 16 karakter - "AutoCompanionBot" (bot navigasi utama) SUDAH pas 16
// karakter, jadi worker sapuan TIDAK BOLEH menambah sufiks di belakang nama itu (server memotong
// diam-diam jadi 16 karakter pertama, membuat semua worker bentrok login sebagai akun yang SAMA -
// bug nyata yang ditemukan lewat UUID identik di log server). Pakai prefiks pendek terpisah.
function buildWorkerBotName(i) {
  const name = `Sweep_S${i + 1}`;
  if (name.length > 16) throw new Error(`Nama worker "${name}" melebihi batas 16 karakter Minecraft`);
  return name;
}

// Bagi titik-titik grid ke N worker secara SELANG-SELING (round-robin), bukan blok berurutan -
// supaya tiap worker langsung menyentuh berbagai bagian area sejak awal (progres visual lebih
// merata di seluruh peta, bukan satu worker "kebagian" pojok sampai akhir).
function partitionPoints(points, workerCount) {
  const buckets = Array.from({ length: workerCount }, () => []);
  points.forEach((p, i) => buckets[i % workerCount].push(p));
  return buckets;
}

async function sweepOneWorker({ workerBotName, host, port, protocolVersion, points, hintY, sharedNodes, onLog, onPointDone, shouldStop }) {
  const client = new LiveProtocolClient({
    host, port, username: workerBotName, protocolVersion,
    autoReconnect: false, movementHeartbeatEnabled: false
  });
  // Graf MILIK worker ini sendiri, terikat ke engine yang MEMBACA lewat client worker ini sendiri -
  // tidak dibagi dengan worker lain (itu bug lama: satu graf bersama dengan engine dummy membuat
  // SEMUA worker gagal menemukan permukaan sungguhan, karena engine dummy selalu mengembalikan
  // null tak peduli siapa yang query).
  const engine = new RichVoxelSpatialEngine((x, y, z) => client.getBlockName(x, y, z));
  const ownGraph = createConnectivityGraph(engine);

  // WAJIB: Node menganggap event 'error' tanpa listener sebagai exception fatal yang mematikan
  // SELURUH proses (bug nyata: crash "ETIMEDOUT" mematikan seluruh sapuan 12-worker gara-gara satu
  // worker kena hiccup jaringan sesaat, tanpa listener ini) - dengan puluhan/ratusan siklus
  // reconnect per worker, error jaringan sesaat itu wajar terjadi dan HARUS non-fatal.
  client.on('error', (err) => onLog(`ERROR jaringan pada ${workerBotName} (non-fatal, lanjut ke titik berikutnya): ${err.message}`));

  client.on('chunk_loaded', ({ chunkX, chunkZ }) => {
    const y = client.position ? Math.floor(client.position.y) : hintY;
    ownGraph.ingestChunk(chunkX, chunkZ, y);
  });

  await client.connect();
  await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));

  for (let i = 0; i < points.length; i++) {
    if (shouldStop()) break;
    const p = points[i];
    rconExec(`tp ${workerBotName} ${p.x.toFixed(1)} ${hintY} ${p.z.toFixed(1)}`);
    await new Promise((r) => setTimeout(r, TELEPORT_SETTLE_MS));
    client.disconnect('sapuan grid - reconnect untuk chunk baru');
    await new Promise((r) => setTimeout(r, DISCONNECT_SETTLE_MS));
    await client.connect();
    await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));
    // Gabung simpul BARU dari graf worker ini ke peta bersama - aman dipanggil dari banyak worker
    // async berbeda karena JS single-thread (tidak ada race condition nyata pada Map biasa).
    for (const n of ownGraph.getAllNodes()) sharedNodes.set(`${n.x},${n.z}`, n);
    onPointDone();
  }

  client.disconnect('sapuan grid worker selesai');
}

async function sweepGridViaRcon({ botName, host, port, protocolVersion, center, sizeBlocks, spacing, hintY = 70, onLog = () => {}, onProgress = () => {}, shouldStop = () => false, workerCount = 1, existingNodes = [] }) {
  const sharedNodes = new Map();
  for (const n of existingNodes) sharedNodes.set(`${n.x},${n.z}`, n);

  let points = buildGridPoints(center, sizeBlocks, spacing);
  if (existingNodes.length > 0) {
    // Jangan sapu ulang titik yang kolomnya SUDAH dikenal dari data sebelumnya - dipakai saat
    // memperluas area sapuan (mis. 1000x1000 -> 2000x2000) supaya cuma cincin baru di luar area
    // lama yang benar-benar diterbangi ulang, bukan mengulang semuanya dari nol.
    const before = points.length;
    points = points.filter((p) => !sharedNodes.has(`${Math.round(p.x)},${Math.round(p.z)}`));
    onLog(`${before - points.length} titik dilewati (kolomnya sudah dikenal dari sapuan sebelumnya) - tersisa ${points.length} titik baru.`);
  }
  onLog(`Sapuan grid: ${points.length} titik menutupi area ${sizeBlocks}x${sizeBlocks} blok di sekitar (${center.x},${center.z}), spasi ${spacing} blok, ${workerCount} bot paralel.`);

  // PENTING: JANGAN materialize Array.from(sharedNodes.values()) di sini - dipanggil SETIAP titik
  // selesai (ratusan/ribuan kali untuk area luas), dan untuk dataset jutaan simpul itu berarti
  // menyalin seluruh dataset berulang-ulang tiap beberapa detik, jadi sampah GC yang sangat besar -
  // ini PERSIS penyebab crash "JavaScript heap out of memory" yang pernah terjadi nyata. nodeCount
  // (Map.size, O(1)) cukup untuk progres; array penuh cuma dibuat SEKALI di akhir (lihat return).
  let doneCount = 0;
  const onPointDone = () => {
    doneCount++;
    onLog(`[${doneCount}/${points.length}] graf sekarang ${sharedNodes.size} simpul.`);
    onProgress({ done: doneCount, total: points.length, nodeCount: sharedNodes.size, sharedNodes });
  };

  if (workerCount <= 1) {
    await sweepOneWorker({ workerBotName: botName, host, port, protocolVersion, points, hintY, sharedNodes, onLog, onPointDone, shouldStop });
  } else {
    const buckets = partitionPoints(points, workerCount);
    onLog(`Membagi ${points.length} titik ke ${workerCount} bot: ~${Math.ceil(points.length / workerCount)} titik per bot.`);
    await Promise.all(buckets.map((bucketPoints, i) =>
      sweepOneWorker({
        workerBotName: buildWorkerBotName(i),
        host, port, protocolVersion,
        points: bucketPoints, hintY, sharedNodes, onLog, onPointDone, shouldStop
      }).catch((e) => onLog(`Worker ${i + 1} gagal: ${e.message}`))
    ));
  }

  onLog(`Sapuan grid selesai. Total simpul graf: ${sharedNodes.size}.`);

  return { nodes: Array.from(sharedNodes.values()) };
}

module.exports = { sweepGridViaRcon, buildGridPoints, partitionPoints, buildWorkerBotName, sweepOneWorker };
