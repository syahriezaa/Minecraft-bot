/**
 * @file singleLiveBot.js
 * @description Peluncur bot tunggal persisten Scout_Alpha tanpa konflik sesi.
 */

const { LiveProtocolClient } = require('./liveProtocolClient');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
const BOT_NAME = 'Scout_Alpha';

console.log('======================================================================');
console.log(`  🚀 MEMULAI BOT TUNGGAL PERSISTEN: ${BOT_NAME}                     `);
console.log('======================================================================\n');

const client = new LiveProtocolClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_NAME,
  protocolVersion: 775,
  autoReconnect: true,
  maxReconnectAttempts: 999,
  reconnectBaseDelayMs: 3000
});

client.on('joined', (d) => {
  console.log(`🎉 [${BOT_NAME}] BERHASIL MASUK KE SERVER! (Entity ID: ${d.entityId})`);
});

client.on('teleport', (pos) => {
  console.log(`📍 [${BOT_NAME}] SPAWN POS: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
});

client.on('health', (h) => {
  console.log(`❤️ [${BOT_NAME}] HP: ${h.health.toFixed(1)}/20 | Food: ${h.food}/20`);
});

client.on('kicked', (r) => {
  console.warn(`⚠️ [${BOT_NAME}] Kicked:`, r);
});

client.on('error', (err) => {
  console.error(`❌ [${BOT_NAME}] Error:`, err.message);
});

client.connect().then(() => {
  console.log(`🟢 [${BOT_NAME}] KONEKSI TUNGGAL STABIL DAN PERSISTEN AKTIF!`);
}).catch(e => {
  console.error(`❌ Gagal koneksi:`, e.message);
});
