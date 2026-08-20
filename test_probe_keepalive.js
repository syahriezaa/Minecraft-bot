/**
 * @file test_probe_keepalive.js
 * @description Mendiagnosis packet ID keepalive toServer yang tepat pada NeoForge 26.1.2 / Protocol 775.
 */

const { LiveProtocolClient } = require('./src/network/liveProtocolClient');

const client = new LiveProtocolClient({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'Keepalive_Probe',
  protocolVersion: 775,
  autoReconnect: false
});

client.on('packet_raw', ({ packetId, buffer, state }) => {
  if (state === 'play') {
    console.log(`[INBOUND PLAY] ID: 0x${packetId.toString(16).padStart(2, '0')} Len: ${buffer.length}`);
    if (packetId === 0x1d || packetId === 0x20) {
      console.log('DISCONNECT RAW:', buffer.toString('utf8').replace(/[^a-zA-Z0-9_{}:.,\" \/-]/g, ' '));
    }
  }
});

client.on('joined', (d) => {
  console.log('🎉 JOINED PLAY STATE SUCCESS! Entity ID:', d.entityId);
});

client.connect().catch(e => console.error(e));

setTimeout(() => {
  console.log('⏱️ 15 detik uji selesai.');
  client.disconnect();
  process.exit(0);
}, 15000);
