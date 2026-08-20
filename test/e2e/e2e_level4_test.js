/**
 * Alias Suite Pengujian E2E: Level 4 Benchmark (Underground Spawner Farm)
 * Sesuai dengan spesifikasi tata letak PROJECT.md §Code Layout.
 */

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { PgTestClient } = require('../helpers/dbTestHelper');
const { assertCoordinateClose, ok, equal } = require('../helpers/assertions');

async function run() {
  console.log('🚀 Menjalankan Uji E2E Level 4 (Navigasi Bawah Tanah ke Spawner [-256, -20, -432])...');
  const arena = new MockArenaHarness({ port: 25574 });
  await arena.start();

  const db = new PgTestClient();
  await db.connect();
  await db.runMigrations();

  const runId = await arena.startBenchmark(4);
  const res = await arena.waitForBenchmarkComplete(runId, 8000);

  equal(res.status, 'SUCCESS', 'Benchmark Level 4 harus berhasil.');
  assertCoordinateClose(arena.bot.entity.position, { x: -256, y: -20, z: -432 }, 0.6);

  await arena.stop();
  await db.cleanupAndClose();
  console.log(`🎉 Level 4 Benchmark Selesai: Sukses (${res.duration_ms}ms, Koordinat Akhir: [-256, -20, -432])`);
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Uji Level 4 Gagal:', err);
    process.exit(1);
  });
}

module.exports = { run };
