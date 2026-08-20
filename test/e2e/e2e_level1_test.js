/**
 * Alias Suite Pengujian E2E: Level 1 Benchmark (Flat Ground 30m)
 * Sesuai dengan spesifikasi tata letak PROJECT.md §Code Layout.
 */

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { PgTestClient } = require('../helpers/dbTestHelper');
const { assertCoordinateClose, ok, equal } = require('../helpers/assertions');

async function run() {
  console.log('🚀 Menjalankan Uji E2E Level 1 (Medan Datar 30m - 5 Runs Berturut-turut)...');
  const arena = new MockArenaHarness({ port: 25571 });
  await arena.start();

  const db = new PgTestClient();
  await db.connect();
  await db.runMigrations();

  let passed = 0;
  for (let i = 1; i <= 5; i++) {
    const runId = await arena.startBenchmark(1);
    const res = await arena.waitForBenchmarkComplete(runId, 5000);
    equal(res.status, 'SUCCESS', `Run Level 1 ke-${i} harus berhasil.`);
    assertCoordinateClose(arena.bot.entity.position, { x: 30, y: 64, z: 0 }, 0.5);
    passed++;
    console.log(`  ✔ Run ${i}/5: Sukses (${res.duration_ms}ms)`);
  }

  await arena.stop();
  await db.cleanupAndClose();
  console.log(`🎉 Level 1 Benchmark Selesai: ${passed}/5 Lulus (100% Success Rate)`);
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Uji Level 1 Gagal:', err);
    process.exit(1);
  });
}

module.exports = { run };
