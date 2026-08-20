/**
 * @file patchSweepHoles.js
 * @description Tambal "lubang" pada data sapuan grid yang sudah ada (lihat sweepHoleDetector.js
 * untuk deteksi & pengelompokan lubang) - terbang lewat RCON ke tengah tiap klaster lubang, bukan
 * menyapu ulang seluruh area. Mendukung beberapa bot paralel (workerCount) sama seperti
 * gridSweepViaRcon.js - dipakai otomatis setiap kali sapuan grid selesai (lihat webServer.js).
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { LiveProtocolClient } = require('../network/liveProtocolClient');
const { RichVoxelSpatialEngine } = require('./richVoxelSpatialEngine');
const { createConnectivityGraph } = require('./chunkConnectivityGraph');
const { rconExec } = require('./sweepChunksViaRcon');
const { findMissingColumns, clusterHoles } = require('./sweepHoleDetector');
const { partitionPoints } = require('./gridSweepViaRcon');

// Sama seperti gridSweepViaRcon.js - jauh lebih pendek untuk sapuan lokal.
const IS_LOCAL = process.env.MC_RCON_LOCAL === 'true';
const CHUNK_SETTLE_MS = IS_LOCAL ? 500 : 2000;
const TELEPORT_SETTLE_MS = IS_LOCAL ? 100 : 400;
const DISCONNECT_SETTLE_MS = IS_LOCAL ? 200 : 700;

// Satu burst chunk (teleport+reconnect) menutupi kira-kira 9 chunk (~2300 kolom) di sekitar titik
// teleport - lubang yang lebih kecil dari itu cukup DITAMBAL DENGAN SATU titik (titik tengahnya).
// Lubang yang LEBIH BESAR (ditemukan dari kasus live nyata: satu klaster 488,727 kolom, ratusan
// blok lebar) butuh BEBERAPA titik tersebar, bukan satu titik tengah saja - satu burst cuma
// menyentuh sebagian kecil area seluas itu.
const SINGLE_PATCH_SIZE_THRESHOLD = 2000;
const MAX_SAMPLE_POINTS_PER_CLUSTER = 40; // batas jaga-jaga supaya satu lubang raksasa tidak memakan seluruh anggaran maxPatches sendirian

// Ambil titik-titik SUNGGUHAN dari kolom yang hilang (bukan menggrid seluruh kotak pembatas -
// union-find bisa menyambungkan banyak celah kecil yang tersebar jauh jadi satu "klaster" dengan
// bbox raksasa padahal isinya jarang, lihat catatan di sweepHoleDetector.js), pilih greedy: ambil
// titik pertama, buang semua titik lain dalam radius `spacing` darinya, ulangi - hasilnya sebaran
// titik yang benar-benar mewakili DI MANA kolom kosongnya ada, dibatasi jumlah maksimal.
function sampleSpreadPoints(points, spacing, maxPoints) {
  const picked = [];
  const remaining = points;
  for (let i = 0; i < remaining.length && picked.length < maxPoints; i++) {
    const p = remaining[i];
    const tooClose = picked.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < spacing);
    if (!tooClose) picked.push(p);
  }
  return picked;
}

// Ubah satu klaster jadi satu atau beberapa target teleport, tergantung ukurannya - lihat catatan
// SINGLE_PATCH_SIZE_THRESHOLD di atas.
function expandClusterToTargets(cluster, spacing) {
  if (cluster.size <= SINGLE_PATCH_SIZE_THRESHOLD) {
    return [{ x: cluster.x, z: cluster.z, size: cluster.size }];
  }
  const sampled = sampleSpreadPoints(cluster.points, spacing, MAX_SAMPLE_POINTS_PER_CLUSTER);
  return sampled.map((p) => ({ x: p.x, z: p.z, size: cluster.size }));
}

// Sama alasannya dengan buildWorkerBotName di gridSweepViaRcon.js - nama HARUS pendek (batas 16
// karakter Minecraft), dan prefiks BEDA dari worker sapuan ("Sweep_S...") supaya bisa jalan
// bersamaan tanpa risiko tabrakan nama kalau suatu saat keduanya aktif berdekatan.
function buildPatchWorkerName(i) {
  const name = `Patch_S${i + 1}`;
  if (name.length > 16) throw new Error(`Nama worker "${name}" melebihi batas 16 karakter Minecraft`);
  return name;
}

async function patchOneWorker({ workerBotName, host, port, protocolVersion, targets, hintY, sharedNodes, onLog, onPatchDone, shouldStop }) {
  const client = new LiveProtocolClient({
    host, port, username: workerBotName, protocolVersion,
    autoReconnect: false, movementHeartbeatEnabled: false
  });
  // Graf MILIK worker ini sendiri, terikat ke engine yang membaca lewat client worker ini sendiri -
  // BUKAN satu graf bersama dengan engine dummy (bug nyata sebelumnya: engine dummy selalu
  // mengembalikan null, jadi TIDAK ADA worker yang bisa menemukan permukaan sungguhan sama sekali).
  const engine = new RichVoxelSpatialEngine((x, y, z) => client.getBlockName(x, y, z));
  const ownGraph = createConnectivityGraph(engine);

  // WAJIB: event 'error' tanpa listener mematikan SELURUH proses Node (lihat catatan sama di
  // gridSweepViaRcon.js) - dengan banyak siklus reconnect per worker, hiccup jaringan sesaat wajar
  // terjadi dan harus non-fatal.
  client.on('error', (err) => onLog(`ERROR jaringan pada ${workerBotName} (non-fatal, lanjut ke titik berikutnya): ${err.message}`));

  client.on('chunk_loaded', ({ chunkX, chunkZ }) => {
    const y = client.position ? Math.floor(client.position.y) : hintY;
    ownGraph.ingestChunk(chunkX, chunkZ, y);
  });

  await client.connect();
  await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));

  for (let i = 0; i < targets.length; i++) {
    if (shouldStop()) break;
    const t = targets[i];
    rconExec(`tp ${workerBotName} ${t.x.toFixed(1)} ${hintY} ${t.z.toFixed(1)}`);
    await new Promise((r) => setTimeout(r, TELEPORT_SETTLE_MS));
    client.disconnect('tambal lubang - reconnect untuk chunk baru');
    await new Promise((r) => setTimeout(r, DISCONNECT_SETTLE_MS));
    await client.connect();
    await new Promise((r) => setTimeout(r, CHUNK_SETTLE_MS));
    for (const n of ownGraph.getAllNodes()) sharedNodes.set(`${n.x},${n.z}`, n);
    onPatchDone(t);
  }

  client.disconnect('tambal lubang worker selesai');
}

async function patchSweepHoles({ host, port, protocolVersion, existingNodes, bounds, hintY = 70, clusterRadius = 24, maxPatches = 200, workerCount = 1, onLog = () => {}, onProgress = () => {}, shouldStop = () => false }) {
  const missing = findMissingColumns(existingNodes, bounds);
  const clusters = clusterHoles(missing, clusterRadius).sort((a, b) => b.size - a.size); // tambal lubang terbesar dulu
  onLog(`Ditemukan ${missing.length} kolom kosong, dikelompokkan jadi ${clusters.length} klaster lubang.`);

  // Lubang besar diubah jadi BEBERAPA titik tersebar (bukan cuma satu titik tengah) - lihat
  // expandClusterToTargets di atas. spacing 48 selaras dengan lebar cakupan satu burst chunk.
  const allTargets = clusters.flatMap((c) => expandClusterToTargets(c, 48));
  const targets = allTargets.slice(0, maxPatches);
  if (allTargets.length > maxPatches) onLog(`Membatasi ke ${maxPatches} titik tambalan dulu (dari ${allTargets.length} total titik, ${clusters.length} klaster) - jalankan lagi untuk sisanya.`);

  const sharedNodes = new Map();
  for (const n of existingNodes) sharedNodes.set(`${n.x},${n.z}`, n);

  if (targets.length === 0) {
    onLog('Tidak ada lubang berarti untuk ditambal.');
    return { nodes: Array.from(sharedNodes.values()), patchedClusters: 0, remainingClusters: 0 };
  }

  // Sama seperti gridSweepViaRcon.js - JANGAN materialize array penuh tiap titik (bug nyata: crash
  // "heap out of memory" untuk dataset jutaan simpul). Cuma kirim referensi Map live + nodeCount.
  let doneCount = 0;
  const onPatchDone = (t) => {
    doneCount++;
    onLog(`[${doneCount}/${targets.length}] Tambal lubang di (${t.x},${t.z}) (${t.size} kolom kosong) - graf sekarang ${sharedNodes.size} simpul.`);
    onProgress({ done: doneCount, total: targets.length, nodeCount: sharedNodes.size, sharedNodes });
  };

  const effectiveWorkers = Math.min(workerCount, targets.length);
  onLog(`Menambal ${targets.length} klaster lubang dengan ${effectiveWorkers} bot.`);
  const buckets = partitionPoints(targets, effectiveWorkers);
  await Promise.all(buckets.map((bucketTargets, i) =>
    patchOneWorker({
      workerBotName: buildPatchWorkerName(i),
      host, port, protocolVersion,
      targets: bucketTargets, hintY, sharedNodes, onLog, onPatchDone, shouldStop
    }).catch((e) => onLog(`Worker tambal ${i + 1} gagal: ${e.message}`))
  ));

  onLog(`Penambalan selesai. Total simpul graf: ${sharedNodes.size}.`);

  return { nodes: Array.from(sharedNodes.values()), patchedClusters: targets.length, remainingClusters: Math.max(0, clusters.length - targets.length) };
}

module.exports = { patchSweepHoles, buildPatchWorkerName, sampleSpreadPoints, expandClusterToTargets, patchOneWorker };
