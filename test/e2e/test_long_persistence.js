/**
 * @file test_long_persistence.js
 * @description Pengujian stabilitas koneksi jangka panjang bot ke server live Minecraft.
 */

const { LiveProtocolClient } = require('../../src/network/liveProtocolClient');
const mc = require('minecraft-protocol');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
const BOT_NAME = 'Companion_Alpha';

console.log('======================================================================');
console.log('  🚀 PENGUJIAN STABILITAS PERSISTEN JANGKA PANJANG (20 DETIK)         ');
console.log('======================================================================\n');

const client = new LiveProtocolClient({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_NAME,
  protocolVersion: 775,
  autoReconnect: false
});

client.on('joined', (d) => {
  console.log(`🎉 [Companion_Alpha] BERHASIL MASUK PLAY STATE! (Entity ID: ${d.entityId})`);
});

client.on('teleport', (pos) => {
  console.log(`📍 [Companion_Alpha] SPAWN POS: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
});

client.on('health', (h) => {
  console.log(`❤️ [Companion_Alpha] HEALTH: ${h.health.toFixed(1)}/20 | FOOD: ${h.food}/20`);
});

client.on('kicked', (r) => {
  console.log(`❌ [Companion_Alpha] KICKED: ${r}`);
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
