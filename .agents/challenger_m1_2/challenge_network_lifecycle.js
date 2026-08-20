/**
 * @file challenge_network_lifecycle.js
 * @description Suite Pengujian Adversarial Jaringan & Siklus Hidup Protokol 775 untuk LiveProtocolClient.
 * Menguji ketahanan terhadap lag/delay paket konfigurasi, injeksi custom payload,
 * rentetan high-frequency keepalive, variasi teleportId ekstrim, simulasi TCP drop & reconnect,
 * serta uji ketahanan koneksi langsung (live probe >= 10s) pada server atoms-girl.tun.ply.gg:25565.
 *
 * Aturan Tim: Komentar, log, dan pesan error dalam Bahasa Indonesia.
 */

const net = require('node:net');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveProtocolClient,
  querySLP,
  verifyBotOnline,
  PROTOCOL_STATES,
  CONNECTION_STATES,
  writeVarInt,
  readVarInt,
  writeString,
  readString
} = require('../../src/network/liveProtocolClient.js');

// ==============================================================================
// Helper Mock Server Protokol 775
// ==============================================================================

/**
 * Membungkus payload menjadi paket berbingkai VarInt length
 * @param {number} packetId
 * @param {Buffer} [body=Buffer.alloc(0)]
 * @returns {Buffer}
 */
function createPacket(packetId, body = Buffer.alloc(0)) {
  const idBuf = writeVarInt(packetId);
  const payload = Buffer.concat([idBuf, body]);
  const lenBuf = writeVarInt(payload.length);
  return Buffer.concat([lenBuf, payload]);
}

/**
 * Membaca paket-paket dari buffer socket
 * @param {Buffer} buffer
 * @returns {{ packets: Array<{ packetId: number, data: Buffer }>, remaining: Buffer }}
 */
function parsePackets(buffer) {
  const packets = [];
  let current = buffer;

  while (current.length > 0) {
    const lenRes = readVarInt(current, 0);
    if (!lenRes) break;

    const totalLen = lenRes.size + lenRes.value;
    if (current.length < totalLen) break;

    const frame = current.subarray(lenRes.size, totalLen);
    current = current.subarray(totalLen);

    const idRes = readVarInt(frame, 0);
    if (idRes) {
      packets.push({
        packetId: idRes.value,
        data: frame.subarray(idRes.size)
      });
    }
  }

  return { packets, remaining: current };
}

/**
 * Membuat in-memory TCP Mock Server Protokol 775 yang dapat diprogram per skenario
 * @param {number} port
 * @param {(socket: net.Socket) => void} onConnectionHandler
 * @returns {Promise<{ server: net.Server, port: number, close: () => Promise<void> }>}
 */
function startMockServer(onConnectionHandler) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      socket.on('error', () => {}); // Abaikan error socket server-side saat koneksi diputus paksa
      onConnectionHandler(socket);
    });

    server.on('error', () => {});

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

// ==============================================================================
// Suite Pengujian Adversarial Jaringan
// ==============================================================================

describe('Suite Pengujian Adversarial: Ketahanan Jaringan & Siklus Hidup Protokol 775', { timeout: 60000 }, () => {

  // ----------------------------------------------------------------------------
  // Skenario 1: Delayed Packets & Network Lag during Configuration Phase
  // ----------------------------------------------------------------------------
  it('Skenario 1: Harus bertahan dari lag jaringan dan penundaan paket bertahap pada fase Configuration', async () => {
    console.log('\n--- [Skenario 1] Uji Penundaan Paket Konfigurasi (Simulasi Lag) ---');

    let serverConfigFinishedSent = false;
    let clientReachedPlay = false;

    const mockServer = await startMockServer((socket) => {
      let state = 'HANDSHAKING';
      let rxBuf = Buffer.alloc(0);

      socket.on('data', async (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        const { packets, remaining } = parsePackets(rxBuf);
        rxBuf = remaining;

        for (const pkt of packets) {
          if (state === 'HANDSHAKING' && pkt.packetId === 0x00) {
            state = 'LOGIN';
          } else if (state === 'LOGIN' && pkt.packetId === 0x00) {
            // Login Start diterima -> kirim Login Success
            const uuidBuf = Buffer.alloc(16, 0xAA);
            const userBuf = writeString('LagTestBot');
            socket.write(createPacket(0x02, Buffer.concat([uuidBuf, userBuf])));
          } else if (state === 'LOGIN' && pkt.packetId === 0x03) {
            // Login Acknowledged -> Masuk Configuration
            state = 'CONFIGURATION';

            // Kirim paket konfigurasi dengan penundaan bertahap (50ms per paket)
            const registries = ['minecraft:dimension_type', 'minecraft:biome', 'minecraft:chat_type', 'minecraft:damage_type', 'minecraft:wolf_variant'];
            for (const reg of registries) {
              await new Promise((r) => setTimeout(r, 40));
              if (socket.destroyed) return;
              socket.write(createPacket(0x07, writeString(reg)));
            }

            // Kirim Update Tags dengan jeda
            await new Promise((r) => setTimeout(r, 60));
            if (socket.destroyed) return;
            socket.write(createPacket(0x0d, Buffer.alloc(10, 0x01)));

            // Kirim KeepAlive pada fase config
            await new Promise((r) => setTimeout(r, 40));
            if (socket.destroyed) return;
            const keepBuf = Buffer.alloc(8);
            keepBuf.writeBigInt64BE(88889999n, 0);
            socket.write(createPacket(0x04, keepBuf));

            // Kirim Finish Configuration
            await new Promise((r) => setTimeout(r, 80));
            if (socket.destroyed) return;
            serverConfigFinishedSent = true;
            socket.write(createPacket(0x03, Buffer.alloc(0)));
          } else if (state === 'CONFIGURATION' && pkt.packetId === 0x03) {
            // Client membalas Finish Configuration -> Masuk PLAY
            state = 'PLAY';
            const entityIdBuf = Buffer.alloc(4);
            entityIdBuf.writeInt32BE(4242, 0);
            socket.write(createPacket(0x31, entityIdBuf)); // Join game
          }
        }
      });
    });

    const client = new LiveProtocolClient({
      host: '127.0.0.1',
      port: mockServer.port,
      username: 'LagTestBot',
      protocolVersion: 775,
      autoReconnect: false,
      socketTimeoutMs: 15000
    });

    let configFinishedEvent = false;
    let keepAliveConfigReceived = false;

    client.on('configuration_finished', () => {
      configFinishedEvent = true;
    });

    client.on('keep_alive', (id) => {
      if (id === 88889999n) keepAliveConfigReceived = true;
    });

    client.on('joined', () => {
      clientReachedPlay = true;
    });

    await client.connect();

    assert.ok(serverConfigFinishedSent, 'Server harus berhasil mengirim finish_configuration');
    assert.ok(configFinishedEvent, 'Klien harus memancarkan event configuration_finished');
    assert.ok(keepAliveConfigReceived, 'Klien harus memproses keep_alive pada fase konfigurasi yang tertunda');
    assert.ok(clientReachedPlay, 'Klien harus sukses mencapai Play state meski paket dikirim dengan penundaan');
    assert.equal(client.protocolState, PROTOCOL_STATES.PLAY, 'Status akhir klien harus PLAY');
    assert.equal(client.entityId, 4242, 'Entity ID harus cocok');
    assert.equal(client.registries.size, 5, 'Klien harus menyimpan seluruh 5 registri yang tertunda');

    client.disconnect();
    await mockServer.close();
    console.log('✅ [Skenario 1] Lulus: Klien menangani lag paket konfigurasi secara sempurna.');
  });

  // ----------------------------------------------------------------------------
  // Skenario 2: Custom Payload Injection (Unrecognized Channels & Brand)
  // ----------------------------------------------------------------------------
  it('Skenario 2: Harus menangani injeksi Custom Payload (saluran tak dikenal, data biner acak, brand)', async () => {
    console.log('\n--- [Skenario 2] Uji Injeksi Custom Payload & Saluran Tak Dikenal ---');

    const receivedCustomPayloads = [];

    const mockServer = await startMockServer((socket) => {
      let state = 'HANDSHAKING';
      let rxBuf = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        const { packets, remaining } = parsePackets(rxBuf);
        rxBuf = remaining;

        for (const pkt of packets) {
          if (state === 'HANDSHAKING' && pkt.packetId === 0x00) {
            state = 'LOGIN';
          } else if (state === 'LOGIN' && pkt.packetId === 0x00) {
            const uuidBuf = Buffer.alloc(16, 0xBB);
            const userBuf = writeString('PayloadBot');
            socket.write(createPacket(0x02, Buffer.concat([uuidBuf, userBuf])));
          } else if (state === 'LOGIN' && pkt.packetId === 0x03) {
            state = 'CONFIGURATION';

            // Injeksi 1: minecraft:brand
            const brandChannel = writeString('minecraft:brand');
            const brandData = writeString('NeoForge-Custom-26.1.2');
            socket.write(createPacket(0x01, Buffer.concat([brandChannel, brandData])));

            // Injeksi 2: Unrecognized channel dengan binary payload acak
            const unknownChannel1 = writeString('neoforge:mod_negotiation');
            const randomBinary1 = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04]);
            socket.write(createPacket(0x01, Buffer.concat([unknownChannel1, randomBinary1])));

            // Injeksi 3: Corrupt/weird channel name
            const unknownChannel2 = writeString('alien_mod:telemetry_stream_99');
            const largeData = Buffer.alloc(512, 0x7A);
            socket.write(createPacket(0x01, Buffer.concat([unknownChannel2, largeData])));

            // Kirim finish config
            socket.write(createPacket(0x03, Buffer.alloc(0)));
          } else if (state === 'CONFIGURATION' && pkt.packetId === 0x03) {
            state = 'PLAY';
            const entityIdBuf = Buffer.alloc(4);
            entityIdBuf.writeInt32BE(9999, 0);
            socket.write(createPacket(0x31, entityIdBuf));
          }
        }
      });
    });

    const client = new LiveProtocolClient({
      host: '127.0.0.1',
      port: mockServer.port,
      username: 'PayloadBot',
      protocolVersion: 775,
      autoReconnect: false
    });

    client.on('packet', (name, data, state) => {
      if (name === 'custom_payload') {
        receivedCustomPayloads.push({ channel: data.channel, size: data.data.length, state });
      }
    });

    await client.connect();

    assert.equal(client.protocolState, PROTOCOL_STATES.PLAY);
    assert.equal(receivedCustomPayloads.length, 3, 'Klien harus menangkap seluruh 3 custom payload tanpa crash');
    assert.equal(receivedCustomPayloads[0].channel, 'minecraft:brand');
    assert.equal(receivedCustomPayloads[1].channel, 'neoforge:mod_negotiation');
    assert.equal(receivedCustomPayloads[1].size, 8);
    assert.equal(receivedCustomPayloads[2].channel, 'alien_mod:telemetry_stream_99');
    assert.equal(receivedCustomPayloads[2].size, 512);

    client.disconnect();
    await mockServer.close();
    console.log('✅ [Skenario 2] Lulus: Klien mengabaikan saluran tak dikenal dengan aman dan mengekstrak payload.');
  });

  // ----------------------------------------------------------------------------
  // Skenario 3: High-Frequency Burst Keepalives (10 rapid keepalives)
  // ----------------------------------------------------------------------------
  it('Skenario 3: Harus merespons 10 rentetan keepalive frekuensi tinggi secara instan dengan ID persis', async () => {
    console.log('\n--- [Skenario 3] Uji Rentetan Keepalive Frekuensi Tinggi (10 paket beruntun) ---');

    const expectedKeepAliveIds = [
      1000000000000000001n,
      1000000000000000002n,
      1000000000000000003n,
      1000000000000000004n,
      1000000000000000005n,
      1000000000000000006n,
      1000000000000000007n,
      1000000000000000008n,
      1000000000000000009n,
      1000000000000000010n
    ];

    const receivedKeepAliveResponses = [];
    let allKeepAlivesAckedPromise;
    let resolveKeepAlivesAcked;

    allKeepAlivesAckedPromise = new Promise((resolve) => {
      resolveKeepAlivesAcked = resolve;
    });

    const mockServer = await startMockServer((socket) => {
      let state = 'HANDSHAKING';
      let rxBuf = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        const { packets, remaining } = parsePackets(rxBuf);
        rxBuf = remaining;

        for (const pkt of packets) {
          if (state === 'HANDSHAKING' && pkt.packetId === 0x00) {
            state = 'LOGIN';
          } else if (state === 'LOGIN' && pkt.packetId === 0x00) {
            const uuidBuf = Buffer.alloc(16, 0xCC);
            const userBuf = writeString('BurstBot');
            socket.write(createPacket(0x02, Buffer.concat([uuidBuf, userBuf])));
          } else if (state === 'LOGIN' && pkt.packetId === 0x03) {
            state = 'CONFIGURATION';
            socket.write(createPacket(0x03, Buffer.alloc(0))); // Finish config
          } else if (state === 'CONFIGURATION' && pkt.packetId === 0x03) {
            state = 'PLAY';
            const entityIdBuf = Buffer.alloc(4);
            entityIdBuf.writeInt32BE(777, 0);
            socket.write(createPacket(0x31, entityIdBuf)); // Join game

            // Kirim 10 keepalive secara instan beruntun
            setImmediate(() => {
              for (const kaId of expectedKeepAliveIds) {
                const kaBuf = Buffer.alloc(8);
                kaBuf.writeBigInt64BE(kaId, 0);
                socket.write(createPacket(0x2c, kaBuf)); // 0x2c keepalive toClient Play
              }
            });
          } else if (state === 'PLAY' && pkt.packetId === 0x1c) {
            // Keepalive response toServer Play (0x1c)
            if (pkt.data.length >= 8) {
              const respId = pkt.data.readBigInt64BE(0);
              receivedKeepAliveResponses.push(respId);
              if (receivedKeepAliveResponses.length === expectedKeepAliveIds.length) {
                resolveKeepAlivesAcked();
              }
            }
          }
        }
      });
    });

    const client = new LiveProtocolClient({
      host: '127.0.0.1',
      port: mockServer.port,
      username: 'BurstBot',
      protocolVersion: 775,
      autoReconnect: false
    });

    await client.connect();

    // Tunggu sampai seluruh 10 respon diterima server
    await allKeepAlivesAckedPromise;

    assert.equal(receivedKeepAliveResponses.length, 10, 'Server harus menerima tepat 10 respons keepalive');
    for (let i = 0; i < expectedKeepAliveIds.length; i++) {
      assert.equal(
        receivedKeepAliveResponses[i],
        expectedKeepAliveIds[i],
        `Keepalive response #${i + 1} ID tidak cocok (${receivedKeepAliveResponses[i]} vs ${expectedKeepAliveIds[i]})`
      );
    }

    client.disconnect();
    await mockServer.close();
    console.log('✅ [Skenario 3] Lulus: Klien merespons 10 rentetan keepalive dengan ID persis 100% tanpa paket tertinggal.');
  });

  // ----------------------------------------------------------------------------
  // Skenario 4: Teleport Packet Simulation with Varied Teleport IDs & Pos
  // ----------------------------------------------------------------------------
  it('Skenario 4: Harus memproses sinkronisasi teleportasi dengan berbagai teleportId dan membalas confirm + player_loaded', async () => {
    console.log('\n--- [Skenario 4] Uji Variasi Teleport ID & Player Loaded ---');

    const testTeleports = [
      { id: 0, x: -256.5, y: -20.0, z: -432.5, yaw: 0.0, pitch: 0.0 },
      { id: 1, x: 100.0, y: 64.0, z: 200.0, yaw: 90.0, pitch: 45.0 },
      { id: 127, x: 0.0, y: 70.0, z: 0.0, yaw: 180.0, pitch: -30.0 },
      { id: 128, x: -1000.0, y: 128.0, z: 5000.0, yaw: 270.0, pitch: 15.0 },
      { id: 25565, x: 50.25, y: 63.0, z: -75.8, yaw: 45.0, pitch: 0.0 },
      { id: 2097151, x: -256.0, y: -20.0, z: -432.0, yaw: 0.0, pitch: 0.0 }
    ];

    const receivedTeleportConfirms = [];
    const receivedPlayerLoadedCount = { count: 0 };
    let teleportsDonePromise;
    let resolveTeleportsDone;

    teleportsDonePromise = new Promise((resolve) => {
      resolveTeleportsDone = resolve;
    });

    const mockServer = await startMockServer((socket) => {
      let state = 'HANDSHAKING';
      let rxBuf = Buffer.alloc(0);

      socket.on('data', async (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        const { packets, remaining } = parsePackets(rxBuf);
        rxBuf = remaining;

        for (const pkt of packets) {
          if (state === 'HANDSHAKING' && pkt.packetId === 0x00) {
            state = 'LOGIN';
          } else if (state === 'LOGIN' && pkt.packetId === 0x00) {
            const uuidBuf = Buffer.alloc(16, 0xDD);
            const userBuf = writeString('TeleportBot');
            socket.write(createPacket(0x02, Buffer.concat([uuidBuf, userBuf])));
          } else if (state === 'LOGIN' && pkt.packetId === 0x03) {
            state = 'CONFIGURATION';
            socket.write(createPacket(0x03, Buffer.alloc(0)));
          } else if (state === 'CONFIGURATION' && pkt.packetId === 0x03) {
            state = 'PLAY';
            const entityIdBuf = Buffer.alloc(4);
            entityIdBuf.writeInt32BE(101, 0);
            socket.write(createPacket(0x31, entityIdBuf));

            // Kirim paket teleportasi satu per satu
            setImmediate(async () => {
              for (const tp of testTeleports) {
                // Skema 26.1.2 teleport 0x48:
                // teleportId(varint) + x(f64) + y(f64) + z(f64) + dx(f64) + dy(f64) + dz(f64) + yaw(f32) + pitch(f32) + flags(u32/u8)
                const teleIdBuf = writeVarInt(tp.id);
                const coordsBuf = Buffer.alloc(24 + 24 + 8 + 4);
                coordsBuf.writeDoubleBE(tp.x, 0);
                coordsBuf.writeDoubleBE(tp.y, 8);
                coordsBuf.writeDoubleBE(tp.z, 16);
                coordsBuf.writeDoubleBE(0.0, 24); // dx
                coordsBuf.writeDoubleBE(0.0, 32); // dy
                coordsBuf.writeDoubleBE(0.0, 40); // dz
                coordsBuf.writeFloatBE(tp.yaw, 48);
                coordsBuf.writeFloatBE(tp.pitch, 52);
                coordsBuf.writeUInt32BE(0, 56); // flags

                socket.write(createPacket(0x48, Buffer.concat([teleIdBuf, coordsBuf])));
                await new Promise((r) => setTimeout(r, 20));
              }
            });
          } else if (state === 'PLAY' && pkt.packetId === 0x00) {
            // Confirm Teleportation (0x00)
            const teleIdRes = readVarInt(pkt.data, 0);
            if (teleIdRes) {
              receivedTeleportConfirms.push(teleIdRes.value);
            }
            if (receivedTeleportConfirms.length === testTeleports.length) {
              resolveTeleportsDone();
            }
          } else if (state === 'PLAY' && pkt.packetId === 0x2c) {
            // Player Loaded (0x2c)
            receivedPlayerLoadedCount.count++;
          }
        }
      });
    });

    const client = new LiveProtocolClient({
      host: '127.0.0.1',
      port: mockServer.port,
      username: 'TeleportBot',
      protocolVersion: 775,
      autoReconnect: false
    });

    const clientEmittedTeleports = [];
    client.on('teleport', (data) => {
      clientEmittedTeleports.push(data);
    });

    await client.connect();
    await teleportsDonePromise;

    // Berikan jeda sejenak untuk memastikan seluruh paket player_loaded terproses
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(receivedTeleportConfirms.length, testTeleports.length, 'Harus mengonfirmasi seluruh teleportId');
    for (let i = 0; i < testTeleports.length; i++) {
      assert.equal(receivedTeleportConfirms[i], testTeleports[i].id, `Teleport confirmation #${i + 1} ID tidak cocok`);
      assert.equal(clientEmittedTeleports[i].teleportId, testTeleports[i].id);
      assert.equal(clientEmittedTeleports[i].x, testTeleports[i].x);
      assert.equal(clientEmittedTeleports[i].y, testTeleports[i].y);
      assert.equal(clientEmittedTeleports[i].z, testTeleports[i].z);
    }

    assert.ok(receivedPlayerLoadedCount.count >= testTeleports.length, 'Klien harus mengirimkan paket player_loaded (0x2c) pada setiap teleportasi');
    assert.deepEqual(
      { x: client.position.x, y: client.position.y, z: client.position.z },
      { x: -256.0, y: -20.0, z: -432.0 },
      'Posisi akhir bot harus terupdate ke nilai teleport terakhir'
    );

    client.disconnect();
    await mockServer.close();
    console.log('✅ [Skenario 4] Lulus: Seluruh teleportId dikonfirmasi dengan benar beserta paket player_loaded.');
  });

  // ----------------------------------------------------------------------------
  // Skenario 5: Connection Drop & Exponential Backoff Auto-Reconnection
  // ----------------------------------------------------------------------------
  it('Skenario 5: Harus melakukan auto-reconnect saat koneksi TCP diputus secara paksa (TCP Drop)', async () => {
    console.log('\n--- [Skenario 5] Uji Pemutusan Koneksi TCP & Auto-Reconnect ---');

    let connectionCount = 0;
    let reconnectSuccessfulPromise;
    let resolveReconnectSuccessful;

    reconnectSuccessfulPromise = new Promise((resolve) => {
      resolveReconnectSuccessful = resolve;
    });

    const mockServer = await startMockServer((socket) => {
      connectionCount++;
      const currentConn = connectionCount;
      let state = 'HANDSHAKING';
      let rxBuf = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        const { packets, remaining } = parsePackets(rxBuf);
        rxBuf = remaining;

        for (const pkt of packets) {
          if (state === 'HANDSHAKING' && pkt.packetId === 0x00) {
            state = 'LOGIN';
          } else if (state === 'LOGIN' && pkt.packetId === 0x00) {
            const uuidBuf = Buffer.alloc(16, 0xEE);
            const userBuf = writeString('ReconnBot');
            socket.write(createPacket(0x02, Buffer.concat([uuidBuf, userBuf])));
          } else if (state === 'LOGIN' && pkt.packetId === 0x03) {
            state = 'CONFIGURATION';
            socket.write(createPacket(0x03, Buffer.alloc(0)));
          } else if (state === 'CONFIGURATION' && pkt.packetId === 0x03) {
            state = 'PLAY';
            const entityIdBuf = Buffer.alloc(4);
            entityIdBuf.writeInt32BE(555, 0);
            socket.write(createPacket(0x31, entityIdBuf));

            if (currentConn === 1) {
              // Pada koneksi pertama: Hancurkan socket setelah 50ms untuk mensimulasikan putus koneksi paksa
              setTimeout(() => {
                console.log('💥 [Mock Server] Memutus paksa koneksi TCP socket #1...');
                socket.destroy();
              }, 50);
            } else if (currentConn === 2) {
              // Pada koneksi kedua (reconnect): Sukses!
              resolveReconnectSuccessful();
            }
          }
        }
      });
    });

    const client = new LiveProtocolClient({
      host: '127.0.0.1',
      port: mockServer.port,
      username: 'ReconnBot',
      protocolVersion: 775,
      autoReconnect: true,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 200,
      backoffMultiplier: 1.5
    });

    // Tangani event error agar tidak menjadi uncaught exception pada EventEmitter saat socket di-destroy
    client.on('error', (err) => {
      console.log(`ℹ️ [Uji Expected] Event error tertangkap saat pemutusan: ${err.message}`);
    });

    const reconnectEvents = [];
    client.on('reconnecting', (info) => {
      reconnectEvents.push(info);
      console.log(`🔄 [Klien] Memicu event reconnecting: Percobaan #${info.attempt}, Jeda: ${info.delayMs}ms`);
    });

    // Mulai koneksi awal
    await client.connect();

    // Tunggu sampai reconnect berhasil pada koneksi ke-2
    await reconnectSuccessfulPromise;

    assert.equal(connectionCount, 2, 'Server harus menerima tepat 2 koneksi (koneksi awal + reconnect)');
    assert.ok(reconnectEvents.length >= 1, 'Event reconnecting harus dipancarkan');
    assert.equal(reconnectEvents[0].attempt, 1, 'Percobaan pertama harus bernomor attempt 1');
    assert.equal(client.protocolState, PROTOCOL_STATES.PLAY, 'Status akhir setelah reconnect harus kembali PLAY');

    client.disconnect();
    await mockServer.close();
    console.log('✅ [Skenario 5] Lulus: Auto-reconnect berhasil memulihkan koneksi setelah TCP drop.');
  });

  // ----------------------------------------------------------------------------
  // Skenario 6: Live Server Sustained Connection Probe (atoms-girl.tun.ply.gg:25565)
  // ----------------------------------------------------------------------------
  it('Skenario 6: Harus mempertahankan koneksi live server atoms-girl.tun.ply.gg:25565 selama 12+ detik', async () => {
    console.log('\n--- [Skenario 6] Uji Presensi Live Server atoms-girl.tun.ply.gg:25565 (12+ Detik) ---');

    const LIVE_HOST = 'atoms-girl.tun.ply.gg';
    const LIVE_PORT = 25565;
    const BOT_USERNAME = `C2_Test_${Math.floor(Math.random() * 8999 + 1000)}`;

    console.log(`🌐 [Live Probe] Menghubungkan bot "${BOT_USERNAME}" ke ${LIVE_HOST}:${LIVE_PORT}...`);

    const client = new LiveProtocolClient({
      host: LIVE_HOST,
      port: LIVE_PORT,
      username: BOT_USERNAME,
      protocolVersion: 775,
      autoReconnect: false,
      socketTimeoutMs: 30000
    });

    let keepAliveCount = 0;
    let disconnectedPrematurely = false;

    client.on('keep_alive', (id) => {
      keepAliveCount++;
      console.log(`💓 [Live Probe] KeepAlive #${keepAliveCount} diterima & dibalas: ${id}`);
    });

    client.on('disconnect', () => {
      if (!isCleanDisconnect) {
        disconnectedPrematurely = true;
      }
    });

    let isCleanDisconnect = false;

    // 1. Hubungkan ke server live
    const startConnectTime = Date.now();
    await client.connect();
    const connectDuration = Date.now() - startConnectTime;

    console.log(`⚡ [Live Probe] Handshake berhasil dalam ${connectDuration}ms! Entity ID: ${client.entityId}`);
    assert.equal(client.protocolState, PROTOCOL_STATES.PLAY, 'Klien harus berada pada status PLAY');
    assert.equal(client.connectionState, CONNECTION_STATES.CONNECTED, 'Status koneksi harus CONNECTED');

    // 2. Kirim update posisi
    client.sendPosition({ x: -256.0, y: -20.0, z: -432.0, onGround: true, hasHorizontalCollision: false });

    // 3. Verifikasi kueri SLP saat bot sedang terhubung
    console.log('🔍 [Live Probe] Menjalankan kueri SLP saat bot aktif...');
    await new Promise((r) => setTimeout(r, 2000));

    const slpVerification = await verifyBotOnline({
      host: LIVE_HOST,
      port: LIVE_PORT,
      botUsername: BOT_USERNAME,
      timeoutMs: 15000
    });

    console.log(`📊 [Live Probe] SLP Result: Online=${slpVerification.playerCount}, Sample=${JSON.stringify(slpVerification.sample)}`);
    assert.ok(slpVerification.isOnline, 'Jumlah pemain online di SLP harus >= 1');
    assert.ok(slpVerification.playerCount >= 1, `Pemain online harus >= 1, diperoleh: ${slpVerification.playerCount}`);

    // 4. Pertahankan koneksi selama 12 detik penuh (10+ detik)
    console.log('⏱️ [Live Probe] Mempertahankan koneksi live selama 12 detik...');
    const liveStartTime = Date.now();
    await new Promise((r) => setTimeout(r, 12000));
    const sustainedDuration = Date.now() - liveStartTime;

    assert.ok(!disconnectedPrematurely, 'Klien tidak boleh terputus secara prematur');
    assert.equal(client.connectionState, CONNECTION_STATES.CONNECTED, 'Koneksi harus tetap CONNECTED setelah 12 detik');
    console.log(`⏱️ [Live Probe] Presensi berhasil dipertahankan selama ${(sustainedDuration / 1000).toFixed(2)} detik.`);

    // 5. Disconnect normal
    isCleanDisconnect = true;
    client.disconnect('Pengujian Challenger 2 Selesai');
    assert.equal(client.connectionState, CONNECTION_STATES.DISCONNECTED);

    console.log('✅ [Skenario 6] Lulus: Presensi live 12+ detik pada atoms-girl.tun.ply.gg:25565 terverifikasi stabil.');
  });

});
