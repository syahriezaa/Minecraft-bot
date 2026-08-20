/**
 * @file telemetry_db_test.js
 * @description Suite Pengujian Komprehensif Database PostgreSQL & Layanan Telemetri (Milestone 1).
 * Menguji:
 * 1. Konektivitas pool database & pemeriksaan kesehatan (health check).
 * 2. Eksekusi migrasi skema DDL (5 tabel resmi + 10 indeks) serta idempotensi migrasi.
 * 3. Operasi CRUD repository telemetri, logging ringkasan, dan audit AI.
 * 4. Simulasi Ingestion Batch 20 Hz (100+ tick points) dan verifikasi persistensi penuh di PostgreSQL.
 * 5. Ketahanan terhadap koneksi putus (buffer retention & auto-recovery), buffer capping (anti-OOM), dan graceful shutdown.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

// Import modul yang diuji
const { pool, checkDatabaseHealth, closeDatabasePool } = require('../../src/config/database');
const { runMigrations, resetDatabase } = require('../../src/database/migrations');
const telemetryRepo = require('../../src/database/telemetryRepository');
const { BatchIngestionService } = require('../../src/database/batchIngestion');

describe('Suite Verifikasi PostgreSQL Telemetry & Batch Ingestion (Milestone 1)', () => {
  before(async () => {
    // Pastikan koneksi database hidup sebelum menjalankan test
    const health = await checkDatabaseHealth();
    assert.equal(health.ok, true, `Database harus dalam kondisi siap: ${health.error}`);
    // Reset dan inisialisasi skema awal
    await runMigrations(pool);
  });

  after(async () => {
    // Tutup pool koneksi database secara anggun
    await closeDatabasePool();
  });

  // ===========================================================================
  // 1. KONEKTIVITAS DATABASE & HEALTH CHECK
  // ===========================================================================
  describe('1. Konektivitas Database & Health Check', () => {
    it('harus berhasil melakukan ping dan query sederhana SELECT 1', async () => {
      const result = await pool.query('SELECT 1 AS alive, current_database() AS db_name;');
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].alive, 1);
      assert.equal(result.rows[0].db_name, 'minecraft_companion');
    });

    it('harus mengembalikan status health check ok dengan rincian database, user, dan latensi', async () => {
      const health = await checkDatabaseHealth();
      assert.equal(health.ok, true);
      assert.ok(health.latencyMs >= 0);
      assert.equal(health.database, 'minecraft_companion');
      assert.ok(health.version.includes('PostgreSQL'));
    });
  });

  // ===========================================================================
  // 2. MIGRASI SKEMA DDL & IDEMPOTENSI
  // ===========================================================================
  describe('2. Migrasi Skema DDL & Idempotensi', () => {
    it('harus memverifikasi keberadaan kelima tabel resmi di database', async () => {
      const query = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('schema_migrations', 'benchmark_runs', 'telemetry_logs', 'movement_action_logs', 'action_audit_logs');
      `;
      const { rows } = await pool.query(query);
      const tableNames = rows.map((r) => r.table_name);

      assert.ok(tableNames.includes('schema_migrations'), 'Tabel schema_migrations harus ada');
      assert.ok(tableNames.includes('benchmark_runs'), 'Tabel benchmark_runs harus ada');
      assert.ok(tableNames.includes('telemetry_logs'), 'Tabel telemetry_logs harus ada');
      assert.ok(tableNames.includes('movement_action_logs'), 'Tabel movement_action_logs harus ada');
      assert.ok(tableNames.includes('action_audit_logs'), 'Tabel action_audit_logs harus ada');
    });

    it('harus memverifikasi keberadaan seluruh indeks komposit dan B-tree', async () => {
      const query = `
        SELECT indexname 
        FROM pg_indexes 
        WHERE schemaname = 'public';
      `;
      const { rows } = await pool.query(query);
      const indexNames = rows.map((r) => r.indexname);

      assert.ok(indexNames.includes('idx_benchmark_runs_level_status'));
      assert.ok(indexNames.includes('idx_benchmark_runs_start_time'));
      assert.ok(indexNames.includes('idx_telemetry_logs_run_id'));
      assert.ok(indexNames.includes('idx_telemetry_logs_level_status'));
      assert.ok(indexNames.includes('idx_movement_logs_run_tick'));
      assert.ok(indexNames.includes('idx_movement_logs_run_stuck'));
      assert.ok(indexNames.includes('idx_action_audit_run_id'));
    });

    it('harus bersifat idempoten saat migrasi dijalankan ulang untuk kedua kalinya tanpa error', async () => {
      const result = await runMigrations(pool);
      assert.equal(result.appliedCount, 0, 'Tidak boleh ada migrasi baru yang dijalankan ulang');
    });
  });

  // ===========================================================================
  // 3. OPERASI CRUD TELEMETRY REPOSITORY
  // ===========================================================================
  describe('3. Operasi CRUD Telemetry Repository', () => {
    let testRunId;

    it('harus berhasil membuat entri benchmark_run baru dengan status RUNNING', async () => {
      testRunId = uuidv4();
      const run = await telemetryRepo.createBenchmarkRun(pool, {
        id: testRunId,
        level: 'level1',
        status: 'RUNNING',
        metadata: { bot_name: 'ExplorerBot', environment: 'test_arena' }
      });

      assert.equal(run.id, testRunId);
      assert.equal(run.level, 'level1');
      assert.equal(run.status, 'RUNNING');
      assert.equal(run.obstacle_count, 0);
      assert.equal(run.metadata.bot_name, 'ExplorerBot');
    });

    it('harus berhasil memperbarui status benchmark_run ke SUCCESS beserta metrik akhir', async () => {
      const updated = await telemetryRepo.updateBenchmarkRunStatus(pool, testRunId, {
        status: 'SUCCESS',
        end_time: new Date(),
        duration_ms: 8500,
        obstacle_count: 2,
        stuck_recovery_count: 1,
        success_rate: 1.0,
        metadata: { verified: true }
      });

      assert.equal(updated.id, testRunId);
      assert.equal(updated.status, 'SUCCESS');
      assert.equal(updated.duration_ms, 8500);
      assert.equal(updated.obstacle_count, 2);
      assert.equal(updated.stuck_recovery_count, 1);
      assert.equal(updated.success_rate, 1.0);
      assert.equal(updated.metadata.verified, true);
    });

    it('harus dapat mengambil detail benchmark run berdasarkan ID', async () => {
      const run = await telemetryRepo.getBenchmarkRunById(pool, testRunId);
      assert.ok(run);
      assert.equal(run.id, testRunId);
      assert.equal(run.status, 'SUCCESS');
    });

    it('harus berhasil menyimpan ringkasan telemetri ke telemetry_logs dengan data JSONB', async () => {
      const summary = await telemetryRepo.logTelemetrySummary(pool, {
        run_id: testRunId,
        level: 'level1',
        status: 'SUCCESS',
        travel_duration_ms: 8500,
        obstacle_count: 2,
        start_pos: { x: 0, y: 64, z: 0 },
        end_pos: { x: 30, y: 64, z: 0 },
        coordinate_delta: 30.0,
        path_history: [
          { tick: 0, x: 0, y: 64, z: 0 },
          { tick: 20, x: 10, y: 64, z: 0 },
          { tick: 60, x: 30, y: 64, z: 0 }
        ]
      });

      assert.equal(summary.run_id, testRunId);
      assert.equal(summary.coordinate_delta, 30.0);
      assert.equal(summary.start_pos.x, 0);
      assert.equal(summary.end_pos.x, 30);
      assert.equal(summary.path_history.length, 3);
    });

    it('harus dapat mengambil ringkasan telemetri berdasarkan run_id', async () => {
      const tele = await telemetryRepo.getTelemetryByRunId(pool, testRunId);
      assert.ok(tele);
      assert.equal(tele.run_id, testRunId);
      assert.equal(tele.travel_duration_ms, 8500);
    });

    it('harus berhasil mencatat audit tindakan AI ke action_audit_logs', async () => {
      const audit = await telemetryRepo.logActionAudit(pool, {
        run_id: testRunId,
        task: 'ZOMBIE_FARM',
        action_type: 'ATTACK_COOLDOWN_PACER',
        payload: { target: 'zombie', weapon: 'iron_sword', attackCooldownMs: 625 },
        result: { status: 'HIT_SUCCESS', damageDealt: 9.0 }
      });

      assert.equal(audit.run_id, testRunId);
      assert.equal(audit.task, 'ZOMBIE_FARM');
      assert.equal(audit.payload.attackCooldownMs, 625);
      assert.equal(audit.result.status, 'HIT_SUCCESS');
    });

    it('harus dapat mengambil riwayat recent runs dan statistik agregat', async () => {
      const recent = await telemetryRepo.queryRecentRuns(pool, { limit: 5 });
      assert.ok(Array.isArray(recent));
      assert.ok(recent.length >= 1);

      const stats = await telemetryRepo.getAggregateBenchmarkStats(pool, 'level1');
      assert.ok(Array.isArray(stats));
      assert.ok(stats.length >= 1);
      assert.equal(stats[0].level, 'level1');
      assert.ok(stats[0].total_runs >= 1);
    });
  });

  // ===========================================================================
  // 4. SIMULASI BATCH INGESTION 20 HZ (100+ TICK POINTS)
  // ===========================================================================
  describe('4. Simulasi Ingestion Batch Telemetri Tick 20 Hz', () => {
    let batchRunId;

    beforeEach(async () => {
      batchRunId = uuidv4();
      await telemetryRepo.createBenchmarkRun(pool, {
        id: batchRunId,
        level: 'level2',
        status: 'RUNNING'
      });
    });

    it('harus dapat menerima 120 tick points (simulasi 20 Hz) dan menyimpan 100% data secara utuh ke PostgreSQL via UNNEST', async () => {
      const batchService = new BatchIngestionService(pool, {
        flushIntervalMs: 250,
        batchThreshold: 50,
        maxBufferSize: 5000
      });

      const totalTicks = 120; // 6 detik navigasi pada 20 Hz
      for (let t = 1; t <= totalTicks; t++) {
        batchService.ingestTick({
          run_id: batchRunId,
          tick: t,
          x: Number((t * 0.25).toFixed(2)),
          y: 64.0,
          z: 0.0,
          velocity_xz: 0.21,
          action: t % 20 === 0 ? 'MICRO_JUMP' : 'SPRINT_FORWARD',
          is_stuck: t === 50,
          recovery_phase: t === 50 ? 1 : 0
        });
      }

      // Tunggu graceful shutdown dan flush seluruh antrean
      const stats = await batchService.flushAndClose();

      assert.equal(stats.totalIngested, 120);
      assert.equal(stats.totalPersisted, 120);
      assert.equal(stats.totalDropped, 0);
      assert.equal(stats.queueLength, 0);

      // Verifikasi langsung ke database PostgreSQL
      const logs = await telemetryRepo.queryMovementLogs(pool, batchRunId, { limit: 200 });
      assert.equal(logs.length, 120, 'Harus tersimpan tepat 120 baris log movement di PostgreSQL');

      // Validasi urutan tick dan nilai record
      assert.equal(Number(logs[0].tick), 1);
      assert.equal(Number(logs[119].tick), 120);
      assert.equal(logs[49].is_stuck, true, 'Tick ke-50 harus tercatat is_stuck = true');
      assert.equal(logs[49].recovery_phase, 1, 'Tick ke-50 harus memiliki recovery_phase = 1');
      assert.equal(logs[19].action, 'MICRO_JUMP', 'Tick ke-20 harus memiliki action MICRO_JUMP');
    });

    it('harus memicu flush instan ketika antrean mencapai ambang batas batchThreshold (50 items)', async () => {
      const batchService = new BatchIngestionService(pool, {
        flushIntervalMs: 10000, // Set interval waktu sangat lama (10 detik) untuk memastikan flush terpicu oleh ambang ukuran
        batchThreshold: 50
      });

      let flushEventEmitted = false;
      batchService.on('flushed', (data) => {
        if (data.count >= 50) {
          flushEventEmitted = true;
        }
      });

      // Masukkan 50 item langsung
      for (let i = 1; i <= 50; i++) {
        batchService.ingestTick({
          run_id: batchRunId,
          tick: i,
          x: i,
          y: 64,
          z: 0,
          velocity_xz: 0.2
        });
      }

      // Beri sedikit waktu untuk setImmediate menjalankan flush threshold
      await new Promise((resolve) => setTimeout(resolve, 80));

      assert.equal(flushEventEmitted, true, 'Event flushed harus terpanggil karena batchThreshold terpenuhi');
      assert.equal(batchService.totalPersisted, 50);

      await batchService.flushAndClose();
    });
  });

  // ===========================================================================
  // 5. KETAHANAN JARINGAN, BUFFER CAPPING, & GRACEFUL SHUTDOWN
  // ===========================================================================
  describe('5. Ketahanan Jaringan, Buffer Capping, & Graceful Shutdown', () => {
    it('harus mempertahankan data dalam antrean saat koneksi database gagal, lalu flush saat koneksi pulih', async () => {
      let isDbDown = true;
      const testRunId = uuidv4();

      // Mock pool yang mensimulasikan kegagalan jaringan
      const mockPool = {
        async query(q, p) {
          if (isDbDown) {
            throw new Error('Koneksi PostgreSQL terputus (ECONNREFUSED / Socket closed)');
          }
          return pool.query(q, p);
        }
      };

      const batchService = new BatchIngestionService(mockPool, {
        flushIntervalMs: 0, // Manual flush untuk kontrol presisi
        batchThreshold: 100,
        maxBufferSize: 1000
      });

      // Ingest 30 tick saat DB bermasalah
      for (let i = 1; i <= 30; i++) {
        batchService.ingestTick({
          run_id: testRunId,
          tick: i,
          x: i,
          y: 64,
          z: 0
        });
      }

      assert.equal(batchService.queue.length, 30);

      // Coba flush saat DB mati -> harus melempar error dan mengembalikan data ke antrean
      await assert.rejects(async () => {
        await batchService.flush();
      }, /Gagal menyimpan batch telemetri ke database/);

      // Verifikasi data TIDAK hilang dari antrean
      assert.equal(batchService.queue.length, 30, 'Data harus tetap dipertahankan di buffer saat flush gagal');
      assert.equal(batchService.totalPersisted, 0);

      // Pulihkan status DB
      isDbDown = false;

      // Flush ulang saat DB sudah pulih
      const flushResult = await batchService.flush();
      assert.equal(flushResult.count, 30);
      assert.equal(batchService.queue.length, 0);
      assert.equal(batchService.totalPersisted, 30);

      await batchService.flushAndClose();
    });

    it('harus membatasi kapasitas buffer pada maxBufferSize dan membuang data tertua untuk mencegah OOM', async () => {
      const mockPool = {
        async query() {
          throw new Error('Database offline');
        }
      };

      const batchService = new BatchIngestionService(mockPool, {
        flushIntervalMs: 0,
        maxBufferSize: 40 // Kapasitas buffer kecil untuk pengujian capping
      });

      // Ingest 65 items (melebihi kapasitas 40)
      for (let i = 1; i <= 65; i++) {
        batchService.ingestTick({
          run_id: uuidv4(),
          tick: i,
          x: i,
          y: 64,
          z: 0
        });
      }

      assert.equal(batchService.queue.length, 40, 'Panjang antrean tidak boleh melebihi maxBufferSize 40');
      assert.equal(batchService.totalDropped, 25, 'Harus ada tepat 25 data tertua yang dibuang');
      assert.equal(batchService.queue[0].tick, 26, 'Item tertua di antrean saat ini harus tick ke-26');
      assert.equal(batchService.queue[39].tick, 65, 'Item terbaru di antrean harus tick ke-65');

      batchService.stopTimer();
    });

    it('harus menolak data baru setelah layanan ditutup dengan flushAndClose()', async () => {
      const batchService = new BatchIngestionService(pool, { flushIntervalMs: 250 });
      await batchService.flushAndClose();

      assert.throws(() => {
        batchService.ingestTick({
          run_id: uuidv4(),
          tick: 1,
          x: 0,
          y: 64,
          z: 0
        });
      }, /Layanan batch ingestion telah ditutup/);
    });
  });
});
