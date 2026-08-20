/**
 * @file test_keepalive_candidates.js
 * @description Mendiagnosis paket ID yang benar untuk keepalive toServer pada NeoForge 26.1.2.
 */

const { LiveProtocolClient, DEFAULT_PACKET_IDS } = require('./src/network/liveProtocolClient');

async function testCandidate(candidateId, name) {
  return new Promise((resolve) => {
    const client = new LiveProtocolClient({
      host: 'atoms-girl.tun.ply.gg',
      port: 25565,
      username: name,
      protocolVersion: 775,
      autoReconnect: false
    });

    let keepAliveReceived = false;

    client.on('packet_raw', ({ packetId, buffer, state }) => {
      if (state === 'play' && packetId === DEFAULT_PACKET_IDS.play.toClient.keepAlive) {
        keepAliveReceived = true;
        console.log(`[0x${candidateId.toString(16)}] Keepalive diterima; respons otomatis klien memakai 0x${DEFAULT_PACKET_IDS.play.toServer.keepAlive.toString(16)}. Waiting 5s...`);
      }
    });

    client.connect().catch(() => {});

    setTimeout(() => {
      if (client.socket && !client.socket.destroyed && keepAliveReceived) {
        console.log(`\n======================================================`);
        console.log(`🎯 KANDIDAT BERHASIL: 0x${candidateId.toString(16)} (SOCKET TERBUKA STABIL)`);
        console.log(`======================================================\n`);
      } else if (keepAliveReceived) {
        console.log(`❌ KANDIDAT GAGAL: 0x${candidateId.toString(16)} (socket terputus).`);
      }
      client.disconnect();
      resolve();
    }, 6000);
  });
}

async function runAll() {
  const candidates = [DEFAULT_PACKET_IDS.play.toServer.keepAlive];
  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    await testCandidate(id, 'Cand_ID_' + i);
    await new Promise(r => setTimeout(r, 1000));
  }
}

runAll();
