/**
 * Alias Suite Pengujian E2E: Level 2 Benchmark (Obstacles & Elevation 50m)
 * Sesuai dengan spesifikasi tata letak PROJECT.md §Code Layout.
 */

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { PgTestClient } = require('../helpers/dbTestHelper');
const { assertCoordinateClose, ok, equal } = require('../helpers/assertions');

async function run() {
  console.log('🚀 Menjalankan Uji E2E Level 2 (Rintangan & Elevasi 50m)...');
  const arena = new MockArenaHarness({ port: 25572 });
  await arena.start();

  const db = new PgTestClient();
  await db.connect();
  await db.runMigrations();

  const runId = await arena.startBenchmark(2);
  arena.injectObstacle({ x: 25, y: 65, z: 0 }, 'stone');
  const res = await arena.waitForBenchmarkComplete(runId, 6000);

  equal(res.status, 'SUCCESS', 'Benchmark Level 2 harus berhasil.');
  assertCoordinateClose(arena.bot.entity.position, { x: 50, y: 64, z: 0 }, 0.5);

  await arena.stop();
  await db.cleanupAndClose();
  console.log(`🎉 Level 2 Benchmark Selesai: Sukses (${res.duration_ms}ms, Obstacles: ${res.obstacleCount})`);
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Uji Level 2 Gagal:', err);
    process.exit(1);
  });
}

module.exports = { run };
