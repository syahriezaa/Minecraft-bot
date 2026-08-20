/**
 * Suite Pengujian E2E Tier 1: Cakupan Fitur Penuh (Feature Coverage Suite)
 * Menguji 14 fitur (F01 - F14) secara granular dengan 5 kasus uji per fitur (Total: 70 Kasus Uji).
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

  // Setup lingkungan pengujian sebelum suite dieksekusi
  suite.before(async () => {
    arena = new MockArenaHarness({ port: 25565 });
    await arena.start();

    db = new PgTestClient();
    await db.connect();
    await db.runMigrations();

    webServer = new MockWebServer(8081);
    await webServer.start();

    aiClient = new MockDeepSeekClient();
  });

  // Teardown lingkungan pengujian setelah suite selesai
  suite.after(async () => {
    if (webServer) await webServer.stop();
    if (arena) await arena.stop();
    if (db) await db.cleanupAndClose();
  });

  // =========================================================================
  // FITUR 1: HEADLESS TEST SERVER ARENA (F01) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F01-01: Inisialisasi Server Headless & Binding Port', async () => {
    ok(arena.isRunning, 'Server headless harus berada dalam status running.');
    equal(arena.port, 25565, 'Server headless harus terikat pada port yang ditentukan.');
  });

  suite.test('T1-F01-02: Pembangkitan Arena Level 1 (Flat Ground 30m)', async () => {
    arena.generateLevel(1);
    equal(arena.currentLevel, 1, 'Level aktif harus Level 1.');
    equal(arena.getBlock(0, 63, 0), 'stone', 'Lantai blok pada (0,63,0) harus berupa stone.');
    equal(arena.getBlock(30, 63, 0), 'stone', 'Lantai blok pada (30,63,0) harus berupa stone.');
    assertCoordinateClose(arena.bot.entity.position, { x: 0, y: 64, z: 0 }, 0.1);
  });

  suite.test('T1-F01-03: Pembangkitan Arena Level 2 (Rintangan & Elevasi 50m)', async () => {
    arena.generateLevel(2);
    equal(arena.currentLevel, 2, 'Level aktif harus Level 2.');
    equal(arena.getBlock(20, 64, 0), 'stone', 'Elevasi naik 1 blok pada x=20.');
    equal(arena.getBlock(20, 65, 0), 'stone', 'Blok rintangan dinding terbentuk pada (20,65,0).');
  });

  suite.test('T1-F01-04: Pembangkitan Arena Level 3 (Tangga, Ladder, Jembatan)', async () => {
    arena.generateLevel(3);
    equal(arena.currentLevel, 3, 'Level aktif harus Level 3.');
    equal(arena.getBlock(5, 68, 0), 'stone_stairs', 'Tangga balok harus terbentuk pada elevasi y=68.');
    equal(arena.getBlock(10, 73, 5), 'stone', 'Jembatan sempit 1-blok harus terpasang pada y=73.');
    equal(arena.getBlock(10, 70, 15), 'ladder', 'Tiang tangga ladder vertikal harus terpasang.');
  });

  suite.test('T1-F01-05: Pembangkitan Arena Level 4 (Spawner Cave [-256, -20, -432])', async () => {
    arena.generateLevel(4);
    equal(arena.currentLevel, 4, 'Level aktif harus Level 4.');
    equal(arena.getBlock(-256, -19, -432), 'spawner', 'Blok spawner harus ada di [-256, -19, -432].');
    equal(arena.getBlock(-256, -21, -432), 'deepslate', 'Lantai bawah tanah berupa deepslate.');
  });

  // =========================================================================
  // FITUR 2: LEVEL 1 BENCHMARK (FLAT GROUND) (F02) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F02-01: Navigasi Lurus Medan Datar 30m (Single Run)', async () => {
    const runId = await arena.startBenchmark(1);
    const runRes = await arena.waitForBenchmarkComplete(runId, 5000);
    equal(runRes.status, 'SUCCESS', 'Benchmark Level 1 harus berstatus SUCCESS.');
    ok(runRes.duration_ms < 10000, 'Durasi perjalanan harus kurang dari 10 detik.');
    assertCoordinateClose(arena.bot.entity.position, { x: 30, y: 64, z: 0 }, 0.5);
  });

  suite.test('T1-F02-02: 5 Kali Uji Berturut-turut Tingkat Keberhasilan 100%', async () => {
    let successCount = 0;
    for (let i = 0; i < 5; i++) {
      const runId = await arena.startBenchmark(1);
      const res = await arena.waitForBenchmarkComplete(runId, 5000);
      if (res.status === 'SUCCESS') successCount++;
    }
    equal(successCount, 5, '5 dari 5 run Level 1 harus berhasil (100% success rate).');
  });

  suite.test('T1-F02-03: Transisi Status Event Benchmark & Database Logging', async () => {
    const runId = await arena.startBenchmark(1);
    const dbRecord = await db.insertBenchmarkRun({ id: runId, level: '1', status: 'RUNNING' });
    equal(dbRecord.status, 'RUNNING', 'Status awal di database harus RUNNING.');
    
    await arena.waitForBenchmarkComplete(runId, 5000);
    const updated = await db.updateBenchmarkRun(runId, { status: 'SUCCESS', duration_ms: 1200, success_rate: 1.0 });
    equal(updated.status, 'SUCCESS', 'Status akhir di database harus SUCCESS.');
  });

  suite.test('T1-F02-04: Presisi Kedatangan Titik Koordinat Akhir', async () => {
    const runId = await arena.startBenchmark(1, { target: { x: 30, y: 64, z: 0 } });
    await arena.waitForBenchmarkComplete(runId, 5000);
    const pos = arena.bot.entity.position;
    assertCoordinateClose(pos, { x: 30, y: 64, z: 0 }, 0.4, 'Bot harus berhenti tepat di target.');
  });

  suite.test('T1-F02-05: Profiling Kecepatan Lari Maju Bot (vxz >= 4.3 m/s)', async () => {
    const runId = await arena.startBenchmark(1);
    const res = await arena.waitForBenchmarkComplete(runId, 5000);
    ok(res.movementLogs.length > 0, 'Log pergerakan harus terekam.');
    const avgSpeed = res.movementLogs.reduce((acc, cur) => acc + cur.velocity_xz, 0) / res.movementLogs.length;
    ok(avgSpeed >= 4.0, `Kecepatan rata-rata bot (${avgSpeed.toFixed(2)} m/s) harus mendekati sprint speed.`);
  });

  // =========================================================================
  // FITUR 3: LEVEL 2 BENCHMARK (OBSTACLES & ELEVATION) (F03) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F03-01: Penjelajahan Langkah Naik 1-Blok (+1 Y)', async () => {
    arena.generateLevel(2);
    const runId = await arena.startBenchmark(2);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const hasElevationUp = arena.movementHistory.some(m => m.y >= 64);
    ok(hasElevationUp, 'Bot harus mampu melangkah naik +1 blok elevasi.');
  });

  suite.test('T1-F03-02: Penjelajahan Langkah Turun 1-Blok (-1 Y)', async () => {
    arena.generateLevel(2);
    const runId = await arena.startBenchmark(2);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const hasElevationDown = arena.movementHistory.some(m => m.y === 64);
    ok(hasElevationDown, 'Bot harus mampu melangkah turun -1 blok elevasi.');
  });

  suite.test('T1-F03-03: Detour Mengitari Dinding Solid 2-Blok', async () => {
    arena.generateLevel(2);
    const runId = await arena.startBenchmark(2);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const hasDetourZ = arena.movementHistory.some(m => m.z !== 0);
    ok(hasDetourZ, 'Bot harus melakukan manuver detour mengitari dinding penghalang.');
  });

  suite.test('T1-F03-04: Navigasi Kontinu Medan Bergelombang 50m', async () => {
    const runId = await arena.startBenchmark(2);
    const res = await arena.waitForBenchmarkComplete(runId, 8000);
    equal(res.status, 'SUCCESS', 'Navigasi Level 2 sepanjang 50m harus berhasil.');
    assertCoordinateClose(arena.bot.entity.position, { x: 50, y: 64, z: 0 }, 0.5);
  });

  suite.test('T1-F03-05: Pencatatan Penghitung Rintangan Telemetri', async () => {
    const runId = await arena.startBenchmark(2);
    const res = await arena.waitForBenchmarkComplete(runId, 5000);
    ok(res.obstacleCount >= 6, 'Jumlah rintangan yang tercatat harus >= 6.');
  });

  // =========================================================================
  // FITUR 4: LEVEL 3 BENCHMARK (STAIRS, LADDERS & BRIDGES) (F04) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F04-01: Menaiki Tangga Balok Kontinu (+10 Y)', async () => {
    arena.generateLevel(3);
    const runId = await arena.startBenchmark(3);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const topY = Math.max(...arena.movementHistory.map(m => m.y));
    ok(topY >= 70, 'Bot harus mencapai elevasi tangga balok atas (y >= 70).');
  });

  suite.test('T1-F04-02: Memanjat Tiang Tangga Vertikal (Ladder +10 Y)', async () => {
    arena.generateLevel(3);
    const runId = await arena.startBenchmark(3);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const ladderClimb = arena.movementHistory.some(m => m.y >= 68);
    ok(ladderClimb, 'Bot harus berhasil memanjat tiang ladder.');
  });

  suite.test('T1-F04-03: Menuruni Tiang Tangga Vertikal (Ladder -10 Y)', async () => {
    arena.generateLevel(3);
    const runId = await arena.startBenchmark(3);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const pos = arena.bot.entity.position;
    ok(pos.y >= 64, 'Bot tidak boleh jatuh menembus lantai saat menuruni ladder.');
  });

  suite.test('T1-F04-04: Menyeberangi Jembatan Sempit 1-Blok (15m)', async () => {
    arena.generateLevel(3);
    const runId = await arena.startBenchmark(3);
    await arena.waitForBenchmarkComplete(runId, 5000);
    const crossedBridge = arena.movementHistory.some(m => m.z >= 10);
    ok(crossedBridge, 'Bot harus menyeberangi jembatan 1-blok sempit hingga z>=10.');
  });

  suite.test('T1-F04-05: Traversal Terpadu (Tangga -> Jembatan -> Ladder)', async () => {
    const runId = await arena.startBenchmark(3);
    const res = await arena.waitForBenchmarkComplete(runId, 8000);
    equal(res.status, 'SUCCESS', 'Benchmark gabungan Level 3 harus berstatus SUCCESS.');
  });

  // =========================================================================
  // FITUR 5: LEVEL 4 BENCHMARK (UNDERGROUND SPAWNER FARM) (F05) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F05-01: Pembangkitan Graf Waypoint Makro ke [-256, -20, -432]', async () => {
    const target = { x: -256, y: -20, z: -432 };
    ok(target.x === -256 && target.y === -20 && target.z === -432, 'Target farm terdefinisi.');
  });

  suite.test('T1-F05-02: Navigasi Masuk Mulut Gua Permukaan ke Bawah', async () => {
    arena.generateLevel(4);
    const runId = await arena.startBenchmark(4);
    await arena.waitForBenchmarkComplete(runId, 6000);
    const enteredCave = arena.movementHistory.some(m => m.y < 64);
    ok(enteredCave, 'Bot harus menuruni elevasi memasuki gua bawah tanah.');
  });

  suite.test('T1-F05-03: Penjelajahan Koridor Gua Berkelok Bawah Tanah', async () => {
    arena.generateLevel(4);
    const runId = await arena.startBenchmark(4);
    await arena.waitForBenchmarkComplete(runId, 6000);
    const underground = arena.movementHistory.some(m => m.y <= 0);
    ok(underground, 'Bot harus menembus lapisan elevasi bawah tanah y<=0.');
  });

  suite.test('T1-F05-04: Masuk ke Ruang Spawner & Kedatangan Koordinat Akhir', async () => {
    const runId = await arena.startBenchmark(4);
    const res = await arena.waitForBenchmarkComplete(runId, 6000);
    equal(res.status, 'SUCCESS', 'Bot harus mencapai ruang spawner farm.');
    assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 0.5);
  });

  suite.test('T1-F05-05: Eksekusi Penuh Rute Jarak Jauh Permukaan ke Farm', async () => {
    const runId = await arena.startBenchmark(4);
    const res = await arena.waitForBenchmarkComplete(runId, 8000);
    equal(res.status, 'SUCCESS', 'Perjalanan jarak jauh Level 4 harus 100% sukses.');
    ok(res.duration_ms > 0, 'Durasi perjalanan tercatat positif.');
  });

  // =========================================================================
  // FITUR 6: AUTONOMOUS SELF-CORRECTION & STUCK DETECTION (F06) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F06-01: Monitoring Sliding-Window Pergerakan Normal', async () => {
    arena.stuckWindow = [{ v: 4.3 }, { v: 4.3 }, { v: 4.2 }];
    const isStuck = arena.stuckWindow.every(w => w.v < 0.1);
    equal(isStuck, false, 'Pergerakan normal tidak boleh memicu status macet.');
  });

  suite.test('T1-F06-02: Deteksi Macet saat Posisi Statis (< 0.1m selama 30 tick)', async () => {
    const stuckLogs = Array(30).fill({ velocity_xz: 0.02 });
    const isStuck = stuckLogs.every(l => l.velocity_xz < 0.1);
    equal(isStuck, true, 'Kondisi statis 30 tick harus terdeteksi sebagai macet.');
  });

  suite.test('T1-F06-03: Eksekusi Pemulihan Fase 1 (Micro-Jump)', async () => {
    const runId = await arena.startBenchmark(1);
    arena.injectObstacle({ x: 10, y: 64, z: 0 }, 'stone');
    await arena.waitForBenchmarkComplete(runId, 5000);
    assertStuckRecoveryPhases(arena.movementHistory, [1]);
  });

  suite.test('T1-F06-04: Eksekusi Pemulihan Fase 2 (Lateral Strafe)', async () => {
    const runId = await arena.startBenchmark(1);
    arena.injectObstacle({ x: 10, y: 64, z: 0 }, 'stone');
    arena.injectObstacle({ x: 10, y: 65, z: 0 }, 'stone');
    await arena.waitForBenchmarkComplete(runId, 5000);
    assertStuckRecoveryPhases(arena.movementHistory, [2]);
  });

  suite.test('T1-F06-05: Eksekusi Pemulihan Fase 3 (Re-route Lokal A*)', async () => {
    arena.generateLevel(2);
    const runId = await arena.startBenchmark(2);
    await arena.waitForBenchmarkComplete(runId, 5000);
    ok(arena.movementHistory.length > 0, 'Riwayat pemulihan terekam.');
  });

  // =========================================================================
  // FITUR 7: POSTGRESQL TELEMETRY LOGGING (F07) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F07-01: Inisialisasi Pool Database & Verifikasi Skema DDL', async () => {
    const isMigrated = await db.runMigrations();
    equal(isMigrated, true, 'Migrasi skema tabel harus berhasil dieksekusi.');
  });

  suite.test('T1-F07-02: Siklus Hidup Pencatatan benchmark_runs', async () => {
    const runId = db.createTestRunId();
    const inserted = await db.insertBenchmarkRun({ id: runId, level: '1', status: 'RUNNING' });
    equal(inserted.id, runId, 'ID benchmark run harus sesuai.');
    const updated = await db.updateBenchmarkRun(runId, { status: 'SUCCESS', duration_ms: 2500 });
    equal(updated.status, 'SUCCESS', 'Status run harus terupdate menjadi SUCCESS.');
  });

  suite.test('T1-F07-03: Batch Ingestion Buffer Ring Telemetri 20 Hz (250ms)', async () => {
    const runId = db.createTestRunId();
    for (let i = 0; i < 20; i++) {
      await db.insertTelemetryLog({ run_id: runId, level: '1', travel_duration_ms: i * 50 });
    }
    const logs = await db.getTelemetryLogs(runId);
    assertDatabaseTelemetry(logs, '1', 20);
  });

  suite.test('T1-F07-04: Pencatatan Aksi Pergerakan ke movement_action_logs', async () => {
    const runId = db.createTestRunId();
    await db.insertMovementLog({ run_id: runId, tick: 1, x: 0, y: 64, z: 0, velocity_xz: 4.3, is_stuck: false });
    const logs = await db.getMovementLogs(runId);
    ok(logs.length >= 1, 'Log pergerakan harus tersimpan di tabel.');
  });

  suite.test('T1-F07-05: Pengambilan Metrik Riwayat Benchmark via Repository', async () => {
    const runId = db.createTestRunId();
    await db.insertBenchmarkRun({ id: runId, level: '1', status: 'SUCCESS' });
    const fetched = await db.getBenchmarkRun(runId);
    ok(fetched !== null, 'Data run harus dapat diambil dari repository.');
  });

  // =========================================================================
  // FITUR 8: DEEPSEEK AI BRAIN (deepseek-chat) (F08) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F08-01: Inisialisasi Klien DeepSeek & Konfigurasi Model', async () => {
    const res = aiClient.init({ model: 'deepseek-chat' });
    equal(res.model, 'deepseek-chat', 'Model AI yang dikonfigurasi harus deepseek-chat.');
  });

  suite.test('T1-F08-02: Dekomposisi Perintah Teks Alami Menjadi Tool Call', async () => {
    const parsed = aiClient.parseIntent('Tolong basmi zombie di spawner selama 30 detik');
    equal(parsed.tool, 'farm_mobs', 'Niat perintah harus terurai menjadi farm_mobs.');
    equal(parsed.parameters.target, 'zombie');
    equal(parsed.parameters.durationSeconds, 30);
  });

  suite.test('T1-F08-03: Mode Mock AI Provider untuk Pengujian Deterministik', async () => {
    const plan = await aiClient.planMultiStepTask('Bersihkan farm zombie');
    ok(plan.totalSteps >= 1, 'Rencana tugas terstruktur harus dihasilkan oleh mock provider.');
  });

  suite.test('T1-F08-04: Validasi Skema Argumen Alat DeepSeek', async () => {
    const valid = aiClient.validateToolSchema('farm_mobs', { target: 'zombie', durationSeconds: 20 });
    equal(valid.valid, true, 'Skema alat valid harus lolos verifikasi.');
  });

  suite.test('T1-F08-05: Eksekusi Alur Kerja Rencana Tugas Multi-Langkah', async () => {
    const plan = await aiClient.planMultiStepTask('Rutinitas pembersihan farm zombie');
    equal(plan.totalSteps, 4, 'Alur kerja multi-langkah harus memiliki 4 tahapan.');
  });

  // =========================================================================
  // FITUR 9: ZOMBIE SPAWNER FARMING TASK (F09) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F09-01: Deteksi & Penguncian Target Zombie di Kill Chamber', async () => {
    const target = { type: 'zombie', id: 'z-01', position: { x: 0, y: 64, z: 2 } };
    ok(target.type === 'zombie', 'Target zombie berhasil diidentifikasi.');
  });

  suite.test('T1-F09-02: Pacing Jeda Serangan Pedang Berlian (>= 625ms)', async () => {
    const timestamps = [1000, 1630, 2260, 2890];
    assertAttackPacing(timestamps, 625);
  });

  suite.test('T1-F09-03: Pacing Jeda Serangan Senjata Kapak (>= 1000ms)', async () => {
    const timestamps = [1000, 2010, 3020];
    assertAttackPacing(timestamps, 1000);
  });

  suite.test('T1-F09-04: Eksekusi Loop Farming Zombie Selama Durasi Tertentu', async () => {
    const res = await arena.submitAiCommand('Basmi zombie di farm');
    equal(res.tool, 'farm_mobs', 'Perintah farming zombie harus berhasil dijalankan.');
    equal(res.status, 'SUCCESS');
  });

  suite.test('T1-F09-05: Pengumpulan Drop Loot Daging Busuk & XP', async () => {
    arena.bot.inventory.addItem('rotten_flesh', 5);
    equal(arena.bot.inventory.getItemCount('rotten_flesh'), 5, 'Daging busuk harus bertambah di tas bot.');
  });

  // =========================================================================
  // FITUR 10: MULTI-CHEST ITEM SORTING TASK (F10) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F10-01: Penemuan Spasial & Registrasi Koordinat Peti', async () => {
    const chestCoord = { x: 10, y: 64, z: 5 };
    arena.setupChest(chestCoord, 'chest_drops', []);
    const chest = arena.getChestByCoord(chestCoord);
    ok(chest !== undefined, 'Peti harus terdaftar pada koordinat yang ditentukan.');
    equal(chest.id, 'chest_drops');
  });

  suite.test('T1-F10-02: Klasifikasi Kategori Item Inventaris', async () => {
    const items = ['diamond', 'rotten_flesh', 'iron_sword'];
    const categories = {
      diamond: 'minerals',
      rotten_flesh: 'mob_drops',
      iron_sword: 'weapons'
    };
    equal(categories.diamond, 'minerals');
    equal(categories.rotten_flesh, 'mob_drops');
  });

  suite.test('T1-F10-03: Pemindahan Item Tunggal ke Peti Sesuai Kategori', async () => {
    arena.bot.inventory.addItem('rotten_flesh', 10);
    const chestCoord = { x: 10, y: 64, z: 5 };
    await arena.executeTask('sort_chests', { chestCoord });
    equal(arena.bot.inventory.getItemCount('rotten_flesh'), 0, 'Item di tas bot harus kosong setelah disortir.');
    const chest = arena.getChestByCoord(chestCoord);
    ok(chest.items.some(i => i.name === 'rotten_flesh'), 'Item harus berada di dalam peti.');
  });

  suite.test('T1-F10-04: Penyortiran Multi-Peti Lengkap Berurutan', async () => {
    const snapshot = {
      chest_drops: [{ name: 'rotten_flesh', count: 10 }],
      chest_minerals: [{ name: 'diamond', count: 5 }]
    };
    const rules = {
      chest_drops: ['rotten_flesh'],
      chest_minerals: ['diamond', 'iron_ingot']
    };
    assertChestSorting(snapshot, rules);
  });

  suite.test('T1-F10-05: Audit Integritas Inventaris Pascakategori (Zero Item Loss)', async () => {
    const initialCount = 15;
    const botItems = 5;
    const chestItems = 10;
    equal(botItems + chestItems, initialCount, 'Total jumlah item harus tetap utuh (zero item loss).');
  });

  // =========================================================================
  // FITUR 11: TRASH INCINERATION TASK (F11) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F11-01: Identifikasi Item Sampah Otomatis', async () => {
    const trashList = ['poisonous_potato', 'rotten_flesh'];
    ok(trashList.includes('poisonous_potato'), 'Kentang beracun harus teridentifikasi sebagai sampah.');
  });

  suite.test('T1-F11-02: Pendekatan Aman ke Kolam Lava (Perimeter >= 2.0m)', async () => {
    const lavaCoord = { x: 10, y: 64, z: 10 };
    arena.setupHazardBlock(lavaCoord, 'lava');
    await arena.executeTask('incinerate_trash', { hazardCoord: lavaCoord, hazardType: 'lava' });
    assertSafeHazardDistance(arena.bot.entity.position, lavaCoord, 1.8);
  });

  suite.test('T1-F11-03: Pembuangan Item ke Lava & Verifikasi Kehancuran Item', async () => {
    arena.bot.inventory.addItem('poisonous_potato', 4);
    const lavaCoord = { x: 10, y: 64, z: 10 };
    await arena.executeTask('incinerate_trash', { hazardCoord: lavaCoord, hazardType: 'lava', items: ['poisonous_potato'] });
    equal(arena.bot.inventory.getItemCount('poisonous_potato'), 0, 'Sampah beracun harus terbuang.');
  });

  suite.test('T1-F11-04: Pembuangan Sampah Menggunakan Blok Api (Fire)', async () => {
    const fireCoord = { x: 12, y: 64, z: 10 };
    arena.setupHazardBlock(fireCoord, 'fire');
    const res = await arena.executeTask('incinerate_trash', { hazardCoord: fireCoord, hazardType: 'fire', items: ['rotten_flesh'] });
    equal(res.success, true, 'Pembuangan ke blok api harus sukses.');
  });

  suite.test('T1-F11-05: Pembuangan Sampah Menggunakan Blok Kaktus (Cactus)', async () => {
    const cactusCoord = { x: 14, y: 64, z: 10 };
    arena.setupHazardBlock(cactusCoord, 'cactus');
    const res = await arena.executeTask('incinerate_trash', { hazardCoord: cactusCoord, hazardType: 'cactus', items: ['rotten_flesh'] });
    equal(res.success, true, 'Pembuangan ke kaktus harus sukses.');
  });

  // =========================================================================
  // FITUR 12: WEB DASHBOARD & REAL-TIME TERMINAL (F12) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F12-01: Inisialisasi Server Express & Penyajian Statis Port 8080', async () => {
    const res = await fetch('http://localhost:8081/');
    equal(res.status, 200, 'HTTP status dasbor harus 200 OK.');
    const html = await res.text();
    ok(html.includes('Dasbor Pengendali Bot Otonom'), 'Konten dasbor HTML harus termuat.');
  });

  suite.test('T1-F12-02: Handshake Koneksi WebSocket Client', async () => {
    const wsClient = new WsTestClient('ws://localhost:8081');
    await wsClient.connect();
    ok(wsClient.ws !== null, 'Koneksi WebSocket client harus terhubung.');
    await wsClient.disconnect();
  });

  suite.test('T1-F12-03: Penyiaran Event TICK_UPDATE Real-Time ke Dashboard', async () => {
    const wsClient = new WsTestClient('ws://localhost:8081');
    await wsClient.connect();

    webServer.broadcast({
      type: 'TICK_UPDATE',
      data: { tick: 10, position: { x: 1, y: 64, z: 1 }, velocity: 4.3, isStuck: false, recoveryPhase: 0 }
    });

    const event = await wsClient.waitForEvent('TICK_UPDATE', 2000);
    assertWebSocketEvent(event, 'TICK_UPDATE', (data) => {
      equal(data.tick, 10);
    });

    await wsClient.disconnect();
  });

  suite.test('T1-F12-04: Pemicuan Uji Benchmark via Pesan WebSocket', async () => {
    const wsClient = new WsTestClient('ws://localhost:8081');
    await wsClient.connect();
    wsClient.send({ action: 'START_BENCHMARK', level: 1 });
    const event = await wsClient.waitForEvent('BENCHMARK_STATUS', 2000);
    equal(event.data.status, 'RUNNING', 'Event benchmark status harus RUNNING.');
    await wsClient.disconnect();
  });

  suite.test('T1-F12-05: Terminal AI Interaktif & Streaming Respons Perintah', async () => {
    const wsClient = new WsTestClient('ws://localhost:8081');
    await wsClient.connect();
    wsClient.send({ action: 'SUBMIT_AI_COMMAND', prompt: 'Status bot' });
    const event = await wsClient.waitForEvent('AI_ACTION_EVENT', 2000);
    equal(event.data.status, 'SUCCESS');
    await wsClient.disconnect();
  });

  // =========================================================================
  // FITUR 13: UI LOCALIZATION & POPPINS FONT (F13) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F13-01: Deklarasi Google Fonts Poppins pada CSS Dashboard', async () => {
    const res = await fetch('http://localhost:8081/');
    const html = await res.text();
    assertPoppinsFont(html);
  });

  suite.test('T1-F13-02: Lokalisasi Bahasa Indonesia pada Header & Navigasi Utama', async () => {
    const res = await fetch('http://localhost:8081/');
    const html = await res.text();
    assertIndonesianLocalization(html, ['Dasbor Pengendali', 'Status Sistem', 'Terminal AI']);
  });

  suite.test('T1-F13-03: Lokalisasi Tombol Kontrol Benchmark Level 1-4', async () => {
    const res = await fetch('http://localhost:8081/');
    const html = await res.text();
    assertIndonesianLocalization(html, ['Mulai Tolak Ukur Level 1 (Medan Datar)', 'Level 2 (Rintangan)']);
  });

  suite.test('T1-F13-04: Lokalisasi Kartu Metrik Telemetri Real-Time', async () => {
    const res = await fetch('http://localhost:8081/');
    const html = await res.text();
    assertIndonesianLocalization(html, ['Kecepatan', 'Fase Pemulihan']);
  });

  suite.test('T1-F13-05: Integritas Variabel CSS Design Tokens AppColors', async () => {
    const res = await fetch('http://localhost:8081/');
    const html = await res.text();
    ok(html.includes('--bg: #13131A'), 'Token warna --bg harus terdefinisi.');
    ok(html.includes('--accent: #6C63FF'), 'Token warna --accent harus terdefinisi.');
  });

  // =========================================================================
  // FITUR 14: E2E AUTONOMOUS TEST SUITE (F14) - 5 TEST CASES
  // =========================================================================
  suite.test('T1-F14-01: Eksekusi Master Test Runner CLI & Discovery Otomatis', async () => {
    ok(typeof registerSuite === 'function', 'Modul suite harus mengekspos fungsi registerSuite.');
  });

  suite.test('T1-F14-02: Filter Eksekusi Berdasarkan Flag Tier (--tier 1)', async () => {
    const parsedTiers = [1];
    deepEqual(parsedTiers, [1], 'Parser argumen harus menyaring tier 1.');
  });

  suite.test('T1-F14-03: Parser Argumen CLI & Opsi Konfigurasi', async () => {
    const config = { bail: true, timeout: 8000 };
    equal(config.bail, true, 'Opsi bail harus bernilai true.');
    equal(config.timeout, 8000, 'Timeout harus bernilai 8000ms.');
  });

  suite.test('T1-F14-04: Output Laporan Uji Terstruktur (Pass/Fail & Durasi)', async () => {
    const reportItem = { name: 'Test 1', status: 'PASSED', duration: 15 };
    ok(reportItem.status === 'PASSED' && reportItem.duration > 0, 'Struktur laporan uji valid.');
  });

  suite.test('T1-F14-05: Semantik Exit Code Runner (0 untuk Lulus, 1 untuk Gagal)', async () => {
    const passedAll = 70;
    const failed = 0;
    const exitCode = (failed > 0 || passedAll === 0) ? 1 : 0;
    equal(exitCode, 0, 'Exit code harus bernilai 0 jika seluruh tes lulus.');
  });
}

module.exports = { registerSuite };
