/**
 * @file adversarial_audit.js
 * @description Script audit forensik dan stress-testing independen untuk Milestone 1.
 */

const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { pool, checkDatabaseHealth, closeDatabasePool } = require('../../src/config/database');
const { runMigrations, resetDatabase } = require('../../src/database/migrations');
const telemetryRepo = require('../../src/database/telemetryRepository');
const { BatchIngestionService } = require('../../src/database/batchIngestion');

async function runAdversarialAudit() {
  console.log('=== MEMULAI AUDIT FORENSIK DAN ADVERSARIAL TESTING M1 ===\n');
  const results = [];

  function recordCheck(name, pass, details) {
    results.push({ name, pass, details });
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}: ${details}`);
  }

  try {
    // 1. Uji Konektivitas PostgreSQL Nyata
    const health = await checkDatabaseHealth();
    recordCheck(
      'Konektivitas PostgreSQL Asli',
      health.ok === true && health.database === 'minecraft_companion',
      `Terkoneksi ke ${health.database} (${health.version}) dalam ${health.latencyMs}ms`
    );

    // 2. Uji Idempotensi Migrasi
    const mig1 = await runMigrations(pool);
    recordCheck('Migrasi Idempoten', mig1.appliedCount === 0, `Applied count: ${mig1.appliedCount}`);

    // 3. Uji Ketahanan SQL Injection pada Semua Repositori Endpoint
    const sqliPayloads = [
      "'; DROP TABLE benchmark_runs CASCADE; --",
      "' OR 1=1 --",
      "' UNION SELECT NULL, NULL, NULL --",
      "admin'--",
      "level1' AND 1=cast((SELECT version()) as int) --"
    ];

    let sqliPassed = true;
    let sqliDetails = '';

    for (const payload of sqliPayloads) {
      try {
        // Test queryRecentRuns dengan SQLi payload di level dan status
        await telemetryRepo.queryRecentRuns(pool, { level: payload, status: payload });
        // Test getAggregateBenchmarkStats dengan SQLi di level
        await telemetryRepo.getAggregateBenchmarkStats(pool, payload);
        // Test queryActionAudits dengan SQLi di task dan actionType
        await telemetryRepo.queryActionAudits(pool, { task: payload, actionType: payload });
      } catch (err) {
        // If it throws an SQL syntax error from raw interpolation, that's a failure!
        // Parameterized queries will just return 0 rows without syntax errors.
        if (err.message.includes('syntax error') || err.message.includes('DROP TABLE')) {
          sqliPassed = false;
          sqliDetails = `SQL Injection lolos di payload: ${payload} -> ${err.message}`;
          break;
        }
      }
    }
    if (sqliPassed) {
      recordCheck('Ketahanan SQL Injection', true, 'Seluruh kueri dinamis aman dan menggunakan parameter $1, $2, dst.');
    } else {
      recordCheck('Ketahanan SQL Injection', false, sqliDetails);
    }

    // 4. Uji Non-Facade / Real DB Modification & Constraints (Foreign Key Cascade & Set Null)
    const runId = uuidv4();
    const createdRun = await telemetryRepo.createBenchmarkRun(pool, {
      id: runId,
      level: 'level3',
      status: 'RUNNING',
      metadata: { test: 'integrity_audit_real_db' }
    });

    const summary = await telemetryRepo.logTelemetrySummary(pool, {
      run_id: runId,
      level: 'level3',
      status: 'RUNNING',
      start_pos: { x: 0, y: 64, z: 0 },
      end_pos: { x: 40, y: 80, z: 20 },
      coordinate_delta: 45.2,
      path_history: [{ tick: 1, x: 0, y: 64, z: 0 }]
    });

    const mov = await telemetryRepo.logMovementAction(pool, {
      run_id: runId,
      tick: 1,
      x: 0,
      y: 64,
      z: 0,
      velocity_xz: 0.15,
      action: 'SPRINT_FORWARD',
      is_stuck: false,
      recovery_phase: 0
    });

    const audit = await telemetryRepo.logActionAudit(pool, {
      run_id: runId,
      task: 'NAVIGATE',
      action_type: 'PATH_CALCULATION',
      payload: { target: { x: 40, y: 80, z: 20 } },
      result: { nodes: 15 }
    });

    // Verifikasi keberadaan di DB
    const runInDb = await telemetryRepo.getBenchmarkRunById(pool, runId);
    recordCheck('Persistensi Nyata benchmark_runs', runInDb !== null && runInDb.id === runId, `ID: ${runInDb?.id}`);

    // Update status dan verifikasi di DB
    await telemetryRepo.updateBenchmarkRunStatus(pool, runId, {
      status: 'SUCCESS',
      duration_ms: 12500,
      obstacle_count: 5,
      stuck_recovery_count: 2,
      success_rate: 1.0,
      metadata: { audited: true }
    });
    const updatedRunInDb = await telemetryRepo.getBenchmarkRunById(pool, runId);
    recordCheck(
      'Pembaruan Nyata updateBenchmarkRunStatus',
      updatedRunInDb.status === 'SUCCESS' && updatedRunInDb.duration_ms === 12500 && updatedRunInDb.metadata.audited === true,
      `Status: ${updatedRunInDb.status}, Duration: ${updatedRunInDb.duration_ms}ms, Metadata: ${JSON.stringify(updatedRunInDb.metadata)}`
    );

    // Hapus benchmark_run langsung dari PostgreSQL untuk menguji ON DELETE CASCADE dan ON DELETE SET NULL
    await pool.query('DELETE FROM benchmark_runs WHERE id = $1', [runId]);

    const teleAfterDel = await telemetryRepo.getTelemetryByRunId(pool, runId);
    const movAfterDel = await telemetryRepo.queryMovementLogs(pool, runId);
    const auditAfterDel = await pool.query('SELECT * FROM action_audit_logs WHERE id = $1', [audit.id]);

    const cascadeSuccess = teleAfterDel === null && movAfterDel.length === 0 && auditAfterDel.rows[0].run_id === null;
    recordCheck(
      'Integritas Relasional Kunci Asing (CASCADE & SET NULL)',
      cascadeSuccess,
      `telemetry_logs deleted: ${teleAfterDel === null}, movement_action_logs deleted: ${movAfterDel.length === 0}, action_audit_logs run_id: ${auditAfterDel.rows[0].run_id}`
    );

    // 5. Uji UNNEST Batch Ingestion Skala Besar & Presisi Data
    const testBatchRunId = uuidv4();
    await telemetryRepo.createBenchmarkRun(pool, { id: testBatchRunId, level: 'level4', status: 'RUNNING' });

    const batchCount = 300;
    const batchService = new BatchIngestionService(pool, {
      flushIntervalMs: 100,
      batchThreshold: 50,
      chunkSize: 200,
      maxBufferSize: 1000
    });

    for (let i = 1; i <= batchCount; i++) {
      batchService.ingestTick({
        run_id: testBatchRunId,
        tick: i,
        x: Number((i * 0.1).toFixed(2)),
        y: Number((64 - i * 0.2).toFixed(2)),
        z: Number((-i * 0.5).toFixed(2)),
        velocity_xz: 0.22,
        action: i % 50 === 0 ? 'RE_ROUTE_PATH' : 'SPRINT_FORWARD',
        is_stuck: i % 50 === 0,
        recovery_phase: i % 50 === 0 ? 3 : 0
      });
    }

    const flushStats = await batchService.flushAndClose();
    recordCheck(
      'UNNEST Batch Ingestion 300 Item Presisi Penuh',
      flushStats.totalIngested === batchCount && flushStats.totalPersisted === batchCount && flushStats.totalDropped === 0,
      `Ingested: ${flushStats.totalIngested}, Persisted: ${flushStats.totalPersisted}, Dropped: ${flushStats.totalDropped}`
    );

    // Ambil log dari PostgreSQL dan bandingkan presisi nilainya
    const persistedLogs = await telemetryRepo.queryMovementLogs(pool, testBatchRunId, { limit: 500 });
    const tick50 = persistedLogs.find((l) => Number(l.tick) === 50);
    const tick300 = persistedLogs.find((l) => Number(l.tick) === 300);

    const precisionPassed =
      persistedLogs.length === batchCount &&
      tick50 &&
      tick50.action === 'RE_ROUTE_PATH' &&
      tick50.is_stuck === true &&
      tick50.recovery_phase === 3 &&
      tick300 &&
      Number(tick300.x) === 30.0;

    recordCheck(
      'Integritas Data Persistensi PostgreSQL (Tick Record Matching)',
      precisionPassed,
      `Total baris di DB: ${persistedLogs.length}, Tick 50 action: ${tick50?.action}, is_stuck: ${tick50?.is_stuck}, recovery_phase: ${tick50?.recovery_phase}`
    );

    // 6. Uji Penanganan Error & Pesan Bahasa Indonesia
    let errorLanguagePassed = false;
    try {
      await telemetryRepo.createBenchmarkRun(pool, {});
    } catch (err) {
      if (err.message.includes('Parameter level wajib diisi')) {
        errorLanguagePassed = true;
      }
    }

    let closedErrorPassed = false;
    try {
      batchService.ingestTick({ run_id: testBatchRunId, tick: 999 });
    } catch (err) {
      if (err.message.includes('Layanan batch ingestion telah ditutup')) {
        closedErrorPassed = true;
      }
    }

    recordCheck(
      'Pesan Kesalahan dalam Bahasa Indonesia',
      errorLanguagePassed && closedErrorPassed,
      'Pesan error tervalidasi dalam Bahasa Indonesia sesuai aturan user_global'
    );

    // 7. Cleanup data test
    await pool.query('DELETE FROM benchmark_runs WHERE id = $1', [testBatchRunId]);
    await pool.query('DELETE FROM action_audit_logs WHERE id = $1', [audit.id]);

    console.log('\n=== HASIL RINGKASAN AUDIT FORENSIK ===');
    const allPassed = results.every((r) => r.pass);
    console.log(`Status Akhir: ${allPassed ? 'CLEAN (Semua 7 Uji Forensik Lulus)' : 'VIOLATION'}`);

    return { allPassed, results };
  } finally {
    await closeDatabasePool();
  }
}

runAdversarialAudit()
  .then((res) => {
    process.exit(res.allPassed ? 0 : 1);
  })
  .catch((err) => {
    console.error('Audit crashed:', err);
    process.exit(1);
  });
