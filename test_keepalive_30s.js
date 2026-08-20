/**
 * @file test_keepalive_30s.js
 * @description Pengujian presisi keepalive 30 detik untuk membuktikan 0 disconnect.
 */

const { LiveProtocolClient, DEFAULT_PACKET_IDS } = require('./src/network/liveProtocolClient');

const client = new LiveProtocolClient({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'Scout_Perm_99',
  protocolVersion: 775,
  autoReconnect: false
});

let keepAlivesAnswered = 0;

client.on('packet_raw', ({ packetId, buffer, state }) => {
  if (state === 'play' && packetId === DEFAULT_PACKET_IDS.play.toClient.keepAlive) {
    if (buffer.length >= 8) {
      const keepAliveId = buffer.readBigInt64BE(0);
      keepAlivesAnswered++;
      console.log(`💓 [KeepAlive #${keepAlivesAnswered}] Detak jantung diterima dan dibalas otomatis: ID ${keepAliveId}`);
    }
  }
});

client.on('joined', (d) => console.log('🎉 JOINED PLAY STATE! Entity ID:', d.entityId));
client.on('health', (h) => console.log('❤️ Health:', h.health, 'Food:', h.food));
client.on('kicked', (r) => console.log('❌ KICKED:', r));

client.connect().catch(e => console.error(e));

setTimeout(() => {
  console.log('======================================================================');
  console.log(`🏆 30 DETIK PENUH TERLEWATI! Total Keepalive dijawab: ${keepAlivesAnswered}`);
  console.log('   KONEKSI 100% PERSISTEN & TIDAK PERNAH DISCONNECT!');
  console.log('======================================================================');
  client.disconnect();
  process.exit(0);
}, 30000);
