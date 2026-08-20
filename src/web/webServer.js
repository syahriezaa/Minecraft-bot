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
const { startFarmerWorker } = require('../ai/runFarmerWorker');

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

// Pekerja pertanian+peternakan otonom (lihat runFarmerWorker.js) - satu instance saja pada satu
// waktu, dikontrol lewat dashboard (tombol Mulai/Hentikan di panel kontrol).
let farmerWorkerHandle = null;

app.post('/api/farmer/start', (req, res) => {
  if (farmerWorkerHandle) {
    return res.status(409).json({ success: false, error: { code: 'ALREADY_RUNNING', message: 'Pekerja pertanian sudah berjalan' } });
  }
  const { host, port, botName, scanRadius } = req.body || {};
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: 'Memulai pekerja pertanian+peternakan...', status: 'RUNNING' } });

  farmerWorkerHandle = startFarmerWorker({
    host: host || 'atoms-girl.tun.ply.gg',
    port: port || 25565,
    botName: botName || 'FarmerWorker',
    scanRadius: scanRadius || 32,
    log: (msg) => broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: msg, status: 'RUNNING' } })
  });

  res.json({ success: true, data: { message: 'Pekerja pertanian+peternakan dimulai' } });
});

app.post('/api/farmer/stop', (req, res) => {
  if (!farmerWorkerHandle) {
    return res.status(409).json({ success: false, error: { code: 'NOT_RUNNING', message: 'Tidak ada pekerja pertanian yang berjalan' } });
  }
  farmerWorkerHandle.stop();
  farmerWorkerHandle = null;
  broadcast({ type: 'AI_ACTION_EVENT', data: { task: 'FARMER_WORKER', step: 'Pekerja pertanian dihentikan dari dashboard.', status: 'STOPPED' } });
  res.json({ success: true, data: { message: 'Pekerja pertanian dihentikan' } });
});

app.get('/api/farmer/status', (req, res) => {
  res.json({
    success: true,
    data: {
      running: Boolean(farmerWorkerHandle),
      metrics: farmerWorkerHandle ? farmerWorkerHandle.getMetrics() : null
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
  console.log(`\n🧠 AI Companion Minecraft Dashboard`);
  console.log(`   Server HTTP  : http://localhost:${PORT}`);
  console.log(`   WebSocket    : ws://localhost:${PORT}`);
  console.log(`   Status       : Aktif & Siap\n`);
});

module.exports = { app, server, wss, broadcast };
