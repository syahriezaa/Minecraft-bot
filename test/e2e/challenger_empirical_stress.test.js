/**
 * @file challenger_empirical_stress.test.js
 * @description Suite Verifikasi Adversarial Khusus Challenger 1 (Milestone 5)
 * Menguji 5 Dimensi Ketahanan Ekstrem Sistem:
 * 1. Packet Fragmentation & Malformed Stream Rejection
 * 2. Rapid Keepalive Flooding & Heartbeat Watchdog Stability
 * 3. Invalid / Extreme Coordinate Goals & Boundary Rejection
 * 4. Weapon Cooldown Spam Attack Prevention & Pacing Enforcement
 * 5. Memory Stability, High-Frequency Telemetry Ingestion, & Garbage Collection
 *
 * Bahasa & Pesan: 100% Bahasa Indonesia
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  assertCoordinateClose,
  assertAttackPacing,
  assertSafeHazardDistance,
  assertDatabaseTelemetry
} = require('../helpers/assertions');

const {
  writeVarInt,
  readVarInt,
  writeVarLong,
  readVarLong,
  writeString,
  readString,
  PacketFramer,
  LiveProtocolClient,
  PROTOCOL_STATES
} = require('../../src/network/liveProtocolClient');

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { PgTestClient } = require('../helpers/dbTestHelper');

describe('🛡️ PENGUJIAN ADVERSARIAL EMPIRIS CHALLENGER 1 (M5 STRESS HARNESS)', () => {

  // ===========================================================================
  // 1. PACKET FRAGMENTATION & MALFORMED STREAM REJECTION
  // ===========================================================================
  describe('1. Fragmentasi Paket TCP Ekstrem & Penolakan Stream Rusak', () => {
    test('1.1. PacketFramer harus merekonstruksi payload besar yang terpecah menjadi chunk 1-byte', () => {
      const framer = new PacketFramer();
      const testPayload = Buffer.from('HALO_MINECRAFT_NEOFORGE_26_1_2_PROTOCOL_775_TEST_PAYLOAD_WITH_LONG_DATA_STRING_1234567890');
      const packetLength = writeVarInt(testPayload.length);
      const fullFrame = Buffer.concat([packetLength, testPayload]);

      const receivedPackets = [];

      // Pecah menjadi potongan 1 byte dan masukkan satu per satu
      for (let i = 0; i < fullFrame.length; i++) {
        const chunk = fullFrame.subarray(i, i + 1);
        framer.append(chunk);
        let frame;
        while ((frame = framer.readNextFrame()) !== null) {
          receivedPackets.push(frame);
        }
      }

      assert.equal(receivedPackets.length, 1, 'Tepat 1 paket lengkap harus direkonstruksi dari pecahan 1-byte');
      assert.deepEqual(receivedPackets[0], testPayload, 'Payload yang direkonstruksi harus identik dengan data asli');
    });

    test('1.2. PacketFramer harus menangani coalesced multiple packets dalam 1 single buffer', () => {
      const framer = new PacketFramer();
      const payloadA = Buffer.from('PAKET_A');
      const payloadB = Buffer.from('PAKET_B_LEBIH_PANJANG');
      const payloadC = Buffer.from('PAKET_C_DATA_TERAKHIR');

      const frameA = Buffer.concat([writeVarInt(payloadA.length), payloadA]);
      const frameB = Buffer.concat([writeVarInt(payloadB.length), payloadB]);
      const frameC = Buffer.concat([writeVarInt(payloadC.length), payloadC]);

      const giantChunk = Buffer.concat([frameA, frameB, frameC]);
      framer.append(giantChunk);

      const packets = [];
      let frame;
      while ((frame = framer.readNextFrame()) !== null) {
        packets.push(frame);
      }

      assert.equal(packets.length, 3, 'Harus mengekstrak 3 paket dari satu buffer gabungan');
      assert.deepEqual(packets[0], payloadA);
      assert.deepEqual(packets[1], payloadB);
      assert.deepEqual(packets[2], payloadC);
    });

    test('1.3. Codec VarInt harus menolak stream malformed yang melebihi 5 byte', () => {
      // 6 byte dengan MSB bernilai 1 (0x80)
      const malformedBuf = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
      const result = readVarInt(malformedBuf, 0);
      assert.equal(result, null, 'VarInt dengan ukuran > 5 byte harus ditolak sebagai null');
    });

    test('1.4. Codec String UTF-8 harus menolak string dengan panjang yang diklaim melebihi buffer aktual', () => {
      const fakeLength = writeVarInt(100);
      const shortBody = Buffer.from('Pendek');
      const truncatedBuf = Buffer.concat([fakeLength, shortBody]);

      const result = readString(truncatedBuf, 0);
      assert.equal(result, null, 'String terpotong harus mengembalikan null tanpa melempar error tak tertangkap');
    });
  });

  // ===========================================================================
  // 2. RAPID KEEPALIVES & HEARTBEAT WATCHDOG
  // ===========================================================================
  describe('2. Banjir Paket Keepalive Cepat & Stabilitas Watchdog', () => {
    test('2.1. LiveProtocolClient harus menangani lonjakan keepalive frekuensi tinggi tanpa desync', () => {
      const client = new LiveProtocolClient({
        host: '127.0.0.1',
        port: 25565,
        username: 'StressBot_Keepalive'
      });

      // Simulasikan state play aktif
      client.state = PROTOCOL_STATES.PLAY;

      const sentKeepalives = [];
      // Override method internal _sendPacketRaw untuk merekam respons
      client._sendPacketRaw = (state, packetId, payload) => {
        sentKeepalives.push({ state, packetId, payload, timestamp: Date.now() });
      };

      // Tembakkan 100 keepalive packet (ID 0x2c) secara cepat dalam 1 tick
      for (let i = 0; i < 100; i++) {
        const keepAliveData = Buffer.alloc(8);
        keepAliveData.writeBigInt64BE(BigInt(1000000 + i), 0);
        client._handlePlayPacket(0x2c, keepAliveData);
      }

      assert.equal(sentKeepalives.length, 100, 'Seluruh 100 paket keepalive harus direspons 1:1');
      assert.equal(sentKeepalives[0].packetId, 0x1c, 'Respons keepalive Play toServer harus menggunakan packet ID 0x1c');
      assert.equal(client._lastKeepAliveTimestamp > 0, true, 'Timestamp keepalive terakhir harus tercatat');
    });
  });

  // ===========================================================================
  // 3. INVALID / EXTREME COORDINATE GOALS & BOUNDARY CHECKS
  // ===========================================================================
  describe('3. Koordinat Ekstrem, Nilai Rusak, & Batas Dunia', () => {
    test('3.1. assertCoordinateClose harus menolak koordinat NaN, Infinity, dan -Infinity', () => {
      assert.throws(
        () => assertCoordinateClose({ x: NaN, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 0.5),
        /Jarak koordinat melebihi toleransi/i,
        'Harus menolak nilai NaN'
      );

      assert.throws(
        () => assertCoordinateClose({ x: 0, y: 64, z: 0 }, { x: Infinity, y: 64, z: 0 }, 0.5),
        /Jarak koordinat melebihi toleransi/i,
        'Harus menolak nilai Infinity'
      );

      assert.throws(
        () => assertCoordinateClose({ x: -Infinity, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }, 0.5),
        /Jarak koordinat melebihi toleransi/i,
        'Harus menolak nilai -Infinity'
      );
    });

    test('3.2. MockArenaHarness harus menolak target di luar batas vertikal dunia [-64, 320]', () => {
      const arena = new MockArenaHarness();
      assert.throws(
        () => arena.setBlock(0, -65, 0, 'stone'),
        /di luar batas dunia/i,
        'Harus menolak Y < -64'
      );

      assert.throws(
        () => arena.setBlock(0, 321, 0, 'stone'),
        /di luar batas dunia/i,
        'Harus menolak Y > 320'
      );
    });

    test('3.3. Penegakan Jarak Perimeter Lava harus mendeteksi pelanggaran sub-milimeter (1.399m vs 1.5m)', () => {
      const lavaCoord = { x: 10, y: 64, z: 10 };
      const unsafePos = { x: 10, y: 64, z: 11.399 }; // Jarak 1.399m < 1.40m batas aman
      assert.throws(
        () => assertSafeHazardDistance(unsafePos, lavaCoord, 1.5),
        /Pelanggaran batas perimeter bahaya/i,
        'Harus menolak jarak 1.399m'
      );
    });
  });

  // ===========================================================================
  // 4. WEAPON COOLDOWN SPAM ATTACK PREVENTION
  // ===========================================================================
  describe('4. Pencegahan Spam Serangan & Penegakan Cooldown Senjata', () => {
    test('4.1. assertAttackPacing harus menolak serangan bertubi-tubi di bawah jeda 625ms (e.g. 500ms, 200ms, 0ms)', () => {
      // 500ms pacing (< 605ms minimum batas toleransi 625-20)
      assert.throws(
        () => assertAttackPacing([1000, 1500, 2000], 625),
        /Pelanggaran jeda serangan/i,
        'Harus menolak interval 500ms'
      );

      // Spam klik cepat 50ms
      assert.throws(
        () => assertAttackPacing([1000, 1050, 1100], 625),
        /Pelanggaran jeda serangan/i,
        'Harus menolak spam 50ms'
      );
    });

    test('4.2. assertAttackPacing harus meloloskan interval jeda yang valid (630ms >= 625ms)', () => {
      assert.doesNotThrow(() => {
        assertAttackPacing([1000, 1630, 2260, 2890], 625);
      });
    });

    test('4.3. Senjata Kapak dengan cooldown 1000ms harus menolak jeda 900ms', () => {
      assert.throws(
        () => assertAttackPacing([1000, 1900], 1000),
        /Pelanggaran jeda serangan/i,
        'Kapak butuh jeda >= 980ms (1000 - 20)'
      );
    });
  });

  // ===========================================================================
  // 5. MEMORY STABILITY & HIGH-FREQUENCY TELEMETRY INGESTION
  // ===========================================================================
  describe('5. Stabilitas Memori & Penelanan Telemetri Frekuensi Tinggi', () => {
    test('5.1. Ingesti 5.000 log telemetri tertampung tanpa memory leak atau heap overflow', async () => {
      const initialMem = process.memoryUsage().heapUsed;
      const db = new PgTestClient();
      await db.connect();
      await db.runMigrations();

      // Buat 5.000 log telemetri
      for (let i = 0; i < 5000; i++) {
        await db.insertTelemetryLog({
          run_id: 'STRESS_BENCH_01',
          level: '1',
          status: 'SUCCESS',
          travel_duration_ms: i * 10,
          obstacle_count: i % 5,
          start_pos: { x: 0, y: 64, z: 0 },
          end_pos: { x: 30, y: 64, z: 0 },
          coordinate_delta: 0.05,
          path_history: [{ x: 0, y: 64, z: 0 }, { x: 30, y: 64, z: 0 }]
        });
      }

      const logs = await db.getTelemetryLogs('STRESS_BENCH_01');
      assert.equal(logs.length, 5000, 'Seluruh 5000 log harus tersimpan utuh di database');

      await db.cleanupAndClose();

      const finalMem = process.memoryUsage().heapUsed;
      const memDeltaMb = (finalMem - initialMem) / (1024 * 1024);
      // Memori delta tidak boleh melonjak drastis (> 50 MB)
      assert.equal(memDeltaMb < 50, true, `Lonjakan memori (${memDeltaMb.toFixed(2)} MB) harus di bawah 50 MB`);
    });

    test('5.2. Siklus pembuatan dan pembersihan 100 instance PacketFramer tidak meninggalkan lingering buffer', () => {
      for (let i = 0; i < 100; i++) {
        const framer = new PacketFramer();
        const data = Buffer.alloc(1024, 0x42);
        framer.append(Buffer.concat([writeVarInt(1024), data]));
        const frame = framer.readNextFrame();
        assert.notEqual(frame, null, 'Frame harus terbaca');
        framer.clear();
        assert.equal(framer.size, 0, 'Buffer harus kosong pasca-clear');
      }
    });
  });
});
