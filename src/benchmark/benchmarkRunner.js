/**
 * @file benchmarkRunner.js
 * @description Orkestrator eksekusi benchmark navigasi otomatis Level 1-4.
 * Menjalankan: start server -> build arena -> spawn bot -> navigate -> ukur hasil.
 */

const testServerModule = require('../server/testServer');
const { buildArena } = require('../server/arenaBuilder');
const { createBot, disconnectBot } = require('../navigation/botClient');
const { navigateTo, getPosition, calculateDistance } = require('../navigation/movementController');
const { StuckDetector } = require('../navigation/stuckDetector');
const { RecoveryStateMachine } = require('../navigation/recoveryStateMachine');
const { getNextWaypoint, isAtWaypoint } = require('../navigation/waypointGraph');
const { BENCHMARK_CONFIGS, BENCHMARK_LEVELS, BENCHMARK_STATUS } = require('../config/constants');

class BenchmarkRunner {
  constructor(options = {}) {
    this.telemetryRepo = options.telemetryRepo || null;
    this.onProgress = options.onProgress || (() => {});
    this.onComplete = options.onComplete || (() => {});
    this.isRunning = false;
    this.results = [];
  }

  /**
   * Menjalankan benchmark untuk satu level tertentu.
   * @param {number} level - Nomor level (1, 2, 3, atau 4)
   * @returns {Promise<Object>} Hasil benchmark
   */
  async runBenchmark(level) {
    const levelKey = `level${level}`;
    const config = BENCHMARK_CONFIGS[levelKey];
    if (!config) throw new Error(`Level ${level} tidak valid`);

    this.isRunning = true;
    console.log(`\n[Benchmark] ▶ Memulai Level ${level}: ${config.nameId}`);
    this.onProgress({ level, status: BENCHMARK_STATUS.RUNNING, message: `Memulai Level ${level}: ${config.nameId}` });

    let server = null;
    let bot = null;
    const startTime = Date.now();

    try {
      // 1. Mulai server headless
      console.log('[Benchmark] Memulai server headless...');
      server = await testServerModule.startTestServer({ port: 25567, version: '1.20.1' });

      // 2. Bangun arena (gunakan wrapper setBlock dari modul testServer)
      console.log(`[Benchmark] Membangun arena Level ${level}...`);
      const arenaServer = {
        setBlock: (x, y, z, name, props) => testServerModule.setBlock(x, y, z, name, props)
      };
      const arenaInfo = await buildArena(level, arenaServer);

      // 3. Sambungkan bot
      console.log('[Benchmark] Menghubungkan bot...');
      bot = await createBot({ port: 25567, username: `BenchmarkBot_L${level}` });

      // Tunggu bot stabil & chunks termuat oleh server (flying-squid perlu waktu muat)
      console.log('[Benchmark] Menunggu chunks termuat (6 detik)...');
      await new Promise(r => setTimeout(r, 6000));

      // 4. Teleportasi bot ke posisi awal
      const startPos = config.startCoord;
      const targetPos = config.targetCoord;

      // 5. Navigasi ke target
      console.log(`[Benchmark] Navigasi dari (${startPos.x}, ${startPos.y}, ${startPos.z}) ke (${targetPos.x}, ${targetPos.y}, ${targetPos.z})...`);

      const stuckDetector = new StuckDetector();
      const recovery = new RecoveryStateMachine();
      let stuckRecoveryCount = 0;

      // Untuk Level 4, gunakan waypoint graph
      let navResult;
      if (level === 4) {
        navResult = await this._navigateWithWaypoints(bot, targetPos, stuckDetector, recovery, config.timeoutMs);
        stuckRecoveryCount = navResult.stuckRecoveryCount || 0;
      } else {
        navResult = await navigateTo(bot, targetPos, 2.5);
      }

      const duration = Date.now() - startTime;
      const finalPos = getPosition(bot);
      const coordinateDelta = calculateDistance(finalPos, targetPos);
      const success = navResult.success || coordinateDelta <= 3.0;

      const result = {
        level,
        levelName: config.nameId,
        status: success ? BENCHMARK_STATUS.SUCCESS : BENCHMARK_STATUS.FAILED,
        success,
        duration_ms: duration,
        startPos,
        endPos: finalPos,
        targetPos,
        coordinateDelta: Math.round(coordinateDelta * 100) / 100,
        stuckRecoveryCount,
        error: navResult.error || null,
        timestamp: new Date().toISOString()
      };

      console.log(`[Benchmark] ${success ? '✅' : '❌'} Level ${level}: ${result.status} (Delta: ${result.coordinateDelta}m, Durasi: ${result.duration_ms}ms)`);
      this.results.push(result);
      this.onComplete(result);

      // Simpan ke database jika tersedia
      if (this.telemetryRepo) {
        try {
          await this.telemetryRepo.insertBenchmarkResult(result);
        } catch (e) {
          console.error('[Benchmark] Gagal menyimpan hasil ke database:', e.message);
        }
      }

      return result;
    } catch (error) {
      const result = {
        level,
        levelName: config.nameId,
        status: BENCHMARK_STATUS.FAILED,
        success: false,
        duration_ms: Date.now() - startTime,
        error: error.message,
        timestamp: new Date().toISOString()
      };
      console.error(`[Benchmark] ❌ Level ${level} error:`, error.message);
      this.results.push(result);
      this.onComplete(result);
      return result;
    } finally {
      // Cleanup
      if (bot) await disconnectBot(bot);
      await testServerModule.stopTestServer();
      this.isRunning = false;
    }
  }

  /**
   * Navigasi Level 4 menggunakan waypoint graph makro.
   * @private
   */
  async _navigateWithWaypoints(bot, finalTarget, stuckDetector, recovery, timeoutMs) {
    const overallStart = Date.now();
    let stuckRecoveryCount = 0;

    while (Date.now() - overallStart < timeoutMs) {
      const currentPos = getPosition(bot);
      const nextWp = getNextWaypoint(currentPos, finalTarget);

      if (!nextWp || isAtWaypoint(currentPos, finalTarget, 3)) {
        return { success: true, stuckRecoveryCount };
      }

      console.log(`[Benchmark L4] Navigasi ke waypoint: ${nextWp.label} (${nextWp.x}, ${nextWp.y}, ${nextWp.z})`);
      const result = await navigateTo(bot, nextWp, 3);

      if (!result.success) {
        stuckRecoveryCount++;
        console.log(`[Benchmark L4] Waypoint gagal, memulai pemulihan fase ${recovery.currentPhase + 1}...`);
        await recovery.attemptRecovery(bot);
      }
    }

    return { success: false, error: 'Timeout navigasi Level 4', stuckRecoveryCount };
  }

  /**
   * Menjalankan seluruh benchmark Level 1-4 secara berurutan.
   * Level 1 memerlukan 5 kali berturut-turut sukses.
   * @returns {Promise<Array>} Daftar hasil semua level
   */
  async runAllBenchmarks() {
    const allResults = [];

    // Level 1: 5 kali berturut-turut
    console.log('\n[Benchmark] ═══ Memulai Level 1: 5 Kali Berturut-turut ═══');
    let consecutiveSuccesses = 0;
    for (let i = 0; i < 5; i++) {
      const result = await this.runBenchmark(1);
      result.runNumber = i + 1;
      allResults.push(result);
      if (result.success) {
        consecutiveSuccesses++;
      } else {
        console.log(`[Benchmark] Level 1 gagal pada percobaan ke-${i + 1}. Berhenti.`);
        break;
      }
      // Jeda antar percobaan
      await new Promise(r => setTimeout(r, 1000));
    }

    if (consecutiveSuccesses < 5) {
      console.log(`[Benchmark] Level 1 hanya berhasil ${consecutiveSuccesses}/5 kali. Benchmark dihentikan.`);
      return allResults;
    }

    // Level 2-4: Masing-masing 1 kali
    for (let level = 2; level <= 4; level++) {
      console.log(`\n[Benchmark] ═══ Memulai Level ${level} ═══`);
      const result = await this.runBenchmark(level);
      allResults.push(result);

      if (!result.success) {
        console.log(`[Benchmark] Level ${level} gagal. Benchmark dihentikan.`);
        break;
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    // Ringkasan
    const passed = allResults.filter(r => r.success).length;
    const total = allResults.length;
    console.log(`\n[Benchmark] ═══ RINGKASAN: ${passed}/${total} Berhasil ═══`);

    return allResults;
  }

  /**
   * Mendapatkan seluruh hasil benchmark.
   * @returns {Array}
   */
  getResults() {
    return [...this.results];
  }
}

module.exports = { BenchmarkRunner };
