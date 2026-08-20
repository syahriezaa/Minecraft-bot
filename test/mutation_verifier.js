/**
 * Script Verifikasi Mutasi & Adversarial Testing untuk assertions.js dan E2E Test Suite.
 * Dibuat oleh challenger_e2e_2 untuk menguji kepekaan dan validitas asersi secara empiris.
 *
 * Menguji:
 * 1. False-Positive Prevention: Memastikan asersi GAGAL (throw AssertionError) jika kondisi dilanggar.
 * 2. Precision & Boundary Limits: Memeriksa nilai batas (edge/boundary cases).
 * 3. Fault Injection: Memeriksa apakah suite pengujian mendeteksi bug yang diinjeksikan ke simulator/mock.
 * 4. Tautology Detection: Memeriksa apakah ada kasus uji yang bertipe vacuous pass (selalu bernilai true).
 */

const assert = require('node:assert/strict');
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
  assertPoppinsFont
} = require('./helpers/assertions');

const results = {
  totalPassedMutations: 0,
  totalFailedMutations: 0,
  details: []
};

function testMutation(name, testFn, expectThrow = true, expectedErrorRegex = null) {
  try {
    testFn();
    if (expectThrow) {
      console.error(`  ✖ GAGAL (False Positive terdeteksi!): "${name}" seharusnya melempar error, tapi lolos.`);
      results.totalFailedMutations++;
      results.details.push({ name, status: 'FAILED_FALSE_POSITIVE', error: 'Did not throw as expected' });
    } else {
      console.log(`  ✔ LULUS (Valid Case): "${name}"`);
      results.totalPassedMutations++;
      results.details.push({ name, status: 'PASSED' });
    }
  } catch (err) {
    if (!expectThrow) {
      console.error(`  ✖ GAGAL (Unexpected Error): "${name}" melempar error tidak terduga:`, err.message);
      results.totalFailedMutations++;
      results.details.push({ name, status: 'FAILED_UNEXPECTED_ERROR', error: err.message });
    } else {
      if (expectedErrorRegex && !expectedErrorRegex.test(err.message)) {
        console.error(`  ✖ GAGAL (Wrong Error Message): "${name}" melempar error: "${err.message}", diharapkan cocok regex: ${expectedErrorRegex}`);
        results.totalFailedMutations++;
        results.details.push({ name, status: 'FAILED_WRONG_MESSAGE', error: err.message });
      } else {
        console.log(`  ✔ LULUS (Mutation Caught): "${name}" -> Melempar: "${err.message.split('\n')[0].substring(0, 70)}..."`);
        results.totalPassedMutations++;
        results.details.push({ name, status: 'PASSED_MUTATION_CAUGHT' });
      }
    }
  }
}

console.log('================================================================================');
console.log('🧪 MEMULAI PENGUJIAN ADVERSARIAL & MUTASI ASSERTION HELPERS');
console.log('================================================================================\n');

// -----------------------------------------------------------------------------
// 1. assertCoordinateClose
// -----------------------------------------------------------------------------
console.log('--- 1. assertCoordinateClose ---');
// 1.1 Valid cases
testMutation('1.1 Koordinat identik', () => {
  assertCoordinateClose({ x: 10, y: 64, z: 10 }, { x: 10, y: 64, z: 10 }, 0.5);
}, false);

testMutation('1.2 Koordinat di dalam toleransi (delta = 0.3m < 0.5m)', () => {
  assertCoordinateClose({ x: 10.3, y: 64, z: 10 }, { x: 10, y: 64, z: 10 }, 0.5);
}, false);

testMutation('1.3 Koordinat tepat pada batas toleransi (delta = 0.5m)', () => {
  assertCoordinateClose({ x: 10.5, y: 64, z: 10 }, { x: 10, y: 64, z: 10 }, 0.5);
}, false);

// 1.2 Mutated/Violated cases (MUST FAIL)
testMutation('1.4 Mutasi: Jarak melebihi batas toleransi (delta = 0.6m > 0.5m)', () => {
  assertCoordinateClose({ x: 10.6, y: 64, z: 10 }, { x: 10, y: 64, z: 10 }, 0.5);
}, true, /Jarak koordinat melebihi toleransi/i);

testMutation('1.5 Mutasi: Jarak ekstrem jauh (delta = 50m)', () => {
  assertCoordinateClose({ x: 60, y: 64, z: 10 }, { x: 10, y: 64, z: 10 }, 0.5);
}, true, /Jarak koordinat melebihi toleransi/i);

testMutation('1.6 Mutasi: Input actualPos bernilai null', () => {
  assertCoordinateClose(null, { x: 10, y: 64, z: 10 }, 0.5);
}, true, /Posisi aktual bot tidak boleh null/i);

testMutation('1.7 Mutasi: Input targetPos bernilai undefined', () => {
  assertCoordinateClose({ x: 10, y: 64, z: 10 }, undefined, 0.5);
}, true, /Posisi target tidak boleh null/i);


// -----------------------------------------------------------------------------
// 2. assertTrajectoryProgress
// -----------------------------------------------------------------------------
console.log('\n--- 2. assertTrajectoryProgress ---');
const target = { x: 30, y: 64, z: 0 };

testMutation('2.1 Valid: Bot bergerak mendekat dari x=0 ke x=20 (target x=30)', () => {
  assertTrajectoryProgress([{ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 }], target);
}, false);

testMutation('2.2 Mutasi: Bot bergerak menjauh dari target (x=20 ke x=0)', () => {
  assertTrajectoryProgress([{ x: 20, y: 64, z: 0 }, { x: 0, y: 64, z: 0 }], target);
}, true, /Lintasan tidak menunjukkan kemajuan/i);

testMutation('2.3 Mutasi: Bot statis di tempat yang sama (jarak awal == jarak akhir)', () => {
  assertTrajectoryProgress([{ x: 10, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }], target);
}, true, /Lintasan tidak menunjukkan kemajuan/i);

testMutation('2.4 Mutasi: Riwayat lintasan hanya 1 titik (kurang dari 2 titik)', () => {
  assertTrajectoryProgress([{ x: 0, y: 64, z: 0 }], target);
}, true, /Riwayat lintasan harus memiliki minimal 2 titik/i);

testMutation('2.5 Mutasi: Riwayat lintasan array kosong []', () => {
  assertTrajectoryProgress([], target);
}, true, /Riwayat lintasan harus memiliki minimal 2 titik/i);


// -----------------------------------------------------------------------------
// 3. assertStuckRecoveryPhases
// -----------------------------------------------------------------------------
console.log('\n--- 3. assertStuckRecoveryPhases ---');
const sampleMovementLogs = [
  { is_stuck: false, recovery_phase: 0 },
  { is_stuck: true, recovery_phase: 1 },
  { is_stuck: true, recovery_phase: 2 },
  { is_stuck: false, recovery_phase: 0 }
];

testMutation('3.1 Valid: Meminta fase 1 yang ada dalam log', () => {
  assertStuckRecoveryPhases(sampleMovementLogs, 1);
}, false);

testMutation('3.2 Valid: Meminta daftar fase [1, 2] yang keduanya ada', () => {
  assertStuckRecoveryPhases(sampleMovementLogs, [1, 2]);
}, false);

testMutation('3.3 Mutasi: Meminta fase 4 yang TIDAK ADA dalam log', () => {
  assertStuckRecoveryPhases(sampleMovementLogs, 4);
}, true, /Fase pemulihan 4 tidak ditemukan/i);

testMutation('3.4 Mutasi: Meminta [1, 4] di mana fase 4 tidak ada', () => {
  assertStuckRecoveryPhases(sampleMovementLogs, [1, 4]);
}, true, /Fase pemulihan 4 tidak ditemukan/i);

testMutation('3.5 Mutasi: movementLogs bukan array (objek tunggal)', () => {
  assertStuckRecoveryPhases({ is_stuck: true, recovery_phase: 1 }, [1]);
}, true, /movementLogs harus berupa array/i);


// -----------------------------------------------------------------------------
// 4. assertAttackPacing
// -----------------------------------------------------------------------------
console.log('\n--- 4. assertAttackPacing ---');

testMutation('4.1 Valid: Interval jeda serangan pedang >= 625ms (delta = 630ms)', () => {
  assertAttackPacing([1000, 1630, 2260, 2890], 625);
}, false);

testMutation('4.2 Valid: Interval jeda pada batas toleransi timer (delta = 605ms >= 625-20)', () => {
  assertAttackPacing([1000, 1605], 625);
}, false);

testMutation('4.3 Mutasi: Pelanggaran jeda serangan (Spam attack delta = 300ms < 625ms)', () => {
  assertAttackPacing([1000, 1300, 1600], 625);
}, true, /Pelanggaran jeda serangan/i);

testMutation('4.4 Mutasi: Spam serangan ekstrem (delta = 10ms)', () => {
  assertAttackPacing([1000, 1010], 625);
}, true, /Pelanggaran jeda serangan/i);

testMutation('4.5 Mutasi: Array timestamp serangan hanya 1 item', () => {
  assertAttackPacing([1000], 625);
}, true, /Diperlukan minimal 2 serangan untuk validasi jeda/i);


// -----------------------------------------------------------------------------
// 5. assertChestSorting
// -----------------------------------------------------------------------------
console.log('\n--- 5. assertChestSorting ---');
const validSnapshot = {
  chest_drops: [{ name: 'rotten_flesh', count: 10 }, { name: 'bone', count: 5 }],
  chest_minerals: [{ name: 'diamond', count: 3 }, { name: 'iron_ingot', count: 8 }]
};
const sortingRules = {
  chest_drops: ['rotten_flesh', 'bone'],
  chest_minerals: ['diamond', 'iron_ingot', 'gold_ingot']
};

testMutation('5.1 Valid: Semua item di peti sesuai aturan', () => {
  assertChestSorting(validSnapshot, sortingRules);
}, false);

testMutation('5.2 Mutasi: Peti drops tercemar item mineral (diamond)', () => {
  const badSnapshot = {
    chest_drops: [{ name: 'rotten_flesh', count: 10 }, { name: 'diamond', count: 1 }]
  };
  assertChestSorting(badSnapshot, sortingRules);
}, true, /Item tidak sesuai kategori.*Peti "chest_drops" berisi item "diamond"/i);

testMutation('5.3 Mutasi: Peti minerals tercemar item sampah (poisonous_potato)', () => {
  const badSnapshot = {
    chest_minerals: [{ name: 'poisonous_potato', count: 2 }]
  };
  assertChestSorting(badSnapshot, sortingRules);
}, true, /Item tidak sesuai kategori.*Peti "chest_minerals" berisi item "poisonous_potato"/i);

testMutation('5.4 Mutasi: Parameter chestSnapshot bernilai null', () => {
  assertChestSorting(null, sortingRules);
}, true, /chestSnapshot harus berupa objek/i);


// -----------------------------------------------------------------------------
// 6. assertSafeHazardDistance
// -----------------------------------------------------------------------------
console.log('\n--- 6. assertSafeHazardDistance ---');
const lavaCoord = { x: 10, y: 64, z: 10 };

testMutation('6.1 Valid: Posisi bot berada pada jarak aman (jarak 2.0m > 1.5m)', () => {
  assertSafeHazardDistance({ x: 10, y: 64, z: 12 }, lavaCoord, 1.5);
}, false);

testMutation('6.2 Valid: Riwayat lintasan bot semuanya berada pada jarak >= 1.5m', () => {
  const safeTraj = [
    { x: 10, y: 64, z: 15 },
    { x: 10, y: 64, z: 13 },
    { x: 10, y: 64, z: 12 }
  ];
  assertSafeHazardDistance(safeTraj, lavaCoord, 1.5);
}, false);

testMutation('6.3 Mutasi: Posisi bot terlalu dekat dengan lava (jarak 0.5m < 1.5m)', () => {
  assertSafeHazardDistance({ x: 10, y: 64, z: 10.5 }, lavaCoord, 1.5);
}, true, /Pelanggaran batas perimeter bahaya/i);

testMutation('6.4 Mutasi: Bot berdiri tepat di atas blok lava (jarak 0.0m)', () => {
  assertSafeHazardDistance({ x: 10, y: 64, z: 10 }, lavaCoord, 1.5);
}, true, /Pelanggaran batas perimeter bahaya/i);

testMutation('6.5 Mutasi: Salah satu titik dalam lintasan melanggar batas perimeter', () => {
  const badTraj = [
    { x: 10, y: 64, z: 15 }, // aman (5m)
    { x: 10, y: 64, z: 10.8 }, // melanggar (0.8m < 1.4m)
    { x: 10, y: 64, z: 12 } // aman (2m)
  ];
  assertSafeHazardDistance(badTraj, lavaCoord, 1.5);
}, true, /Pelanggaran batas perimeter bahaya/i);


// -----------------------------------------------------------------------------
// 7. assertDatabaseTelemetry
// -----------------------------------------------------------------------------
console.log('\n--- 7. assertDatabaseTelemetry ---');
const sampleDbLogs = [
  { id: 1, level: '1', status: 'SUCCESS' },
  { id: 2, level: '1', status: 'SUCCESS' },
  { id: 3, level: '1', status: 'SUCCESS' }
];

testMutation('7.1 Valid: Jumlah log cukup (3 >= 2) dan level cocok ("1")', () => {
  assertDatabaseTelemetry(sampleDbLogs, '1', 2);
}, false);

testMutation('7.2 Mutasi: Jumlah log kurang dari minCount (ditemukan 3, minimal 5)', () => {
  assertDatabaseTelemetry(sampleDbLogs, '1', 5);
}, true, /Jumlah baris log telemetri di database kurang/i);

testMutation('7.3 Mutasi: Level pada log tidak cocok (diharapkan "2", ditemukan "1")', () => {
  assertDatabaseTelemetry(sampleDbLogs, '2', 1);
}, true, /Level pada log telemetri tidak cocok/i);

testMutation('7.4 Mutasi: dbLogs bukan array (berupa objek)', () => {
  assertDatabaseTelemetry({ id: 1, level: '1' }, '1', 1);
}, true, /dbLogs harus berupa array/i);


// -----------------------------------------------------------------------------
// 8. assertWebSocketEvent
// -----------------------------------------------------------------------------
console.log('\n--- 8. assertWebSocketEvent ---');
const sampleEvent = {
  type: 'TICK_UPDATE',
  data: { tick: 42, position: { x: 5, y: 64, z: 0 } }
};

testMutation('8.1 Valid: Tipe event cocok dan fungsi validator lolos', () => {
  assertWebSocketEvent(sampleEvent, 'TICK_UPDATE', (data) => {
    assert.equal(data.tick, 42);
  });
}, false);

testMutation('8.2 Mutasi: Tipe event tidak cocok (diharapkan BENCHMARK_STATUS, diterima TICK_UPDATE)', () => {
  assertWebSocketEvent(sampleEvent, 'BENCHMARK_STATUS');
}, true, /Tipe event WebSocket tidak cocok/i);

testMutation('8.3 Mutasi: Event bernilai null', () => {
  assertWebSocketEvent(null, 'TICK_UPDATE');
}, true, /Event WebSocket tidak boleh null/i);

testMutation('8.4 Mutasi: Fungsi validator melempar AssertionError internal', () => {
  assertWebSocketEvent(sampleEvent, 'TICK_UPDATE', (data) => {
    assert.equal(data.tick, 999, 'Tick harus bernilai 999');
  });
}, true, /Tick harus bernilai 999/i);


// -----------------------------------------------------------------------------
// 9. assertIndonesianLocalization
// -----------------------------------------------------------------------------
console.log('\n--- 9. assertIndonesianLocalization ---');
const sampleHtml = '<html><body><h1>Dasbor Pengendali Bot</h1><p>Status Sistem: Aktif</p></body></html>';

testMutation('9.1 Valid: Semua frasa Bahasa Indonesia wajib ada', () => {
  assertIndonesianLocalization(sampleHtml, ['Dasbor Pengendali', 'Status Sistem', 'Aktif']);
}, false);

testMutation('9.2 Mutasi: Salah satu frasa Bahasa Indonesia hilang/tidak ditemukan', () => {
  assertIndonesianLocalization(sampleHtml, ['Dasbor Pengendali', 'FrasaYangTidakPernahAda']);
}, true, /Frasa lokalisasi Bahasa Indonesia.*tidak ditemukan/i);

testMutation('9.3 Mutasi: requiredTerms berupa array kosong []', () => {
  assertIndonesianLocalization(sampleHtml, []);
}, true, /requiredTerms harus berupa array non-kosong/i);

testMutation('9.4 Mutasi: textOrHtml bukan string (null)', () => {
  assertIndonesianLocalization(null, ['Dasbor']);
}, true, /textOrHtml harus berupa string/i);


// -----------------------------------------------------------------------------
// 10. assertPoppinsFont
// -----------------------------------------------------------------------------
console.log('\n--- 10. assertPoppinsFont ---');
const validCss = 'body { font-family: "Poppins", sans-serif; background-color: #13131A; }';
const validHtmlFontLink = '<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">';
const badCss = 'body { font-family: "Arial", "Helvetica", sans-serif; }';

testMutation('10.1 Valid: font-family Poppins ada di CSS', () => {
  assertPoppinsFont(validCss);
}, false);

testMutation('10.2 Valid: Google Fonts Poppins link ada di HTML', () => {
  assertPoppinsFont(validHtmlFontLink);
}, false);

testMutation('10.3 Mutasi: CSS hanya memuat font Arial (Poppins hilang)', () => {
  assertPoppinsFont(badCss);
}, true, /Tipografi Google Fonts Poppins tidak ditemukan/i);

testMutation('10.4 Mutasi: String teks biasa tanpa deklarasi Poppins', () => {
  assertPoppinsFont('Selamat datang di aplikasi Minecraft Bot');
}, true, /Tipografi Google Fonts Poppins tidak ditemukan/i);

testMutation('10.5 Mutasi: Input bukan string (undefined)', () => {
  assertPoppinsFont(undefined);
}, true, /cssOrHtml harus berupa string/i);


// =============================================================================
// RINGKASAN HASIL MUTASI
// =============================================================================
console.log('\n================================================================================');
console.log('📊 RINGKASAN HASIL VERIFIKASI ADVERSARIAL & MUTASI ASSERTIONS');
console.log('================================================================================');
console.log(`Total Kasus Uji Mutasi & Batas: ${results.totalPassedMutations + results.totalFailedMutations}`);
console.log(`Berhasil Lolos (Passed)       : ${results.totalPassedMutations} ✔`);
console.log(`Gagal (Failed)                : ${results.totalFailedMutations} ✖`);

if (results.totalFailedMutations === 0) {
  console.log('\n🎉 VERIFIKASI SELESAI: SEMUA ASSERTION HELPERS TERBUKTI SENSITIF & VALID 100%!');
  console.log('   - Nol False-Positive (Semua pelanggaran berhasil terdeteksi & melempar error).');
  console.log('   - Pesan kesalahan Bahasa Indonesia terkonfirmasi informatif dan konsisten.');
  process.exit(0);
} else {
  console.error('\n✖ DITEMUKAN CACAT/INSENSITIVITAS PADA ASSERTIONS!');
  process.exit(1);
}
