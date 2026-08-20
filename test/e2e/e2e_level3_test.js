/**
 * Alias Suite Pengujian E2E: Level 3 Benchmark (Stairs, Ladders & Bridges)
 * Sesuai dengan spesifikasi tata letak PROJECT.md §Code Layout.
 */

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { PgTestClient } = require('../helpers/dbTestHelper');
const { assertCoordinateClose, ok, equal } = require('../helpers/assertions');

async function run() {
  console.log('🚀 Menjalankan Uji E2E Level 3 (Tangga Balok, Tiang Ladder & Jembatan Sempit)...');
  const arena = new MockArenaHarness({ port: 25573 });
  await arena.start();

  const db = new PgTestClient();
  await db.connect();
  await db.runMigrations();

  const runId = await arena.startBenchmark(3);
  const res = await arena.waitForBenchmarkComplete(runId, 6000);

  equal(res.status, 'SUCCESS', 'Benchmark Level 3 harus berhasil.');
  assertCoordinateClose(arena.bot.entity.position, { x: 10, y: 64, z: 15 }, 0.6);

  await arena.stop();
  await db.cleanupAndClose();
  console.log(`🎉 Level 3 Benchmark Selesai: Sukses (${res.duration_ms}ms)`);
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Uji Level 3 Gagal:', err);
    process.exit(1);
  });
}

module.exports = { run };
