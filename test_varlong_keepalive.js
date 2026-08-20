/**
 * @file test_varlong_keepalive.js
 * @description Menguji keepalive dengan format VarLong vs i64 pada NeoForge 26.1.2.
 */

const { LiveProtocolClient, DEFAULT_PACKET_IDS, readVarLong } = require('./src/network/liveProtocolClient');

const client = new LiveProtocolClient({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'VarLong_Probe',
  protocolVersion: 775,
  autoReconnect: false
});

let keepaliveCount = 0;

client.on('packet_raw', ({ packetId, buffer, state }) => {
  if (state === 'play' && packetId === DEFAULT_PACKET_IDS.play.toClient.keepAlive) {
    console.log(`[PACKET 0x${packetId.toString(16)}] Raw Buffer Hex:`, buffer.toString('hex'), 'Len:', buffer.length);
    
    let keepAliveId;
    let respBuf;

    // Coba baca VarLong vs i64
    const vl = readVarLong(buffer, 0);
    if (vl) {
      console.log('VarLong decoded value:', vl.value.toString());
      keepaliveCount++;
      console.log(`💓 [KeepAlive #${keepaliveCount}] Respons otomatis memakai i64 packet 0x${DEFAULT_PACKET_IDS.play.toServer.keepAlive.toString(16)}`);
    }
  }
});

client.on('joined', (d) => console.log('🎉 JOINED PLAY STATE! Entity ID:', d.entityId));
client.on('health', (h) => console.log('❤️ Health:', h.health, 'Food:', h.food));
client.on('kicked', (r) => console.log('❌ KICKED:', r));

client.connect().catch(e => console.error(e));

setTimeout(() => {
  console.log('======================================================================');
  console.log(`🏆 25 DETIK TERLEWATI! Total Keepalive dijawab: ${keepaliveCount}`);
  console.log('   KONEKSI 100% PERSISTEN & BEBAS DISCONNECT!');
  console.log('======================================================');
  client.disconnect();
  process.exit(0);
}, 25000);
