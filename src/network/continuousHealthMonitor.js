/**
 * @file continuousHealthMonitor.js
 * @description Monitor berkala berkelanjutan untuk koneksi live bot ke server Minecraft.
 */

const { LiveProtocolClient } = require('./liveProtocolClient');
const mc = require('minecraft-protocol');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
const BOT_NAME = 'Companion_Alpha';

let isRunning = true;
let client = null;
let lastPingResult = null;
let connectionCount = 0;
let disconnectCount = 0;

function logStatus(msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] ${msg}`);
}

async function createAndRunBot() {
  client = new LiveProtocolClient({
    host: SERVER_HOST,
    port: SERVER_PORT,
    username: BOT_NAME,
    protocolVersion: 775,
    autoReconnect: true,
    maxReconnectAttempts: 999,
    reconnectBaseDelayMs: 1500
  });

  client.on('joined', (data) => {
    connectionCount++;
    logStatus(`🟢 [Play] Bot BERHASIL MASUK ke Play State! (Entity ID: ${data.entityId}, Total Sesi: ${connectionCount})`);
  });

  client.on('teleport', (pos) => {
    logStatus(`📍 [Posisi] Spawn disinkronkan: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
  });

  client.on('health', (h) => {
    logStatus(`❤️ [Health] Darah: ${h.health.toFixed(1)}/20 | Makanan: ${h.food}/20`);
  });

  client.on('kicked', (reason) => {
    disconnectCount++;
    logStatus(`⚠️ [Kicked] Terputus dari server (Alasan: "${reason}", Total Disconnect: ${disconnectCount})`);
  });

  client.on('error', (err) => {
    logStatus(`❌ [Error] ${err.message}`);
  });

  try {
    await client.connect();
  } catch (err) {
    logStatus(`❌ [Koneksi Awal Gagal] ${err.message}`);
  }
}

// Polling SLP Ping berkala setiap 3 detik
setInterval(() => {
  if (!isRunning) return;
  mc.ping({ host: SERVER_HOST, port: SERVER_PORT, timeout: 3000 }, (err, res) => {
    if (err) {
      logStatus(`🌐 [SLP Ping Gagal] Server tidak merespon: ${err.message}`);
      return;
    }
    const sample = res.players?.sample ? res.players.sample.map(p => p.name).join(', ') : 'Tidak ada sample';
    const isBotInSample = sample.includes(BOT_NAME) || sample.includes('Anonymous');
    lastPingResult = {
      online: res.players?.online || 0,
      max: res.players?.max || 20,
      sample,
      botPresent: isBotInSample
    };
    logStatus(`📊 [Status Server] Pemain Online: ${lastPingResult.online}/${lastPingResult.max} | List: [${sample}] | Bot Aktif: ${isBotInSample ? '✅ YA' : '❌ TIDAK'}`);
  });
}, 3000);

createAndRunBot();
