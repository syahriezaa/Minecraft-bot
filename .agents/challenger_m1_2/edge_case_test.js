/**
 * @file edge_case_test.js
 * @description Suite Pengujian Empiris Edge Cases, Boundary Conditions, Integritas Relasional, dan Idempotensi (Challenger 2 Milestone 1).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

// Import modul implementasi Milestone 1
const { pool, checkDatabaseHealth, closeDatabasePool } = require('../../src/config/database');
const { runMigrations, resetDatabase, ensureMigrationsTable } = require('../../src/database/migrations');
const telemetryRepo = require('../../src/database/telemetryRepository');
const { BatchIngestionService } = require('../../src/database/batchIngestion');

describe('Tantangan Empiris Challenger 2 — Milestone 1 (Edge Cases, FK Integrity, Input Validation, Idempotency)', () => {
  before(async () => {
    // 1. Verifikasi kesehatan PostgreSQL
    const health = await checkDatabaseHealth();
    assert.equal(health.ok, true, `PostgreSQL harus dalam kondisi aktif: ${health.error}`);

    // 2. Pastikan migrasi terbaru aktif
    await runMigrations(pool);
  });

  after(async () => {
    // Bersihkan pool setelah pengujian
    await closeDatabasePool();
  });

  // =========================================================================
  // 1. KONDISI BATAS EKSTRIM: JSONB BESAR, BERSARANG, & 100+ KOORDINAT
  // =========================================================================
  describe('1. Kondisi Batas Ekstrim (Large Nested JSONB & 100+ Coordinates)', () => {
    const extremeRunId = uuidv4();

    it('harus mampu menyimpan dan mengambil metadata bersarang 5 tingkat dengan karakter unicode dan struktur kompleks', async () => {
      const nestedMetadata = {
        bot_configuration: {
          version: '1.20.1',
          heuristics: {
            stuck_window: {
              size: 20,
              velocity_threshold: 0.05,
              stuck_flags: [true, false, true, { reason: 'UNREACHABLE_NODE', depth: 4 }]
            },
            recovery: {
              phases: ['MICRO_JUMP', 'LATERAL_STRAFE', 'RE_ROUTE', 'REWIND_BACKTRACK'],
              timeout_pacing_ms: 625,
              advanced_ai: {
                model: 'deepseek-chat',
                prompt_tokens: 1540,
                nested_eval: {
                  deep_key: 'Nilai validasi dalam Bahasa Indonesia: Berhasil 100% 🤖 🚀',
                  unicode_chars: '日本語・한국어・العربية・Minecraft ⛏️'
                }
              }
            }
          }
        },
        system_stats: {
          node_version: process.version,
          memory_rss_mb: 42.5
        }
      };

      const created = await telemetryRepo.createBenchmarkRun(pool, {
        id: extremeRunId,
        level: 'level4',
        status: 'RUNNING',
        metadata: nestedMetadata
      });

      assert.equal(created.id, extremeRunId);
      assert.deepEqual(created.metadata.bot_configuration.heuristics.recovery.advanced_ai.nested_eval.deep_key,
        'Nilai validasi dalam Bahasa Indonesia: Berhasil 100% 🤖 🚀');
      assert.equal(created.metadata.bot_configuration.heuristics.recovery.phases.length, 4);

      // Uji JSONB Merge saat Update Status
      const updateMetadataPatch = {
        completion_report: {
          target_reached: true,
          spawner_coords: [-256, -20, -432],
          mobs_killed: 45
        }
      };

      const updated = await telemetryRepo.updateBenchmarkRunStatus(pool, extremeRunId, {
        status: 'SUCCESS',
        duration_ms: 18450,
        obstacle_count: 12,
        stuck_recovery_count: 3,
        success_rate: 1.0,
        metadata: updateMetadataPatch
      });

      assert.equal(updated.status, 'SUCCESS');
      // Verifikasi bahwa metadata lama tetap utuh (merged)
      assert.equal(updated.metadata.bot_configuration.version, '1.20.1');
      assert.deepEqual(updated.metadata.completion_report.spawner_coords, [-256, -20, -432]);
    });

    it('harus mampu menyimpan start_pos dan end_pos dengan koordinat negatif float presisi tinggi', async () => {
      const startPos = { x: 12.87654321, y: 64.0, z: -89.12345678, yaw: 180.5, pitch: -12.3 };
      const endPos = { x: -256.0, y: -20.5, z: -432.0, yaw: 90.0, pitch: 0.0, biome: 'deep_dark_spawner' };

      // Buat 150 titik riwayat jalur (path_history)
      const pathHistory = [];
      for (let i = 0; i < 150; i++) {
        pathHistory.push({
          tick: i,
          x: Number((startPos.x + (endPos.x - startPos.x) * (i / 149)).toFixed(4)),
          y: Number((startPos.y + (endPos.y - startPos.y) * (i / 149)).toFixed(4)),
          z: Number((startPos.z + (endPos.z - startPos.z) * (i / 149)).toFixed(4)),
          velocity_xz: Number((0.21 + Math.sin(i / 10) * 0.05).toFixed(4)),
          action: i % 30 === 0 ? 'MICRO_JUMP' : (i % 50 === 0 ? 'RE_ROUTE' : 'SPRINT_FORWARD'),
          is_stuck: i === 45,
          recovery_phase: i === 45 ? 1 : 0
        });
      }

      const summary = await telemetryRepo.logTelemetrySummary(pool, {
        run_id: extremeRunId,
        level: 'level4',
        status: 'SUCCESS',
        travel_duration_ms: 18450,
        obstacle_count: 12,
        start_pos: startPos,
        end_pos: endPos,
        coordinate_delta: 532.84,
        path_history: pathHistory
      });

      assert.equal(summary.run_id, extremeRunId);
      assert.equal(summary.coordinate_delta, 532.84);
      assert.equal(summary.start_pos.z, -89.12345678);
      assert.equal(summary.end_pos.biome, 'deep_dark_spawner');
      assert.equal(Array.isArray(summary.path_history), true);
      assert.equal(summary.path_history.length, 150, 'Path history harus menampung tepat 150 koordinat');

      // Ambil kembali dari database untuk memverifikasi parsing JSONB
      const retrieved = await telemetryRepo.getTelemetryByRunId(pool, extremeRunId);
      assert.ok(retrieved);
      assert.equal(retrieved.path_history.length, 150);
      assert.deepEqual(retrieved.path_history[149].x, -256.0);
      assert.deepEqual(retrieved.path_history[149].y, -20.5);
      assert.deepEqual(retrieved.path_history[149].z, -432.0);
    });
  });

  // =========================================================================
  // 2. INTEGRITAS KUNCI ASING (CASCADE DELETION & SET NULL)
  // =========================================================================
  describe('2. Integritas Relasional Kunci Asing (Foreign Key Integrity)', () => {
    let parentRunId;

    it('harus menghapus telemetry_logs & movement_action_logs via CASCADE, dan mengubah run_id pada action_audit_logs menjadi NULL saat benchmark_run dihapus', async () => {
      parentRunId = uuidv4();

      // 1. Buat parent benchmark run
      await telemetryRepo.createBenchmarkRun(pool, {
        id: parentRunId,
        level: 'level3',
        status: 'RUNNING'
      });

      // 2. Buat telemetry_logs terkait
      await telemetryRepo.logTelemetrySummary(pool, {
        run_id: parentRunId,
        level: 'level3',
        status: 'RUNNING',
        travel_duration_ms: 3000,
        obstacle_count: 2,
        start_pos: { x: 0, y: 64, z: 0 },
        end_pos: { x: 10, y: 70, z: 10 },
        coordinate_delta: 15.0,
        path_history: [{ tick: 1, x: 0, y: 64, z: 0 }]
      });

      // 3. Buat 10 baris movement_action_logs terkait
      const movementBatch = [];
      for (let t = 1; t <= 10; t++) {
        movementBatch.push({
          run_id: parentRunId,
          tick: t,
          x: t * 1.0,
          y: 64.0 + t * 0.5,
          z: t * 1.0,
          velocity_xz: 0.2,
          action: 'CLIMB_LADDER',
          is_stuck: false,
          recovery_phase: 0
        });
      }
      const insertedMoves = await telemetryRepo.logMovementActionBatch(pool, movementBatch);
      assert.equal(insertedMoves, 10);

      // 4. Buat 2 baris action_audit_logs terkait
      const audit1 = await telemetryRepo.logActionAudit(pool, {
        run_id: parentRunId,
        task: 'STAIR_CLIMB',
        action_type: 'ALIGN_LADDER_PITCH',
        payload: { targetPitch: -45.0 },
        result: { status: 'ALIGNED' }
      });
      const audit2 = await telemetryRepo.logActionAudit(pool, {
        run_id: parentRunId,
        task: 'BRIDGE_CROSS',
        action_type: 'SNEAK_WALK',
        payload: { sneak: true },
        result: { status: 'SAFE_ON_EDGE' }
      });

      assert.equal(audit1.run_id, parentRunId);
      assert.equal(audit2.run_id, parentRunId);

      // 5. Hapus parent benchmark_run
      const deleteResult = await pool.query('DELETE FROM benchmark_runs WHERE id = $1 RETURNING id;', [parentRunId]);
      assert.equal(deleteResult.rowCount, 1, 'Parent benchmark run harus berhasil dihapus');

      // 6. Verifikasi CASCADE pada telemetry_logs
      const teleCheck = await pool.query('SELECT COUNT(*)::int AS count FROM telemetry_logs WHERE run_id = $1;', [parentRunId]);
      assert.equal(teleCheck.rows[0].count, 0, 'telemetry_logs harus terhapus otomatis melalui CASCADE');

      // 7. Verifikasi CASCADE pada movement_action_logs
      const moveCheck = await pool.query('SELECT COUNT(*)::int AS count FROM movement_action_logs WHERE run_id = $1;', [parentRunId]);
      assert.equal(moveCheck.rows[0].count, 0, 'movement_action_logs harus terhapus otomatis melalui CASCADE');

      // 8. Verifikasi ON DELETE SET NULL pada action_audit_logs
      const auditCheck = await pool.query('SELECT id, run_id, task, action_type FROM action_audit_logs WHERE id IN ($1, $2);', [audit1.id, audit2.id]);
      assert.equal(auditCheck.rows.length, 2, 'action_audit_logs harus tetap tersimpan untuk riwayat audit');
      assert.equal(auditCheck.rows[0].run_id, null, 'Audit log 1 harus memiliki run_id = NULL');
      assert.equal(auditCheck.rows[1].run_id, null, 'Audit log 2 harus memiliki run_id = NULL');

      // 9. Verifikasi kueri repository action_audit_logs masih dapat mengambil audit log tanpa run_id
      const queryAudits = await telemetryRepo.queryActionAudits(pool, { task: 'STAIR_CLIMB' });
      assert.ok(queryAudits.length >= 1);
      assert.equal(queryAudits[0].run_id, null);
    });
  });

  // =========================================================================
  // 3. VALIDASI INPUT & PESAN ERROR DALAM BAHASA INDONESIA
  // =========================================================================
  describe('3. Validasi Input & Penanganan Error Berbahasa Indonesia', () => {
    it('harus menolak pembuatan benchmark run tanpa parameter level dengan pesan Bahasa Indonesia', async () => {
      await assert.rejects(async () => {
        await telemetryRepo.createBenchmarkRun(pool, {});
      }, (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Parameter level wajib diisi untuk membuat benchmark run/);
        return true;
      });

      await assert.rejects(async () => {
        await telemetryRepo.createBenchmarkRun(pool, null);
      }, (err) => {
        assert.match(err.message, /Parameter level wajib diisi/);
        return true;
      });
    });

    it('harus menolak pembaruan benchmark run tanpa runId dengan pesan Bahasa Indonesia', async () => {
      await assert.rejects(async () => {
        await telemetryRepo.updateBenchmarkRunStatus(pool, null, { status: 'SUCCESS' });
      }, (err) => {
        assert.match(err.message, /runId wajib disediakan untuk memperbarui status benchmark run/);
        return true;
      });
    });

    it('harus mengembalikan null secara anggun jika memperbarui benchmark run dengan ID yang tidak ada', async () => {
      const nonExistentId = uuidv4();
      const result = await telemetryRepo.updateBenchmarkRunStatus(pool, nonExistentId, { status: 'SUCCESS' });
      assert.equal(result, null, 'Pembaruan UUID yang tidak ditemukan harus mengembalikan null tanpa error fatal');
    });

    it('harus menolak getBenchmarkRunById tanpa runId dengan pesan Bahasa Indonesia', async () => {
      await assert.rejects(async () => {
        await telemetryRepo.getBenchmarkRunById(pool, null);
      }, (err) => {
        assert.match(err.message, /runId wajib disediakan/);
        return true;
      });
    });

    it('harus menolak logging ringkasan telemetri tanpa field wajib dengan pesan Bahasa Indonesia', async () => {
      await assert.rejects(async () => {
        await telemetryRepo.logTelemetrySummary(pool, { level: 'level1' });
      }, (err) => {
        assert.match(err.message, /run_id, level, dan status wajib diisi untuk menyimpan ringkasan telemetri/);
        return true;
      });
    });

    it('harus menolak logging movement action tanpa run_id atau tick dengan pesan Bahasa Indonesia', async () => {
      await assert.rejects(async () => {
        await telemetryRepo.logMovementAction(pool, { tick: 1 });
      }, (err) => {
        assert.match(err.message, /run_id dan tick wajib diisi untuk mencatat pergerakan bot/);
        return true;
      });

      await assert.rejects(async () => {
        await telemetryRepo.logMovementAction(pool, { run_id: uuidv4() });
      }, (err) => {
        assert.match(err.message, /run_id dan tick wajib diisi untuk mencatat pergerakan bot/);
        return true;
      });
    });

    it('harus mengembalikan 0 saat logMovementActionBatch menerima array kosong atau null', async () => {
      const count1 = await telemetryRepo.logMovementActionBatch(pool, []);
      assert.equal(count1, 0);

      const count2 = await telemetryRepo.logMovementActionBatch(pool, null);
      assert.equal(count2, 0);
    });

    it('harus menolak pencatatan audit log tanpa task atau action_type dengan pesan Bahasa Indonesia', async () => {
      await assert.rejects(async () => {
        await telemetryRepo.logActionAudit(pool, { task: 'FARM' });
      }, (err) => {
        assert.match(err.message, /task dan action_type wajib diisi untuk mencatat audit tindakan/);
        return true;
      });
    });

    it('harus menangani pelanggaran CHECK constraint database dengan pesan terbungkus yang deskriptif', async () => {
      // 1. Status tidak valid pada benchmark_runs
      await assert.rejects(async () => {
        await telemetryRepo.createBenchmarkRun(pool, {
          level: 'level1',
          status: 'INVALID_STATUS_CODE'
        });
      }, (err) => {
        assert.match(err.message, /Gagal menyimpan benchmark run ke database/);
        return true;
      });

      // 2. Recovery phase tidak valid (< 0 atau > 4) pada movement_action_logs
      const testRun = await telemetryRepo.createBenchmarkRun(pool, { level: 'level1', status: 'RUNNING' });
      await assert.rejects(async () => {
        await telemetryRepo.logMovementAction(pool, {
          run_id: testRun.id,
          tick: 1,
          recovery_phase: 99 // Melanggar CHECK (recovery_phase BETWEEN 0 AND 4)
        });
      }, (err) => {
        assert.match(err.message, /Gagal menyimpan log pergerakan/);
        return true;
      });
    });

    it('harus membatasi pagination query options agar tidak terjadi query ekstrim atau SQL injection', async () => {
      // Limit negatif dan limit sangat besar
      const runsNegative = await telemetryRepo.queryRecentRuns(pool, { limit: -10, offset: -5 });
      assert.ok(Array.isArray(runsNegative));

      const runsHuge = await telemetryRepo.queryRecentRuns(pool, { limit: 999999 });
      assert.ok(Array.isArray(runsHuge));
      assert.ok(runsHuge.length <= 100, 'Limit harus dibatasi maksimal 100 item');
    });
  });

  // =========================================================================
  // 4. PENGUJIAN IDEMPOTENSI MIGRASI SECARA BERURUTAN & KONKUREN
  // =========================================================================
  describe('4. Idempotensi Migrasi Skema DDL Multi-Eksekusi', () => {
    it('harus tetap stabil dan mengembalikan appliedCount 0 saat dipanggil 5 kali berturut-turut', async () => {
      for (let i = 1; i <= 5; i++) {
        const result = await runMigrations(pool);
        assert.equal(result.appliedCount, 0, `Panggilan migrasi ke-${i} harus menghasilkan appliedCount = 0`);
        assert.deepEqual(result.versions, []);
      }
    });

    it('harus memverifikasi seluruh 5 tabel dan 10 indeks tetap utuh setelah eksekusi migrasi berulang', async () => {
      const tableQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_name IN ('schema_migrations', 'benchmark_runs', 'telemetry_logs', 'movement_action_logs', 'action_audit_logs');
      `;
      const tables = await pool.query(tableQuery);
      assert.equal(tables.rows.length, 5, 'Kelima tabel harus tetap eksis');

      const indexQuery = `
        SELECT indexname 
        FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename IN ('benchmark_runs', 'telemetry_logs', 'movement_action_logs', 'action_audit_logs');
      `;
      const indexes = await pool.query(indexQuery);
      const indexNames = indexes.rows.map((r) => r.indexname);

      const expectedIndexes = [
        'benchmark_runs_pkey',
        'idx_benchmark_runs_level_status',
        'idx_benchmark_runs_start_time',
        'telemetry_logs_pkey',
        'idx_telemetry_logs_run_id',
        'idx_telemetry_logs_level_status',
        'idx_telemetry_logs_created_at',
        'movement_action_logs_pkey',
        'idx_movement_logs_run_tick',
        'idx_movement_logs_run_stuck',
        'idx_movement_logs_created_at',
        'action_audit_logs_pkey',
        'idx_action_audit_run_id',
        'idx_action_audit_task_created'
      ];

      for (const expected of expectedIndexes) {
        assert.ok(indexNames.includes(expected), `Indeks ${expected} harus tetap ada setelah pengujian idempotensi.`);
      }
    });

    it('harus mampu menangani pemanggilan migrasi konkuren tanpa error collision', async () => {
      const concurrentResults = await Promise.all([
        runMigrations(pool),
        runMigrations(pool),
        runMigrations(pool)
      ]);

      for (const res of concurrentResults) {
        assert.equal(res.appliedCount, 0);
      }
    });
  });
});
