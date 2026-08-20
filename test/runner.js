#!/usr/bin/env node

/**
 * Master E2E Test Runner untuk Minecraft Autonomous Companion.
 * Mendukung eksekusi berjenjang 4-Tier, seleksi flag --tier, filtering aman, pelaporan terstruktur,
 * jaminan eksekusi cleanup hooks via try-finally, dan semantik exit code (0 untuk 100% lulus, 1 untuk kegagalan).
 *
 * Semua label dan output konsol dalam Bahasa Indonesia.
 */

const fs = require('node:fs');
const path = require('node:path');

// Parser argumen CLI
function parseArgs(argv = process.argv) {
  const options = {
    tiers: [1, 2, 3, 4],
    bail: false,
    json: false,
    timeout: 15000,
    filter: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tier' && argv[i + 1]) {
      const tierArg = argv[++i];
      options.tiers = tierArg
        .split(',')
        .map(t => parseInt(t.trim(), 10))
        .filter(t => !isNaN(t) && [1, 2, 3, 4].includes(t));
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
================================================================================
🚀 MINECRAFT AUTONOMOUS COMPANION — MASTER E2E TEST RUNNER
================================================================================

Penggunaan:
  node test/runner.js [opsi]

Opsi:
  --tier <1,2,3,4>    Pilih tier pengujian (1: Coverage, 2: Boundary, 3: Pairwise, 4: Real-World)
                      Contoh: --tier 1 atau --tier 1,2 (default: seluruh tier 1-4)
  --bail              Hentikan eksekusi pengujian segera pada kegagalan pertama
  --json              Tampilkan keluaran hasil ringkasan dalam format JSON
  --timeout <ms>      Batas waktu per kasus uji dalam milidetik (default: 15000ms)
  --filter <regex>    Filter kasus uji berdasarkan nama (pencocokan ekspresi reguler)
  --help, -h          Tampilkan panduan bantuan ini

Semantik Exit Code:
  0: Seluruh kasus uji lulus 100% (Passed)
  1: Terdapat kegagalan pengujian atau terjadi kesalahan sistem (Failed)
================================================================================
      `);
      process.exit(0);
    } else {
      console.error(`Peringatan: Argumen tidak dikenal '${arg}'. Gunakan --help untuk bantuan.`);
    }
  }
  return options;
}

// Engine Pelari Tes Mikro Mandiri (Eksekusi Sekuensial dengan Guard Timeout & Cleanup)
class TestContext {
  constructor(options) {
    this.options = options;
    this.results = [];
    this.currentSuite = '';
    this.filterRegex = this._compileFilter(options.filter);
  }

  _compileFilter(filter) {
    if (!filter) return null;
    try {
      return new RegExp(filter, 'i');
    } catch (e) {
      // Fallback aman: jika pola regex tidak valid, escape karakter khusus agar menjadi pencocokan teks harfiah
      const escaped = String(filter).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped, 'i');
    }
  }

  async runSuite(name, suiteFn) {
    this.currentSuite = name;
    if (!this.options.json) {
      console.log(`\n📦 MENJALANKAN ${name.toUpperCase()}`);
      console.log('-'.repeat(80));
    }

    const testQueue = [];
    const beforeHooks = [];
    const afterHooks = [];

    const suiteContext = {
      test: (testName, fn) => {
        testQueue.push({ name: testName, fn });
      },
      it: (testName, fn) => {
        testQueue.push({ name: testName, fn });
      },
      before: (fn) => {
        beforeHooks.push(fn);
      },
      after: (fn) => {
        afterHooks.push(fn);
      }
    };

    // Daftarkan seluruh tes
    await suiteFn(suiteContext);

    try {
      // Jalankan before hooks
      for (const hook of beforeHooks) {
        await hook();
      }

      // Jalankan seluruh tes secara sekuensial
      for (const item of testQueue) {
        if (this.filterRegex && !this.filterRegex.test(item.name)) {
          continue;
        }

        const start = Date.now();
        let status = 'PASSED';
        let error = null;
        let timerId = null;

        try {
          const timeoutPromise = new Promise((_, reject) => {
            timerId = setTimeout(
              () => reject(new Error(`Timeout: Pengujian melebihi batas waktu ${this.options.timeout}ms`)),
              this.options.timeout
            );
          });

          await Promise.race([
            Promise.resolve().then(() => item.fn()),
            timeoutPromise
          ]);
        } catch (err) {
          status = 'FAILED';
          error = err;
        } finally {
          if (timerId !== null) {
            clearTimeout(timerId);
            timerId = null;
          }
        }

        const duration = Date.now() - start;
        const resultItem = {
          suite: name,
          name: item.name,
          status,
          duration,
          error: error ? error.message : null,
          stack: error ? error.stack : null
        };

        this.results.push(resultItem);

        if (!this.options.json) {
          if (status === 'PASSED') {
            console.log(`  ✔ ${item.name} (${duration}ms)`);
          } else {
            console.error(`  ✖ ${item.name} (${duration}ms)`);
            console.error(`    ↳ Kesalahan: ${error.message}`);
          }
        }

        if (status === 'FAILED' && this.options.bail) {
          throw new Error(`Eksekusi dihentikan (--bail) karena kegagalan pada: ${item.name}`);
        }
      }
    } finally {
      // Jalankan after hooks (pastikan selalu dipanggil bahkan jika terjadi kegagalan atau --bail)
      for (const hook of afterHooks) {
        try {
          await hook();
        } catch (e) {
          // Abaikan kesalahan teardown agar seluruh afterHook tetap diproses
        }
      }
    }
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
    console.log(`Node.js Version: ${process.version} | Target Tiers: [${options.tiers.join(', ')}]`);
    console.log('='.repeat(80));
  }

  const tierFiles = {
    1: { name: 'Tier 1: Feature Coverage (70 Kasus Uji)', path: path.join(__dirname, 'e2e', 'tier1_feature_coverage.test.js') },
    2: { name: 'Tier 2: Boundary & Corner Cases (70 Kasus Uji)', path: path.join(__dirname, 'e2e', 'tier2_boundary_corner.test.js') },
    3: { name: 'Tier 3: Pairwise Cross-Feature Interactions (16 Kasus Uji)', path: path.join(__dirname, 'e2e', 'tier3_pairwise.test.js') },
    4: { name: 'Tier 4: Real-World Workload Scenarios (7 Skenario)', path: path.join(__dirname, 'e2e', 'tier4_realworld.test.js') }
  };

  let hasErrors = false;

  for (const tier of options.tiers) {
    const tierMeta = tierFiles[tier];
    if (tierMeta && fs.existsSync(tierMeta.path)) {
      try {
        const suiteModule = require(tierMeta.path);
        const runnerFn = suiteModule.registerSuite || suiteModule.runSuite || suiteModule;
        if (typeof runnerFn === 'function') {
          await testCtx.runSuite(tierMeta.name, runnerFn);
        } else {
          hasErrors = true;
          if (!options.json) {
            console.error(`  ✖ Kesalahan: Modul suite Tier ${tier} tidak mengekspor fungsi runner yang valid.`);
          }
          if (options.bail) break;
        }
      } catch (err) {
        hasErrors = true;
        if (!options.json) {
          console.error(`Gagal mengeksekusi Tier ${tier}: ${err.message}`);
        }
        if (options.bail) break;
      }
    } else {
      hasErrors = true;
      if (!options.json) {
        console.error(`  ✖ Kesalahan: Berkas suite Tier ${tier} (${tierMeta ? tierMeta.path : 'N/A'}) tidak ditemukan.`);
      }
      if (options.bail) break;
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
  const total = testCtx.results.length;
  const passed = testCtx.results.filter(r => r.status === 'PASSED').length;
  const failed = testCtx.results.filter(r => r.status === 'FAILED').length;

  const isSuccess = failed === 0 && total > 0 && !hasErrors;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          summary: {
            total,
            passed,
            failed,
            hasErrors: Boolean(hasErrors),
            durationSeconds: parseFloat(totalDuration),
            status: isSuccess ? 'PASSED' : 'FAILED'
          },
          results: testCtx.results
        },
        null,
        2
      )
    );
  } else {
    console.log('\n' + '='.repeat(80));
    console.log('📊 RINGKASAN EKSEKUSI PENGUJIAN E2E');
    console.log('='.repeat(80));
    console.log(`Total Pengujian : ${total}`);
    console.log(`Lulus (Pass)    : ${passed} ✔`);
    console.log(`Gagal (Fail)    : ${failed} ✖`);
    console.log(`Waktu Eksekusi  : ${totalDuration} detik`);
    console.log('-'.repeat(80));
    console.log(
      `Status Akhir    : ${
        isSuccess
          ? 'SEMUA SUITE LULUS 100% (PASSED) 🎉'
          : total === 0
          ? 'TIDAK ADA PENGUJIAN DIJALANKAN (ZERO TESTS) ⚠'
          : 'PENGUJIAN GAGAL (FAILED) ❌'
      }`
    );
    console.log('='.repeat(80));
  }

  if (!isSuccess) {
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
