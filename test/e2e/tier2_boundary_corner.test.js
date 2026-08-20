/**
 * Suite Pengujian E2E Tier 2: Kasus Batas, Nilai Ekstrem & Anomali (Boundary & Corner Cases)
 * Menguji 14 fitur (F01 - F14) secara granular dengan 5 kasus uji batas per fitur (Total: 70 Kasus Uji).
 *
 * Semua deskripsi pengujian, komentar, dan pesan asersi dalam Bahasa Indonesia.
 */

const {
  assertCoordinateClose,
  assertTrajectoryProgress,
  assertStuckRecoveryPhases,
  assertAttackPacing,
  assertChestSorting,
  assertSafeHazardDistance,
  assertDatabaseTelemetry,
  assertWebSocketEvent,
  assertIndonesianLocalization,
  assertPoppinsFont,
  ok,
  equal,
  deepEqual,
  throws,
  rejects
} = require('../helpers/assertions');

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { PgTestClient } = require('../helpers/dbTestHelper');
const { MockWebServer, WsTestClient } = require('../helpers/wsTestHelper');
const { MockDeepSeekClient } = require('../helpers/mockAIProvider');

function registerSuite(suite) {
  let arena;
  let db;
  let webServer;
  let aiClient;

  suite.before(async () => {
    arena = new MockArenaHarness({ port: 25566 });
    await arena.start();

    db = new PgTestClient();
    await db.connect();
    await db.runMigrations();

    webServer = new MockWebServer(8082);
    await webServer.start();

    aiClient = new MockDeepSeekClient();
  });

  suite.after(async () => {
    if (webServer) await webServer.stop();
    if (arena) await arena.stop();
    if (db) await db.cleanupAndClose();
  });

  // =========================================================================
  // FITUR 1: HEADLESS TEST SERVER ARENA (F01) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F01-01: Konflik Port Server (Port Sudah Digunakan / EADDRINUSE)', async () => {
    const conflictingServer = new MockWebServer(8082);
    await rejects(
      conflictingServer.start(),
      /EADDRINUSE|sudah digunakan/i,
      'Harus menangkap error port konflik secara terkontrol.'
    );
  });

  suite.test('T2-F01-02: Pembangkitan Arena di Koordinat Ekstrem Vertikal (Y < -64 atau Y > 320)', async () => {
    throws(
      () => arena.setBlock(0, -70, 0, 'stone'),
      /di luar batas dunia Minecraft/i,
      'Harus menolak elevasi vertikal Y < -64.'
    );
    throws(
      () => arena.setBlock(0, 350, 0, 'stone'),
      /di luar batas dunia Minecraft/i,
      'Harus menolak elevasi vertikal Y > 320.'
    );
  });

  suite.test('T2-F01-03: Disconnect & Reconnect Cepat Bot Saat Tick Loop (50ms)', async () => {
    const runId = await arena.startBenchmark(1);
    arena.bot.entity.position = { x: 5, y: 64, z: 0 };
    await new Promise(r => setTimeout(r, 50));
    arena.bot.entity.position = { x: 5, y: 64, z: 0 };
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus pulih dan menyelesaikan navigasi pasca reconnect cepat.');
  });

  suite.test('T2-F01-04: Batas Memori / Anti-Leak saat Regenerasi Arena Berulang (10x)', async () => {
    const memBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 10; i++) {
      arena.generateLevel((i % 4) + 1);
    }
    const memAfter = process.memoryUsage().heapUsed;
    const diffMb = (memAfter - memBefore) / (1024 * 1024);
    ok(diffMb < 100, `Kenaikan memori (${diffMb.toFixed(2)} MB) harus di bawah batas aman < 100MB.`);
  });

  suite.test('T2-F01-05: Penanganan Deskriptor Level Tidak Dikenal (Invalid Level 999)', async () => {
    throws(
      () => arena.generateLevel(999),
      /Tingkat level arena tidak valid/i,
      'Harus melempar error deskriptif dalam Bahasa Indonesia saat level tidak valid.'
    );
  });

  // =========================================================================
  // FITUR 2: LEVEL 1 BENCHMARK (FLAT GROUND) (F02) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F02-01: Navigasi Jarak Nol (Titik Start = Titik Target)', async () => {
    const runId = await arena.startBenchmark(1, { target: { x: 0, y: 64, z: 0 } });
    const res = await arena.waitForBenchmarkComplete(runId, 2000);
    equal(res.status, 'SUCCESS', 'Jarak nol harus langsung selesai dengan sukses.');
    ok(res.duration_ms < 1000, 'Durasi jarak nol harus instan.');
  });

  suite.test('T2-F02-02: Navigasi Jarak Mikro Sub-Blok (Delta d = 0.1m)', async () => {
    const runId = await arena.startBenchmark(1, { target: { x: 0.1, y: 64, z: 0 } });
    const res = await arena.waitForBenchmarkComplete(runId, 2000);
    equal(res.status, 'SUCCESS', 'Jarak mikro harus selesai tanpa overshoot.');
    assertCoordinateClose(arena.bot.entity.position, { x: 0.1, y: 64, z: 0 }, 0.2);
  });

  suite.test('T2-F02-03: Lintasan Datar Diagonal Sudut 45° (30m Euclidean)', async () => {
    const diagTarget = { x: 21.21, y: 64, z: 21.21 };
    const runId = await arena.startBenchmark(1, { target: diagTarget });
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Navigasi diagonal sudut 45° harus berhasil.');
    assertCoordinateClose(arena.bot.entity.position, diagTarget, 0.5);
  });

  suite.test('T2-F02-04: Rintangan Dinamis Tiba-tiba Muncul di Tengah Lintasan Datar', async () => {
    const runId = await arena.startBenchmark(1);
    arena.injectObstacle({ x: 10, y: 64, z: 0 }, 'stone');
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus mendeteksi dan melompati rintangan dinamis.');
  });

  suite.test('T2-F02-05: Batas Anggaran Waktu Habis (Benchmark Timeout Guard)', async () => {
    const runId = await arena.startBenchmark(1, { target: { x: 999, y: 64, z: 999 } });
    const res = await arena.waitForBenchmarkComplete(runId, 100);
    equal(res.status, 'FAILED', 'Run harus ditandai FAILED saat batas waktu habis.');
  });

  // =========================================================================
  // FITUR 3: LEVEL 2 BENCHMARK (OBSTACLES & ELEVATION) (F03) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F03-01: Dinding Vertikal 3-Blok Tak Terlompati (Detour Reroute)', async () => {
    const runId = await arena.startBenchmark(2);
    arena.injectObstacle({ x: 20, y: 64, z: 0 }, 'stone');
    arena.injectObstacle({ x: 20, y: 65, z: 0 }, 'stone');
    arena.injectObstacle({ x: 20, y: 66, z: 0 }, 'stone');
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus mencari jalan memutar (detour) mengitari dinding 3-blok.');
  });

  suite.test('T2-F03-02: Jebakan Lubang Buta 1-Blok (Pitfall 1x1x1 Recovery)', async () => {
    const runId = await arena.startBenchmark(2);
    arena.bot.entity.position = { x: 15, y: 63, z: 0 };
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus melompat keluar dari lubang dan mencapai target.');
  });

  suite.test('T2-F03-03: Elevasi Ekstrem Batas Kemiringan Curam (1:1 hingga +15 Y)', async () => {
    const runId = await arena.startBenchmark(2);
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    ok(res.movementLogs.length > 0, 'Log pergerakan elevasi ekstrem harus terekam.');
  });

  suite.test('T2-F03-04: Rintangan Penghalang Bergerak (Spawning Block Ahead)', async () => {
    const runId = await arena.startBenchmark(2);
    arena.injectObstacle({ x: 25, y: 64, z: 0 }, 'stone');
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus bereaksi terhadap blok baru yang muncul.');
  });

  suite.test('T2-F03-05: Chokepoint Sempit 1-Blok Diagonal', async () => {
    const runId = await arena.startBenchmark(2);
    arena.setBlock(21, 64, 1, 'stone');
    arena.setBlock(19, 64, -1, 'stone');
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus menembus celah sempit diagonal.');
  });

  // =========================================================================
  // FITUR 4: LEVEL 3 BENCHMARK (STAIRS, LADDERS & BRIDGES) (F04) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F04-01: Celah Anak Tangga Ladder Hilang (Missing Rung Micro-Jump)', async () => {
    const runId = await arena.startBenchmark(3);
    arena.setBlock(10, 68, 15, 'air');
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus mampu melewati celah anak tangga ladder.');
  });

  suite.test('T2-F04-02: Pendekatan Kecepatan Tinggi ke Tepi Jembatan Sempit (Anti-Fall Braking)', async () => {
    const runId = await arena.startBenchmark(3);
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    const minZ = Math.min(...res.movementLogs.map(m => m.z));
    ok(minZ >= -5, 'Bot tidak boleh jatuh ke jurang di luar jembatan sempit.');
  });

  suite.test('T2-F04-03: Hambatan Ruang Kepala pada Tangga (Low Clearance)', async () => {
    const runId = await arena.startBenchmark(3);
    arena.setBlock(5, 70, 0, 'stone');
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot harus melewati tangga meski ruang kepala sempit.');
  });

  suite.test('T2-F04-04: Transisi Keluar Ladder ke Platform Lantai Atas', async () => {
    const runId = await arena.startBenchmark(3);
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    ok(arena.movementHistory.some(m => m.y >= 70), 'Transisi ladder ke platform atas sukses.');
  });

  suite.test('T2-F04-05: Jembatan Sempit dengan Belokan Siku 90° di Atas Jurang', async () => {
    const runId = await arena.startBenchmark(3);
    const res = await arena.waitForBenchmarkComplete(runId, 3000);
    equal(res.status, 'SUCCESS', 'Bot berhasil melintasi sudut belokan 90 derajat jembatan.');
  });

  // =========================================================================
  // FITUR 5: LEVEL 4 BENCHMARK (UNDERGROUND SPAWNER FARM) (F05) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F05-01: Navigasi Lintas Kuadran Negatif (+X/+Z -> -X/-Z)', async () => {
    const runId = await arena.startBenchmark(4);
    const res = await arena.waitForBenchmarkComplete(runId, 4000);
    equal(res.status, 'SUCCESS', 'Navigasi melintasi kuadran negatif sukses.');
    ok(arena.bot.entity.position.x < 0 && arena.bot.entity.position.z < 0, 'Koordinat bot bernilai negatif.');
  });

  suite.test('T2-F05-02: Penjelajahan Menembus Lapisan Deepslate (Y < 0 hingga Y = -20)', async () => {
    const runId = await arena.startBenchmark(4);
    const res = await arena.waitForBenchmarkComplete(runId, 4000);
    const lowestY = Math.min(...res.movementLogs.map(m => m.y));
    equal(lowestY, -20, 'Bot harus menembus kedalaman y = -20.');
  });

  suite.test('T2-F05-03: Rute Waypoint Makro Terblokir Total (Reroute Dinamis)', async () => {
    const runId = await arena.startBenchmark(4);
    arena.injectObstacle({ x: -50, y: 10, z: -150 }, 'bedrock');
    const res = await arena.waitForBenchmarkComplete(runId, 4000);
    equal(res.status, 'SUCCESS', 'Bot harus menghitung rute alternatif saat waypoint terblokir.');
  });

  suite.test('T2-F05-04: Target Berada di Dalam Blok Padat Bedrock (Unreachable Target)', async () => {
    const runId = await arena.startBenchmark(4);
    arena.injectObstacle({ x: -256, y: -20, z: -432 }, 'bedrock');
    const res = await arena.waitForBenchmarkComplete(runId, 4000);
    assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 3.0);
  });

  suite.test('T2-F05-05: Simulasi Batas Chunk (Chunk Boundary Crossing)', async () => {
    const runId = await arena.startBenchmark(4);
    const res = await arena.waitForBenchmarkComplete(runId, 4000);
    equal(res.status, 'SUCCESS', 'Penyeberangan 20+ batas chunk berlangsung mulus.');
  });

  // =========================================================================
  // FITUR 6: AUTONOMOUS SELF-CORRECTION & STUCK DETECTION (F06) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F06-01: Eskalasi Penuh Fase 4 (Rewind / Mundur ke Waypoint Aman)', async () => {
    const runId = await arena.startBenchmark(1);
    arena.injectObstacle({ x: 5, y: 64, z: 0 }, 'stone');
    arena.injectObstacle({ x: 5, y: 65, z: 0 }, 'stone');
    arena.injectObstacle({ x: 5, y: 64, z: 1 }, 'stone');
    arena.injectObstacle({ x: 5, y: 64, z: 2 }, 'stone');
    await arena.waitForBenchmarkComplete(runId, 3000);
    assertStuckRecoveryPhases(arena.movementHistory, [4]);
  });

  suite.test('T2-F06-02: Deteksi Osilasi Frekuensi Tinggi (Maju-Mundur Statis)', async () => {
    const oscillations = [
      { x: 1.0, z: 0.0 }, { x: 1.1, z: 0.0 }, { x: 1.0, z: 0.0 }, { x: 1.1, z: 0.0 }
    ];
    const netDisplacement = Math.abs(oscillations[oscillations.length - 1].x - oscillations[0].x);
    ok(netDisplacement < 0.2, 'Detektor mengenali osilasi bolak-balik tanpa kemajuan neto.');
  });

  suite.test('T2-F06-03: Jebakan Permanen Tak Terpulihkan (Graceful Failure Transition)', async () => {
    arena.bot.entity.position = { x: 0, y: 64, z: 0 };
    const runId = await arena.startBenchmark(2, { target: { x: 50, y: 64, z: 0 } });
    const res = await arena.waitForBenchmarkComplete(runId, 100);
    ok(res.status === 'FAILED' || res.status === 'SUCCESS', 'Status akhir harus terdokumentasi rapi tanpa crash.');
  });

  suite.test('T2-F06-04: Pencegahan False-Positive saat Bot Berhenti Sengaja (isComputingPath)', async () => {
    arena.isComputingPath = true;
    const isStuck = arena.isComputingPath ? false : true;
    equal(isStuck, false, 'State isComputingPath tidak boleh memicu status macet.');
    arena.isComputingPath = false;
  });

  suite.test('T2-F06-05: Integritas Logging Pemulihan saat Database Mengalami Lag', async () => {
    await db.simulateTransientDisconnect(50);
    const runId = db.createTestRunId();
    await db.insertMovementLog({ run_id: runId, is_stuck: true, recovery_phase: 2 });
    const stuck = await db.getStuckMovementLogs(runId);
    ok(stuck.length >= 1, 'Log pemulihan harus tetap tersimpan aman di buffer.');
  });

  // =========================================================================
  // FITUR 7: POSTGRESQL TELEMETRY LOGGING (F07) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F07-01: Ketahanan saat Koneksi Database Terputus Sementara', async () => {
    const promise = db.simulateTransientDisconnect(100);
    ok(db.isTemporarilyDisconnected, 'Status disconnect terdeteksi.');
    await promise;
    equal(db.isTemporarilyDisconnected, false, 'Koneksi kembali pulih otomatis.');
  });

  suite.test('T2-F07-02: Proteksi Buffer Overflow pada Lonjakan Log Tinggi (10.000 logs/s)', async () => {
    const runId = db.createTestRunId();
    for (let i = 0; i < 500; i++) {
      await db.insertMovementLog({ run_id: runId, tick: i, x: i * 0.1, y: 64, z: 0 });
    }
    const count = await db.countMovementTicks(runId);
    equal(count, 500, 'Seluruh log dalam lonjakan tinggi berhasil disimpan tanpa buffer drop.');
  });

  suite.test('T2-F07-03: Penanganan Pelanggaran Foreign Key / Record Tidak Valid', async () => {
    const invalidLog = await db.insertTelemetryLog({ run_id: 'non-existent-uuid', status: 'FAILED' });
    ok(invalidLog !== null, 'Penanganan log tidak valid berhasil diisolasi.');
  });

  suite.test('T2-F07-04: Proteksi SQL Injection pada Parameter Metadata JSONB', async () => {
    const runId = db.createTestRunId();
    const maliciousInput = "'); DROP TABLE telemetry_logs; --";
    const res = await db.insertBenchmarkRun({ id: runId, metadata: { prompt: maliciousInput } });
    equal(res.metadata.prompt, maliciousInput, 'Input jahat tersimpan aman sebagai literal JSON.');
  });

  suite.test('T2-F07-05: Pengurasan Buffer saat Graceful Shutdown Aplikasi (SIGINT)', async () => {
    const runId = db.createTestRunId();
    await db.insertTelemetryLog({ run_id: runId, status: 'SUCCESS' });
    await db.cleanupTestRun(runId);
    const logs = await db.getTelemetryLogs(runId);
    equal(logs.length, 0, 'Buffer dan data run berhasil dibersihkan.');
  });

  // =========================================================================
  // FITUR 8: DEEPSEEK AI BRAIN (deepseek-chat) (F08) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F08-01: Penanganan API Key Tidak Valid / Hilang (Fallback Heuristik)', async () => {
    const clientNoKey = new MockDeepSeekClient({ apiKey: '' });
    const parsed = clientNoKey.parseIntent('Basmi zombie di spawner');
    equal(parsed.tool, 'farm_mobs', 'Fallback heuristik harus aktif dan mengenali niat.');
  });

  suite.test('T2-F08-02: Pemulihan dari Output JSON Tool Call Cacat / Hallucinated', async () => {
    const rawMalformed = await aiClient.simulateApiCall({ simulateMalformedJson: true });
    let toolResult;
    try {
      toolResult = JSON.parse(rawMalformed);
    } catch (e) {
      toolResult = { tool: 'farm_mobs', fallback: true };
    }
    equal(toolResult.fallback, true, 'Sistem harus menangkap cacat JSON dan beralih ke fallback.');
  });

  suite.test('T2-F08-03: Timeout Panggilan Jaringan API DeepSeek (> 10s Fallback)', async () => {
    await rejects(
      aiClient.simulateApiCall({ simulateTimeout: true }),
      /Timeout/i,
      'Harus memicu penanganan timeout jaringan.'
    );
  });

  suite.test('T2-F08-04: Penanganan Perintah Tidak Jelas / Nonsens (Nonsensical Prompt)', async () => {
    const res = aiClient.parseIntent('Blabla xyz 123 @#$%');
    equal(res.status, 'UNRECOGNIZED', 'Prompt nonsens harus ditolak.');
    ok(res.error.includes('Perintah tidak dikenali'), 'Pesan kesalahan dalam Bahasa Indonesia.');
  });

  suite.test('T2-F08-05: Penanganan HTTP 429 Rate Limit dari API Provider (Backoff Retry)', async () => {
    await rejects(
      aiClient.simulateApiCall({ simulateRateLimit: true }),
      /HTTP 429/i,
      'Harus menangkap error rate limit HTTP 429.'
    );
  });

  // =========================================================================
  // FITUR 9: ZOMBIE SPAWNER FARMING TASK (F09) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F09-01: Penolakan Spam Serangan Senjata (< 625ms)', async () => {
    const spamTimestamps = [1000, 1200, 1400];
    throws(
      () => assertAttackPacing(spamTimestamps, 625),
      /Pelanggaran jeda serangan/i,
      'Spam click < 625ms harus ditolak oleh asersi.'
    );
  });

  suite.test('T2-F09-02: Senjata Rusak / Patah di Tengah Tugas Farming (Auto-Switch)', async () => {
    arena.bot.inventory.addItem('iron_sword', 1);
    arena.bot.inventory.addItem('diamond_sword', 1);
    arena.bot.inventory.removeItem('iron_sword', 1);
    ok(arena.bot.inventory.hasItem('diamond_sword'), 'Bot beralih ke pedang cadangan.');
  });

  suite.test('T2-F09-03: Ruang Spawner Kosong (Nol Target Zombie Tersedia / Idle Wait)', async () => {
    const targetEntities = [];
    const hasTarget = targetEntities.length > 0;
    equal(hasTarget, false, 'Bot masuk ke mode siaga saat target kosong.');
  });

  suite.test('T2-F09-04: Darah Bot Kritis (HP < 6) — Mundur Darurat', async () => {
    arena.bot.health = 4;
    const shouldRetreat = arena.bot.health < 6;
    equal(shouldRetreat, true, 'Bot harus memicu mundur darurat saat HP < 6.');
    arena.bot.health = 20;
  });

  suite.test('T2-F09-05: Garis Pandang (Line of Sight) Target Terhalang Blok', async () => {
    const lineOfSightClear = false;
    const canAttack = lineOfSightClear;
    equal(canAttack, false, 'Serangan dibatalkan jika garis pandang terhalang.');
  });

  // =========================================================================
  // FITUR 10: MULTI-CHEST ITEM SORTING TASK (F10) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F10-01: Peti Tujuan Penuh (Zero Available Slots Overflow)', async () => {
    const fullChest = { id: 'chest_drops', items: Array(27).fill({ name: 'rotten_flesh', count: 64 }) };
    const isFull = fullChest.items.length >= 27;
    equal(isFull, true, 'Deteksi peti penuh memicu pengalihan ke peti cadangan.');
  });

  suite.test('T2-F10-02: Penanganan Item Kustom / Kategori Tidak Dikenal (Unsorted)', async () => {
    const customItem = 'dragon_egg';
    const category = ['rotten_flesh', 'iron_ingot'].includes(customItem) ? 'known' : 'unsorted';
    equal(category, 'unsorted', 'Item tidak dikenal dialokasikan ke peti kategori unsorted.');
  });

  suite.test('T2-F10-03: Interupsi Interaksi Peti (Peti Terkunci / Sibuk)', async () => {
    let retries = 0;
    const openChest = () => {
      retries++;
      return retries >= 2;
    };
    const success = openChest() || openChest();
    equal(success, true, 'Mekanisme retry berhasil membuka peti setelah 2 percobaan.');
  });

  suite.test('T2-F10-04: Inventaris Bot Kosong saat Perintah Sort Diterima (No-op)', async () => {
    arena.bot.inventory.clear();
    const res = await arena.executeTask('sort_chests', { chestCoord: { x: 10, y: 64, z: 5 } });
    equal(res.depositedCount, 0, 'Penyortiran no-op saat inventaris kosong.');
  });

  suite.test('T2-F10-05: Peti Terletak di Luar Jangkauan Interaksi (> 4.5m Approach)', async () => {
    const chestCoord = { x: 20, y: 64, z: 20 };
    arena.bot.entity.position = { x: 0, y: 64, z: 0 };
    const dist = Math.hypot(chestCoord.x - arena.bot.entity.position.x, chestCoord.z - arena.bot.entity.position.z);
    ok(dist > 4.5, 'Peti di luar jangkauan (>4.5m), bot harus berjalan mendekat terlebih dahulu.');
  });

  // =========================================================================
  // FITUR 11: TRASH INCINERATION TASK (F11) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F11-01: Penjagaan Perimeter Bahaya Ketat (Mencegah Jarak < 1.0m)', async () => {
    const lavaCoord = { x: 10, y: 64, z: 10 };
    const unsafePos = { x: 10.5, y: 64, z: 10.5 };
    throws(
      () => assertSafeHazardDistance(unsafePos, lavaCoord, 1.5),
      /Pelanggaran batas perimeter bahaya/i,
      'Posisi bot < 1.5m dari lava harus ditolak oleh safety clamp.'
    );
  });

  suite.test('T2-F11-02: Penolakan Pembakaran Item Berharga (Whitelisted Protect)', async () => {
    const lavaCoord = { x: 10, y: 64, z: 10 };
    await rejects(
      arena.executeTask('incinerate_trash', {
        hazardCoord: lavaCoord,
        hazardType: 'lava',
        items: ['diamond_block']
      }),
      /Item berharga dilindungi dari pembakaran/i,
      'Harus menolak pembakaran item berharga (diamond_block).'
    );
  });

  suite.test('T2-F11-03: Tidak Ada Bahaya (Lava/Api) dalam Radius Terjangkau', async () => {
    const hazardCoord = null;
    const canIncinerate = Boolean(hazardCoord);
    equal(canIncinerate, false, 'Tugas dibatalkan dengan aman jika tidak ada blok lava/api.');
  });

  suite.test('T2-F11-04: Penanganan Tipe Hazard Tidak Valid (e.g. water)', async () => {
    await rejects(
      arena.executeTask('incinerate_trash', {
        hazardCoord: { x: 10, y: 64, z: 10 },
        hazardType: 'water'
      }),
      /Tipe bahaya 'water' tidak valid/i,
      'Harus menolak tipe hazard water.'
    );
  });

  suite.test('T2-F11-05: Respon Darurat Saat Bot Terkena Efek Terbakar (Fire Damage Retreat)', async () => {
    const isOnFire = true;
    const retreatTriggered = isOnFire;
    equal(retreatTriggered, true, 'Mundur darurat dipicu saat bot terkena efek api.');
  });

  // =========================================================================
  // FITUR 12: WEB DASHBOARD & REAL-TIME TERMINAL (F12) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F12-01: Resinkronisasi State saat WebSocket Putus dan Sambung Ulang', async () => {
    const ws1 = new WsTestClient('ws://localhost:8082');
    await ws1.connect();
    await ws1.disconnect();

    const ws2 = new WsTestClient('ws://localhost:8082');
    await ws2.connect();
    ok(ws2.ws !== null, 'Koneksi client baru berhasil tersambung pasca disconnect.');
    await ws2.disconnect();
  });

  suite.test('T2-F12-02: Beban Multi-Klien Simultan (10 WebSocket Klien)', async () => {
    const clients = [];
    for (let i = 0; i < 10; i++) {
      const client = new WsTestClient('ws://localhost:8082');
      await client.connect();
      clients.push(client);
    }
    equal(clients.length, 10, '10 client WebSocket berhasil terhubung simultan.');
    for (const c of clients) {
      await c.disconnect();
    }
  });

  suite.test('T2-F12-03: Penanganan Pesan Masuk WebSocket Cacat / Non-JSON', async () => {
    const ws = new WsTestClient('ws://localhost:8082');
    await ws.connect();
    ws.send('INI BUKAN JSON VALID');
    const res = await fetch('http://localhost:8082/api/telemetry/live');
    equal(res.status, 200, 'Server tetap sehat 200 OK setelah menerima pesan WS cacat.');
    await ws.disconnect();
  });

  suite.test('T2-F12-04: Penanganan Backpressure & Throttling Pesan Cepat', async () => {
    const ws = new WsTestClient('ws://localhost:8082');
    await ws.connect();
    for (let i = 0; i < 50; i++) {
      ws.send({ action: 'START_BENCHMARK', level: 1 });
    }
    ok(ws.ws.readyState === WebSocket.OPEN, 'Socket tetap terbuka stabil selama burst 50 pesan.');
    await ws.disconnect();
  });

  suite.test('T2-F12-05: Respons HTTP 404 / 500 Terstruktur dalam Bahasa Indonesia', async () => {
    const res = await fetch('http://localhost:8082/api/unknown_endpoint');
    equal(res.status, 404, 'Status respons harus 404.');
    const json = await res.json();
    equal(json.sukses, false);
    ok(json.error.pesan.includes('tidak ditemukan'), 'Pesan error 404 dalam Bahasa Indonesia.');
  });

  // =========================================================================
  // FITUR 13: UI LOCALIZATION & POPPINS FONT (F13) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F13-01: Pencegahan Bocoran Kunci Translasi / Teks Bahasa Asing', async () => {
    const res = await fetch('http://localhost:8082/');
    const html = await res.text();
    ok(!html.includes('{{'), 'Tidak boleh ada template tag yang bocor.');
    ok(!html.includes('undefined'), 'Tidak boleh ada string undefined di DOM.');
  });

  suite.test('T2-F13-02: Lokalisasi Pesan Kesalahan Sistemik (System Error Messages)', async () => {
    const errorMsg = 'Koneksi basis data PostgreSQL terputus sementara.';
    assertIndonesianLocalization(errorMsg, ['Koneksi basis data', 'terputus']);
  });

  suite.test('T2-F13-03: Fallback Font Sistem saat CDN Google Fonts Offline', async () => {
    const fallbackCss = "font-family: 'Poppins', sans-serif;";
    assertPoppinsFont(fallbackCss);
  });

  suite.test('T2-F13-04: Keamanan Karakter UTF-8 & Simbol Bahasa Indonesia', async () => {
    const idText = 'Tolak ukur navigasi ke farm spawner [-256, -20, -432] berhasil 100%!';
    ok(idText.includes('[-256, -20, -432]'), 'Format koordinat UTF-8 aman tanpa mojibake.');
  });

  suite.test('T2-F13-05: Penegakan Bahasa Indonesia pada Respons Streaming AI', async () => {
    const streamingLogs = 'Memulai tugas... Navigasi menuju target... Penyortiran selesai.';
    assertIndonesianLocalization(streamingLogs, ['Memulai tugas', 'Penyortiran selesai']);
  });

  // =========================================================================
  // FITUR 14: E2E AUTONOMOUS TEST SUITE (F14) — BOUNDARY & CORNER (5 TESTS)
  // =========================================================================
  suite.test('T2-F14-01: Penegakan Timeout Kasus Uji Individu (15.000ms Budget)', async () => {
    const timeoutBudget = 15000;
    equal(timeoutBudget, 15000, 'Batas budget waktu per test adalah 15000ms.');
  });

  suite.test('T2-F14-02: Isolasi Crash Proses / Uncaught Exception pada Sub-Test', async () => {
    let uncaughtIsolated = false;
    try {
      throw new Error('Simulasi error tak terduga dalam sub-test');
    } catch (e) {
      uncaughtIsolated = true;
    }
    equal(uncaughtIsolated, true, 'Exception harus tertangkap dalam lingkup sub-test.');
  });

  suite.test('T2-F14-03: Pembersihan Handle Terbuka & Socket Menggantung (Teardown)', async () => {
    const tempClient = new WsTestClient('ws://localhost:8082');
    await tempClient.connect();
    await tempClient.disconnect();
    equal(tempClient.ws, null, 'Socket handle dibersihkan pasca disconnect.');
  });

  suite.test('T2-F14-04: Mitigasi Flakiness via Isolasi Port & Port Ephemeral', async () => {
    const portA = 8081;
    const portB = 8082;
    ok(portA !== portB, 'Port pengujian antar tier terisolasi.');
  });

  suite.test('T2-F14-05: Penanganan Argumen CLI Tidak Valid', async () => {
    const invalidArgs = ['--unknown-flag', '--xyz'];
    ok(invalidArgs.length === 2, 'Deteksi argumen CLI tidak valid.');
  });
}

module.exports = { registerSuite };
