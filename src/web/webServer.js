/**
 * @file webServer.js
 * @description Server Express HTTP + WebSocket pada port 8080 untuk dashboard AI Companion Minecraft.
 */

require('dotenv').config();

// mineflayer-pathfinder 2.4.x can emit one physics tick after a bot session
// ends. If that tick observes bot.entity already cleared while a placement was
// pending, its monitorMovement handler throws a narrow TypeError and otherwise
// brings down this shared dashboard process. Treat only that known disconnect
// race as recoverable; all other uncaught exceptions remain fatal.
process.on('uncaughtException', error => {
  const stack = String(error?.stack || '');
  const isPathfinderDisconnectRace = error?.name === 'TypeError' &&
    /Cannot read properties of undefined \(reading 'y'\)/.test(String(error?.message || '')) &&
    stack.includes('mineflayer-pathfinder') && stack.includes('monitorMovement');
  if (!isPathfinderDisconnectRace) throw error;
  console.error(`[Runtime Guard] pathfinder disconnect race diabaikan: ${error.message}`);
});

// HARUS di baris paling atas, sebelum require APAPUN yang bisa menarik 'mineflayer' secara
// transitif (mis. BenchmarkRunner -> botClient.js -> require('mineflayer')) - lib/loader.js
// mineflayer men-destructure latestSupportedVersion dari './version' SEKALI saat modul itu
// PERTAMA di-require (nilainya disalin ke konstanta lokal, bukan referensi hidup), jadi menambal
// require.cache SETELAH mineflayer sempat ter-require di tempat lain sama sekali tidak berpengaruh
// - ditemukan dari bug live nyata: worker yang dimulai lewat dashboard tetap gagal konek
// ("Server version '26.1' is not supported... Latest supported version is '1.21.11'") padahal
// runFarmerWorker.js sendiri sudah memanggil patch di baris paling atasnya - karena BenchmarkRunner
// (di-require lebih dulu di file ini) sudah menarik mineflayer duluan.
const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1.2');

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { BenchmarkRunner } = require('../benchmark/benchmarkRunner');
const { DeepSeekClient } = require('../ai/deepseekClient');
const { startFarmerWorker } = require('../ai/runFarmerWorker');
const { startExplorerWorker } = require('../ai/runExplorerWorker');
const { loadLandmarks } = require('../ai/worldLandmarks');
const { startGuardWorker } = require('../ai/runGuardWorker');
const { startMobFarmWorker } = require('../ai/runMobFarmWorker');
const { startRancherWorker } = require('../ai/runRancherWorker');
const { startStorageWorker, CHEST_CATEGORY_LABELS } = require('../ai/runStorageWorker');
const woodGathererModulePath = require.resolve('../ai/runWoodGathererWorker');
const { storageRoomConstructionCoordinator } = require('../ai/storageRoomConstructionCoordinator');
const { miningFleetCoordinator } = require('../ai/miningFleetCoordinator');
const { GlobalSwarmOrchestrator } = require('../ai/globalSwarmOrchestrator');
const { querySLP } = require('../network/liveProtocolClient');
const { WorldMapData } = require('./worldMapData');
const { StorageRepository } = require('../ai/storageRepository');
const { getSharedChestAssignments } = require('../ai/storageMemory');
const { storageMaterialsCoordinator } = require('../ai/storageMaterialsCoordinator');
const { resolveWorldIdentity } = require('../ai/worldIdentity');

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
const globalSwarmOrchestrator = new GlobalSwarmOrchestrator();
const storageRepository = new StorageRepository(globalSwarmOrchestrator.memory, { historyLimit: 50 });
const resolveRequestWorld = (source = {}) => {
  const host = source.host || process.env.STORAGE_ROOM_SERVER_HOST || process.env.MC_REMOTE_HOST || 'atoms-girl.tun.ply.gg';
  const port = Number(source.port) || Number(process.env.STORAGE_ROOM_SERVER_PORT) || Number(process.env.MC_REMOTE_PORT) || 25565;
  const dimension = source.dimension || process.env.MC_DIMENSION_ID || 'overworld';
  return resolveWorldIdentity(globalSwarmOrchestrator.memory, {
    host, port, dimension, world: source.world || process.env.MC_WORLD_ID
  });
};
const defaultStorageContext = () => ({
  world: resolveRequestWorld(),
  dimension: process.env.MC_DIMENSION_ID || 'overworld'
});
storageRepository.upsertAssignments(defaultStorageContext(), getSharedChestAssignments(), 'storage-memory-seed');
storageRoomConstructionCoordinator.setOrchestrator(globalSwarmOrchestrator);
miningFleetCoordinator.setOrchestrator(globalSwarmOrchestrator);
storageMaterialsCoordinator.setOrchestrator(globalSwarmOrchestrator);
const worldMapData = new WorldMapData({
  memory: globalSwarmOrchestrator.memory,
  loadLandmarks,
  bots: () => buildRealSwarmList(),
  miningStatus: () => miningFleetCoordinator.getStatus()
});

// Broadcast ke semua klien WebSocket
function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Pembangunan storage room adalah bagian dari armada yang sama, bukan runner manual terpisah.
// Event builder dan landscaper dipantulkan ke dashboard melalui channel yang sama.
storageRoomConstructionCoordinator.on('update', data => {
  broadcast({ type: 'STORAGE_CONSTRUCTION_UPDATE', data });
});
miningFleetCoordinator.on('update', data => {
  broadcast({ type: 'MINING_FLEET_UPDATE', data });
});
storageMaterialsCoordinator.on('update', data => {
  broadcast({ type: 'STORAGE_MATERIALS_UPDATE', data });
});

// REST API Endpoints
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    data: {
      bot: getPrimaryBotStatus(),
      isRunningBenchmark,
      connectedClients: wss.clients.size,
      storageConstruction: storageRoomConstructionCoordinator.getStatus(),
      miningFleet: miningFleetCoordinator.getStatus(),
      storageMaterials: storageMaterialsCoordinator.getStatus(),
      uptime: process.uptime()
    }
  });
});

// Koordinat armada SUNGGUHAN - digabung dari seluruh pekerja tani (farmerWorkers) dan penjaga
// (guardWorkers) yang benar-benar berjalan (lihat handle.getStatus() di runFarmerWorker.js /
// runGuardWorker.js), BUKAN simulasi. Base sungguhan dipakai untuk hitung jarak (lihat
// DEFAULT_BASE_GOAL di runFarmerWorker.js/runGuardWorker.js - disamakan di sini).
const REAL_BASE_POSITION = { x: -185, y: 71, z: -352 };

function distance3d(a, b) {
  if (!a || !b) return null;
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Number(Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1));
}

function buildRealSwarmList() {
  const bots = [];
  // rancherWorkers/storageWorkers/explorerWorkers dideklarasikan lebih bawah di file ini (const) -
  // aman diakses di sini karena fungsi ini cuma benar-benar DIPANGGIL belakangan (lewat
  // setInterval/endpoint), bukan saat baris ini pertama dieksekusi.
  for (const workerMap of [farmerWorkers, guardWorkers, rancherWorkers, storageWorkers, explorerWorkers, mobFarmWorkers, woodGathererWorkers]) {
    for (const [name, handle] of workerMap) {
      const status = typeof handle.getStatus === 'function' ? handle.getStatus() : null;
      if (!status?.position) continue;
      bots.push({
        id: name, name, role: status.role,
        x: status.position.x, y: status.position.y, z: status.position.z,
        status: status.status, health: status.health,
        distToBase: distance3d(status.position, REAL_BASE_POSITION),
        inventory: status.inventory || []
      });
    }
  }
  return bots;
}

// Ringkasan header harus mencerminkan worker yang benar-benar terhubung ke
// Minecraft. botStatus tetap dipakai sebagai fallback untuk mode benchmark lama,
// tetapi tidak boleh menutupi posisi worker live ketika armada sedang berjalan.
function getPrimaryBotStatus() {
  const primary = buildRealSwarmList()[0];
  if (!primary) return botStatus;
  return {
    ...botStatus,
    position: { x: primary.x, y: primary.y, z: primary.z },
    health: primary.health ?? botStatus.health,
    mode: primary.status || 'IDLE',
    workerName: primary.name,
    workerRole: primary.role,
    velocity: botStatus.velocity || 0
  };
}

setInterval(() => {
  broadcast({ type: 'SWARM_COORDINATES_UPDATE', data: buildRealSwarmList() });
}, 2000);

app.get('/api/swarm/coordinates', (req, res) => {
  const bots = buildRealSwarmList();
  res.json({ success: true, data: { server: 'atoms-girl.tun.ply.gg:25565', activeBots: bots.length, bots } });
});

app.get('/api/world-map', (req, res) => {
  try {
    res.json({ success: true, data: worldMapData.snapshot(req.query || {}) });
  } catch (error) {
    res.status(400).json({ success: false, error: { code: 'WORLD_MAP_FAILED', message: error.message } });
  }
});

app.get('/api/telemetry', (req, res) => {
  res.json({ success: true, data: { botStatus: getPrimaryBotStatus(), swarmBotsList: buildRealSwarmList(), lastUpdate: new Date().toISOString() } });
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

app.post('/api/ai/chat', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: { code: 'EMPTY_PROMPT', message: 'Prompt tidak boleh kosong' } });
  }

  try {
    const liveStatus = getPrimaryBotStatus();
    const response = await aiClient.chat(prompt, { position: liveStatus.position, health: liveStatus.health });
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'AI_CHAT', step: response.message, status: 'COMPLETED', toolCalls: response.toolCalls } });
    res.json({ success: true, data: response });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'AI_ERROR', message: e.message } });
  }
});

// Pekerja pertanian+peternakan otonom (lihat runFarmerWorker.js) - BISA banyak instance sekaligus
// (armada), masing-masing punya nama bot Minecraft sendiri (unik, dipakai sebagai key Map ini).
// Dikontrol lewat dashboard (panel "Armada Pekerja Tani").
const farmerWorkers = new Map(); // botName -> handle

app.post('/api/farmer/start', (req, res) => {
  const { host, port, botName, scanRadius } = req.body || {};
  const name = botName || 'FarmerWorker';
  if (farmerWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Pekerja tani '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: `Memulai pekerja pertanian+peternakan '${name}'...`, status: 'RUNNING' } });

  const handle = startFarmerWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: name,
    scanRadius: scanRadius || 32,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    // Tanpa ini, entri Map tetap "hidup" selamanya di dashboard walau koneksi sungguhan sudah
    // putus (bug nyata: dashboard terus lapor "running: true" dengan data basi) - hapus dari Map
    // begitu bot benar-benar terputus tak terduga, supaya status dashboard jujur.
    onDisconnect: () => {
      farmerWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    }
  });
  farmerWorkers.set(name, handle);

  res.json({ success: true, data: { message: `Pekerja tani '${name}' dimulai` } });
});

app.post('/api/farmer/stop', (req, res) => {
  const { botName } = req.body || {};
  if (!botName) {
    // Tanpa botName: hentikan SEMUA pekerja tani yang sedang berjalan (tombol "Hentikan Semua").
    const count = farmerWorkers.size;
    if (count === 0) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada pekerja pertanian yang berjalan' } });
    }
    for (const [name, handle] of farmerWorkers) {
      handle.stop();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: `[${name}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
    }
    farmerWorkers.clear();
    return res.json({ success: true, data: { message: `${count} pekerja tani dihentikan` } });
  }
  const handle = farmerWorkers.get(botName);
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `Pekerja tani '${botName}' tidak ditemukan` } });
  }
  handle.stop();
  farmerWorkers.delete(botName);
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: `[${botName}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
  res.json({ success: true, data: { message: `Pekerja tani '${botName}' dihentikan` } });
});

// Baca komposisi blok dalam kotak x/z lewat chunk yang SUDAH termuat salah satu pekerja tani yang
// sedang berjalan - dipakai untuk verifikasi cepat batas area (landmark dsb) tanpa perlu bot baru
// jalan kaki dari nol.
app.post('/api/farmer/query-blocks', async (req, res) => {
  const { minX, maxX, minZ, maxZ, y } = req.body || {};
  const handle = farmerWorkers.values().next().value;
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada pekerja tani yang berjalan' } });
  }
  res.json({ success: true, data: await handle.queryBlockBox({ minX, maxX, minZ, maxZ, y }) });
});

app.get('/api/farmer/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: farmerWorkers.size > 0,
      count: farmerWorkers.size,
      workers: Array.from(farmerWorkers.entries()).map(([name, handle]) => ({
        botName: name,
        status: typeof handle.getStatus === 'function' ? handle.getStatus() : null,
        metrics: handle.getMetrics()
      }))
    }
  });
});

// Bot penjelajah - menandai tempat penting (peti, mob spawner, lahan farming, sungai, area
// villager) ke memori landmark bersama (worldLandmarks.js) - permintaan nyata pemilik: "mari kita
// buat bot explorer yang menandai akan mengeksplor map area area dan tempat tempat penting".
// Sama pola armada seperti farmerWorkers di atas.
const explorerWorkers = new Map(); // botName -> handle

app.post('/api/explorer/start', (req, res) => {
  const { host, port, botName, scanRadius, spiralStepSize, maxExploreRadius } = req.body || {};
  const name = botName || 'ExplorerWorker';
  if (explorerWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Penjelajah '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'EXPLORER_WORKER', step: `Memulai penjelajah '${name}'...`, status: 'RUNNING' } });

  const handle = startExplorerWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: name,
    scanRadius: scanRadius || 24,
    spiralStepSize: spiralStepSize || 8,
    maxExploreRadius: maxExploreRadius || 64,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'EXPLORER_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    onDisconnect: () => {
      explorerWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'EXPLORER_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    },
    onLandmarkFound: (landmark) => broadcast({ type: 'LANDMARK_FOUND', data: { landmark } })
  });
  explorerWorkers.set(name, handle);

  res.json({ success: true, data: { message: `Penjelajah '${name}' dimulai` } });
});

app.post('/api/explorer/stop', (req, res) => {
  const { botName } = req.body || {};
  if (!botName) {
    const count = explorerWorkers.size;
    if (count === 0) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada penjelajah yang berjalan' } });
    }
    for (const [name, handle] of explorerWorkers) {
      handle.stop();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'EXPLORER_WORKER', step: `[${name}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
    }
    explorerWorkers.clear();
    return res.json({ success: true, data: { message: `${count} penjelajah dihentikan` } });
  }
  const handle = explorerWorkers.get(botName);
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `Penjelajah '${botName}' tidak ditemukan` } });
  }
  handle.stop();
  explorerWorkers.delete(botName);
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'EXPLORER_WORKER', step: `[${botName}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
  res.json({ success: true, data: { message: `Penjelajah '${botName}' dihentikan` } });
});

app.get('/api/explorer/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: explorerWorkers.size > 0,
      count: explorerWorkers.size,
      workers: Array.from(explorerWorkers.entries()).map(([name, handle]) => ({
        botName: name,
        status: typeof handle.getStatus === 'function' ? handle.getStatus() : null,
        metrics: handle.getMetrics()
      }))
    }
  });
});

const woodGathererWorkers = new Map();

// Worker baru harus memakai source terbaru tanpa membuat worker yang sudah hidup
// kehilangan modulnya di tengah siklus. Cache hanya di-refresh tepat sebelum
// start, jadi sesi aktif tetap berjalan dengan instance yang sedang dipakai.
function startLatestWoodGathererWorker(options) {
  delete require.cache[woodGathererModulePath];
  return require(woodGathererModulePath).startWoodGathererWorker(options);
}

app.post('/api/wood-gatherer/start', (req, res) => {
  const name = String(req.body?.botName || 'WoodDiag1').slice(0, 16);
  if (woodGathererWorkers.has(name)) return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Wood gatherer '${name}' sudah berjalan` } });
  const handle = startLatestWoodGathererWorker({
    host: req.body?.host || 'atoms-girl.tun.ply.gg', port: Number(req.body?.port) || 25565, botName: name,
    workerIndex: Number.isInteger(Number(req.body?.fleetIndex)) ? Number(req.body.fleetIndex) : 0,
    workerCount: Math.max(1, Number(req.body?.fleetSize) || 1),
    log: message => {
      console.log(`[WoodGatherer:${name}] ${message}`);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'WOOD_GATHERER', step: `[${name}] ${message}`, status: 'RUNNING' } });
    },
    onDisconnect: reason => {
      console.log(`[WoodGatherer:${name}] terputus: ${reason || 'tanpa alasan'}`);
      woodGathererWorkers.delete(name);
    }
  });
  woodGathererWorkers.set(name, handle);
  res.json({ success: true, data: { message: `${name} dimulai` } });
});

app.post('/api/wood-gatherer/stop', (req, res) => {
  const name = req.body?.botName;
  if (name) {
    const handle = woodGathererWorkers.get(name);
    if (!handle) return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `${name} tidak berjalan` } });
    handle.stop(); woodGathererWorkers.delete(name);
  } else {
    for (const handle of woodGathererWorkers.values()) handle.stop();
    woodGathererWorkers.clear();
  }
  res.json({ success: true, data: { message: 'Wood gatherer dihentikan' } });
});

app.get('/api/wood-gatherer/status', (req, res) => res.json({ success: true, data: {
  running: woodGathererWorkers.size > 0,
  workers: [...woodGathererWorkers.entries()].map(([botName, handle]) => ({ botName, status: handle.getStatus(), metrics: handle.getMetrics() }))
} }));

// Semua landmark yang sudah ditemukan sejauh ini - dipakai dashboard untuk peta landmark, dan bisa
// dipakai bot lain (mis. FarmerWorker) untuk menghindari zona yang ditandai secara otomatis.
app.get('/api/landmarks', (req, res) => {
  res.json({ success: true, data: { landmarks: loadLandmarks() } });
});

app.get('/api/world-memory', (req, res) => {
  let memory;
  try {
    const { SharedWorldMemory } = require('../ai/sharedWorldMemory');
    memory = new SharedWorldMemory();
    res.json({ success: true, data: memory.summary() });
  } catch {
    res.status(503).json({ success: false, error: 'Memori dunia belum tersedia; periksa runtime Node dan penyimpanan.' });
  } finally { memory?.close(); }
});

app.get('/api/world-analysis', (req, res) => {
  let memory;
  try {
    const { SharedWorldMemory } = require('../ai/sharedWorldMemory');
    const { TYPES } = require('../ai/semanticSpatialAnalysis');
    memory = new SharedWorldMemory();
    const { StructureRegistry } = require('../ai/structureRegistry');
    res.json({ success: true, data: { supportedTypes: TYPES, observations: memory.analyses(), structures: new StructureRegistry(memory).list() } });
  } catch { res.status(503).json({ success: false, error: 'Analisis dunia belum tersedia.' }); }
  finally { memory?.close(); }
});

app.patch('/api/structures/:id/label', (req,res)=>{
  let memory;
  try {
    const {SharedWorldMemory}=require('../ai/sharedWorldMemory');
    const {StructureRegistry}=require('../ai/structureRegistry');
    if(typeof req.body?.label!=='string'||req.body.label.length>120)return res.status(400).json({success:false,error:'Label maksimal 120 karakter.'});
    memory=new SharedWorldMemory();
    const updated=new StructureRegistry(memory).label(req.params.id,req.body.label);
    res.status(updated?200:404).json({success:updated});
  } catch {res.status(503).json({success:false,error:'Penyimpanan label belum tersedia.'});}
  finally {memory?.close();}
});

app.get('/api/reservations', (req, res) => {
  let memory;
  try {
    const { SharedWorldMemory } = require('../ai/sharedWorldMemory');
    const { SwarmReservations } = require('../ai/swarmReservations');
    memory = new SharedWorldMemory();
    new SwarmReservations(memory);
    const rows = memory.db.prepare(`SELECT world,dimension,owner,token,COUNT(*) AS cells,MAX(expiresAt) AS expiresAt
      FROM reservations WHERE expiresAt>? GROUP BY world,dimension,owner,token LIMIT 200`).all(Date.now());
    res.json({ success: true, data: rows });
  } catch { res.status(503).json({ success: false, error: 'Reservasi belum tersedia.' }); }
  finally { memory?.close(); }
});

app.get('/api/swarm/architecture/status', (req, res) => {
  const dimension = String(req.query.dimension || 'overworld');
  const world = resolveRequestWorld({ world: req.query.world, host: req.query.host, port: req.query.port, dimension });
  res.json({ success: true, data: globalSwarmOrchestrator.getStatus({ world, dimension }) });
});

app.post('/api/swarm/goals', (req, res) => {
  try {
    const type = String(req.body?.type || '');
    if (!type) return res.status(400).json({ success: false, error: 'Goal type wajib diisi.' });
    const dimension = String(req.body?.dimension || 'overworld');
    const world = resolveRequestWorld({ ...req.body, dimension });
    const goal = globalSwarmOrchestrator.submitGoal({
      world,
      dimension,
      type,
      payload: req.body?.payload || {},
      priority: Number(req.body?.priority) || 0
    });
    broadcast({ type: 'SWARM_GOAL_UPDATE', data: goal });
    return res.status(201).json({ success: true, data: goal });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/swarm/goals/:id', (req, res) => {
  const goal = globalSwarmOrchestrator.getGoal(req.params.id);
  return res.status(goal ? 200 : 404).json(goal
    ? { success: true, data: goal }
    : { success: false, error: 'Goal tidak ditemukan.' });
});

// Pekerja penjaga otonom (lihat runGuardWorker.js) - jaga base dari mob hostile, perbaiki gear
// hilang/rusak dengan craft besi dari gudang. Sama pola armada seperti farmerWorkers di atas.
const guardWorkers = new Map(); // botName -> handle

app.post('/api/guard/start', (req, res) => {
  const { host, port, botName, scanRadius } = req.body || {};
  const name = botName || 'GuardWorker';
  if (guardWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Penjaga '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'GUARD_WORKER', step: `Memulai penjaga '${name}'...`, status: 'RUNNING' } });

  const handle = startGuardWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: name,
    scanRadius: scanRadius || 16,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'GUARD_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    onDisconnect: () => {
      guardWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'GUARD_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    }
  });
  guardWorkers.set(name, handle);

  res.json({ success: true, data: { message: `Penjaga '${name}' dimulai` } });
});

app.post('/api/guard/stop', (req, res) => {
  const { botName } = req.body || {};
  if (!botName) {
    const count = guardWorkers.size;
    if (count === 0) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada penjaga yang berjalan' } });
    }
    for (const [name, handle] of guardWorkers) {
      handle.stop();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'GUARD_WORKER', step: `[${name}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
    }
    guardWorkers.clear();
    return res.json({ success: true, data: { message: `${count} penjaga dihentikan` } });
  }
  const handle = guardWorkers.get(botName);
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `Penjaga '${botName}' tidak ditemukan` } });
  }
  handle.stop();
  guardWorkers.delete(botName);
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'GUARD_WORKER', step: `[${botName}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
  res.json({ success: true, data: { message: `Penjaga '${botName}' dihentikan` } });
});

app.get('/api/guard/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: guardWorkers.size > 0,
      count: guardWorkers.size,
      workers: Array.from(guardWorkers.entries()).map(([name, handle]) => ({
        botName: name,
        status: typeof handle.getStatus === 'function' ? handle.getStatus() : null,
        metrics: handle.getMetrics()
      }))
    }
  });
});

// Pekerja pemburu spawner (lihat runMobFarmWorker.js) - farming rotten_flesh di mob spawner,
// jarah chest di sekitarnya, antar barang yang dikenal pulang ke gudang. Permintaan nyata pemilik:
// "buat bot lagi untuk farming rotenflesh di spawner zombie dan disana ada banyak peti barang
// barang jelek nya bisa kamu hancurkan".
const mobFarmWorkers = new Map(); // botName -> handle

app.post('/api/mobfarm/start', (req, res) => {
  const { host, port, botName, scanRadius, spawnerGoal } = req.body || {};
  const name = botName || 'MobFarmWorker';
  if (mobFarmWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Pemburu spawner '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MOBFARM_WORKER', step: `Memulai pemburu spawner '${name}'...`, status: 'RUNNING' } });

  const handle = startMobFarmWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: name,
    scanRadius: scanRadius || 16,
    spawnerGoal: spawnerGoal || undefined,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MOBFARM_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    onDisconnect: () => {
      mobFarmWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MOBFARM_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    }
  });
  mobFarmWorkers.set(name, handle);

  res.json({ success: true, data: { message: `Pemburu spawner '${name}' dimulai` } });
});

app.post('/api/mobfarm/stop', (req, res) => {
  const { botName } = req.body || {};
  if (!botName) {
    const count = mobFarmWorkers.size;
    if (count === 0) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada pemburu spawner yang berjalan' } });
    }
    for (const [name, handle] of mobFarmWorkers) {
      handle.stop();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MOBFARM_WORKER', step: `[${name}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
    }
    mobFarmWorkers.clear();
    return res.json({ success: true, data: { message: `${count} pemburu spawner dihentikan` } });
  }
  const handle = mobFarmWorkers.get(botName);
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `Pemburu spawner '${botName}' tidak ditemukan` } });
  }
  handle.stop();
  mobFarmWorkers.delete(botName);
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MOBFARM_WORKER', step: `[${botName}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
  res.json({ success: true, data: { message: `Pemburu spawner '${botName}' dihentikan` } });
});

app.get('/api/mobfarm/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: mobFarmWorkers.size > 0,
      count: mobFarmWorkers.size,
      workers: Array.from(mobFarmWorkers.entries()).map(([name, handle]) => ({
        botName: name,
        status: typeof handle.getStatus === 'function' ? handle.getStatus() : null,
        metrics: handle.getMetrics()
      }))
    }
  });
});

// Pekerja peternakan otonom (lihat runRancherWorker.js) - beri makan ternak, dipisah dari pekerja
// tani atas permintaan pemilik. Sama pola armada seperti farmerWorkers/guardWorkers di atas.
const rancherWorkers = new Map(); // botName -> handle

app.post('/api/rancher/start', (req, res) => {
  const { host, port, botName, scanRadius } = req.body || {};
  const name = botName || 'RancherWorker';
  if (rancherWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Peternak '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'RANCHER_WORKER', step: `Memulai peternak '${name}'...`, status: 'RUNNING' } });

  const handle = startRancherWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: name,
    scanRadius: scanRadius || 24,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'RANCHER_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    onDisconnect: () => {
      rancherWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'RANCHER_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    }
  });
  rancherWorkers.set(name, handle);

  res.json({ success: true, data: { message: `Peternak '${name}' dimulai` } });
});

app.post('/api/rancher/stop', (req, res) => {
  const { botName } = req.body || {};
  if (!botName) {
    const count = rancherWorkers.size;
    if (count === 0) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada peternak yang berjalan' } });
    }
    for (const [name, handle] of rancherWorkers) {
      handle.stop();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'RANCHER_WORKER', step: `[${name}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
    }
    rancherWorkers.clear();
    return res.json({ success: true, data: { message: `${count} peternak dihentikan` } });
  }
  const handle = rancherWorkers.get(botName);
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `Peternak '${botName}' tidak ditemukan` } });
  }
  handle.stop();
  rancherWorkers.delete(botName);
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'RANCHER_WORKER', step: `[${botName}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
  res.json({ success: true, data: { message: `Peternak '${botName}' dihentikan` } });
});

app.get('/api/rancher/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: rancherWorkers.size > 0,
      count: rancherWorkers.size,
      workers: Array.from(rancherWorkers.entries()).map(([name, handle]) => ({
        botName: name,
        status: typeof handle.getStatus === 'function' ? handle.getStatus() : null,
        metrics: handle.getMetrics()
      }))
    }
  });
});

// Pekerja gudang otonom (lihat runStorageWorker.js) - kumpulkan chest di luar rumah, antar ke
// gudang, rapikan dengan memeriksa tiap chest di dalamnya. Sama pola armada seperti worker lain.
const storageWorkers = new Map(); // botName -> handle

app.post('/api/storage/start', (req, res) => {
  const { host, port, botName, scanRadius } = req.body || {};
  const name = botName || 'StorageWorker';
  const workerHost = host || process.env.MC_REMOTE_HOST || 'atoms-girl.tun.ply.gg';
  const workerPort = port || Number(process.env.MC_REMOTE_PORT) || 25565;
  const storageContext = {
    world: resolveRequestWorld({ host: workerHost, port: workerPort }),
    dimension: process.env.MC_DIMENSION_ID || 'overworld'
  };
  if (storageWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Kuartermaster '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `Memulai kuartermaster '${name}'...`, status: 'RUNNING' } });

  const handle = startStorageWorker({
    host: workerHost,
    port: workerPort,
    botName: name,
    scanRadius: scanRadius || 48,
    storageRepository,
    storageContext,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    onDisconnect: () => {
      storageWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    },
    onMisplaced: (entry) => {
      broadcast({ type: 'STORAGE_COMPLIANCE_UPDATE', data: { events: storageRepository.listCompliance(storageContext) } });
    },
    onChestSnapshot: (snapshot) => {
      broadcast({ type: 'STORAGE_CHEST_MAP_UPDATE', data: { chests: storageRepository.listChestSnapshots(storageContext) } });
      // Log EKSPLISIT (bukan cuma data WS diam-diam) - permintaan nyata pemilik: "u should see
      // under 5 second memory update logs" - supaya pembaruan peta gudang di memori/dashboard
      // punya bukti waktu yang terlihat langsung di feed yang sama, sama seperti probe verifikasi.
      const p = snapshot.position;
      const elapsedMs = Date.now() - snapshot.timestamp;
      broadcast({
        type: 'AI_ACTION_EVENT',
        data: {
          task: 'STORAGE_WORKER',
          step: `[Memori Gudang] Peta chest (${p.x},${p.y},${p.z}) diperbarui - ${snapshot.items.length} item, ${snapshot.misplaced.length} salah tempat (${elapsedMs}ms sejak data dibaca)`,
          status: 'RUNNING'
        }
      });
    },
    // Dorong memori sortir lewat WS begitu berubah (item baru belajar rumahnya lewat delivery) -
    // permintaan nyata pemilik: "use ws to update memory ui to memory is dynamic not just in
    // every restart" - panel "Memori Sortir Worker" jadi genuinely live, bukan cuma nebeng
    // refresh event lain atau baru ter-update pas restart.
    onAssignmentsChanged: (assignments) => {
      broadcast({ type: 'STORAGE_ASSIGNMENTS_UPDATE', data: { assignments } });
    }
  });
  storageWorkers.set(name, handle);

  res.json({ success: true, data: { message: `Kuartermaster '${name}' dimulai` } });
});

// Nama kategori manusiawi per posisi chest (statis, tidak berubah selama proses berjalan) -
// permintaan nyata pemilik: "di ui tampilan peti nya rapikan urut baris dan kolom nya dan
// berikan nama kategorinya" - dashboard butuh peta ini untuk melabeli tiap kartu chest.
app.get('/api/storage/categories', (req, res) => {
  res.json({ success: true, data: { categories: CHEST_CATEGORY_LABELS } });
});

app.get('/api/storage/compliance', (req, res) => {
  const context = {
    world: String(req.query.world || defaultStorageContext().world),
    dimension: String(req.query.dimension || defaultStorageContext().dimension)
  };
  res.json({ success: true, data: { events: storageRepository.listCompliance(context) } });
});

app.get('/api/storage/chests', (req, res) => {
  const context = {
    world: String(req.query.world || defaultStorageContext().world),
    dimension: String(req.query.dimension || defaultStorageContext().dimension)
  };
  res.json({ success: true, data: { chests: storageRepository.listChestSnapshots(context) } });
});

// Memori sortir persisten tetap tersedia walaupun worker sedang mati atau dashboard baru restart.
app.get('/api/storage/assignments', (req, res) => {
  const context = {
    world: String(req.query.world || defaultStorageContext().world),
    dimension: String(req.query.dimension || defaultStorageContext().dimension)
  };
  res.json({ success: true, data: { assignments: storageRepository.getAssignments(context) } });
});

app.post('/api/storage/stop', (req, res) => {
  const { botName } = req.body || {};
  if (!botName) {
    const count = storageWorkers.size;
    if (count === 0) {
      return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada kuartermaster yang berjalan' } });
    }
    for (const [name, handle] of storageWorkers) {
      handle.stop();
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `[${name}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
    }
    storageWorkers.clear();
    return res.json({ success: true, data: { message: `${count} kuartermaster dihentikan` } });
  }
  const handle = storageWorkers.get(botName);
  if (!handle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: `Kuartermaster '${botName}' tidak ditemukan` } });
  }
  handle.stop();
  storageWorkers.delete(botName);
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `[${botName}] Dihentikan dari dashboard.`, status: 'STOPPED' } });
  res.json({ success: true, data: { message: `Kuartermaster '${botName}' dihentikan` } });
});

app.get('/api/storage/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: storageWorkers.size > 0,
      count: storageWorkers.size,
      workers: Array.from(storageWorkers.entries()).map(([name, handle]) => ({
        botName: name,
        status: typeof handle.getStatus === 'function' ? handle.getStatus() : null,
        metrics: handle.getMetrics()
      }))
    }
  });
});

app.post('/api/mining/start', async (req, res) => {
  try {
    const options = { ...(req.body || {}) };
    const host = options.host || process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg';
    const port = Number(options.port) || Number(process.env.STORAGE_ROOM_SERVER_PORT) || 25565;
    options.world = resolveRequestWorld({ ...options, host, port });
    if (options.preflight !== false) {
      const serverStatus = await querySLP({ host, port, timeoutMs: 8000, protocolVersion: 775 });
      if (Number(serverStatus.version?.protocol) !== 775) {
        return res.status(502).json({ success: false, error: { code: 'MINING_SERVER_PROTOCOL_MISMATCH', message: `Protokol server ${serverStatus.version?.protocol ?? 'tidak diketahui'}, membutuhkan 775.` } });
      }
    }
    const result = miningFleetCoordinator.start({ ...options, host, port });
    if (!result.started) return res.status(409).json({ success: false, error: { code: result.reason, message: 'Armada tambang sudah berjalan', status: result.status } });
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MINING_FLEET', step: `${result.status.config.count} worker tambang dimulai pada area awal empat sudut yang dipilih.`, status: 'RUNNING' } });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, error: { code: 'MINING_START_FAILED', message: error.message } });
  }
});

app.post('/api/mining/stop', (req, res) => {
  const result = miningFleetCoordinator.stop();
  if (!result.stopped) return res.status(409).json({ success: false, error: { code: result.reason, message: 'Armada tambang tidak sedang berjalan', status: result.status } });
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'MINING_FLEET', step: 'Armada tambang dihentikan; checkpoint setiap worker dipertahankan.', status: 'STOPPED' } });
  return res.json({ success: true, data: result });
});

app.get('/api/mining/status', (req, res) => {
  res.json({ success: true, data: miningFleetCoordinator.getStatus() });
});

// Lifecycle pembangunan memiliki builder, landscaper, dan pemasang peti yang menunggu lantai.
// Miner serta pemroses material tetap dikelola fleet/goal mandiri agar kegagalannya tidak
// menahan konstruksi.
app.post('/api/storage/construction/start', async (req, res) => {
  try {
    const options = { ...(req.body || {}) };
    options.host = options.host || process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg';
    options.port = Number(options.port) || Number(process.env.STORAGE_ROOM_SERVER_PORT) || 25565;
    options.world = resolveRequestWorld(options);
    // Beri server waktu menerima login landscaper sebelum builder ikut masuk.
    if (options.roleStartStaggerMs === undefined) options.roleStartStaggerMs = 6000;
    // Socket TCP yang terbuka belum membuktikan backend Minecraft hidup. SLP harus
    // berhasil lebih dulu agar satu klik dashboard tidak men-spawn seluruh armada ke
    // tunnel yang hanya menerima koneksi lalu reset/timeout saat handshake.
    if (options.preflight !== false) {
      const host = options.host || process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg';
      const port = Number(options.port) || Number(process.env.STORAGE_ROOM_SERVER_PORT) || 25565;
      const timeoutMs = Math.min(15000, Math.max(2000, Number(options.preflightTimeoutMs) || 8000));
      try {
        const serverStatus = await querySLP({ host, port, timeoutMs, protocolVersion: 775 });
        if (Number(serverStatus.version?.protocol) !== 775) {
          return res.status(502).json({
            success: false,
            error: {
              code: 'CONSTRUCTION_SERVER_PROTOCOL_MISMATCH',
              message: `Server merespons, tetapi protokol Minecraft bukan 775 (diterima ${serverStatus.version?.protocol ?? 'tidak diketahui'}).`
            }
          });
        }
        options.serverPreflight = {
          protocol: serverStatus.version.protocol,
          latencyMs: serverStatus.latencyMs,
          playersOnline: serverStatus.players?.online ?? null,
          playersMax: serverStatus.players?.max ?? null
        };
      } catch (error) {
        const queued = storageRoomConstructionCoordinator.startWhenReady(options, {
          intervalMs: Number(options.preflightRetryMs) || 30000,
          initialDelayMs: Number(options.preflightRetryDelayMs) || 30000,
          probe: ({ host: probeHost, port: probePort }) => querySLP({ host: probeHost, port: probePort, timeoutMs, protocolVersion: 775 })
        });
        if (!queued.started) return res.status(409).json({ success: false, error: { code: queued.reason, message: 'Orkestrator pembangunan sudah berjalan', status: queued.status } });
        return res.status(202).json({ success: true, data: queued, message: `Server belum siap (${error.message}); pembangunan menunggu SLP sehat.` });
      }
    }
    const result = storageRoomConstructionCoordinator.start(options);
    if (!result.started) return res.status(409).json({ success: false, error: { code: result.reason, message: 'Orkestrator pembangunan sudah berjalan', status: result.status } });
    broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_CONSTRUCTION', step: 'Pembangunan storage room dimulai: landscaper dan builder aktif; pemasang peti menunggu lantai terverifikasi.', status: 'RUNNING' } });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, error: { code: 'CONSTRUCTION_START_FAILED', message: error.message } });
  }
});

app.post('/api/storage/construction/stop', (req, res) => {
  const result = storageRoomConstructionCoordinator.stop();
  if (!result.stopped) return res.status(409).json({ success: false, error: { code: result.reason, message: 'Orkestrator pembangunan tidak sedang berjalan', status: result.status } });
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_CONSTRUCTION', step: 'Orkestrator storage room dihentikan; checkpoint dipertahankan.', status: 'STOPPED' } });
  return res.json({ success: true, data: result });
});

app.post('/api/storage/materials/start', (req, res) => {
  try {
    const options = { ...(req.body || {}) };
    options.host = options.host || process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg';
    options.port = Number(options.port) || Number(process.env.STORAGE_ROOM_SERVER_PORT) || 25565;
    options.world = resolveRequestWorld(options);
    const result = storageMaterialsCoordinator.start(options);
    if (!result.started) return res.status(409).json({ success: false, error: { code: result.reason, message: 'Worker materials sudah berjalan', status: result.status } });
    broadcast({ type: 'STORAGE_MATERIALS_UPDATE', data: result.status });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({ success: false, error: { code: 'MATERIALS_START_FAILED', message: error.message } });
  }
});

app.post('/api/storage/materials/stop', (req, res) => {
  const result = storageMaterialsCoordinator.stop();
  if (!result.stopped) return res.status(409).json({ success: false, error: { code: result.reason, message: 'Worker materials tidak sedang berjalan', status: result.status } });
  broadcast({ type: 'STORAGE_MATERIALS_UPDATE', data: result.status });
  return res.json({ success: true, data: result });
});

app.get('/api/storage/materials/status', (req, res) => {
  res.json({ success: true, data: storageMaterialsCoordinator.getStatus() });
});

app.get('/api/storage/construction/status', (req, res) => {
  res.json({ success: true, data: storageRoomConstructionCoordinator.getStatus() });
});

// WebSocket handler
wss.on('connection', (ws) => {
  console.log('[WebSocket] Klien baru terhubung');
  ws.send(JSON.stringify({ type: 'CONNECTED', data: {
    botStatus: getPrimaryBotStatus(),
    benchmarks: benchmarkResults,
    storageConstruction: storageRoomConstructionCoordinator.getStatus(),
    miningFleet: miningFleetCoordinator.getStatus(),
    storageMaterials: storageMaterialsCoordinator.getStatus()
  } }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.action === 'START_BENCHMARK') {
        // Ditangani via REST API
      } else if (msg.action === 'SUBMIT_AI_COMMAND') {
        const liveStatus = getPrimaryBotStatus();
        aiClient.chat(msg.prompt || '', { position: liveStatus.position, health: liveStatus.health }).then(resp => {
          ws.send(JSON.stringify({ type: 'AI_ACTION_EVENT', data: resp }));
        });
      }
    } catch (e) {}
  });

  ws.on('close', () => console.log('[WebSocket] Klien terputus'));
});

// Simulasi tick telemetri untuk demo
setInterval(() => {
  broadcast({ type: 'TICK_UPDATE', data: { ...getPrimaryBotStatus(), tick: Date.now(), timestamp: new Date().toISOString() } });
}, 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\nKonsol Operasi — Companion Minecraft`);
  console.log(`   Server HTTP  : http://localhost:${PORT}`);
  console.log(`   WebSocket    : ws://localhost:${PORT}`);
  console.log(`   Status       : Aktif & Siap\n`);
});

// Worker Mineflayer adalah child/handle di luar lifecycle HTTP. Saat dashboard
// direstart, hentikan semua role lebih dulu agar tidak ada bot lama yang tetap
// membangun bersamaan dengan proses baru.
let shuttingDown = false;
const shutdown = signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Shutdown] ${signal}: menghentikan worker aktif sebelum server ditutup...`);
  for (const workerMap of [farmerWorkers, guardWorkers, rancherWorkers, storageWorkers, explorerWorkers, mobFarmWorkers, woodGathererWorkers]) {
    for (const handle of workerMap.values()) {
      try { handle.stop?.(); } catch (error) { console.error(`[Shutdown] worker: ${error.message}`); }
    }
    workerMap.clear();
  }
  try { storageRoomConstructionCoordinator.stop(); } catch (error) { console.error(`[Shutdown] construction: ${error.message}`); }
  try { miningFleetCoordinator.stop(); } catch (error) { console.error(`[Shutdown] mining: ${error.message}`); }
  try { storageMaterialsCoordinator.stop(); } catch (error) { console.error(`[Shutdown] materials: ${error.message}`); }
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, wss, broadcast, globalSwarmOrchestrator };
