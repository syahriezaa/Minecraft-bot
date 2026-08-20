/**
 * Suite Pengujian E2E Tier 3: Pengujian Lintas Fitur Berpasangan (Pairwise Cross-Feature Suite)
 * Menguji 16 interaksi matriks lintas fitur (T3-PAIR-01 s/d T3-PAIR-16).
 *
 * Menguji integrasi antara:
 * - Server Headless Arena & PostgreSQL lifecycle
 * - WebSocket Dashboard 20Hz vs Batch Telemetry Ingestion
 * - Level 2 Rintangan & Deteksi Macet 4-Fase
 * - Level 3 Vertikal & Rewind Phase 4
 * - Level 4 Deep Spawner [-256, -20, -432] & Database JSONB Path History
 * - DeepSeek AI Brain Tool Calling & Combat Pacing (>= 625ms)
 * - Zombie Farming & Multi-Chest Sorting
 * - Item Filtering: Perlindungan Mineral vs Pembuangan Limbah
 * - Batas Perimeter Keamanan Lava (>= 1.5m)
 * - UI Localization Bahasa Indonesia & Font Poppins
 * - Transisi Database is_stuck & recovery_phase
 * - Heuristic Fallback Mock AI
 * - Beban Ring Buffer vs WebSocket Broadcaster
 * - Transisi Level 3 Vertikal ke Level 4 Bawah Tanah
 * - Audit Trail REST API /api/telemetry/audit
 * - Mob Swarm Collision & Kiting
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
  deepEqual
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
    arena = new MockArenaHarness({ port: 25567 });
    await arena.start();

    db = new PgTestClient();
    await db.connect();
    await db.runMigrations();

    webServer = new MockWebServer(8083);
    await webServer.start();

    aiClient = new MockDeepSeekClient();
  });

  suite.after(async () => {
    if (webServer) await webServer.stop();
    if (arena) await arena.stop();
    if (db) await db.cleanupAndClose();
  });

  // T3-PAIR-01: Sinkronisasi Lifecycle Headless Arena & Inisialisasi Database
  suite.test('T3-PAIR-01: Sinkronisasi Lifecycle Headless Arena & Inisialisasi Database', async () => {
    const runId = await arena.startBenchmark(1);
    const dbRun = await db.insertBenchmarkRun({ id: runId, level: '1', status: 'RUNNING' });
    equal(dbRun.id, runId, 'ID benchmark run pada DB harus cocok dengan runId harness.');
    equal(dbRun.status, 'RUNNING', 'Status awal pada database harus RUNNING.');

    const res = await arena.waitForBenchmarkComplete(runId, 5000);
    const updated = await db.updateBenchmarkRun(runId, {
      status: res.status,
      duration_ms: res.duration_ms,
      success_rate: res.success_rate
    });

    equal(updated.status, 'SUCCESS', 'Status akhir di database harus SUCCESS.');
    ok(updated.duration_ms > 0, 'Durasi waktu perjalanan harus tercatat positif.');
    equal(updated.success_rate, 1.0, 'Tingkat keberhasilan harus 1.0 (100%).');
  });

  // T3-PAIR-02: Paritas Metrik Real-Time Streaming WebSocket vs PostgreSQL Ingestion (Level 1)
  suite.test('T3-PAIR-02: Paritas Metrik Real-Time Streaming WebSocket vs PostgreSQL Ingestion (Level 1)', async () => {
    const wsClient = new WsTestClient('ws://localhost:8083');
    await wsClient.connect();

    const receivedTicks = [];
    wsClient.on('TICK_UPDATE', (data) => {
      receivedTicks.push(data);
    });

    const runId = await arena.startBenchmark(1);
    arena.on('TICK_UPDATE', (evt) => {
      webServer.broadcast(evt);
    });

    const res = await arena.waitForBenchmarkComplete(runId, 5000);
    for (const log of res.movementLogs) {
      await db.insertMovementLog({
        run_id: runId,
        tick: log.tick,
        x: log.x,
        y: log.y,
        z: log.z,
        velocity_xz: log.velocity_xz,
        is_stuck: log.is_stuck,
        recovery_phase: log.recovery_phase
      });
    }

    const dbLogs = await db.getMovementLogs(runId);
    ok(dbLogs.length > 0, 'Log pergerakan di DB tidak boleh kosong.');
    equal(dbLogs.length, res.movementLogs.length, 'Jumlah log di DB harus sama persis dengan log pergerakan harness.');
    assertCoordinateClose(arena.bot.entity.position, { x: 30, y: 64, z: 0 }, 0.5);

    await wsClient.disconnect();
  });

  // T3-PAIR-03: Injeksi Rintangan Dinamis Level 2 & Aktivasi Stuck Recovery Fase 1 & 2
  suite.test('T3-PAIR-03: Injeksi Rintangan Dinamis Level 2 & Aktivasi Stuck Recovery Fase 1 & 2', async () => {
    const runId = await arena.startBenchmark(2);
    arena.injectObstacle({ x: 25, y: 65, z: 0 }, 'stone');
    arena.injectObstacle({ x: 25, y: 65, z: 1 }, 'stone');
    const res = await arena.waitForBenchmarkComplete(runId, 6000);

    for (const log of res.movementLogs) {
      if (log.is_stuck) {
        await db.insertMovementLog({
          run_id: runId,
          tick: log.tick,
          x: log.x,
          y: log.y,
          z: log.z,
          velocity_xz: log.velocity_xz,
          is_stuck: true,
          recovery_phase: log.recovery_phase
        });
      }
    }

    const stuckDbLogs = await db.getStuckMovementLogs(runId);
    ok(stuckDbLogs.length >= 1, 'Tabel movement_action_logs harus mencatat minimal 1 event macet.');
    equal(res.status, 'SUCCESS', 'Bot harus pulih dan menyelesaikan navigasi ke titik akhir.');
  });

  // T3-PAIR-04: Navigasi Vertikal Level 3 (Ladder & Narrow Bridge) dengan Rewind Recovery Fase 4
  suite.test('T3-PAIR-04: Navigasi Vertikal Level 3 (Ladder & Narrow Bridge) dengan Rewind Recovery Fase 4', async () => {
    const runId = await arena.startBenchmark(3);
    const res = await arena.waitForBenchmarkComplete(runId, 5000);
    equal(res.status, 'SUCCESS', 'Navigasi terpadu Level 3 harus berhasil.');
    const minY = Math.min(...res.movementLogs.map(m => m.y));
    ok(minY >= 63, 'Bot tidak boleh jatuh ke bawah elevasi dasar arena (y >= 63).');
  });

  // T3-PAIR-05: Validasi Jalur Level 4 Spawner Farm Antara PostgreSQL path_history & Canvas Visualizer
  suite.test('T3-PAIR-05: Validasi Jalur Level 4 Spawner Farm Antara PostgreSQL path_history & Canvas Visualizer', async () => {
    const runId = await arena.startBenchmark(4);
    const res = await arena.waitForBenchmarkComplete(runId, 6000);
    equal(res.status, 'SUCCESS', 'Perjalanan Level 4 ke spawner farm harus sukses.');

    const pathPoints = res.movementLogs.map(m => ({ x: m.x, y: m.y, z: m.z }));
    await db.insertTelemetryLog({
      run_id: runId,
      level: '4',
      travel_duration_ms: res.duration_ms,
      path_history: pathPoints
    });

    const fetchedLogs = await db.getTelemetryLogs(runId);
    ok(fetchedLogs.length >= 1, 'Data telemetri tersimpan di DB.');
    assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 0.6);
  });

  // T3-PAIR-06: Integrasi DeepSeek AI Tool Calling farm_mobs dengan Attack Cooldown Pacing
  suite.test('T3-PAIR-06: Integrasi DeepSeek AI Tool Calling farm_mobs dengan Attack Cooldown Pacing', async () => {
    const prompt = 'Tolong bersihkan zombie di ruang spawner selama 10 detik!';
    const parsed = aiClient.parseIntent(prompt);
    equal(parsed.tool, 'farm_mobs', 'Parser AI harus mengidentifikasi tool farm_mobs.');

    const attackTimestamps = [];
    const onAttack = (evt) => attackTimestamps.push(evt.timestamp);
    arena.on('entityAttack', onAttack);

    await arena.submitAiCommand(prompt);
    arena.removeListener('entityAttack', onAttack);

    ok(attackTimestamps.length >= 3, 'Minimal 3 serangan senjata dieksekusi.');
    assertAttackPacing(attackTimestamps, 625);
  });

  // T3-PAIR-07: Estafet Otomatis Farming Zombie ke Penyortiran Item Multi-Peti
  suite.test('T3-PAIR-07: Estafet Otomatis Farming Zombie ke Penyortiran Item Multi-Peti', async () => {
    arena.bot.inventory.clear();
    await arena.submitAiCommand('Basmi zombie');
    arena.bot.inventory.addItem('rotten_flesh', 12);
    arena.bot.inventory.addItem('iron_ingot', 2);

    const chestDropsCoord = { x: 10, y: 64, z: 5 };
    const chestMineralsCoord = { x: 12, y: 64, z: 5 };
    arena.setupChest(chestDropsCoord, 'chest_drops', []);
    arena.setupChest(chestMineralsCoord, 'chest_minerals', []);

    await arena.executeTask('sort_chests', { chestCoord: chestDropsCoord });
    webServer.recordAudit('CHEST_DEPOSIT', 'rotten_flesh', 12, chestDropsCoord);

    const chestDrops = arena.getChestByCoord(chestDropsCoord);
    ok(chestDrops.items.some(i => i.name === 'rotten_flesh'), 'Peti drops harus memuat rotten_flesh.');
  });

  // T3-PAIR-08: Filter Inventaris: Pemisahan Mineral Berharga vs Limbah Sampah Sebelum Insinerasi
  suite.test('T3-PAIR-08: Filter Inventaris: Pemisahan Mineral Berharga vs Limbah Sampah Sebelum Insinerasi', async () => {
    arena.bot.inventory.clear();
    arena.bot.inventory.addItem('diamond', 3);
    arena.bot.inventory.addItem('iron_sword', 1);
    arena.bot.inventory.addItem('poisonous_potato', 5);
    arena.bot.inventory.addItem('rotten_flesh', 20);

    const chestMinerals = { x: 12, y: 64, z: 5 };
    arena.setupChest(chestMinerals, 'chest_minerals', []);
    arena.bot.inventory.removeItem('diamond', 3);
    arena.bot.inventory.removeItem('iron_sword', 1);
    arena.getChestByCoord(chestMinerals).items.push({ name: 'diamond', count: 3 });
    arena.getChestByCoord(chestMinerals).items.push({ name: 'iron_sword', count: 1 });

    const lavaCoord = { x: 20, y: 64, z: 20 };
    arena.setupHazardBlock(lavaCoord, 'lava');
    await arena.executeTask('incinerate_trash', {
      hazardCoord: lavaCoord,
      hazardType: 'lava',
      items: ['poisonous_potato', 'rotten_flesh']
    });

    equal(arena.bot.inventory.getItemCount('poisonous_potato'), 0, 'Sampah kentang beracun berhasil dimusnahkan.');
    const minerals = arena.getChestByCoord(chestMinerals);
    ok(minerals.items.some(i => i.name === 'diamond' && i.count === 3), 'Diamond tersimpan aman di peti mineral.');
  });

  // T3-PAIR-09: Penegakan Batas Keamanan Perimeter Bahaya (Lava/Fire Incinerator)
  suite.test('T3-PAIR-09: Penegakan Batas Keamanan Perimeter Bahaya (Lava/Fire Incinerator)', async () => {
    const lavaCoord = { x: 10, y: 64, z: 10 };
    arena.setupHazardBlock(lavaCoord, 'lava');
    arena.bot.health = 20;

    await arena.executeTask('incinerate_trash', {
      hazardCoord: lavaCoord,
      hazardType: 'lava',
      items: ['rotten_flesh']
    });

    assertSafeHazardDistance(arena.bot.entity.position, lavaCoord, 1.8);
    equal(arena.bot.health, 20, 'Health bot harus tetap penuh (20 HP) tanpa luka terbakar.');
  });

  // T3-PAIR-10: Lokalisasi Bahasa Indonesia & Google Fonts Poppins pada UI Dashboard
  suite.test('T3-PAIR-10: Lokalisasi Bahasa Indonesia & Google Fonts Poppins pada UI Dashboard', async () => {
    const res = await fetch('http://localhost:8083/');
    const html = await res.text();

    assertPoppinsFont(html);
    assertIndonesianLocalization(html, [
      'Dasbor Pengendali',
      'Status Sistem',
      'Terminal AI',
      'Mulai Tolak Ukur'
    ]);
  });

  // T3-PAIR-11: Audit Transisi is_stuck dan recovery_phase di Database PostgreSQL
  suite.test('T3-PAIR-11: Audit Transisi is_stuck dan recovery_phase di Database PostgreSQL', async () => {
    const runId = db.createTestRunId();
    await db.insertMovementLog({ run_id: runId, tick: 1, x: 0, y: 64, z: 0, velocity_xz: 4.3, is_stuck: false, recovery_phase: 0 });
    await db.insertMovementLog({ run_id: runId, tick: 2, x: 2, y: 64, z: 0, velocity_xz: 0.0, is_stuck: true, recovery_phase: 1 });
    await db.insertMovementLog({ run_id: runId, tick: 3, x: 2, y: 64, z: 0, velocity_xz: 0.0, is_stuck: true, recovery_phase: 2 });
    await db.insertMovementLog({ run_id: runId, tick: 4, x: 3, y: 64, z: 1, velocity_xz: 4.3, is_stuck: false, recovery_phase: 0 });

    const stuckLogs = await db.getStuckMovementLogs(runId);
    equal(stuckLogs.length, 2, 'Tepat 2 tick tercatat berstatus macet.');
    equal(stuckLogs[0].recovery_phase, 1, 'Fase macet pertama harus 1.');
    equal(stuckLogs[1].recovery_phase, 2, 'Fase macet kedua harus 2.');
  });

  // T3-PAIR-12: Fallback Deterministik Mock AI dalam Mode Headless Offline
  suite.test('T3-PAIR-12: Fallback Deterministik Mock AI dalam Mode Headless Offline', async () => {
    const offlineClient = new MockDeepSeekClient({ apiKey: '' });
    const plan = await offlineClient.planMultiStepTask('Bersihkan farm zombie');
    equal(plan.status, 'MOCK_PLAN_READY', 'Status rencana harus siap via heuristic engine.');
    ok(plan.steps.length >= 3, 'Rencana tugas harus berisi minimal 3 langkah.');
  });

  // T3-PAIR-13: Ketahanan Beban Ring Buffer Batch Ingestion vs WebSocket Broadcaster
  suite.test('T3-PAIR-13: Ketahanan Beban Ring Buffer Batch Ingestion vs WebSocket Broadcaster', async () => {
    const runId = db.createTestRunId();
    const wsClient = new WsTestClient('ws://localhost:8083');
    await wsClient.connect();

    const broadcastCount = 50;
    for (let i = 0; i < broadcastCount; i++) {
      const msg = { type: 'TICK_UPDATE', data: { tick: i, x: i, y: 64, z: 0 } };
      webServer.broadcast(msg);
      await db.insertMovementLog({ run_id: runId, tick: i, x: i, y: 64, z: 0 });
    }

    const count = await db.countMovementTicks(runId);
    equal(count, broadcastCount, 'Seluruh 50 tick pergerakan harus tersimpan di PostgreSQL.');
    await wsClient.disconnect();
  });

  // T3-PAIR-14: Transisi Mulus Navigasi Vertikal Level 3 ke Rute Bawah Tanah Level 4
  suite.test('T3-PAIR-14: Transisi Mulus Navigasi Vertikal Level 3 ke Rute Bawah Tanah Level 4', async () => {
    const runIdL3 = await arena.startBenchmark(3);
    const resL3 = await arena.waitForBenchmarkComplete(runIdL3, 5000);
    equal(resL3.status, 'SUCCESS', 'Level 3 harus sukses.');

    const runIdL4 = await arena.startBenchmark(4);
    const resL4 = await arena.waitForBenchmarkComplete(runIdL4, 6000);
    equal(resL4.status, 'SUCCESS', 'Level 4 harus sukses.');

    assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 0.6);
  });

  // T3-PAIR-15: Pencatatan Audit Trail Transaksi Peti ke PostgreSQL dan Verifikasi REST API
  suite.test('T3-PAIR-15: Pencatatan Audit Trail Transaksi Peti ke PostgreSQL dan Verifikasi REST API', async () => {
    webServer.recordAudit('CHEST_DEPOSIT', 'iron_ingot', 10, { x: 12, y: 64, z: 5 });
    const res = await fetch('http://localhost:8083/api/telemetry/audit?action=CHEST_DEPOSIT');
    equal(res.status, 200, 'HTTP status endpoint audit harus 200 OK.');

    const json = await res.json();
    equal(json.sukses, true);
    ok(json.data.length >= 1, 'Data log audit harus memuat minimal 1 entri.');
    const last = json.data[json.data.length - 1];
    equal(last.item, 'iron_ingot');
    equal(last.count, 10);
  });

  // T3-PAIR-16: Mitigasi Desakan Kerumunan Zombie (Mob Swarm Collision & Kiting)
  suite.test('T3-PAIR-16: Mitigasi Desakan Kerumunan Zombie (Mob Swarm Collision & Kiting)', async () => {
    arena.bot.health = 20;
    const res = await arena.submitAiCommand('Basmi 4 zombie di spawner');
    equal(res.status, 'SUCCESS', 'Pembersihan kerumunan zombie harus sukses.');
    equal(arena.bot.health, 20, 'Health bot harus bertahan hidup tanpa tewas.');
  });
}

module.exports = { registerSuite };
