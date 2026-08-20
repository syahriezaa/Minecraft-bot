/**
 * @file spawnLiveCompanion.js
 * @description Bot persisten tunggal Companion_Alpha yang hidup stabil di samping pemain greenhouse.
 */

const { LiveProtocolClient } = require('./liveProtocolClient');

const client = new LiveProtocolClient({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'Companion_Alpha',
  protocolVersion: 775,
  autoReconnect: true,
  maxReconnectAttempts: 999,
  reconnectBaseDelayMs: 2000
});

client.on('joined', (d) => {
  console.log(`🎉 [Companion_Alpha] BERHASIL MASUK PLAY STATE! (Entity ID: ${d.entityId})`);
});

client.on('teleport', (pos) => {
  console.log(`📍 [Companion_Alpha] SPAWN POS: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
});

client.on('health', (h) => {
  console.log(`❤️ [Companion_Alpha] KESEHATAN: HP=${h.health.toFixed(1)}/20, FOOD=${h.food}/20`);
});

client.on('kicked', (r) => {
  console.warn(`⚠️ [Companion_Alpha] Kicked:`, r);
});

client.on('error', (err) => {
  console.error(`❌ [Companion_Alpha] Error:`, err.message);
});

client.connect().then(() => {
  console.log('🟢 [Companion_Alpha] KONEKSI AKTIF DAN PERSISTEN DI SERVER!');
}).catch(e => {
  console.error('❌ Gagal koneksi:', e.message);
});
