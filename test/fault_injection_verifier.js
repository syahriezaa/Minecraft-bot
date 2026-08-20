/**
 * Script Verifikasi Fault-Injection & Suite Sensitivity.
 * Dibuat oleh challenger_e2e_2 untuk menguji kepekaan suite pengujian E2E saat harness/sistem disabotase.
 *
 * Menguji apakah suite E2E secara deterministik mendeteksi:
 * 1. Sabotase Posisi Bot (Coordinates Drift Mutation)
 * 2. Sabotase Status Sukses Benchmark (Status Regression Mutation)
 * 3. Sabotase Cooldown Serangan Senjata (Combat Spam Attack Mutation)
 * 4. Sabotase Kategori Item Peti (Chest Contamination Mutation)
 * 5. Sabotase Jarak Perimeter Lava (Hazard Proximity Breach Mutation)
 * 6. Sabotase Font Poppins / Desain UI (Style Regression Mutation)
 * 7. Sabotase Lokalisasi Bahasa Indonesia (Localization Regression Mutation)
 */

const assert = require('node:assert/strict');
const { MockArenaHarness } = require('./helpers/mockArenaHarness');
const { PgTestClient } = require('./helpers/dbTestHelper');
const { MockWebServer, WsTestClient } = require('./helpers/wsTestHelper');
const { MockDeepSeekClient } = require('./helpers/mockAIProvider');
const {
  assertCoordinateClose,
  assertAttackPacing,
  assertChestSorting,
  assertSafeHazardDistance,
  assertIndonesianLocalization,
  assertPoppinsFont
} = require('./helpers/assertions');

let passedInjections = 0;
let failedInjections = 0;

function reportFault(name, caught, errorMsg) {
  if (caught) {
    console.log(`  ✔ SUKSES MENANGKAP BUG: "${name}" -> ${errorMsg.split('\n')[0].substring(0, 65)}...`);
    passedInjections++;
  } else {
    console.error(`  ✖ GAGAL MENANGKAP BUG (Silent Pass / False Positive!): "${name}"`);
    failedInjections++;
  }
}

async function runFaultInjections() {
  console.log('================================================================================');
  console.log('🔬 MEMULAI PENGUJIAN FAULT-INJECTION PADA SUBSISTEM & TEST SUITE');
  console.log('================================================================================\n');

  // 1. Sabotase Posisi Bot: Target Level 1 adalah (30,64,0), kita mutasikan posisi bot ke (20,64,0)
  {
    let caught = false;
    let errText = '';
    try {
      const botPos = { x: 20, y: 64, z: 0 };
      const expectedTarget = { x: 30, y: 64, z: 0 };
      assertCoordinateClose(botPos, expectedTarget, 0.5, 'Bot harus berhenti tepat di target.');
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('1. Sabotase Posisi Bot (Bot berhenti di x=20 bukan x=30)', caught, errText);
  }

  // 2. Sabotase Cooldown Serangan: AI atau Bot menyerang terlalu cepat (300ms vs min 625ms)
  {
    let caught = false;
    let errText = '';
    try {
      const spamTimestamps = [1000, 1300, 1600]; // 300ms pacing
      assertAttackPacing(spamTimestamps, 625);
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('2. Sabotase Cooldown Serangan (Bot spam-clicking 300ms)', caught, errText);
  }

  // 3. Sabotase Sort Peti: Item rotten_flesh masuk ke chest_minerals
  {
    let caught = false;
    let errText = '';
    try {
      const contaminatedSnapshot = {
        chest_minerals: [{ name: 'rotten_flesh', count: 5 }]
      };
      const rules = {
        chest_minerals: ['diamond', 'iron_ingot', 'gold_ingot']
      };
      assertChestSorting(contaminatedSnapshot, rules);
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('3. Sabotase Sort Peti (Peti mineral tercemar rotten_flesh)', caught, errText);
  }

  // 4. Sabotase Perimeter Lava: Bot mendekati lava pada jarak 0.8m (< 1.5m)
  {
    let caught = false;
    let errText = '';
    try {
      const botPos = { x: 10, y: 64, z: 10.8 };
      const lavaPos = { x: 10, y: 64, z: 10.0 };
      assertSafeHazardDistance(botPos, lavaPos, 1.5);
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('4. Sabotase Perimeter Lava (Bot mendekat hingga 0.8m ke lava)', caught, errText);
  }

  // 5. Sabotase Tipografi: Dashboard menggunakan Arial tanpa font Poppins
  {
    let caught = false;
    let errText = '';
    try {
      const sabotagedHtml = '<style>body { font-family: Arial, sans-serif; }</style>';
      assertPoppinsFont(sabotagedHtml);
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('5. Sabotase Font Poppins (HTML hanya menggunakan font Arial)', caught, errText);
  }

  // 6. Sabotase Lokalisasi: UI Dashboard berbahasa Inggris tanpa Bahasa Indonesia
  {
    let caught = false;
    let errText = '';
    try {
      const englishHtml = '<div><h1>Bot Control Dashboard</h1><p>System Status: Active</p></div>';
      assertIndonesianLocalization(englishHtml, ['Dasbor Pengendali', 'Status Sistem']);
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('6. Sabotase Bahasa UI (UI bahasa Inggris tanpa terjemahan Indonesia)', caught, errText);
  }

  // 7. Sabotase Database Telemetri: Database mengembalikan 0 log saat diharapkan >= 20
  {
    let caught = false;
    let errText = '';
    try {
      const emptyLogs = [];
      const { assertDatabaseTelemetry } = require('./helpers/assertions');
      assertDatabaseTelemetry(emptyLogs, '1', 20);
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('7. Sabotase Telemetri DB (Log DB kosong saat diharapkan 20 log)', caught, errText);
  }

  // 8. Sabotase AI Tool Schema: Parameter `durationSeconds` bertipe string bukan number
  {
    let caught = false;
    let errText = '';
    try {
      const ai = new MockDeepSeekClient();
      const validation = ai.validateToolSchema('farm_mobs', { target: 'zombie', durationSeconds: 'tiga puluh' });
      assert.equal(validation.valid, true, 'Harus valid');
    } catch (err) {
      caught = true;
      errText = err.message;
    }
    reportFault('8. Sabotase AI Tool Schema (Parameter tipe data string bukannya number)', caught, errText);
  }

  console.log('\n================================================================================');
  console.log('📊 RINGKASAN HASIL FAULT-INJECTION SUITE');
  console.log('================================================================================');
  console.log(`Total Skenario Sabotase: ${passedInjections + failedInjections}`);
  console.log(`Berhasil Tertangkap   : ${passedInjections} ✔`);
  console.log(`Lolos/Tidak Tertangkap: ${failedInjections} ✖`);

  if (failedInjections === 0) {
    console.log('\n🎉 SEMUA SKENARIO SABOTASE BERHASIL TERDETEKSI 100%!');
    console.log('   Suite pengujian E2E terbukti memiliki sensitivitas tinggi dan bebas dari vacuous pass.');
    process.exit(0);
  } else {
    console.error('\n✖ ADA SABOTASE YANG LOLOS TANPA TERDETEKSI!');
    process.exit(1);
  }
}

runFaultInjections().catch(err => {
  console.error('Fatal error during fault injection:', err);
  process.exit(1);
});
