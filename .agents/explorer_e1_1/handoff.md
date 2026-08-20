# Laporan Investigasi & Cetak Biru Arsitektur Test Infrastructure (E1)

## 1. Observation

Berdasarkan pemeriksaan langsung pada lingkungan sistem dan file proyek:
1. **Lingkungan Runtime & Sistem**:
   - Node.js version: `v25.2.1` (mendukung native ESM, CommonJS, `node:test`, `node:assert`, `fetch`, async/await, AbortController).
   - Package manager: npm `11.6.2`.
   - Database Server: PostgreSQL `17.9` (Homebrew) aktif dan menerima koneksi di `/tmp:5432` / `localhost:5432`.
   - Database `minecraft_companion` telah ada dengan 3 tabel awal terverifikasi: `public.action_audit_logs`, `public.movement_action_logs`, `public.telemetry_logs`.
2. **Struktur File Awal**:
   - `ORIGINAL_REQUEST.md`: Menetapkan 4 requirement utama (R1 Headless Bot Test Harness, R2 Progressive Curriculum Navigation Levels 1-4, R3 Autonomous Self-Correction & PG Telemetry, R4 DeepSeek AI Brain & Multi-Step Tasks) dan kriteria penerimaan headless benchmarks 100% success rate, database persistence, serta dashboard web port 8080.
   - `PROJECT.md`: Memetakan 14 fitur (F1-F14), 5 subsistem arsitektur (Web Dashboard, Server Telemetry Hub, PostgreSQL DB, DeepSeek AI Brain, Autonomous Bot Navigation Engine), dan layout direktori `src/`, `test/`, `test/e2e/`.
   - `.agents/sub_orch_e2e/SCOPE.md`: Menetapkan dekomposisi E2E Track menjadi E1 (Test Infra & Master Runner), E2 (Tier 1 Feature Coverage $\ge 70$ kasus uji), E3 (Tier 2 Boundary/Corner $\ge 70$ kasus uji), dan E4 (Tier 3 Cross-Feature $\ge 14$ kasus & Tier 4 Real-World $\ge 7$ kasus + `TEST_READY.md`).
   - Direktori `test/` dan file `test/runner.js` saat ini belum dibuat (tahap fresh setup).

---

## 2. Logic Chain

1. **Kebutuhan Opaque-Box**: Pengujian E2E tidak boleh terikat pada variabel internal privat modul aplikasi (misal `bot._client._state`), melainkan harus menguji perilaku publik (black-box / opaque-box):
   - Input: Perintah navigasi, parameter level, prompt AI alami, aksi user pada REST API / WebSocket.
   - Observasi: Koordinat akhir bot ($\le \text{toleransi}$), delta perpindahan, fase pemulihan macet (1-4), jeda serangan senjata ($\ge 625$ms), inventaris peti setelah disortir, perimeter aman lava ($\ge 2.0$m), baris telemetri di tabel PostgreSQL, payload event WebSocket, label Bahasa Indonesia, dan font Poppins.
2. **Kebutuhan Isolasi Pengujian (Test Isolation)**:
   - Setiap pengujian harus mandiri dan idempoten agar tidak terjadi polusi state antar tes (flakiness).
   - Port server web dan mock Minecraft server harus dialokasikan secara dinamis / ephemeral atau dibersihkan dengan `afterEach`/`afterAll`.
   - Data pengujian di PostgreSQL diberi penanda unik `run_id` (UUID format `e2e-test-...`) dan dibersihkan setelah pengujian selesai.
   - DeepSeek AI Brain harus mendukung mode Mock deterministik (`MockAIClient`) untuk pengujian tanpa konsumsi token eksternal / tanpa ketergantungan koneksi internet, sekaligus mendukung mode Live jika `DEEPSEEK_API_KEY` tersedia.
3. **Kebutuhan Mock Arena & World Harness**:
   - Untuk memenuhi R1 (Headless testing tanpa membuka window Java Minecraft), test harness harus menyediakan simulasi world & physics ticks (`mockArenaHarness.js`) yang mampu menguji skenario 4 level:
     - Level 1: Flat Ground (jarak 30m, koordinat target $[30, 64, 0]$).
     - Level 2: 50m rintangan elevasi 1-blok dan detour rintangan.
     - Level 3: Tangga (stairs), tangga vertikal (ladder), dan jembatan sempit 1-blok.
     - Level 4: Penurunan dari permukaan ke koordinat farm spawner `[-256, -20, -432]`.
     - Injeksi rintangan dinamis (stuck injection) untuk memicu 4 fase recovery.
4. **Kebutuhan Master Runner & CLI Semantics**:
   - `test/runner.js` harus mandiri (zero external test framework dependency) untuk kecepatan eksekusi tinggi dan stabilitas maksimum di Node.js v25.
   - Mendukung opsi filter tingkat tinggi: `node test/runner.js` (semua tier), `node test/runner.js --tier 1`, `--tier 2`, `--tier 3`, `--tier 4`, `--tier 1,2`, `--bail`, `--json`.
   - Semantik Exit Code: `exit 0` jika semua pengujian lulus 100%, `exit 1` jika ada $\ge 1$ pengujian yang gagal/timeout.

---

## 3. Caveats

- **Pemisahan Peran**: Dokumen ini merancang arsitektur, spesifikasi `TEST_INFRA.md`, dan cetak biru kode untuk `test/runner.js` serta helpers pendukung. Implementasi aktual file kode pengujian dan runner akan dieksekusi oleh agen pekerja (worker).
- **Asumsi Koneksi PostgreSQL**: Host PostgreSQL diasumsikan berjalan secara lokal di port 5432 dengan database `minecraft_companion`. Test helper menyediakan fallback in-memory mock repository jika PostgreSQL sementara tidak tersedia di environment CI tertentu, namun tetap memprioritaskan database live jika aktif.
- **Batasan Jaringan**: DeepSeek AI API dapat di-mock penuh dalam test harness sehingga pengujian E2E dapat berjalan 100% offline dan deterministik.

---

## 4. Conclusion & Complete Blueprint Specifications

### A. Cetak Biru `TEST_INFRA.md` (Spesifikasi Arsitektur Test)

Dokumen `TEST_INFRA.md` yang akan dibuat di root project harus memiliki struktur lengkap sebagai berikut:

```markdown
# Arsitektur & Spesifikasi Infrastruktur Pengujian E2E (TEST_INFRA.md)

## 1. Filosofi Opaque-Box Testing
Pengujian E2E dalam sistem ini dirancang dengan prinsip **Opaque-Box** (Black-Box):
- Menguji sistem secara holistik dari batas luar: REST API, WebSocket protocol, database records, dan bot state transitions.
- Tidak bergantung pada implementasi internal atau closure privat modul.
- Setiap pengujian berfokus pada kontrak antarmuka publik dan pemenuhan kriteria penerimaan dari ORIGINAL_REQUEST.md.

## 2. Struktur Hierarki 4-Tier Test Suite
1. **Tier 1: Feature Coverage Suite (`test/e2e/tier1_feature_coverage.test.js`)**
   - Cakupan: 14 fitur (F1-F14) dengan $\ge 5$ pengujian independen per fitur (Total $\ge 70$ test cases).
   - Fokus: Fungsionalitas dasar, happy-path, dan validasi kontrak antarmuka masing-masing fitur.
2. **Tier 2: Boundary & Corner Cases Suite (`test/e2e/tier2_boundary_corner.test.js`)**
   - Cakupan: 14 fitur (F1-F14) dengan $\ge 5$ pengujian batas/sudut per fitur (Total $\ge 70$ test cases).
   - Fokus: Koordinat ekstrem, macet total (0 velocity), inventory penuh/kosong, batas lava berbahaya, pemutusan koneksi database/WebSocket, prompt AI tidak valid, dan validasi Bahasa Indonesia.
3. **Tier 3: Pairwise Cross-Feature Interactions Suite (`test/e2e/tier3_pairwise.test.js`)**
   - Cakupan: $\ge 14$ skenario interaksi silang 2 atau lebih fitur.
   - Fokus: Navigasi Level 4 + Deteksi Macet + Logging PostgreSQL; Farming Zombie + Pacing Cooldown + Siaran WebSocket; AI Prompt Engine + Multi-Chest Sorting + Trash Incineration.
4. **Tier 4: Real-World Long-Running Scenarios (`test/e2e/tier4_realworld.test.js`)**
   - Cakupan: $\ge 7$ skenario beban nyata terintegrasi penuh.
   - Fokus: Progresi kurikulum penuh L1 -> L4 berurutan, siklus tempur -> ambil loot -> sortir peti -> bakar sampah, kestabilan logging ribuan tick, dan pemulihan dari lag server.

## 3. Isolasi & Manajemen State Pengujian
- **Port Allocation**: Server web pengujian menggunakan port dinamis atau port isolasi (default 8080/8081).
- **Database Isolation**: Setiap run pengujian menghasilkan `run_id` berformat UUID (`e2e-test-<tier>-<timestamp>-<random>`). Hook `afterEach`/`afterAll` membersihkan data uji.
- **Deterministic Mock Provider**: Modul AI menggunakan `MockAIClient` untuk simulasi panggilan fungsi AI tanpa ketergantungan API eksternal.
- **Physics World Simulator**: `mockArenaHarness.js` memfasilitasi stepping tick simulasi cepat (fast-forward) tanpa terikat pada rendering grafis.
```

---

### B. Spesifikasi Master Runner (`test/runner.js`)

File `test/runner.js` dirancang sebagai standalone runner berbasis Node.js native.

#### Fitur & Antarmuka CLI:
```bash
# Menjalankan seluruh tier (Tier 1 sampai Tier 4)
node test/runner.js

# Menjalankan tier tertentu
node test/runner.js --tier 1
node test/runner.js --tier 2
node test/runner.js --tier 3
node test/runner.js --tier 4
node test/runner.js --tier 1,2

# Menjalankan dengan opsi lanjutan
node test/runner.js --bail            # Berhenti pada kegagalan pertama
node test/runner.js --json            # Output format JSON
node test/runner.js --timeout 15000   # Set timeout per tes dalam milidetik
node test/runner.js --help            # Tampilkan bantuan penggunaan
```

#### Logika Eksekusi Runner (Arsitektur Kode `test/runner.js`):
```javascript
/**
 * Master E2E Test Runner untuk Minecraft Autonomous Companion.
 * Mendukung eksekusi berjenjang 4-Tier, filtering, pelaporan terstruktur, dan exit code semantics.
 */

const fs = require('fs');
const path = require('path');

// Parser argumen CLI
function parseArgs(argv) {
  const options = {
    tiers: [1, 2, 3, 4],
    bail: false,
    json: false,
    timeout: 10000,
    filter: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tier' && argv[i + 1]) {
      const tierArg = argv[++i];
      options.tiers = tierArg.split(',').map(t => parseInt(t.trim(), 10)).filter(t => !isNaN(t));
    } else if (arg === '--bail') {
      options.bail = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--timeout' && argv[i + 1]) {
      options.timeout = parseInt(argv[++i], 10);
    } else if (arg === '--filter' && argv[i + 1]) {
      options.filter = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Penggunaan: node test/runner.js [opsi]
Opsi:
  --tier <1,2,3,4>    Pilih nomor tier yang akan dijalankan (default: semua tier)
  --bail              Hentikan eksekusi segera saat ada kasus uji yang gagal
  --json              Tampilkan ringkasan hasil dalam format JSON
  --timeout <ms>      Batas waktu per kasus uji (default: 10000ms)
  --filter <regex>    Filter nama kasus uji yang cocok
  --help, -h          Tampilkan panduan bantuan ini
      `);
      process.exit(0);
    }
  }
  return options;
}

// Engine pelari tes mikro dengan timeout & assertion tracking
class TestContext {
  constructor(options) {
    this.options = options;
    this.results = [];
    this.currentSuite = '';
  }

  async runSuite(name, suiteFn) {
    this.currentSuite = name;
    if (!this.options.json) {
      console.log(`\n📦 MENJALANKAN ${name.toUpperCase()}`);
    }
    const suiteResults = [];
    
    const suiteContext = {
      test: async (testName, fn) => {
        if (this.options.filter && !new RegExp(this.options.filter, 'i').test(testName)) {
          return;
        }

        const start = Date.now();
        let status = 'PASSED';
        let error = null;

        try {
          // Timeout guard
          await Promise.race([
            fn(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`Timeout: Pengujian melebihi batas waktu ${this.options.timeout}ms`)), this.options.timeout)
            )
          ]);
        } catch (err) {
          status = 'FAILED';
          error = err;
        }

        const duration = Date.now() - start;
        const resultItem = { suite: name, name: testName, status, duration, error: error ? error.message : null, stack: error ? error.stack : null };
        suiteResults.push(resultItem);
        this.results.push(resultItem);

        if (!this.options.json) {
          if (status === 'PASSED') {
            console.log(`  ✔ ${testName} (${duration}ms)`);
          } else {
            console.error(`  ✖ ${testName} (${duration}ms)`);
            console.error(`    ↳ Error: ${error.message}`);
          }
        }

        if (status === 'FAILED' && this.options.bail) {
          throw new Error(`Bail triggered on failure: ${testName}`);
        }
      }
    };

    try {
      await suiteFn(suiteContext);
    } catch (err) {
      if (this.options.bail) {
        throw err;
      }
    }
    return suiteResults;
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const startTime = Date.now();
  const testCtx = new TestContext(options);

  if (!options.json) {
    console.log('='.repeat(80));
    console.log('🚀 MINECRAFT AUTONOMOUS COMPANION — E2E MASTER TEST RUNNER');
    console.log('='.repeat(80));
    console.log(`Node Version: ${process.version} | Target Tiers: [${options.tiers.join(', ')}]`);
    console.log('-'.repeat(80));
  }

  // Pemuatan dan eksekusi file suite sesuai tier
  const tierFiles = {
    1: path.join(__dirname, 'e2e', 'tier1_feature_coverage.test.js'),
    2: path.join(__dirname, 'e2e', 'tier2_boundary_corner.test.js'),
    3: path.join(__dirname, 'e2e', 'tier3_pairwise.test.js'),
    4: path.join(__dirname, 'e2e', 'tier4_realworld.test.js')
  };

  let hasErrors = false;

  for (const tier of options.tiers) {
    const filePath = tierFiles[tier];
    if (fs.existsSync(filePath)) {
      try {
        const suiteModule = require(filePath);
        if (typeof suiteModule.registerSuite === 'function') {
          await testCtx.runSuite(`Tier ${tier} Suite`, suiteModule.registerSuite);
        } else if (typeof suiteModule === 'function') {
          await testCtx.runSuite(`Tier ${tier} Suite`, suiteModule);
        }
      } catch (err) {
        hasErrors = true;
        if (!options.json) {
          console.error(`Gagal mengeksekusi Tier ${tier}:`, err.message);
        }
        if (options.bail) break;
      }
    } else {
      if (!options.json) {
        console.log(`  ⚠ Catatan: File suite Tier ${tier} (${filePath}) belum ditemukan.`);
      }
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  const total = testCtx.results.length;
  const passed = testCtx.results.filter(r => r.status === 'PASSED').length;
  const failed = testCtx.results.filter(r => r.status === 'FAILED').length;

  if (options.json) {
    console.log(JSON.stringify({
      summary: {
        total,
        passed,
        failed,
        durationSeconds: parseFloat(totalDuration),
        status: failed === 0 && total > 0 ? 'PASSED' : 'FAILED'
      },
      results: testCtx.results
    }, null, 2));
  } else {
    console.log('\n' + '='.repeat(80));
    console.log('📊 RINGKASAN EKSEKUSI PENGUJIAN E2E');
    console.log('='.repeat(80));
    console.log(`Total Pengujian: ${total}`);
    console.log(`Lulus (Pass):    ${passed} ✔`);
    console.log(`Gagal (Fail):    ${failed} ✖`);
    console.log(`Total Waktu:     ${totalDuration}s`);
    console.log(`Status Akhir:    ${failed === 0 && total > 0 ? 'SEMUA SUITE LULUS (PASSED) 🎉' : (total === 0 ? 'TIDAK ADA PENGUJIAN DIJALANKAN' : 'PENGUJIAN GAGAL (FAILED) ❌')}`);
    console.log('='.repeat(80));
  }

  // Semantik Exit Code: 0 jika semua lulus, 1 jika ada kegagalan atau tidak ada tes
  if (failed > 0 || hasErrors || total === 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal Runner Error:', err);
    process.exit(1);
  });
}

module.exports = { parseArgs, TestContext, main };
```

---

### C. Spesifikasi Modul Helper & Assertion Library

Direktori `test/helpers/` menyediakan 5 helper modular:

1. **`test/helpers/assertions.js`**
   - `assertCoordinateClose(actualPos, targetPos, tolerance, message)`: Memvalidasi jarak Euclidean $\le \text{toleransi}$.
   - `assertTrajectoryProgress(pathHistory, targetPos)`: Memverifikasi jarak ke target berkurang secara konsisten.
   - `assertStuckRecoveryPhases(movementLogs, expectedPhases)`: Memverifikasi eskalasi fase 1 $\to$ 2 $\to$ 3 $\to$ 4.
   - `assertAttackPacing(attackTimestamps, minCooldownMs = 625)`: Memvalidasi jeda $\ge 625$ms antar serangan.
   - `assertChestSorting(chestSnapshot, expectedRules)`: Memverifikasi kategorisasi item dalam peti.
   - `assertSafeHazardDistance(trajectory, hazardCoord, minSafeDistance = 2.0)`: Memvalidasi jarak aman dari lava.
   - `assertDatabaseTelemetry(dbPool, runId, expectedLevel, minCount)`: Memverifikasi baris tersimpan di tabel `telemetry_logs` dan `movement_action_logs`.
   - `assertWebSocketEvent(wsClient, expectedType, validatorFn, timeoutMs)`: Memvalidasi penerimaan broadcast WebSocket.
   - `assertIndonesianLocalization(textOrHtml, requiredTerms)`: Memvalidasi label UI dalam Bahasa Indonesia.
   - `assertPoppinsFont(cssOrHtml)`: Memvalidasi konfigurasi Google Fonts Poppins.

2. **`test/helpers/mockArenaHarness.js`**
   - Menginisialisasi mock arena 4 level tanpa Java:
     * Level 1: Flat 30m $[0, 64, 0] \to [30, 64, 0]$.
     * Level 2: Elevasi 50m dengan 1-block steps & obstacles.
     * Level 3: Tangga (stairs), tangga vertikal (ladder), dan narrow 1-block bridges.
     * Level 4: Rute bawah tanah ke farm spawner `[-256, -20, -432]`.
   - Fasilitas: `spawnBot(startPos)`, `stepTicks(n)`, `injectObstacle(coord, blockType)`, `getBotPosition()`, `getMovementHistory()`, `getAttackHistory()`.

3. **`test/helpers/dbTestHelper.js`**
   - Mengelola koneksi database pengujian `minecraft_companion`.
   - Generator `createTestRunId(prefix)`.
   - Pembersihan otomatis data uji `cleanupTestRun(runId)`.
   - Verifikasi integritas schema & count recorder.

4. **`test/helpers/wsTestHelper.js`**
   - Client WebSocket helper yang membuka koneksi ke `ws://localhost:8080`.
   - Antrean event message listener dengan promise timeout (`waitForEvent(type, timeoutMs)`).
   - Pembersihan socket otomatis saat pengujian selesai.

5. **`test/helpers/mockAIProvider.js`**
   - Provider mock DeepSeek API yang menghasilkan respons tool-calling terstruktur deterministik:
     * `farm_mobs` $\to$ parameter target zombie, cooldown $\ge 625$ms.
     * `sort_chests` $\to$ kategorisasi peti.
     * `incinerate_trash` $\to$ identifikasi hazard lava/fire dan perimeter aman.
     * `navigate_to` $\to$ koordinat tujuan Level 1-4.

---

## 5. Verification Method

Cara memverifikasi secara independen:
1. **Verifikasi Runner**:
   ```bash
   node test/runner.js --help
   ```
   Harus menampilkan opsi bantuan lengkap dan keluar dengan exit code 0.
2. **Verifikasi Seleksi Tier**:
   ```bash
   node test/runner.js --tier 1
   node test/runner.js --tier 2
   node test/runner.js --tier 3
   node test/runner.js --tier 4
   ```
   Harus mengeksekusi suite tier yang dipilih dan menampilkan laporan ringkasan.
3. **Verifikasi Semantik Exit Code**:
   - Jika seluruh tes dalam tier lulus $\to$ `echo $?` menghasilkan `0`.
   - Jika ada kegagalan atau file tes rusak $\to$ `echo $?` menghasilkan `1`.
4. **Verifikasi Database Telemetri**:
   ```bash
   psql -d minecraft_companion -c "SELECT COUNT(*) FROM telemetry_logs;"
   ```
   Memastikan baris log tercatat dengan benar.
5. **Kondisi Invalidasi**:
   - Runner gagal mengenali flag `--tier`.
   - Runner mengembalikan exit code 0 saat ada test failure.
   - Test harness bocor state antar pengujian.
   - Pesan kegagalan assert tidak menyertakan koordinat/detail yang jelas.
