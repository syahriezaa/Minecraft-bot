/**
 * @file persistentLiveSwarm.js
 * @description Daemon armada 5 bot persisten mandiri untuk Minecraft NeoForge 26.1.2.
 */

const { LiveProtocolClient } = require('./liveProtocolClient');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;

const BOT_NAMES = [
  'Scout_Alpha_01',
  'Scout_Bravo_02',
  'Scout_Charlie_03',
  'Scout_Delta_04',
  'Scout_Echo_05'
];

const activeClients = [];

async function startPersistentSwarm() {
  console.log(`======================================================================`);
  console.log(`  🚀 MEMULAI ARMADA 5 BOT PERSISTEN KE LIVE SERVER: ${SERVER_HOST}:${SERVER_PORT}`);
  console.log(`======================================================================\n`);

  for (let i = 0; i < BOT_NAMES.length; i++) {
    const name = BOT_NAMES[i];
    
    // Jeda 2 detik antar bot untuk mencegah rate limit login
    if (i > 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const client = new LiveProtocolClient({
      host: SERVER_HOST,
      port: SERVER_PORT,
      username: name,
      protocolVersion: 775,
      autoReconnect: true,
      maxReconnectAttempts: 999,
      reconnectBaseDelayMs: 3000
    });

    client.on('joined', (d) => {
      console.log(`[${name}] 🟢 BERHASIL MASUK & AKTIF DI SERVER! Entity ID: ${d.entityId}`);
    });

    client.on('teleport', (pos) => {
      console.log(`[${name}] 📍 SPAWN: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
    });

    client.on('health', (h) => {
      console.log(`[${name}] ❤️ HP: ${h.health.toFixed(1)}/20 | Food: ${h.food}/20`);
    });

    client.on('kicked', (r) => {
      console.warn(`[${name}] ⚠️ Kicked:`, r);
    });

    client.on('error', (err) => {
      console.error(`[${name}] ❌ Error:`, err.message);
    });

    try {
      await client.connect();
      activeClients.push(client);
    } catch (e) {
      console.error(`[${name}] ❌ Gagal koneksi awal:`, e.message);
    }
  }

  console.log(`\n🎉 SELURUH ARMADA (${activeClients.length} BOT) SEKARANG ONLINE & PERSISTEN DI SERVER!`);
  console.log(`👀 Server sekarang akan menampilkan 5/20 pemain online.`);
}

startPersistentSwarm().catch(err => {
  console.error('❌ Kesalahan fatal pada swarm:', err);
});
