/**
 * Suite Pengujian E2E Tier 4: Skenario Beban Nyata (Real-World Workload Scenarios)
 * Menguji 7 skenario komprehensif beban dunia nyata (T4-SCEN-01 s/d T4-SCEN-07).
 *
 * Menguji skenario:
 * 1. Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom (5x L1, 1x L2, 1x L3, 1x L4)
 * 2. Pipeline Lengkap: Farming, Looting, Sorting & Incineration
 * 3. Navigasi Gua Vertikal dengan Pemulihan Rintangan Dinamis Berulang
 * 4. AI Multi-Task Planner dengan Simulasi Gangguan API & Failover
 * 5. Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database
 * 6. Sesi Observasi & Kontrol Dasbor Multi-Klien Simultan (5 Klien)
 * 7. Disaster Recovery: Restart Server Headless & Resumsi Misi Otonom
 *
 * Seluruh kode pengujian, deskripsi, dan pesan asersi dalam Bahasa Indonesia baku.
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
    arena = new MockArenaHarness({ port: 25568 });
    await arena.start();

    db = new PgTestClient();
    await db.connect();
    await db.runMigrations();

    webServer = new MockWebServer(8084);
    await webServer.start();

    aiClient = new MockDeepSeekClient();
  });

  suite.after(async () => {
    if (webServer) await webServer.stop();
    if (arena) await arena.stop();
    if (db) await db.cleanupAndClose();
  });

  // =========================================================================
  // T4-SCEN-01: Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom
  // =========================================================================
  suite.test('T4-SCEN-01: Progresi Penuh Kurikulum Benchmark Level 1–4 Otonom', async () => {
    const executedRuns = [];

    // 1. Level 1: 5 Kali Uji Datar 30m Berturut-turut (100% Success Rate)
    for (let i = 0; i < 5; i++) {
      const runId = await arena.startBenchmark(1);
      const res = await arena.waitForBenchmarkComplete(runId, 5000);
      equal(res.status, 'SUCCESS', `Uji Level 1 run ke-${i + 1} harus SUCCESS.`);
      await db.insertBenchmarkRun({
        id: runId,
        level: '1',
        status: res.status,
        duration_ms: res.duration_ms,
        success_rate: 1.0
      });
      executedRuns.push(runId);
    }

    // 2. Level 2: 50m dengan Rintangan & Elevasi
    const runIdL2 = await arena.startBenchmark(2);
    const resL2 = await arena.waitForBenchmarkComplete(runIdL2, 6000);
    equal(resL2.status, 'SUCCESS', 'Uji Level 2 harus SUCCESS.');
    await db.insertBenchmarkRun({
      id: runIdL2,
      level: '2',
      status: resL2.status,
      duration_ms: resL2.duration_ms,
      success_rate: 1.0
    });
    executedRuns.push(runIdL2);

    // 3. Level 3: Tangga Balok, Tiang Ladder (+10Y/-10Y), Jembatan Sempit 15m
    const runIdL3 = await arena.startBenchmark(3);
    const resL3 = await arena.waitForBenchmarkComplete(runIdL3, 6000);
    equal(resL3.status, 'SUCCESS', 'Uji Level 3 harus SUCCESS.');
    await db.insertBenchmarkRun({
      id: runIdL3,
      level: '3',
      status: resL3.status,
      duration_ms: resL3.duration_ms,
      success_rate: 1.0
    });
    executedRuns.push(runIdL3);

    // 4. Level 4: Penjelajahan Jarak Jauh ke Spawner Cave [-256, -20, -432]
    const runIdL4 = await arena.startBenchmark(4);
    const resL4 = await arena.waitForBenchmarkComplete(runIdL4, 8000);
    equal(resL4.status, 'SUCCESS', 'Uji Level 4 harus SUCCESS.');
    await db.insertBenchmarkRun({
      id: runIdL4,
      level: '4',
      status: resL4.status,
      duration_ms: resL4.duration_ms,
      success_rate: 1.0
    });
    executedRuns.push(runIdL4);

    equal(executedRuns.length, 8, 'Total 8 run benchmark harus selesai dieksekusi.');
    assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 0.6);
  });

  // =========================================================================
  // T4-SCEN-02: Pipeline Lengkap: Farming, Looting, Sorting & Incineration
  // =========================================================================
  suite.test('T4-SCEN-02: Pipeline Lengkap: Farming, Looting, Sorting & Incineration', async () => {
    // 1. Perintah Teks Melalui Terminal AI
    const commandText = 'Lakukan rutinitas pembersihan farm zombie dan rapikan penyimpanan!';
    const plan = await aiClient.planMultiStepTask(commandText);
    ok(plan.totalSteps >= 4, 'AI Planner harus menghasilkan alur kerja pemeliharaan 4 tahap.');

    // 2. Eksekusi Rutinitas Lengkap
    const res = await arena.runFullMaintenanceRoutine();
    equal(res.farmingComplete, true, 'Farming zombie harus berhasil.');
    equal(res.sortingComplete, true, 'Penyortiran ke peti harus berhasil.');
    equal(res.trashIncinerated, true, 'Pembakaran sampah beracun harus berhasil.');
    equal(res.botDamaged, false, 'Bot tidak boleh terluka oleh api/lava.');

    // 3. Verifikasi Isi Peti
    const chestTools = arena.getChestByCoord({ x: 12, y: 64, z: 5 });
    ok(chestTools.items.some(i => i.name === 'iron_helmet'), 'Helm besi tersimpan di peti.');
    ok(chestTools.items.some(i => i.name === 'iron_ingot'), 'Batangan besi tersimpan di peti.');

    // 4. Verifikasi Tas Bot Bersih dari Kentang Beracun
    equal(arena.bot.inventory.getItemCount('poisonous_potato'), 0, 'Sampah beracun musnah total.');
  });

  // =========================================================================
  // T4-SCEN-03: Navigasi Gua Vertikal dengan Pemulihan Rintangan Dinamis Berulang
  // =========================================================================
  suite.test('T4-SCEN-03: Navigasi Gua Vertikal dengan Pemulihan Rintangan Dinamis Berulang', async () => {
    const runId = await arena.startBenchmark(2);
    // Injeksi 3 jenis halangan dinamis
    arena.injectObstacle({ x: 14, y: 64, z: 0 }, 'stone'); // Rintangan 1: Di batas elevasi
    arena.injectObstacle({ x: 20, y: 65, z: 2 }, 'stone'); // Rintangan 2: Di titik belokan
    arena.injectObstacle({ x: 28, y: 65, z: 0 }, 'stone'); // Rintangan 3: Di turunan

    const res = await arena.waitForBenchmarkComplete(runId, 6000);
    equal(res.status, 'SUCCESS', 'Bot harus mampu mengatasi 3 rintangan dan mencapai target.');
    ok(res.stuckCount >= 1, 'Mekanisme pemulihan harus aktif saat mendeteksi rintangan.');
  });

  // =========================================================================
  // T4-SCEN-04: AI Multi-Task Planner dengan Simulasi Gangguan API & Failover
  // =========================================================================
  suite.test('T4-SCEN-04: AI Multi-Task Planner dengan Simulasi Gangguan API & Failover', async () => {
    const complexPrompt = 'Periksa peti nomor 1, ambil semua pedang besi, lalu bawa ke koordinat [-250, 64, 100] untuk berjaga-jaga!';

    // Simulasikan API DeepSeek Eksternal Gagal (HTTP 503 / Timeout)
    const fallbackClient = new MockDeepSeekClient({ apiKey: '' });
    const plan = await fallbackClient.planMultiStepTask(complexPrompt);

    equal(plan.status, 'MOCK_PLAN_READY', 'Fallback heuristik lokal harus aktif dan menghasilkan rencana.');
    ok(plan.steps.length >= 3, 'Langkah kerja terurai dengan benar.');

    // Eksekusi Rencana Heuristik
    const execRes = await arena.executeTask('sort_chests', { chestCoord: { x: 1, y: 64, z: 1 } });
    equal(execRes.success, true, 'Eksekusi rencana failover berhasil diselesaikan.');
  });

  // =========================================================================
  // T4-SCEN-05: Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database
  // =========================================================================
  suite.test('T4-SCEN-05: Endurance Telemetri Frekuensi Tinggi & Uji Putus Koneksi Database', async () => {
    const runId = db.createTestRunId();

    // 1. Aliran Data Telemetri Cepat
    for (let i = 0; i < 200; i++) {
      await db.insertMovementLog({
        run_id: runId,
        tick: i,
        x: Math.sin(i * 0.1) * 10,
        y: 64,
        z: Math.cos(i * 0.1) * 10,
        velocity_xz: 4.3
      });
    }

    // 2. Simulasi Terputus Koneksi DB Sementara
    const disconnectPromise = db.simulateTransientDisconnect(150);
    equal(db.isTemporarilyDisconnected, true, 'Status database terputus sementara.');

    // 3. Masukkan Data saat DB Sedang Terputus (Disimpan di Buffer Shadow)
    for (let i = 200; i < 300; i++) {
      await db.insertMovementLog({
        run_id: runId,
        tick: i,
        x: i * 0.1,
        y: 64,
        z: 0,
        velocity_xz: 4.3
      });
    }

    await disconnectPromise;
    equal(db.isTemporarilyDisconnected, false, 'Koneksi database pulih otomatis.');

    // 4. Verifikasi Seluruh 300 Tick Berhasil Disimpan Tanpa Kehilangan Data
    const totalCount = await db.countMovementTicks(runId);
    equal(totalCount, 300, 'Total 300 tick telemetri harus utuh di database (zero data loss).');
  });

  // =========================================================================
  // T4-SCEN-06: Sesi Observasi & Kontrol Dasbor Multi-Klien Simultan
  // =========================================================================
  suite.test('T4-SCEN-06: Sesi Observasi & Kontrol Dasbor Multi-Klien Simultan', async () => {
    // 1. Koneksikan 5 Klien WebSocket Sekaligus
    const clients = [];
    for (let i = 0; i < 5; i++) {
      const c = new WsTestClient('ws://localhost:8084');
      await c.connect();
      clients.push(c);
    }
    equal(clients.length, 5, '5 WebSocket klien berhasil terhubung secara simultan.');

    // 2. Klien 1 Mengirim Perintah Mulai Tolak Ukur
    clients[0].send({ action: 'START_BENCHMARK', level: 2 });

    // 3. Klien 2 Polling REST API
    const resApi = await fetch('http://localhost:8084/api/telemetry/live');
    equal(resApi.status, 200, 'Polling REST API Klien 2 sukses 200 OK.');

    // 4. Klien 3 Mengirim Perintah Chat AI
    clients[2].send({ action: 'SUBMIT_AI_COMMAND', prompt: 'Status bot saat ini apa?' });

    // 5. Verifikasi Broadcast Diterima Bersama
    webServer.broadcast({
      type: 'TICK_UPDATE',
      data: { tick: 99, position: { x: 10, y: 64, z: 0 }, velocity: 4.3 }
    });

    const eventC4 = await clients[3].waitForEvent('TICK_UPDATE', 2000);
    const eventC5 = await clients[4].waitForEvent('TICK_UPDATE', 2000);

    equal(eventC4.data.tick, 99, 'Klien 4 menerima posisi bot yang sinkron.');
    equal(eventC5.data.tick, 99, 'Klien 5 menerima posisi bot yang sinkron.');

    // Bersihkan Seluruh Koneksi Klien
    for (const c of clients) {
      await c.disconnect();
    }
  });

  // =========================================================================
  // T4-SCEN-07: Disaster Recovery: Restart Server Headless & Resumsi Misi Otonom
  // =========================================================================
  suite.test('T4-SCEN-07: Disaster Recovery: Restart Server Headless & Resumsi Misi Otonom', async () => {
    // 1. Mulai Misi Jarak Jauh Level 4 Menuju Spawner
    const runId = await arena.startBenchmark(4);

    // 2. Simulasikan Perjalanan hingga Kedalaman Antara (y = -5)
    arena.bot.entity.position = { x: -180, y: -5, z: -320 };
    const intermediatePos = { ...arena.bot.entity.position };

    // 3. Simulasikan Crash & Restart Server Headless Arena
    await arena.stop();
    await arena.start();

    // 4. Resumsi Misi dari Titik Aman Terakhir
    arena.bot.entity.position = intermediatePos;
    const resumeRunId = await arena.startBenchmark(4, {
      runId: `resumed-${runId}`,
      target: { x: -256, y: -20, z: -432 }
    });

    const res = await arena.waitForBenchmarkComplete(resumeRunId, 8000);
    equal(res.status, 'SUCCESS', 'Misi harus berhasil diselesaikan pasca-restart server.');
    assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 0.6);
  });
}

module.exports = { registerSuite };
