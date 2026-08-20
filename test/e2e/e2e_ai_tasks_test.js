/**
 * Alias Suite Pengujian E2E: AI Tasks (Farming, Sorting, Incineration)
 * Sesuai dengan spesifikasi tata letak PROJECT.md §Code Layout.
 */

const { MockArenaHarness } = require('../helpers/mockArenaHarness');
const { MockDeepSeekClient } = require('../helpers/mockAIProvider');
const { assertAttackPacing, assertSafeHazardDistance, ok, equal } = require('../helpers/assertions');

async function run() {
  console.log('🚀 Menjalankan Uji E2E AI Tasks (DeepSeek Brain, Farming, Sorting & Insinerasi)...');
  const arena = new MockArenaHarness({ port: 25575 });
  await arena.start();

  const aiClient = new MockDeepSeekClient();
  const plan = await aiClient.planMultiStepTask('Rutinitas pembersihan farm zombie');
  equal(plan.totalSteps, 4, 'Alur kerja AI harus terdiri atas 4 langkah.');

  const res = await arena.runFullMaintenanceRoutine();
  equal(res.farmingComplete, true, 'Farming zombie sukses.');
  equal(res.sortingComplete, true, 'Penyortiran peti sukses.');
  equal(res.trashIncinerated, true, 'Insinerasi sampah sukses.');
  equal(res.botDamaged, false, 'Bot tidak terluka.');

  await arena.stop();
  console.log('🎉 AI Tasks Selesai: Seluruh tugas otonom berhasil 100%!');
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Uji AI Tasks Gagal:', err);
    process.exit(1);
  });
}

module.exports = { run };
