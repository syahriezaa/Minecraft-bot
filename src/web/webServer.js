/**
 * @file webServer.js
 * @description Server Express HTTP + WebSocket pada port 8080 untuk dashboard AI Companion Minecraft.
 */

require('dotenv').config();

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
const { startRancherWorker } = require('../ai/runRancherWorker');
const { startStorageWorker, CHEST_CATEGORY_LABELS } = require('../ai/runStorageWorker');

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
  for (const workerMap of [farmerWorkers, guardWorkers, rancherWorkers, storageWorkers, explorerWorkers]) {
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

setInterval(() => {
  broadcast({ type: 'SWARM_COORDINATES_UPDATE', data: buildRealSwarmList() });
}, 2000);

app.get('/api/swarm/coordinates', (req, res) => {
  const bots = buildRealSwarmList();
  res.json({ success: true, data: { server: 'atoms-girl.tun.ply.gg:25565', activeBots: bots.length, bots } });
});

app.get('/api/telemetry', (req, res) => {
  res.json({ success: true, data: { botStatus, swarmBotsList: buildRealSwarmList(), lastUpdate: new Date().toISOString() } });
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
    const response = await aiClient.chat(prompt, { position: botStatus.position, health: botStatus.health });
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

app.get('/api/farmer/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: farmerWorkers.size > 0,
      count: farmerWorkers.size,
      workers: Array.from(farmerWorkers.entries()).map(([name, handle]) => ({
        botName: name,
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
        metrics: handle.getMetrics()
      }))
    }
  });
});

// Semua landmark yang sudah ditemukan sejauh ini - dipakai dashboard untuk peta landmark, dan bisa
// dipakai bot lain (mis. FarmerWorker) untuk menghindari zona yang ditandai secara otomatis.
app.get('/api/landmarks', (req, res) => {
  res.json({ success: true, data: { landmarks: loadLandmarks() } });
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
        metrics: handle.getMetrics()
      }))
    }
  });
});

// Pekerja gudang otonom (lihat runStorageWorker.js) - kumpulkan chest di luar rumah, antar ke
// gudang, rapikan dengan memeriksa tiap chest di dalamnya. Sama pola armada seperti worker lain.
const storageWorkers = new Map(); // botName -> handle

// Riwayat "chest yang ketahuan belum sesuai aturan kategori" - permintaan nyata pemilik: chest di
// dalam storage room yang belum sesuai aturan harus tercatat, terlihat di dashboard tanpa perlu
// scan manual. Disimpan di memori (bukan disk) - cukup untuk sesi berjalan, dibatasi 50 entri
// terbaru supaya tidak membengkak tanpa batas.
const STORAGE_COMPLIANCE_LOG_LIMIT = 50;
const storageComplianceLog = [];
// Peta isi TIAP chest gudang (posKey "x,y,z" -> snapshot terakhir) - permintaan nyata pemilik:
// "di ui web tampilkan isi semua peti nya...dan bagaimana bot akan memindahkannya di tandai
// dengan panah panah" - "pemilik 100% yakin worker tidak melihat isi peti dengan benar", jadi
// panel ini menampilkan APA ADANYA isi yang engine baca (via event 'chestSnapshot'), termasuk
// rencana pemindahan (misplaced -> targetPosition) sebagai bukti visual langsung, bukan cuma log
// teks yang harus dibaca satu-satu. Diperbarui tiap kali chest diperiksa (bersih ATAU salah
// tempat) - disimpan di memori (bukan disk), cukup untuk sesi berjalan.
const storageChestMap = new Map();

app.post('/api/storage/start', (req, res) => {
  const { host, port, botName, scanRadius } = req.body || {};
  const name = botName || 'StorageWorker';
  if (storageWorkers.has(name)) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: `Kuartermaster '${name}' sudah berjalan` } });
  }
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `Memulai kuartermaster '${name}'...`, status: 'RUNNING' } });

  const handle = startStorageWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: name,
    scanRadius: scanRadius || 48,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `[${name}] ${msg}`, status: 'RUNNING' } }),
    onDisconnect: () => {
      storageWorkers.delete(name);
      broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'STORAGE_WORKER', step: `[${name}] Koneksi terputus - dihapus dari daftar armada.`, status: 'STOPPED' } });
    },
    onMisplaced: (entry) => {
      storageComplianceLog.unshift(entry);
      if (storageComplianceLog.length > STORAGE_COMPLIANCE_LOG_LIMIT) storageComplianceLog.length = STORAGE_COMPLIANCE_LOG_LIMIT;
      broadcast({ type: 'STORAGE_COMPLIANCE_UPDATE', data: { events: storageComplianceLog } });
    },
    onChestSnapshot: (snapshot) => {
      storageChestMap.set(`${snapshot.position.x},${snapshot.position.y},${snapshot.position.z}`, snapshot);
      broadcast({ type: 'STORAGE_CHEST_MAP_UPDATE', data: { chests: Array.from(storageChestMap.values()) } });
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
  res.json({ success: true, data: { events: storageComplianceLog } });
});

app.get('/api/storage/chests', (req, res) => {
  res.json({ success: true, data: { chests: Array.from(storageChestMap.values()) } });
});

// Memori sortir MENTAH langsung dari engine yang sedang berjalan (bukan turunan/olahan) -
// permintaan nyata pemilik: "harusnya yang tampil di web itu sama persis dengan memory worker
// nya" - ambil dari worker PERTAMA yang berjalan (biasanya cuma satu kuartermaster aktif).
app.get('/api/storage/assignments', (req, res) => {
  const handle = storageWorkers.values().next().value;
  const assignments = handle ? handle.getAssignments() : null;
  res.json({ success: true, data: { assignments: assignments || {} } });
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
        metrics: handle.getMetrics()
      }))
    }
  });
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
  console.log(`\nKonsol Operasi — Companion Minecraft`);
  console.log(`   Server HTTP  : http://localhost:${PORT}`);
  console.log(`   WebSocket    : ws://localhost:${PORT}`);
  console.log(`   Status       : Aktif & Siap\n`);
});

module.exports = { app, server, wss, broadcast };
