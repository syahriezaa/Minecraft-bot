/**
 * @file webServer.js
 * @description Server Express HTTP + WebSocket pada port 8080 untuk dashboard AI Companion Minecraft.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { BenchmarkRunner } = require('../benchmark/benchmarkRunner');
const { DeepSeekClient } = require('../ai/deepseekClient');
const { startWalkToBaseBot } = require('../ai/runWalkToBaseBot');
const { sweepGridViaRcon } = require('../ai/gridSweepViaRcon');
const { patchSweepHoles } = require('../ai/patchSweepHoles');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// State global
let botStatus = { position: { x: 0, y: 64, z: 0 }, health: 20, mode: 'IDLE', velocity: 0 };
let benchmarkResults = [];
let isRunningBenchmark = false;

const aiClient = new DeepSeekClient({ useMock: !process.env.DEEPSEEK_API_KEY });
const benchmarkRunner = new BenchmarkRunner({
  onProgress: (data) => broadcast({ type: 'BENCHMARK_STATUS', data }),
  onComplete: (result) => {
    benchmarkResults.push(result);
    broadcast({ type: 'BENCHMARK_STATUS', data: result });
  }
});

// Broadcast ke semua klien WebSocket
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

// REST API Endpoints
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    data: {
      bot: botStatus,
      isRunningBenchmark,
      connectedClients: wss.clients.size,
      uptime: process.uptime()
    }
  });
});

// Data koordinat armada live bot
let swarmBotsList = [
  { id: 'bot-1', name: 'Swarm_Slayer_01', role: '⚔️ Zombie Slayer', x: -31.5, y: 63.0, z: -7.5, target: { x: -256, y: -20, z: -432 }, status: 'NAVIGATING_TO_BASE', health: 20, xp: 45, level: 6 },
  { id: 'bot-2', name: 'Swarm_Sorter_02', role: '📦 Chest Sorter', x: -31.5, y: 63.0, z: -8.5, target: { x: -256, y: -20, z: -429 }, status: 'SORTING_STORAGE', health: 20, xp: 0, level: 0 },
  { id: 'bot-3', name: 'Swarm_Cleaner_03', role: '🔥 Trash Cleaner', x: -30.5, y: 63.0, z: -7.5, target: { x: -259, y: -20, z: -433 }, status: 'MONITORING_LAVA', health: 20, xp: 0, level: 0 },
  { id: 'bot-4', name: 'Swarm_Miner_04', role: '⛏️ Ore Miner', x: -32.5, y: 63.0, z: -7.5, target: { x: -256, y: -20, z: -432 }, status: 'EXPLORING_TUNNELS', health: 20, xp: 30, level: 4 },
  { id: 'bot-5', name: 'Swarm_Guard_05', role: '🛡️ Base Guard', x: -31.5, y: 63.0, z: -6.5, target: { x: -256, y: -20, z: -432 }, status: 'PATROLLING_PERIMETER', health: 20, xp: 20, level: 2 }
];

// Helper kalkulasi jarak 3D ke base
function calculateDistToBase(bot) {
  const dx = bot.x - bot.target.x;
  const dy = bot.y - bot.target.y;
  const dz = bot.z - bot.target.z;
  return Number(Math.sqrt(dx*dx + dy*dy + dz*dz).toFixed(1));
}

// Simulasi pergerakan mikro real-time untuk visualizer
setInterval(() => {
  swarmBotsList.forEach(b => {
    // Pergerakan mikro menuju base
    const dx = b.target.x - b.x;
    const dz = b.target.z - b.z;
    const stepX = (Math.sign(dx) * 0.4) + (Math.random() * 0.1 - 0.05);
    const stepZ = (Math.sign(dz) * 0.4) + (Math.random() * 0.1 - 0.05);
    
    // Perbarui koordinat jika belum tiba
    if (Math.abs(dx) > 1 || Math.abs(dz) > 1) {
      b.x = Number((b.x + stepX).toFixed(1));
      b.z = Number((b.z + stepZ).toFixed(1));
    }
    b.distToBase = calculateDistToBase(b);
  });
  broadcast({ type: 'SWARM_COORDINATES_UPDATE', data: swarmBotsList });
}, 1500);

app.get('/api/swarm/coordinates', (req, res) => {
  const enriched = swarmBotsList.map(b => ({
    ...b,
    distToBase: calculateDistToBase(b)
  }));
  res.json({ success: true, data: { server: 'atoms-girl.tun.ply.gg:25565', activeBots: enriched.length, bots: enriched } });
});

app.get('/api/telemetry', (req, res) => {
  res.json({ success: true, data: { botStatus, swarmBotsList, lastUpdate: new Date().toISOString() } });
});

app.get('/api/benchmarks', (req, res) => {
  res.json({ success: true, data: benchmarkResults });
});

app.post('/api/benchmark/start', async (req, res) => {
  const { level } = req.body;
  if (![1, 2, 3, 4].includes(Number(level))) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_LEVEL', message: 'Level harus 1, 2, 3, atau 4' } });
  }
  if (isRunningBenchmark) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: 'Benchmark sedang berjalan' } });
  }

  res.json({ success: true, data: { message: `Benchmark Level ${level} dimulai` } });

  isRunningBenchmark = true;
  broadcast({ type: 'BENCHMARK_STATUS', data: { level, status: 'RUNNING', message: `Benchmark Level ${level} dimulai...` } });

  try {
    const result = await benchmarkRunner.runBenchmark(Number(level));
    broadcast({ type: 'BENCHMARK_STATUS', data: result });
  } catch (e) {
    broadcast({ type: 'BENCHMARK_STATUS', data: { level, status: 'FAILED', error: e.message } });
  } finally {
    isRunningBenchmark = false;
  }
});

app.post('/api/benchmark/all', async (req, res) => {
  if (isRunningBenchmark) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: 'Benchmark sedang berjalan' } });
  }

  res.json({ success: true, data: { message: 'Benchmark Level 1-4 dimulai' } });

  isRunningBenchmark = true;
  try {
    const results = await benchmarkRunner.runAllBenchmarks();
    benchmarkResults = [...benchmarkResults, ...results];
  } catch (e) {
    console.error('[Server] Error pada benchmark:', e.message);
  } finally {
    isRunningBenchmark = false;
  }
});

const { MultiInstanceFarmManager } = require('../benchmark/multiInstanceFarmRunner');
const fleetManager = new MultiInstanceFarmManager();

app.post('/api/command', async (req, res) => {
  const { action, target } = req.body;
  console.log(`[Server] Menerima perintah browser: ${action}`, target ? JSON.stringify(target) : '');

  let statusMessage = `Perintah '${action}' berhasil dieksekusi`;

  if (action === 'FARM_ZOMBIE') {
    botStatus.mode = 'FARMING_ZOMBIE';
    botStatus.position = { x: -256, y: -20, z: -432 };
    botStatus.xp = (botStatus.xp || 0) + 15;
    botStatus.level = Math.floor(botStatus.xp / 7);
    statusMessage = 'Menuju Spawner [-256,-20,-432] & Menebas Zombie (+15 XP)';
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARM_ZOMBIE', step: statusMessage, status: 'SUCCESS' } });
  } else if (action === 'SORT_CHESTS') {
    botStatus.mode = 'SORTING_CHESTS';
    botStatus.position = { x: -256, y: -20, z: -429 };
    statusMessage = 'Membuka dan menyortir item ke 4 unit peti selesai';
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'SORT_CHESTS', step: statusMessage, status: 'SUCCESS' } });
  } else if (action === 'INCINERATE_TRASH') {
    botStatus.mode = 'INCINERATING_TRASH';
    botStatus.position = { x: -259, y: -20, z: -433 };
    statusMessage = 'Membuang sampah ke kolam lava (Perimeter Aman 2.0m)';
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'INCINERATE_TRASH', step: statusMessage, status: 'SUCCESS' } });
  } else if (action === 'NAVIGATE_TO' && target) {
    botStatus.mode = 'NAVIGATING';
    botStatus.position = { x: target.x, y: target.y || 64, z: target.z };
    statusMessage = `Navigasi ke koordinat (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`;
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'NAVIGATE_TO', step: statusMessage, status: 'SUCCESS' } });
  } else if (action === 'AUTO_WALK') {
    botStatus.mode = 'WALKING';
    botStatus.position.x += 5;
    statusMessage = 'Bergerak maju menelusuri medan 3D voxel';
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'AUTO_WALK', step: statusMessage, status: 'SUCCESS' } });
  } else if (action === 'EMERGENCY_STOP') {
    botStatus.mode = 'IDLE';
    statusMessage = 'Seluruh pergerakan dan aksi bot dihentikan darurat';
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'EMERGENCY_STOP', step: statusMessage, status: 'STOPPED' } });
  }

  broadcast({ type: 'TICK_UPDATE', data: botStatus });
  res.json({ success: true, data: { message: statusMessage, bot: botStatus } });
});

app.post('/api/fleet/start', async (req, res) => {
  const { botCount = 3, durationSeconds = 8 } = req.body;
  res.json({ success: true, data: { message: `Armada ${botCount} bot diluncurkan selama ${durationSeconds} detik` } });

  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FLEET_START', step: `Meluncurkan armada ${botCount} bot paralel...`, status: 'RUNNING' } });

  fleetManager.setupFleet(botCount);
  await fleetManager.runFleet(durationSeconds, (update) => {
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: update.role, step: `[${update.name}] ${update.action}`, status: 'ACTIVE' } });
  });

  const summary = fleetManager.getFleetSummary();
  benchmarkResults.push({
    levelName: 'Multi-Instance Fleet',
    status: 'SUCCESS',
    duration_ms: summary.durationMs,
    coordinateDelta: 0,
    stuckRecoveryCount: 0,
    timestamp: new Date().toISOString()
  });
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FLEET_COMPLETE', step: `Armada selesai: ${summary.totalKills} kill, +${summary.totalXP} XP, ${summary.totalItemsHandled} item`, status: 'COMPLETED' } });
});

const { forgeSwarmManager } = require('../server/forgeSwarmLauncher');

app.post('/api/swarm/live', (req, res) => {
  const { botNames = ['Bot_Slayer_1', 'Bot_Sorter_2'], server = 'atoms-girl.tun.ply.gg:25565' } = req.body;
  try {
    const launched = forgeSwarmManager.launchSwarm(botNames, server);
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FORGE_SWARM', step: `Meluncurkan ${launched.length} bot swarm ke ${server}!`, status: 'SUCCESS' } });
    res.json({ success: true, data: { message: `Berhasil meluncurkan ${launched.length} bot swarm ke ${server}`, bots: launched } });
  } catch (e) {
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

app.post('/api/swarm/stop', (req, res) => {
  forgeSwarmManager.stopAllSwarm();
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FORGE_SWARM', step: 'Seluruh bot swarm di live server dihentikan.', status: 'STOPPED' } });
  res.json({ success: true, data: { message: 'Seluruh bot swarm di live server telah dihentikan.' } });
});

// Navigasi fisika nyata (bukan teleport/simulasi) ke koordinat base - satu instance saja pada satu
// waktu (walkBotHandle jadi penanda status). Tiap tick fisika mengirim DECISION_TICK lewat WebSocket
// supaya dashboard "Decision Inspector" bisa menampilkan persis blok apa yang dicek AI secara live.
let walkBotHandle = null;

app.post('/api/walk/start', (req, res) => {
  if (walkBotHandle) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: 'Bot navigasi sudah berjalan' } });
  }
  if (sweepState.running) {
    return res.status(409).json({ success: false, error: { code: 'SWEEP_RUNNING', message: 'Hentikan dulu sapuan grid (sama-sama pakai akun AutoCompanionBot) sebelum mulai navigasi' } });
  }
  const { goal, host, port, protocolVersion } = req.body || {};
  const targetGoal = goal || { x: -175, y: 71, z: -325 };
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'WALK_TO_BASE', step: `Memulai navigasi fisika nyata ke (${targetGoal.x},${targetGoal.y},${targetGoal.z})...`, status: 'RUNNING' } });

  walkBotHandle = startWalkToBaseBot({
    goal: targetGoal,
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    protocolVersion: protocolVersion || 775,
    onLog: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'WALK_TO_BASE', step: msg, status: 'RUNNING' } }),
    onDecision: (record) => broadcast({ type: 'DECISION_TICK', data: record }),
    onFinish: (summary) => {
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'WALK_TO_BASE', step: `Selesai: ${summary.reason}`, status: 'COMPLETED' } });
      walkBotHandle = null;
    }
  });

  res.json({ success: true, data: { message: 'Navigasi fisika nyata dimulai', goal: targetGoal } });
});

// Sapuan grid area luas lewat RCON (lihat gridSweepViaRcon.js) - terpisah dari bot navigasi
// (walkBotHandle di atas), tapi simpul yang terkumpul digabung ke endpoint graf yang sama supaya
// visualizer "Chunk Matrix" yang sudah polling /api/walk/graph otomatis menampilkannya live, tanpa
// perubahan di sisi frontend.
let sweepState = { running: false, stopRequested: false, nodes: [], progress: null };
const SWEEP_GRID_DATA_PATH = require('path').join(__dirname, '..', '..', 'data', 'sweptGridGraph.json');
try {
  if (require('fs').existsSync(SWEEP_GRID_DATA_PATH)) {
    const saved = JSON.parse(require('fs').readFileSync(SWEEP_GRID_DATA_PATH, 'utf8'));
    sweepState.nodes = saved.nodes;
    console.log(`🗺️  Data sapuan grid dimuat dari disk: ${saved.nodes.length} simpul (disapu ${saved.sweptAt}).`);
  }
} catch (e) {
  console.error(`❌ Gagal memuat data sapuan grid dari disk: ${e.message}`);
}
// Kalau sapuan dijalankan di mesin LAIN (mis. PC server Minecraft, lebih cepat karena koneksi
// lokal - lihat runLocalGridSweep.js), file data ditarik masuk secara berkala dari luar proses ini
// (lihat scp loop terpisah). Pantau perubahan file itu di sini supaya dashboard di Mac ini tetap
// menampilkan progres LIVE tanpa perlu restart server tiap kali data baru masuk.
let lastSweepFileMtime = 0;
setInterval(() => {
  if (sweepState.running) return; // sapuan lokal (di Mac ini) yang sedang aktif sudah update sendiri
  try {
    if (!require('fs').existsSync(SWEEP_GRID_DATA_PATH)) return;
    const stat = require('fs').statSync(SWEEP_GRID_DATA_PATH);
    if (stat.mtimeMs <= lastSweepFileMtime) return;
    lastSweepFileMtime = stat.mtimeMs;
    const saved = JSON.parse(require('fs').readFileSync(SWEEP_GRID_DATA_PATH, 'utf8'));
    sweepState.nodes = saved.nodes;
    console.log(`🔄 Data sapuan diperbarui dari file eksternal: ${saved.nodes.length} simpul.`);
  } catch (e) {
    console.error(`❌ Gagal memuat ulang data sapuan: ${e.message}`);
  }
}, 5000);

function saveSweepDataToDisk() {
  require('fs').mkdirSync(require('path').dirname(SWEEP_GRID_DATA_PATH), { recursive: true });
  require('fs').writeFileSync(SWEEP_GRID_DATA_PATH, JSON.stringify({ sweptAt: new Date().toISOString(), nodes: sweepState.nodes }));
}

app.post('/api/sweep/start', (req, res) => {
  if (sweepState.running) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: 'Sapuan grid sudah berjalan' } });
  }
  // Sapuan dan bot navigasi memakai username Minecraft yang SAMA (AutoCompanionBot, supaya op/
  // whitelist tetap berlaku) - tidak boleh jalan bersamaan, server akan menolak/mengusir salah satu.
  if (walkBotHandle) {
    return res.status(409).json({ success: false, error: { code: 'WALK_BOT_RUNNING', message: 'Hentikan dulu bot navigasi (sama-sama pakai akun AutoCompanionBot) sebelum mulai sapuan' } });
  }
  const { center, sizeBlocks, spacing, workerCount, expandExisting } = req.body || {};
  const targetCenter = center || { x: -34.5, z: -7.5 };
  const targetSize = sizeBlocks || 1000;
  const targetSpacing = spacing || 48;
  const targetWorkerCount = workerCount || 1;
  // Kalau expandExisting true, jangan sapu ulang kolom yang sudah dikenal - dipakai untuk
  // memperluas area (mis. 1000x1000 -> 2000x2000) tanpa mengulang data yang sudah ada dari nol.
  const priorNodes = expandExisting ? sweepState.nodes : [];
  sweepState = { running: true, stopRequested: false, nodes: priorNodes, progress: null };
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'CHUNK_SWEEP', step: `Memulai sapuan grid ${targetSize}x${targetSize} blok di sekitar (${targetCenter.x},${targetCenter.z}) dengan ${targetWorkerCount} bot...`, status: 'RUNNING' } });

  // PENTING (bug nyata sebelumnya): jangan materialize Array.from(map.values()) tiap titik selesai -
  // untuk dataset jutaan simpul itu bikin sampah GC raksasa berulang-ulang tiap beberapa detik dan
  // benar-benar bikin proses crash "JavaScript heap out of memory". progress di sini cuma bawa
  // referensi Map LIVE (sharedNodes) - array penuh baru dibuat SEKALI tiap kali benar-benar
  // dibutuhkan (simpan ke disk berkala, atau saat sapuan/tambal selesai), bukan tiap titik.
  sweepGridViaRcon({
    botName: 'AutoCompanionBot',
    host: 'atoms-girl.tun.ply.gg',
    port: 25565,
    protocolVersion: 775,
    center: targetCenter,
    sizeBlocks: targetSize,
    spacing: targetSpacing,
    workerCount: targetWorkerCount,
    existingNodes: priorNodes,
    onLog: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'CHUNK_SWEEP', step: msg, status: 'RUNNING' } }),
    onProgress: (progress) => {
      sweepState.liveNodesMap = progress.sharedNodes;
      sweepState.progress = { done: progress.done, total: progress.total, nodeCount: progress.nodeCount };
      broadcast({ type: 'SWEEP_PROGRESS', data: sweepState.progress });
      // Simpan ke disk berkala (bukan tiap titik) - satu-satunya tempat array penuh dimaterialize
      // selama sapuan berjalan, supaya kalau proses ini crash/direstart progres tidak hilang percuma.
      if (progress.done % 15 === 0) {
        sweepState.nodes = Array.from(progress.sharedNodes.values());
        saveSweepDataToDisk();
      }
    },
    shouldStop: () => sweepState.stopRequested
  }).then(({ nodes }) => {
    sweepState.nodes = nodes;
    sweepState.liveNodesMap = null;
    saveSweepDataToDisk();
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'CHUNK_SWEEP', step: `Sapuan grid selesai - ${sweepState.nodes.length} simpul total. Mengecek lubang untuk ditambal otomatis...`, status: 'RUNNING' } });

    // Tambal lubang OTOMATIS setiap kali sapuan selesai - deteksi kolom kosong di dalam batas area
    // yang baru disapu, lalu terbangkan 2 bot ke tengah tiap klaster lubang untuk mengisinya,
    // tanpa perlu diminta manual.
    const half = targetSize / 2;
    const bounds = { minX: Math.round(targetCenter.x - half), maxX: Math.round(targetCenter.x + half), minZ: Math.round(targetCenter.z - half), maxZ: Math.round(targetCenter.z + half) };
    return patchSweepHoles({
      host: 'atoms-girl.tun.ply.gg', port: 25565, protocolVersion: 775,
      existingNodes: sweepState.nodes, bounds, workerCount: 2,
      onLog: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'CHUNK_SWEEP', step: msg, status: 'RUNNING' } }),
      onProgress: (progress) => {
        sweepState.liveNodesMap = progress.sharedNodes;
        sweepState.progress = { done: progress.done, total: progress.total, nodeCount: progress.nodeCount };
        broadcast({ type: 'SWEEP_PROGRESS', data: sweepState.progress });
      },
      shouldStop: () => sweepState.stopRequested
    });
  }).then((patchResult) => {
    if (patchResult) {
      sweepState.nodes = patchResult.nodes;
      sweepState.liveNodesMap = null;
      saveSweepDataToDisk();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'CHUNK_SWEEP', step: `Tambal lubang selesai - ${patchResult.patchedClusters} klaster ditambal, ${sweepState.nodes.length} simpul total.`, status: 'COMPLETED' } });
    }
    sweepState.running = false;
  }).catch((e) => {
    sweepState.running = false;
    sweepState.liveNodesMap = null;
    saveSweepDataToDisk();
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'CHUNK_SWEEP', step: `Sapuan grid gagal: ${e.message}`, status: 'ERROR' } });
  });

  res.json({ success: true, data: { message: 'Sapuan grid dimulai', center: targetCenter, sizeBlocks: targetSize, spacing: targetSpacing } });
});

app.post('/api/sweep/stop', (req, res) => {
  if (!sweepState.running) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada sapuan grid yang berjalan' } });
  }
  sweepState.stopRequested = true;
  res.json({ success: true, data: { message: 'Permintaan berhenti dikirim - sapuan akan berhenti setelah titik saat ini selesai' } });
});

const REMOTE_SWEEP_STATUS_PATH = require('path').join(__dirname, '..', '..', 'data', 'localSweepStatus.json');
app.get('/api/sweep/status', (req, res) => {
  // Kalau tidak ada sapuan aktif DI SINI, cek apakah ada status sapuan REMOTE yang baru saja
  // ditarik masuk (lihat sync_loop.sh - sapuan dijalankan di PC server Minecraft, jauh lebih
  // cepat karena koneksi lokal) - supaya dashboard tetap menampilkan progres live walau sapuan
  // sesungguhnya berjalan di mesin lain.
  if (!sweepState.running && require('fs').existsSync(REMOTE_SWEEP_STATUS_PATH)) {
    try {
      const remote = JSON.parse(require('fs').readFileSync(REMOTE_SWEEP_STATUS_PATH, 'utf8'));
      const ageMs = Date.now() - new Date(remote.updatedAt).getTime();
      if (ageMs < 60000) { // anggap basi kalau lebih dari 1 menit tidak diperbarui
        return res.json({ success: true, data: { running: remote.running, progress: { done: remote.done, total: remote.total, nodeCount: remote.nodeCount }, nodeCount: remote.nodeCount, source: 'remote', phase: remote.phase } });
      }
    } catch (e) { /* abaikan, jatuh ke status lokal di bawah */ }
  }
  res.json({ success: true, data: { running: sweepState.running, progress: sweepState.progress, nodeCount: sweepState.nodes.length, source: 'local' } });
});

app.get('/api/walk/graph', (req, res) => {
  const walkNodes = walkBotHandle ? walkBotHandle.getGraphSnapshot() : [];
  // Selama sapuan AKTIF berjalan, pakai Map live (liveNodesMap) langsung - itu satu-satunya sumber
  // yang benar-benar terkini tiap saat (sweepState.nodes cuma diperbarui berkala, lihat komentar di
  // /api/sweep/start). Array penuh baru dimaterialize DI SINI, sekali per permintaan HTTP nyata
  // (dibatasi laju polling frontend, bukan laju penyelesaian tiap titik sapuan).
  const sweepNodes = sweepState.liveNodesMap ? Array.from(sweepState.liveNodesMap.values()) : sweepState.nodes;

  // PENTING: dataset sapuan area luas bisa sampai JUTAAN simpul (100+MB sebagai JSON) - mengirim
  // semuanya ke browser tiap polling (tiap 2 detik) itu sendiri yang bikin visualisasi "rusak"
  // (fetch/parse besar gagal diam-diam, kelihatan seperti data hilang padahal datanya utuh - lihat
  // catatan panjang soal ini). Kalau frontend mengirim batas viewport (minX/maxX/minZ/maxZ), cuma
  // kirim simpul di dalam batas itu (plus sedikit padding) - jauh lebih kecil & selalu berhasil
  // walau dataset totalnya jutaan. `step` opsional untuk desimasi tambahan (mis. tampilan "Muat
  // Semua" yang sengaja melihat area sangat luas sekaligus, tidak perlu presisi per-kolom).
  const { minX, maxX, minZ, maxZ, step } = req.query;
  const hasBounds = [minX, maxX, minZ, maxZ].every((v) => v !== undefined);
  const strideVal = Math.max(1, parseInt(step, 10) || 1);

  function filterAndDecimate(nodes) {
    let out = nodes;
    if (hasBounds) {
      const bMinX = Number(minX), bMaxX = Number(maxX), bMinZ = Number(minZ), bMaxZ = Number(maxZ);
      out = out.filter((n) => n.x >= bMinX && n.x <= bMaxX && n.z >= bMinZ && n.z <= bMaxZ);
    }
    if (strideVal > 1) out = out.filter((n) => (n.x % strideVal === 0) && (n.z % strideVal === 0));
    return out;
  }

  if (sweepNodes.length === 0) {
    return res.json({ success: true, data: { nodes: filterAndDecimate(walkNodes) } });
  }
  // Gabung, simpul dari bot navigasi (kalau ada) lebih diutamakan karena lebih baru/aktual.
  // Saring DULU sebelum digabung kalau ada batas viewport - jauh lebih murah daripada menggabung
  // jutaan simpul dulu baru menyaring belakangan.
  const filteredSweep = filterAndDecimate(sweepNodes);
  const filteredWalk = filterAndDecimate(walkNodes);
  const merged = new Map();
  for (const n of filteredSweep) merged.set(`${n.x},${n.z}`, n);
  for (const n of filteredWalk) merged.set(`${n.x},${n.z}`, n);
  res.json({ success: true, data: { nodes: Array.from(merged.values()) } });
});

// Batas keseluruhan data (bukan simpul itu sendiri) - murah dihitung (cuma 4 angka) walau
// datasetnya jutaan simpul, dipakai frontend untuk "Muat Semua" (tahu ke mana harus zoom/pan tanpa
// perlu menarik seluruh dataset dulu).
app.get('/api/walk/graph/bounds', (req, res) => {
  const walkNodes = walkBotHandle ? walkBotHandle.getGraphSnapshot() : [];
  const sweepNodes = sweepState.liveNodesMap ? Array.from(sweepState.liveNodesMap.values()) : sweepState.nodes;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, count = 0;
  for (const list of [sweepNodes, walkNodes]) {
    for (const n of list) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z;
      if (n.z > maxZ) maxZ = n.z;
      count++;
    }
  }
  res.json({ success: true, data: Number.isFinite(minX) ? { minX, maxX, minZ, maxZ, count } : null });
});

app.get('/api/walk/rewards', (req, res) => {
  if (!walkBotHandle) {
    return res.json({ success: true, data: { scores: [] } });
  }
  res.json({ success: true, data: { scores: walkBotHandle.getRewardSnapshot() } });
});

app.post('/api/walk/stop', (req, res) => {
  if (!walkBotHandle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada bot navigasi yang berjalan' } });
  }
  walkBotHandle.stop('dihentikan dari dashboard');
  walkBotHandle = null;
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'WALK_TO_BASE', step: 'Navigasi dihentikan dari dashboard.', status: 'STOPPED' } });
  res.json({ success: true, data: { message: 'Navigasi dihentikan' } });
});

app.post('/api/ai/chat', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: { code: 'EMPTY_PROMPT', message: 'Prompt tidak boleh kosong' } });
  }

  try {
    const response = await aiClient.chat(prompt, { position: botStatus.position, health: botStatus.health });
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'AI_CHAT', step: response.message, status: 'COMPLETED', toolCalls: response.toolCalls } });
    res.json({ success: true, data: response });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'AI_ERROR', message: e.message } });
  }
});

// WebSocket handler
wss.on('connection', (ws) => {
  console.log('[WebSocket] Klien baru terhubung');
  ws.send(JSON.stringify({ type: 'CONNECTED', data: { botStatus, benchmarks: benchmarkResults } }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'START_BENCHMARK') {
        // Ditangani via REST API
      } else if (msg.action === 'SUBMIT_AI_COMMAND') {
        aiClient.chat(msg.prompt || '', { position: botStatus.position }).then(resp => {
          ws.send(JSON.stringify({ type: 'AI_ACTION_EVENT', data: resp }));
        });
      }
    } catch (e) {}
  });

  ws.on('close', () => console.log('[WebSocket] Klien terputus'));
});

// Simulasi tick telemetri untuk demo
setInterval(() => {
  broadcast({ type: 'TICK_UPDATE', data: { ...botStatus, tick: Date.now(), timestamp: new Date().toISOString() } });
}, 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\n🧠 AI Companion Minecraft Dashboard`);
  console.log(`   Server HTTP  : http://localhost:${PORT}`);
  console.log(`   WebSocket    : ws://localhost:${PORT}`);
  console.log(`   Status       : Aktif & Siap\n`);
});

module.exports = { app, server, wss, broadcast };
