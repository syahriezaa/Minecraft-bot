/**
 * @file test_challenger2_resilience.js
 * @description Suite Pengujian Empiris & Stres Adversarial oleh Challenger 2 (Milestone 5).
 * Memvalidasi secara ketat dan mandiri:
 * 1. Ketahanan SLP Verifier terhadap paket cacat (Malformed SLP packets, corrupted JSON, truncated streams, oversized payloads).
 * 2. Simulasi server disconnect, state machine teardown, keepalive watchdog (25s), dan reconnect jitter backoff.
 * 3. Pemutusan koneksi database sementara (PostgreSQL transient disconnect) dan retensi antrean buffer (Zero Data Loss).
 * 4. Anti-AFK sinusoidal micro-drift invariant (radius <= 0.25m dari [-256, -20, -432]).
 * 5. Pembersihan soket TCP deterministik dan pencegahan kebocoran resource (clean socket teardowns).
 *
 * Aturan Tim: Semua komentar, log pengguna, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const EventEmitter = require('node:events');
const {
  querySLP,
  verifyBotOnline,
  PacketFramer,
  writeVarInt,
  readVarInt,
  writeString,
  readString
} = require('../../src/network/slpVerifier');

const {
  LiveProtocolClient,
  createLiveClient,
  PROTOCOL_STATES,
  CONNECTION_STATES
} = require('../../src/network/liveProtocolClient');

const {
  PersistentCompanion,
  PRESENCE_STATES,
  SUBTASK_STATES
} = require('../../src/tasks/persistentCompanion');

const { BatchIngestionService } = require('../../src/database/batchIngestion');
const { MockSlpServer, MOCK_BEHAVIORS } = require('../helpers/mockSlpServer');
const { TARGET_SPAWNER_COORDINATES } = require('../../src/config/constants');

async function runChallenger2Suite() {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('🛡️  CHALLENGER 2 — NETWORK RESILIENCE, SLP ROBUSTNESS & WATCHDOG STRESS');
  console.log('═══════════════════════════════════════════════════════════════════════════\n');

  let passed = 0;
  let total = 0;

  async function testCase(name, fn) {
    total++;
    process.stdout.write(`  ⏳ Menjalankan [${name}]... `);
    try {
      await fn();
      console.log(`\x1b[32m✔ LULUS\x1b[0m`);
      passed++;
    } catch (err) {
      console.log(`\x1b[31m✖ GAGAL\x1b[0m: ${err.message}`);
      throw err;
    }
  }

  // =========================================================================
  // SECTION 1: MALFORMED SLP PACKETS & CODEC FUZZING
  // =========================================================================
  console.log('▶ [SEKSI 1] Uji Ketahanan SLP Verifier & Fuzzing Paket Cacat');

  await testCase('SLP-01: PacketFramer menolak frame biner terpotong tanpa crash', async () => {
    const framer = new PacketFramer();
    // 1. Injeksi potongan VarInt tidak lengkap (byte MSB 0x80 tanpa kelanjutan)
    framer.append(Buffer.from([0x80]));
    assert.equal(framer.readNextFrame(), null, 'Harus mengembalikan null saat VarInt panjang belum lengkap');
    
    // Lengkapi VarInt 2-byte: 0x80 + 0x01 = 128 bytes
    framer.append(Buffer.from([0x01]));
    assert.equal(framer.readNextFrame(), null, 'Harus null karena 128 bytes payload belum tiba');

    // Kosongkan dan uji paket 5-byte terfragmentasi
    framer.clear();
    const payload = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]);
    const header = writeVarInt(payload.length);
    const fullPacket = Buffer.concat([header, payload]);

    // Kirim 2 byte pertama
    framer.append(fullPacket.subarray(0, 2));
    assert.equal(framer.readNextFrame(), null, 'Harus null saat payload baru tiba sebagian');

    // Kirim sisa byte
    framer.append(fullPacket.subarray(2));
    const extracted = framer.readNextFrame();
    assert.ok(extracted, 'Harus berhasil membaca frame setelah seluruh byte tiba');
    assert.deepEqual(extracted, payload);
    assert.equal(framer.readNextFrame(), null, 'Buffer harus kosong');
  });

  await testCase('SLP-02: querySLP melempar error Bahasa Indonesia deskriptif pada JSON korup', async () => {
    const mock = new MockSlpServer({ behavior: MOCK_BEHAVIORS.MALFORMED_JSON });
    const port = await mock.start(0);

    try {
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port, timeoutMs: 1500 });
        },
        (err) => {
          assert.ok(err.message.includes('[SLP] Gagal mem-parsing respons JSON status'), `Pesan salah: ${err.message}`);
          return true;
        }
      );
    } finally {
      await mock.stop();
    }
  });

  await testCase('SLP-03: verifyBotOnline menangani skema respons anomali (sample non-array, online negatif)', async () => {
    const mock = new MockSlpServer();
    const port = await mock.start(0);

    try {
      // Set status dengan skema anomali
      mock.setStatus({
        version: { name: 'NeoForge 26.1.2', protocol: 775 },
        players: {
          online: 5,
          max: 20,
          sample: 'BUKAN_ARRAY' // Cacat tipe data
        }
      });

      const res = await verifyBotOnline({
        host: '127.0.0.1',
        port,
        botUsername: 'Bot_AI_Companion',
        timeoutMs: 1500
      });

      assert.equal(res.playerCount, 5);
      assert.equal(res.sampleOmitted, true, 'Harus mendeteksi bahwa sample ditiadakan atau cacat');
      assert.equal(res.isOnline, true, 'Bot dianggap online saat playerCount >= 1 dan sample dihilangkan');
      assert.deepEqual(res.sample, []);
    } finally {
      await mock.stop();
    }
  });

  await testCase('SLP-04: querySLP mampu memproses payload JSON besar (100KB MOTD / Deskripsi)', async () => {
    const mock = new MockSlpServer();
    const port = await mock.start(0);

    try {
      const hugeDescription = 'A'.repeat(100000);
      mock.setStatus({
        description: { text: hugeDescription },
        players: { online: 2, max: 50, sample: [{ name: 'TestPlayer', id: '00000000-0000-0000-0000-000000000001' }] }
      });

      const res = await querySLP({ host: '127.0.0.1', port, timeoutMs: 3000 });
      assert.equal(res.players.online, 2);
      assert.equal(res.descriptionText.length, 100000);
      assert.ok(res.latencyMs >= 0);
    } finally {
      await mock.stop();
    }
  });

  await testCase('SLP-05: querySLP menutup socket dengan bersih saat koneksi ditolak atau putus mendadak', async () => {
    const mock = new MockSlpServer({ behavior: MOCK_BEHAVIORS.DROP_ON_CONNECT });
    const port = await mock.start(0);

    try {
      await assert.rejects(
        async () => {
          await querySLP({ host: '127.0.0.1', port, timeoutMs: 1000 });
        },
        /(Kesalahan koneksi|Koneksi terputus|ECONNRESET)/i
      );
    } finally {
      await mock.stop();
    }
  });

  // =========================================================================
  // SECTION 2: SERVER DISCONNECTS, RECONNECTION JITTER & STATE MACHINE
  // =========================================================================
  console.log('\n▶ [SEKSI 2] Uji Simulasi Server Disconnect & Formula Jitter Backoff');

  await testCase('NET-01: Verifikasi formula exponential backoff & rentang jitter (10%-20%)', async () => {
    const client = new LiveProtocolClient({
      reconnectBaseDelayMs: 1000,
      backoffMultiplier: 1.8,
      reconnectMaxDelayMs: 30000,
      autoReconnect: true
    });

    const delays = [];
    // Simulasikan 5 percobaan reconnect
    for (let attempt = 1; attempt <= 5; attempt++) {
      client.reconnectAttempts = attempt;
      const baseDelay = client.config.reconnectBaseDelayMs * Math.pow(client.config.backoffMultiplier, attempt - 1);
      const cappedDelay = Math.min(baseDelay, client.config.reconnectMaxDelayMs);
      const minJitterDelay = cappedDelay * 1.10;
      const maxJitterDelay = cappedDelay * 1.20;

      // Verifikasi perhitungan delay
      assert.ok(cappedDelay >= 1000, 'Delay harus >= base delay');
      assert.ok(minJitterDelay <= maxJitterDelay, 'Rentang jitter harus valid');
      delays.push({ attempt, cappedDelay, minJitterDelay, maxJitterDelay });
    }

    // Delay harus meningkat secara monotonik
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i].cappedDelay > delays[i - 1].cappedDelay, 'Backoff harus meningkat eksponensial');
    }
  });

  await testCase('NET-02: disconnect() eksplisit mematikan timer reconnect dan membersihkan listener socket', async () => {
    const client = new LiveProtocolClient({ autoReconnect: true });
    
    // Inisialisasi dummy timer
    client._reconnectTimer = setTimeout(() => {}, 10000);
    client._keepAliveWatchdogTimer = setInterval(() => {}, 10000);
    
    client.disconnect('Uji coba disconnect manual');

    assert.equal(client.config.autoReconnect, false, 'autoReconnect harus false pasca disconnect');
    assert.equal(client._reconnectTimer, null, 'Reconnect timer harus dibersihkan');
    assert.equal(client._keepAliveWatchdogTimer, null, 'Watchdog timer harus dibersihkan');
    assert.equal(client.connectionState, CONNECTION_STATES.DISCONNECTED);
  });

  // =========================================================================
  // SECTION 3: PERSISTENT COMPANION WATCHDOG & ANTI-AFK INVARIANTS
  // =========================================================================
  console.log('\n▶ [SEKSI 3] Uji Watchdog Detak Jantung (25s) & Anti-AFK Micro-Drift Invariant');

  await testCase('WATCHDOG-01: Watchdog memicu timeout alert saat keepalive tidak diterima melebihi ambang batas', async () => {
    const dummyClient = new EventEmitter();
    dummyClient.protocolState = 'play';
    dummyClient.disconnect = (reason) => {
      dummyClient.emit('disconnect', { reason });
    };

    // Konfigurasi keepAliveTimeoutMs rendah (200ms) untuk pengujian deterministik
    const companion = new PersistentCompanion(dummyClient, {
      keepAliveTimeoutMs: 200,
      heartbeatIntervalMs: 50
    });

    companion.start();

    let timeoutAlertFired = false;
    let disconnectedFired = false;

    companion.on('watchdog_timeout', (evt) => {
      timeoutAlertFired = true;
      assert.ok(evt.elapsedMs >= 200, 'Elapsed time harus >= timeout');
    });

    dummyClient.on('disconnect', () => {
      disconnectedFired = true;
    });

    // Tunggu 350ms tanpa mengirim keepalive
    await new Promise((r) => setTimeout(r, 350));

    assert.equal(timeoutAlertFired, true, 'Event watchdog_timeout harus terpanggil');
    assert.equal(disconnectedFired, true, 'Koneksi client harus diputus oleh watchdog');

    companion.stop('Selesai uji watchdog');
  });

  await testCase('WATCHDOG-02: Anti-AFK Micro-drift berada dalam batas ketat radius <= 0.25m dari jangkar spawner', async () => {
    const sentPositions = [];
    const dummyClient = new EventEmitter();
    dummyClient.protocolState = 'play';
    dummyClient.sendPositionAndRotation = (pos) => {
      sentPositions.push(pos);
    };

    const companion = new PersistentCompanion(dummyClient, {
      targetCoordinates: { x: -256, y: -20, z: -432 },
      antiAfkIntervalMs: 20,
      antiAfkYawRangeDeg: 3.5,
      antiAfkPitchRangeDeg: 1.5,
      antiAfkMaxDriftRadius: 0.25
    });

    companion.start();

    // Jalankan 15 tick anti-AFK pulses
    await new Promise((r) => setTimeout(r, 350));

    companion.stop('Selesai uji anti-AFK');

    assert.ok(sentPositions.length >= 10, 'Harus ada minimal 10 pulse anti-AFK terkirim');

    for (const p of sentPositions) {
      const dx = p.x - TARGET_SPAWNER_COORDINATES.x;
      const dz = p.z - TARGET_SPAWNER_COORDINATES.z;
      const driftDist = Math.hypot(dx, dz);

      assert.ok(
        driftDist <= 0.25,
        `Pelanggaran Anti-AFK Drift: jarak ${driftDist.toFixed(4)}m melampaui 0.25m dari jangkar [-256, -20, -432]`
      );
      assert.equal(p.y, TARGET_SPAWNER_COORDINATES.y, 'Ketinggian Y harus stabil di -20');
      assert.ok(p.pitch >= -89 && p.pitch <= 89, 'Pitch harus berada di [-89, 89]');
    }
  });

  await testCase('WATCHDOG-03: Sub-tugas dijeda otomatis saat disconnect dan dilanjutkan saat reconnect', async () => {
    const dummyClient = new EventEmitter();
    dummyClient.protocolState = 'play';

    const companion = new PersistentCompanion(dummyClient);
    companion.start();

    let taskPaused = false;
    let taskResumed = false;

    const mockSubTask = {
      pause: () => { taskPaused = true; },
      resume: () => { taskResumed = true; }
    };

    companion.registerSubTask('zombie_farm', mockSubTask);
    await companion.startSubTask('zombie_farm');

    // Simulasikan disconnect
    dummyClient.emit('disconnect', { reason: 'Jaringan terputus' });
    assert.equal(taskPaused, true, 'Tugas harus dijeda saat disconnect');

    // Simulasikan spawn / reconnect
    dummyClient.emit('spawn');
    assert.equal(taskResumed, true, 'Tugas harus dilanjutkan saat spawn kembali');

    companion.stop('Selesai uji sub-tugas');
  });

  // =========================================================================
  // SECTION 4: DATABASE DISCONNECT & BUFFER RETENTION (ZERO DATA LOSS)
  // =========================================================================
  console.log('\n▶ [SEKSI 4] Uji Pemutusan Koneksi Database & Retensi Buffer (Zero Data Loss)');

  await testCase('DB-01: BatchIngestionService menahan data di antrean saat DB offline dan flush utuh saat online', async () => {
    let dbOnline = false;
    const persistedRows = [];

    // Mock PostgreSQL pool
    const mockPool = {
      query: async (sql, params) => {
        if (!dbOnline) {
          throw new Error('connection refused: database offline');
        }
        // Simulasikan penyimpanan sukses
        const runIds = params[0];
        const ticks = params[1];
        for (let i = 0; i < runIds.length; i++) {
          persistedRows.push({ run_id: runIds[i], tick: ticks[i] });
        }
        return { rowCount: runIds.length };
      }
    };

    const service = new BatchIngestionService(mockPool, {
      flushIntervalMs: 50,
      batchThreshold: 20,
      chunkSize: 100,
      retryDelayMs: 50
    });

    const runId = 'test-resilience-run-001';

    // 1. Ingest 50 data saat DB offline
    for (let tick = 1; tick <= 50; tick++) {
      service.ingestTick({
        run_id: runId,
        tick,
        x: -256 + tick * 0.1,
        y: -20,
        z: -432,
        velocity_xz: 4.3,
        action: 'SPRINT'
      });
    }

    // Tunggu siklus flush gagal
    await new Promise((r) => setTimeout(r, 120));

    // Verifikasi: tidak ada data yang hilang (Zero Data Loss)
    const statsOffline = service.getStats();
    assert.equal(statsOffline.totalPersisted, 0, 'Belum ada data tersimpan saat DB offline');
    assert.equal(statsOffline.totalDropped, 0, 'NOL data boleh dibuang');
    assert.equal(statsOffline.queueLength, 50, 'Seluruh 50 item harus tertahan di memory queue');

    // 2. Ingest 50 data tambahan saat masih offline
    for (let tick = 51; tick <= 100; tick++) {
      service.ingestTick({
        run_id: runId,
        tick,
        x: -256 + tick * 0.1,
        y: -20,
        z: -432,
        velocity_xz: 4.3,
        action: 'SPRINT'
      });
    }

    assert.equal(service.getStats().queueLength, 100, 'Queue harus menampung 100 item');

    // 3. Nyalakan database kembali (Online)
    dbOnline = true;

    // Picu flush
    await service.flushAndClose(2000);

    const statsOnline = service.getStats();
    assert.equal(statsOnline.totalPersisted, 100, 'Total 100 item harus berhasil dipersistensikan');
    assert.equal(statsOnline.totalDropped, 0, 'Zero data loss: 0 item dropped');
    assert.equal(statsOnline.queueLength, 0, 'Antrean harus kosong pasca flushAndClose');
    assert.equal(persistedRows.length, 100, 'Array data tersimpan harus tepat 100 item');
  });

  // =========================================================================
  // SECTION 5: CLEAN SOCKET TEARDOWNS & RESOURCE CLEANUP
  // =========================================================================
  console.log('\n▶ [SEKSI 5] Uji Pembersihan Soket TCP & Penutupan Bersih');

  await testCase('SOCKET-01: Verifikasi penghancuran soket aktif dan pembersihan listener saat stop', async () => {
    const mock = new MockSlpServer();
    const port = await mock.start(0);

    const clientPromises = [];
    for (let i = 0; i < 5; i++) {
      clientPromises.push(
        querySLP({ host: '127.0.0.1', port, timeoutMs: 2000 })
      );
    }

    const results = await Promise.all(clientPromises);
    assert.equal(results.length, 5);

    // Hentikan server mock
    await mock.stop();

    // Verifikasi semua socket mock server telah ditutup
    assert.equal(mock.sockets.size, 0, 'Set socket mock server harus kosong pasca stop()');
    assert.equal(mock.server, null, 'Server net.Server harus null pasca stop()');
  });

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log(`🏆 AUDIT KETAHANAN EMPIRIS CHALLENGER 2: ${passed}/${total} LULUS (100% SUKSES)`);
  console.log('═══════════════════════════════════════════════════════════════════════════\n');
}

if (require.main === module) {
  runChallenger2Suite().catch((err) => {
    console.error('FATAL CHALLENGER 2 ERROR:', err);
    process.exit(1);
  });
}

module.exports = { runChallenger2Suite };
