/**
 * @file runLocalGridSweep.js
 * @description Runner CLI khusus dijalankan LANGSUNG di mesin yang sama dengan server Minecraft
 * (lihat catatan MC_RCON_LOCAL di sweepChunksViaRcon.js) - koneksi ke 127.0.0.1 (bukan lewat tunnel
 * playit.gg dari mesin terpisah), jauh lebih cepat & tidak rentan hiccup jaringan jarak jauh.
 *
 * Sapuan (temukan area BARU) dan tambal lubang (perbaiki area yang SUDAH dikenal tapi bolong)
 * dijalankan BERSAMAAN (bukan berurutan) - membagi total worker jadi dua kelompok yang jalan
 * paralel penuh, memanfaatkan semua core sekaligus alih-alih menunggu satu fase selesai baru mulai
 * fase berikutnya. Target tambal lubang dihitung SEKALI di awal dari data yang sudah ada saat ini -
 * tidak menunggu sapuan selesai dulu, supaya kedua kelompok bisa mulai serentak.
 *
 * Progres ditulis berkala ke file JSON (LOCAL_SWEEP_STATUS_PATH) supaya mesin lain (mis. Mac untuk
 * monitoring) bisa menariknya lewat SCP tanpa perlu koneksi langsung ke proses Node ini.
 *
 * Cara pakai (di PC server):
 *   set MC_RCON_LOCAL=true
 *   node src/ai/runLocalGridSweep.js
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

process.env.MC_RCON_LOCAL = 'true';

const fs = require('fs');
const path = require('path');
const { buildGridPoints, partitionPoints, buildWorkerBotName, sweepOneWorker } = require('./gridSweepViaRcon');
const { buildPatchWorkerName, expandClusterToTargets, patchOneWorker } = require('./patchSweepHoles');
const { findMissingColumns, clusterHoles } = require('./sweepHoleDetector');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const GRAPH_PATH = path.join(DATA_DIR, 'sweptGridGraph.json');
const STATUS_PATH = path.join(DATA_DIR, 'localSweepStatus.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

const CENTER = { x: -34.5, z: -7.5 };
const SIZE_BLOCKS = Number(process.env.SWEEP_SIZE) || 2000;
const SPACING = Number(process.env.SWEEP_SPACING) || 48;
// Beban kerja di sini I/O-bound (koneksi jaringan + proses RCON terpisah per titik), bukan
// CPU-bound murni - jadi worker LEBIH BANYAK dari jumlah core fisik tetap bermanfaat (tiap worker
// kebanyakan menunggu I/O, bukan menghabiskan satu core penuh). Ditambatkan ke 24 core PC server.
const TOTAL_WORKERS = Number(process.env.SWEEP_WORKERS) || 24;
// Bagi antara sapuan (temukan area baru) dan tambal (perbaiki lubang) - proporsi 2:1 karena
// biasanya lebih banyak titik grid baru daripada klaster lubang tersisa, tapi keduanya tetap
// berjalan BERSAMAAN sejak awal, bukan bergantian.
const SWEEP_WORKER_COUNT = Math.max(1, Math.round(TOTAL_WORKERS * (2 / 3)));
const PATCH_WORKER_COUNT = Math.max(1, TOTAL_WORKERS - SWEEP_WORKER_COUNT);

function writeStatus(status) {
  fs.writeFileSync(STATUS_PATH, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

let existingNodes = [];
if (fs.existsSync(GRAPH_PATH)) {
  const saved = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  existingNodes = saved.nodes;
  log(`Data sebelumnya dimuat: ${existingNodes.length} simpul.`);
}

const sharedNodes = new Map();
for (const n of existingNodes) sharedNodes.set(`${n.x},${n.z}`, n);

// Titik sapuan (area BARU) - lewati kolom yang sudah dikenal.
let sweepPoints = buildGridPoints(CENTER, SIZE_BLOCKS, SPACING);
const beforeFilter = sweepPoints.length;
sweepPoints = sweepPoints.filter((p) => !sharedNodes.has(`${Math.round(p.x)},${Math.round(p.z)}`));
log(`Sapuan: ${beforeFilter - sweepPoints.length} titik dilewati (sudah dikenal), ${sweepPoints.length} titik baru.`);

// Target tambal lubang - dihitung SEKALI dari snapshot data SAAT INI (bukan menunggu sapuan
// selesai), supaya sapuan & tambal bisa mulai BERSAMAAN.
const half = SIZE_BLOCKS / 2;
const bounds = { minX: Math.round(CENTER.x - half), maxX: Math.round(CENTER.x + half), minZ: Math.round(CENTER.z - half), maxZ: Math.round(CENTER.z + half) };
const missing = findMissingColumns(existingNodes, bounds);
const clusters = clusterHoles(missing, 24).sort((a, b) => b.size - a.size);
const patchTargets = clusters.flatMap((c) => expandClusterToTargets(c, SPACING)).slice(0, 2000);
log(`Tambal: ${missing.length} kolom kosong, ${clusters.length} klaster, ${patchTargets.length} titik tambalan (dibatasi 2000).`);

log(`Total worker: ${TOTAL_WORKERS} (${SWEEP_WORKER_COUNT} sapuan + ${PATCH_WORKER_COUNT} tambal), berjalan BERSAMAAN.`);
writeStatus({ phase: 'sweeping+patching', running: true, nodeCount: sharedNodes.size, sweepTotal: sweepPoints.length, patchTotal: patchTargets.length, sweepDone: 0, patchDone: 0 });

let sweepDone = 0, patchDone = 0;
let lastSaveAt = Date.now();
function maybeSave() {
  if (Date.now() - lastSaveAt < 10000) return; // simpan berkala, bukan tiap titik - hemat I/O disk untuk dataset besar
  lastSaveAt = Date.now();
  fs.writeFileSync(GRAPH_PATH, JSON.stringify({ sweptAt: new Date().toISOString(), nodes: Array.from(sharedNodes.values()) }));
}

async function main() {
  const host = '127.0.0.1', port = 25565, protocolVersion = 775, hintY = 70;
  const shouldStop = () => false;

  const sweepBuckets = SWEEP_WORKER_COUNT > 0 && sweepPoints.length > 0 ? partitionPoints(sweepPoints, SWEEP_WORKER_COUNT) : [];
  const sweepPromises = sweepBuckets.map((bucketPoints, i) =>
    sweepOneWorker({
      workerBotName: buildWorkerBotName(i),
      host, port, protocolVersion, points: bucketPoints, hintY, sharedNodes, onLog: log,
      onPointDone: () => {
        sweepDone++;
        writeStatus({ phase: 'sweeping+patching', running: true, nodeCount: sharedNodes.size, sweepTotal: sweepPoints.length, patchTotal: patchTargets.length, sweepDone, patchDone });
        maybeSave();
      },
      shouldStop
    }).catch((e) => log(`Worker sapuan ${i + 1} gagal: ${e.message}`))
  );

  const patchBuckets = PATCH_WORKER_COUNT > 0 && patchTargets.length > 0 ? partitionPoints(patchTargets, Math.min(PATCH_WORKER_COUNT, patchTargets.length)) : [];
  const patchPromises = patchBuckets.map((bucketTargets, i) =>
    patchOneWorker({
      workerBotName: buildPatchWorkerName(i),
      host, port, protocolVersion, targets: bucketTargets, hintY, sharedNodes, onLog: log,
      onPatchDone: () => {
        patchDone++;
        writeStatus({ phase: 'sweeping+patching', running: true, nodeCount: sharedNodes.size, sweepTotal: sweepPoints.length, patchTotal: patchTargets.length, sweepDone, patchDone });
        maybeSave();
      },
      shouldStop
    }).catch((e) => log(`Worker tambal ${i + 1} gagal: ${e.message}`))
  );

  await Promise.all([...sweepPromises, ...patchPromises]);

  fs.writeFileSync(GRAPH_PATH, JSON.stringify({ sweptAt: new Date().toISOString(), nodes: Array.from(sharedNodes.values()) }));
  log(`Selesai: ${sharedNodes.size} simpul total (sapuan ${sweepDone}/${sweepPoints.length}, tambal ${patchDone}/${patchTargets.length}).`);
  writeStatus({ phase: 'done', running: false, nodeCount: sharedNodes.size, sweepTotal: sweepPoints.length, patchTotal: patchTargets.length, sweepDone, patchDone });
}

main().catch((e) => {
  log(`GAGAL: ${e.message}`);
  writeStatus({ phase: 'error', running: false, error: e.message });
  process.exit(1);
});
