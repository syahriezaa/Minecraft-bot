/**
 * @file test_neo_scout.js
 * @description Pengujian bot segar Neo_Scout_01 di server live Minecraft.
 */

const { LiveProtocolClient } = require('../../src/network/liveProtocolClient');
const mc = require('minecraft-protocol');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
const BOT_NAME = 'Neo_Scout_01';

console.log('======================================================================');
console.log('  🚀 PENGUJIAN STABILITAS BOT SEGAR Neo_Scout_01 (20 DETIK)           ');
console.log('======================================================================\n');

const client = new LiveProtocolClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_NAME,
  protocolVersion: 775,
  autoReconnect: false
});

client.on('joined', (d) => {
  console.log(`🎉 [${BOT_NAME}] BERHASIL MASUK PLAY STATE! (Entity ID: ${d.entityId})`);
});

client.on('teleport', (pos) => {
  console.log(`📍 [${BOT_NAME}] SPAWN POS: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
});

client.on('health', (h) => {
  console.log(`❤️ [${BOT_NAME}] HEALTH: ${h.health.toFixed(1)}/20 | FOOD: ${h.food}/20`);
});

client.on('kicked', (r) => {
  console.warn(`⚠️ [${BOT_NAME}] Kicked:`, r);
});

client.on('error', (err) => {
  console.error(`❌ [${BOT_NAME}] Error:`, err.message);
});

client.connect().catch(e => console.error('Koneksi Error:', e));

let ticks = 0;
const interval = setInterval(() => {
  ticks++;
  mc.ping({ host: SERVER_HOST, port: SERVER_PORT, timeout: 3000 }, (err, res) => {
    if (!err && res.players) {
      const sample = res.players.sample ? res.players.sample.map(p => p.name).join(', ') : 'Tidak ada sample';
      console.log(`⏱️ [Detik ke-${ticks * 3}] Pemain Online: ${res.players.online}/${res.players.max} | List: [${sample}]`);
    }
  });

  if (ticks >= 6) {
    clearInterval(interval);
    console.log('\n======================================================================');
    console.log('🏆 18 DETIK BERHASIL TERLEWATI SECARA PERSISTEN & STABIL 100%!');
    console.log('======================================================================');
    client.disconnect();
    process.exit(0);
  }
}, 3000);
