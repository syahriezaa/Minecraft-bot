/**
 * @file live_protocol_codecs.test.js
 * @description Suite pengujian unit untuk Packet Codecs, Framer, Kompresi, Bitflags, dan State Transitions pada Protokol 775.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveProtocolClient,
  createLiveClient,
  PacketFramer,
  CompressionHandler,
  PROTOCOL_STATES,
  CONNECTION_STATES,
  DEFAULT_PACKET_IDS,
  writeVarInt,
  readVarInt,
  writeVarLong,
  readVarLong,
  writeString,
  readString,
  encodeMovementFlags,
  decodeMovementFlags,
  generateOfflineUuid,
  uuidToBuffer
} = require('../../src/network/liveProtocolClient.js');

describe('Pengujian Komprehensif Codec Protokol 775 & LiveProtocolClient', () => {

  describe('1. Uji Encoding & Decoding VarInt / VarLong', () => {
    it('harus mengkodekan dan mendekodekan berbagai nilai integer VarInt secara presisi', () => {
      const sampleValues = [0, 1, 2, 127, 128, 255, 25565, 2097151, 2147483647];
      for (const val of sampleValues) {
        const encoded = writeVarInt(val);
        const decoded = readVarInt(encoded, 0);
        assert.ok(decoded, `VarInt gagal dibaca untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai VarInt tidak cocok untuk ${val}`);
      }
    });

    it('harus mengembalikan null jika buffer VarInt belum lengkap atau terpotong', () => {
      const incomplete = Buffer.from([0x80]); // MSB aktif tapi tidak ada byte kelanjutan
      const decoded = readVarInt(incomplete, 0);
      assert.equal(decoded, null);
    });

    it('harus mengkodekan dan mendekodekan VarLong 64-bit secara presisi', () => {
      const longValues = [0n, 1n, 127n, 128n, 2147483647n, 9223372036854775807n];
      for (const val of longValues) {
        const encoded = writeVarLong(val);
        const decoded = readVarLong(encoded, 0);
        assert.ok(decoded, `VarLong gagal dibaca untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai VarLong tidak cocok untuk ${val}`);
      }
    });

    it('harus mengembalikan null jika buffer VarLong belum lengkap', () => {
      const incomplete = Buffer.from([0xFF, 0xFF]);
      const decoded = readVarLong(incomplete, 0);
      assert.equal(decoded, null);
    });

    it('harus membaca dan menulis string UTF-8 dengan prefiks VarInt panjang', () => {
      const text = 'Halo Minecraft NeoForge 26.1.2 Protokol 775!';
      const encoded = writeString(text);
      const decoded = readString(encoded, 0);
      assert.ok(decoded);
      assert.equal(decoded.value, text);
    });

    it('harus mengembalikan null jika string terpotong sebelum ukuran penuh', () => {
      const text = 'StringPanjangYangTerpotong';
      const encoded = writeString(text);
      const truncated = encoded.subarray(0, 5); // Hanya sebagian karakter
      const decoded = readString(truncated, 0);
      assert.equal(decoded, null);
    });

    it('harus mengkodekan dan mendekodekan VarLong negatif dan batas 64-bit secara presisi', () => {
      const negativeLongs = [
        -1n,
        -2n,
        -127n,
        -128n,
        -2147483648n,
        -9223372036854775808n, // Nilai minimum signed 64-bit
        9223372036854775807n,  // Nilai maksimum signed 64-bit
        0n,
        1n
      ];

      for (const val of negativeLongs) {
        const encoded = writeVarLong(val);
        assert.ok(encoded.length >= 1 && encoded.length <= 10, `Panjang VarLong (${encoded.length}) di luar 1..10 byte untuk ${val}`);
        
        const decoded = readVarLong(encoded, 0);
        assert.ok(decoded !== null, `VarLong gagal didekode untuk nilai ${val}`);
        assert.equal(decoded.value, val, `Nilai VarLong tidak cocok untuk ${val}`);
        assert.equal(decoded.size, encoded.length, `Ukuran size VarLong (${decoded.size}) != encoded.length (${encoded.length})`);
      }

      // Verifikasi eksplisit panjang byte two's complement untuk -1n (harus tepat 10 byte)
      const minusOneBuf = writeVarLong(-1n);
      assert.equal(minusOneBuf.length, 10, 'VarLong untuk -1n harus tepat 10 byte');
    });

    it('harus mengembalikan null pada buffer kosong atau offset out-of-bounds untuk readVarInt, readVarLong, dan readString', () => {
      const emptyBuf = Buffer.alloc(0);
      const dummyBuf = Buffer.from([0x01, 0x02]);

      // Buffer kosong
      assert.equal(readVarInt(emptyBuf, 0), null, 'readVarInt harus return null pada buffer 0-byte');
      assert.equal(readVarLong(emptyBuf, 0), null, 'readVarLong harus return null pada buffer 0-byte');
      assert.equal(readString(emptyBuf, 0), null, 'readString harus return null pada buffer 0-byte');

      // Offset out-of-bounds
      assert.equal(readVarInt(dummyBuf, 5), null, 'readVarInt harus return null pada offset out-of-bounds');
      assert.equal(readVarLong(dummyBuf, 5), null, 'readVarLong harus return null pada offset out-of-bounds');
      assert.equal(readString(dummyBuf, 5), null, 'readString harus return null pada offset out-of-bounds');
    });

    it('harus mengembalikan null untuk stream VarInt dan VarLong malformed yang melebihi batas byte maksimum', () => {
      // 5 byte VarInt dengan MSB aktif (tidak pernah terminasi)
      const malformedVarInt = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80]);
      assert.equal(readVarInt(malformedVarInt, 0), null, 'VarInt 5-byte malformed harus return null');

      // 10 byte VarLong dengan MSB aktif (tidak pernah terminasi)
      const malformedVarLong = Buffer.alloc(10, 0x80);
      assert.equal(readVarLong(malformedVarLong, 0), null, 'VarLong 10-byte malformed harus return null');
    });
  });

  describe('2. Uji Bitflags MovementFlags Protokol 775', () => {
    it('harus mengonversi bitflags onGround dan hasHorizontalCollision secara akurat', () => {
      assert.equal(encodeMovementFlags({ onGround: false, hasHorizontalCollision: false }), 0);
      assert.equal(encodeMovementFlags({ onGround: true, hasHorizontalCollision: false }), 1);
      assert.equal(encodeMovementFlags({ onGround: false, hasHorizontalCollision: true }), 2);
      assert.equal(encodeMovementFlags({ onGround: true, hasHorizontalCollision: true }), 3);

      assert.deepEqual(decodeMovementFlags(0), { onGround: false, hasHorizontalCollision: false });
      assert.deepEqual(decodeMovementFlags(1), { onGround: true, hasHorizontalCollision: false });
      assert.deepEqual(decodeMovementFlags(2), { onGround: false, hasHorizontalCollision: true });
      assert.deepEqual(decodeMovementFlags(3), { onGround: true, hasHorizontalCollision: true });
    });
  });

  describe('3. Uji Packet Framer & Buffer Accumulator (Fragmentasi & Coalescing TCP)', () => {
    let framer;

    beforeEach(() => {
      framer = new PacketFramer();
    });

    it('harus mengekstrak beberapa paket yang tergabung dalam 1 frame TCP (Coalesced)', () => {
      const p1 = Buffer.from('PaketSatu');
      const p2 = Buffer.from('PaketDuaPanjangSekali');
      const frame1 = Buffer.concat([writeVarInt(p1.length), p1]);
      const frame2 = Buffer.concat([writeVarInt(p2.length), p2]);
      const coalesced = Buffer.concat([frame1, frame2]);

      framer.append(coalesced);

      const r1 = framer.readNextFrame();
      const r2 = framer.readNextFrame();
      const r3 = framer.readNextFrame();

      assert.ok(r1);
      assert.equal(r1.toString(), 'PaketSatu');
      assert.ok(r2);
      assert.equal(r2.toString(), 'PaketDuaPanjangSekali');
      assert.equal(r3, null);
    });

    it('harus menangani pecahan paket yang datang byte-per-byte (Split/Fragmented)', () => {
      const p = Buffer.from('PecahanPaketJaringan');
      const fullFrame = Buffer.concat([writeVarInt(p.length), p]);

      // Kirim sebagian (hanya 3 byte pertama)
      framer.append(fullFrame.subarray(0, 3));
      assert.equal(framer.readNextFrame(), null);

      // Kirim sisa byte
      framer.append(fullFrame.subarray(3));
      const extracted = framer.readNextFrame();
      assert.ok(extracted);
      assert.equal(extracted.toString(), 'PecahanPaketJaringan');
    });

    it('harus membersihkan buffer saat memanggil clear()', () => {
      framer.append(Buffer.from('DataUji'));
      assert.ok(framer.size > 0);
      framer.clear();
      assert.equal(framer.size, 0);
      assert.equal(framer.readNextFrame(), null);
    });
  });

  describe('4. Uji Compression Handler (Zlib Thresholding)', () => {
    let compression;

    beforeEach(() => {
      compression = new CompressionHandler();
    });

    it('harus melewati paket tanpa kompresi jika threshold = -1', () => {
      compression.setThreshold(-1);
      const data = Buffer.from('DataTanpaKompresi');
      const compressed = compression.compress(data);

      // Framer memotong panjang paket, sisanya dikirim ke decompress
      const lenRes = readVarInt(compressed, 0);
      const body = compressed.subarray(lenRes.size);
      const decompressed = compression.decompress(body);

      assert.equal(decompressed.toString(), data.toString());
    });

    it('harus menggunakan DataLength = 0 untuk paket di bawah ambang batas kompresi', () => {
      compression.setThreshold(256);
      const smallData = Buffer.from('PaketKecilDiBawahThreshold');
      const framed = compression.compress(smallData);

      const lenRes = readVarInt(framed, 0);
      const body = framed.subarray(lenRes.size);

      // Cek bahwa dataLength di body bernilai 0
      const dataLenRes = readVarInt(body, 0);
      assert.equal(dataLenRes.value, 0);

      const decompressed = compression.decompress(body);
      assert.equal(decompressed.toString(), smallData.toString());
    });

    it('harus mengompresi Zlib secara penuh untuk paket di atas ambang batas (>= 256 bytes)', () => {
      compression.setThreshold(256);
      const largeData = Buffer.alloc(1024, 'X');
      const framed = compression.compress(largeData);

      const lenRes = readVarInt(framed, 0);
      const body = framed.subarray(lenRes.size);

      const dataLenRes = readVarInt(body, 0);
      assert.equal(dataLenRes.value, 1024);

      const decompressed = compression.decompress(body);
      assert.equal(decompressed.length, 1024);
      assert.equal(decompressed.toString(), largeData.toString());
    });

    it('harus melempar error jika frame kompresi tidak memiliki VarInt DataLength yang valid', () => {
      compression.setThreshold(256);
      assert.throws(() => {
        compression.decompress(Buffer.from([0x80]));
      }, /Gagal membaca VarInt Data Length/);
    });
  });

  describe('5. Uji Inisialisasi & Helper LiveProtocolClient', () => {
    it('harus menghasilkan UUID offline yang konsisten dan valid RFC 4122', () => {
      const uuid1 = generateOfflineUuid('Bot_Tester');
      const uuid2 = generateOfflineUuid('Bot_Tester');
      assert.equal(uuid1, uuid2);
      assert.match(uuid1, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('harus mengonversi UUID hex ke Buffer 16-byte dengan tepat', () => {
      const uuidStr = '550e8400-e29b-41d4-a716-446655440000';
      const buf = uuidToBuffer(uuidStr);
      assert.equal(buf.length, 16);
      assert.equal(buf.toString('hex'), '550e8400e29b41d4a716446655440000');
    });

    it('harus menginisialisasi LiveProtocolClient dengan status awal yang benar', () => {
      const client = new LiveProtocolClient({ username: 'CompanionBot' });
      assert.equal(client.protocolState, PROTOCOL_STATES.HANDSHAKING);
      assert.equal(client.connectionState, CONNECTION_STATES.DISCONNECTED);
      assert.equal(client.config.username, 'CompanionBot');
      assert.equal(client.config.protocolVersion, 775);
    });

    it('reset koneksi tidak boleh menjadi exception fatal bila pemakai tidak memasang listener error', () => {
      const client = new LiveProtocolClient({ username: 'ResilientBot' });
      assert.doesNotThrow(() => client.emit('error', new Error('uji reset tunnel')));
    });

    it('harus mendukung pembuatan instans melalui fungsi factory createLiveClient', () => {
      const client = createLiveClient({ username: 'FactoryBot' });
      assert.ok(client instanceof LiveProtocolClient);
      assert.equal(client.config.username, 'FactoryBot');
    });
  });

  describe('6. Uji Packet ID Outbound Play Tidak Saling Bertabrakan', () => {
    it('harus memakai packet ID berbeda untuk position, position_look, use_entity, chat, dan respawn', () => {
      const ids = DEFAULT_PACKET_IDS.play.toServer;
      const criticalIds = [
        ids.position,
        ids.positionLook,
        ids.useEntity,
        ids.chatMessage,
        ids.clientCommand
      ];

      assert.equal(new Set(criticalIds).size, criticalIds.length, 'Packet ID outbound kritis tidak boleh duplikat');
    });

    it('harus mengirim attack lewat use_entity dan tidak memakai packet position', () => {
      const client = new LiveProtocolClient({ username: 'PacketBot' });
      client.protocolState = PROTOCOL_STATES.PLAY;

      const sent = [];
      client._sendPacketRaw = (state, packetId, payload) => {
        sent.push({ state, packetId, payload });
      };

      client.sendPosition({ x: 0.1, y: 64, z: 0, onGround: true });
      client.sendAttack(123);
      client.sendRespawn();
      client.sendFlying({ onGround: true, hasHorizontalCollision: false });

      assert.equal(sent[0].packetId, DEFAULT_PACKET_IDS.play.toServer.position);
      assert.equal(sent[1].packetId, DEFAULT_PACKET_IDS.play.toServer.useEntity);
      assert.equal(sent[2].packetId, DEFAULT_PACKET_IDS.play.toServer.clientCommand);
      assert.equal(sent[3].packetId, DEFAULT_PACKET_IDS.play.toServer.flying);
      assert.deepEqual(sent[3].payload, Buffer.from([0x01]));
      assert.notEqual(sent[1].packetId, sent[0].packetId, 'Attack tidak boleh memakai packet ID position');
    });

    it('harus memakai packet ID Protokol 775 untuk health dan keepalive Play', () => {
      const client = new LiveProtocolClient({ username: 'HealthBot', autoRespawn: false });
      client.protocolState = PROTOCOL_STATES.PLAY;

      let healthEvents = 0;
      client.on('health', () => {
        healthEvents++;
      });

      const healthPayload = Buffer.alloc(5);
      healthPayload.writeFloatBE(20, 0);
      healthPayload.writeUInt8(20, 4);
      client._handlePlayPacket(DEFAULT_PACKET_IDS.play.toClient.updateHealth, healthPayload);
      assert.equal(healthEvents, 1, 'Packet update_health valid harus memicu health event');
      assert.equal(client.health, 20);
      assert.equal(DEFAULT_PACKET_IDS.play.toClient.updateHealth, 0x68);
      assert.equal(DEFAULT_PACKET_IDS.play.toClient.keepAlive, 0x2c);
      assert.equal(DEFAULT_PACKET_IDS.play.toServer.keepAlive, 0x1c);
    });

    it('harus membalas keepalive Play 26.1.2 hanya jika payload berbentuk 8 byte', () => {
      const client = new LiveProtocolClient({ username: 'KeepAliveBot' });
      client.protocolState = PROTOCOL_STATES.PLAY;

      const sent = [];
      let malformedKeepAlives = 0;
      client._sendPacketRaw = (state, packetId, payload) => {
        sent.push({ state, packetId, payload });
      };
      client.on('packet', (name) => {
        if (name === 'malformed_keep_alive') malformedKeepAlives++;
      });

      const keepAlivePayload = Buffer.alloc(8);
      keepAlivePayload.writeBigInt64BE(1234n, 0);
      client._handlePlayPacket(DEFAULT_PACKET_IDS.play.toClient.keepAlive, keepAlivePayload);
      client._handlePlayPacket(DEFAULT_PACKET_IDS.play.toClient.keepAlive, Buffer.from([0x01, 0x02, 0x03]));

      assert.equal(sent.length, 1);
      assert.equal(sent[0].packetId, DEFAULT_PACKET_IDS.play.toServer.keepAlive);
      assert.equal(sent[0].payload.readBigInt64BE(0), 1234n);
      assert.equal(malformedKeepAlives, 1);
    });

    it('harus mengonfirmasi teleport dan mengirim player_loaded setelah sinkron posisi awal', () => {
      const client = new LiveProtocolClient({ username: 'TeleportAckBot' });
      client.protocolState = PROTOCOL_STATES.PLAY;

      const sent = [];
      client._sendPacketRaw = (state, packetId, payload) => {
        sent.push({ state, packetId, payload });
      };

      const payload = Buffer.alloc(1 + 24 + 24 + 8 + 1);
      payload.writeUInt8(7, 0);
      payload.writeDoubleBE(12.5, 1);
      payload.writeDoubleBE(65, 9);
      payload.writeDoubleBE(-4.25, 17);
      payload.writeFloatBE(90, 49);
      payload.writeFloatBE(12, 53);
      payload.writeUInt8(0, 57);

      client._handlePlayPacket(0x48, payload);
      client._handlePlayPacket(0x48, payload);

      assert.equal(client.position.x, 12.5);
      assert.equal(client.position.y, 65);
      assert.equal(client.position.z, -4.25);
      assert.equal(sent[0].packetId, DEFAULT_PACKET_IDS.play.toServer.teleportConfirm);
      assert.equal(readVarInt(sent[0].payload).value, 7);
      assert.equal(sent[1].packetId, DEFAULT_PACKET_IDS.play.toServer.playerLoaded);
      assert.equal(sent[1].payload.length, 0);
      assert.equal(sent[2].packetId, DEFAULT_PACKET_IDS.play.toServer.teleportConfirm);
      assert.equal(sent.filter((packet) => packet.packetId === DEFAULT_PACKET_IDS.play.toServer.playerLoaded).length, 1);
    });

    it('harus membuat langkah berjalan kecil melalui packet position_look 26.1.2', () => {
      const client = new LiveProtocolClient({ username: 'WalkStepBot' });
      client.protocolState = PROTOCOL_STATES.PLAY;
      client.position = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true, hasHorizontalCollision: false };

      const sent = [];
      client._sendPacketRaw = (state, packetId, payload) => {
        sent.push({ state, packetId, payload });
      };

      client.sendWalkingStep({ yaw: 0, distance: 0.1 });

      assert.equal(sent.length, 1);
      assert.equal(sent[0].packetId, DEFAULT_PACKET_IDS.play.toServer.positionLook);
      assert.equal(sent[0].payload.readDoubleBE(0), 0);
      assert.equal(sent[0].payload.readDoubleBE(8), 64);
      assert.ok(Math.abs(sent[0].payload.readDoubleBE(16) - 0.1) < 0.000001);
      assert.equal(sent[0].payload.readUInt8(32), 0x01);
    });

    it('harus mem-pause walking step sementara setelah koreksi posisi dari server', () => {
      const client = new LiveProtocolClient({ username: 'CorrectionBot', movementCorrectionPauseMs: 10000 });
      client.protocolState = PROTOCOL_STATES.PLAY;

      const sent = [];
      const corrections = [];
      client._sendPacketRaw = (state, packetId, payload) => {
        sent.push({ state, packetId, payload });
      };
      client.on('movement_correction', (correction) => corrections.push(correction));

      const firstTeleport = Buffer.alloc(1 + 24 + 24 + 8 + 1);
      firstTeleport.writeUInt8(1, 0);
      firstTeleport.writeDoubleBE(0, 1);
      firstTeleport.writeDoubleBE(64, 9);
      firstTeleport.writeDoubleBE(0, 17);

      const correctionTeleport = Buffer.from(firstTeleport);
      correctionTeleport.writeUInt8(2, 0);
      correctionTeleport.writeDoubleBE(0, 1);
      correctionTeleport.writeDoubleBE(64, 9);
      correctionTeleport.writeDoubleBE(0.5, 17);

      client._handlePlayPacket(0x48, firstTeleport);
      client.sendWalkingStep({ yaw: 0, distance: 0.1 });
      client._handlePlayPacket(0x48, correctionTeleport);
      client.sendWalkingStep({ yaw: 0, distance: 0.1 });

      assert.equal(corrections.length, 1);
      assert.equal(corrections[0].teleportId, 2);
      assert.ok(corrections[0].distance >= 0.4);
      assert.equal(sent.filter((packet) => packet.packetId === DEFAULT_PACKET_IDS.play.toServer.positionLook).length, 1);
    });

    it('harus mengirim Login Acknowledged setelah Login Success tanpa settings konfigurasi prematur', () => {
      const client = new LiveProtocolClient({ username: 'AckBot' });
      const sent = [];
      client._sendPacketRaw = (state, packetId, payload) => {
        sent.push({ state, packetId, payload });
      };

      const loginSuccessPayload = Buffer.concat([
        uuidToBuffer(client.uuid),
        writeString('SettingsBot')
      ]);

      client._handleLoginPacket(0x02, loginSuccessPayload);

      assert.equal(client.protocolState, PROTOCOL_STATES.CONFIGURATION);
      assert.equal(sent[0].state, PROTOCOL_STATES.LOGIN);
      assert.equal(sent[0].packetId, 0x03, 'Login Acknowledged harus dikirim');
      assert.equal(sent.length, 1, 'Settings konfigurasi tidak boleh dikirim prematur pada server NeoForge 775');
    });

  });
});
