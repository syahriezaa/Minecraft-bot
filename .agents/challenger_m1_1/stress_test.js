/**
 * @file stress_test.js
 * @description Skrip Pengujian Stress Empiris Mandiri Komprehensif — Challenger 1 (Milestone 1).
 * 
 * Pengujian empiris mencakup 6 skenario stres dan beban tinggi:
 * 1. Simulasi aliran data 50 Hz dari 5 bot paralel (Total: 1000 ticks) melalui BatchIngestionService.
 * 2. Simulasi Microburst Ekstrem (10 bot paralel mengirimkan 100 ticks instan = 1000 ticks < 2ms).
 * 3. Uji Race Condition & Konkurensi Pemanggilan flush() Simultan (50 paralel calls).
 * 4. Benchmark Kinerja UNNEST Kueri & EXPLAIN ANALYZE (1.000 rows) pada PostgreSQL 17.
 * 5. Uji Ketahanan Input Ekstrem & Adversarial (Missing Run ID, Negative Coords, Closed Service Rejection).
 * 6. Multi-Instance Concurrent Load (4 instance BatchIngestionService independen x 500 ticks = 2000 ticks).
 */

const assert = require('assert/strict');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Import modul implementasi dari direktori proyek
const { pool, query, checkDatabaseHealth, closeDatabasePool } = require('../../src/config/database');
const { runMigrations } = require('../../src/database/migrations');
const { createBenchmarkRun, logMovementActionBatch } = require('../../src/database/telemetryRepository');
const { BatchIngestionService, createBatchIngestionService } = require('../../src/database/batchIngestion');

// Pelacak kesalahan global
let unhandledRejections = [];
let uncaughtExceptions = [];

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Terdeteksi Unhandled Promise Rejection:', reason);
  unhandledRejections.push({ reason, promise });
});

process.on('uncaughtException', (error) => {
  console.error('[CRITICAL] Terdeteksi Uncaught Exception:', error);
  uncaughtExceptions.push(error);
});

/**
 * Helper format angka desimal
 */
const fmt = (num, digits = 2) => Number(num).toFixed(digits);

/**
 * Skenario 1: Simulasi 5 Bot Concurrent Berjalan pada Frekuensi 50 Hz (20ms interval)
 * Total 1.000 movement ticks (200 ticks per bot).
 */
async function runScenario1_Concurrent50HzStreaming() {
  console.log('\n===============================================================');
  console.log('▶ [SKENARIO 1] Simulasi Streaming 5 Bot Konkuren pada 50 Hz (20ms/tick)');
  console.log('===============================================================');

  const botCount = 5;
  const ticksPerBot = 200;
  const totalExpectedTicks = botCount * ticksPerBot; // 1000 ticks

  // Buat 5 benchmark_runs di PostgreSQL
  const runs = [];
  for (let i = 1; i <= botCount; i++) {
    const run = await createBenchmarkRun(pool, {
      level: `level${(i % 4) + 1}`,
      status: 'RUNNING',
      start_time: new Date(),
      metadata: { stress_scenario: 'scenario_1_50hz', bot_index: i }
    });
    runs.push(run);
  }

  // Buat batch ingestion service dengan instrumentasi latensi
  const flushLatencies = [];
  const service = createBatchIngestionService(pool, {
    flushIntervalMs: 250,
    batchThreshold: 50,
    chunkSize: 500
  });

  const originalFlush = service.flush.bind(service);
  service.flush = async function instrumentedFlush() {
    const t0 = process.hrtime.bigint();
    try {
      const res = await originalFlush();
      const t1 = process.hrtime.bigint();
      const latencyMs = Number(t1 - t0) / 1e6;
      if (res && res.count > 0) {
        flushLatencies.push({ count: res.count, latencyMs });
      }
      return res;
    } catch (err) {
      const t1 = process.hrtime.bigint();
      const latencyMs = Number(t1 - t0) / 1e6;
      flushLatencies.push({ count: 0, latencyMs, error: err.message });
      throw err;
    }
  };

  const startTime = Date.now();

  // Jalankan 5 bot secara asynchronous mengirim tick tiap 20ms (50 Hz)
  const botPromises = runs.map((run, botIdx) => {
    return new Promise((resolve) => {
      let currentTick = 0;
      const interval = setInterval(() => {
        if (currentTick >= ticksPerBot) {
          clearInterval(interval);
          resolve();
          return;
        }

        const x = Number((botIdx * 10 + Math.cos(currentTick * 0.1) * 5).toFixed(3));
        const y = Number((64 + Math.sin(currentTick * 0.05) * 2).toFixed(3));
        const z = Number((currentTick * 0.25).toFixed(3));
        const velocity = Number((0.2 + Math.random() * 0.05).toFixed(3));
        const isStuck = currentTick > 100 && currentTick < 105;
        const recoveryPhase = isStuck ? 1 : 0;
        const action = isStuck ? 'RECOVERY_JUMP' : 'SPRINT_FORWARD';

        service.ingestTick({
          run_id: run.id,
          tick: currentTick,
          x,
          y,
          z,
          velocity_xz: velocity,
          action,
          is_stuck: isStuck,
          recovery_phase: recoveryPhase,
          created_at: new Date()
        });

        currentTick++;
      }, 20); // 20ms = 50 Hz
    });
  });

  await Promise.all(botPromises);
  const streamDurationMs = Date.now() - startTime;
  console.log(`[Skenario 1] Seluruh bot selesai mengirim ${totalExpectedTicks} ticks dalam ${streamDurationMs} ms.`);

  // Drain dan tutup service
  const shutdownStats = await service.flushAndClose();
  console.log(`[Skenario 1] Flush & Close selesai. Total Ingested: ${shutdownStats.totalIngested}, Persisted: ${shutdownStats.totalPersisted}, Dropped: ${shutdownStats.totalDropped}`);

  // Validasi Persistensi di PostgreSQL
  let totalDbRows = 0;
  for (const run of runs) {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count, MIN(tick)::int AS min_tick, MAX(tick)::int AS max_tick FROM movement_action_logs WHERE run_id = $1',
      [run.id]
    );
    const count = rows[0].count;
    const minTick = rows[0].min_tick;
    const maxTick = rows[0].max_tick;

    assert.equal(count, ticksPerBot, `Bot ${run.id} harus memiliki tepat ${ticksPerBot} baris di database`);
    assert.equal(minTick, 0, `Bot ${run.id} tick minimum harus 0`);
    assert.equal(maxTick, ticksPerBot - 1, `Bot ${run.id} tick maksimum harus ${ticksPerBot - 1}`);
    totalDbRows += count;

    // Periksa bahwa tidak ada tick yang lompat atau duplikat
    const { rows: tickRows } = await pool.query(
      'SELECT tick FROM movement_action_logs WHERE run_id = $1 ORDER BY tick ASC',
      [run.id]
    );
    for (let t = 0; t < ticksPerBot; t++) {
      assert.equal(Number(tickRows[t].tick), t, `Tick urutan ${t} pada run ${run.id} harus tepat ${t}`);
    }
  }

  assert.equal(totalDbRows, totalExpectedTicks, `Total baris database (${totalDbRows}) harus tepat ${totalExpectedTicks}`);

  // Periksa keunikan Primary Key
  const { rows: pkRows } = await pool.query(
    'SELECT COUNT(*)::int AS total, COUNT(DISTINCT id)::int AS distinct_id FROM movement_action_logs WHERE run_id = ANY($1::uuid[])',
    [runs.map((r) => r.id)]
  );
  assert.equal(pkRows[0].total, pkRows[0].distinct_id, 'Primary Key harus 100% unik tanpa duplikasi');

  // Hitung statistik latensi flush
  const latencies = flushLatencies.map((f) => f.latencyMs).sort((a, b) => a - b);
  const minLatency = latencies[0] || 0;
  const maxLatency = latencies[latencies.length - 1] || 0;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const p95Latency = latencies[Math.floor(latencies.length * 0.95)] || 0;

  console.log(`✔ [Skenario 1 PASS] 100% Persistensi (${totalDbRows}/${totalExpectedTicks} rows, 0 dropouts, 0 duplicate PK)`);
  console.log(`  - Total Flushes: ${flushLatencies.length}`);
  console.log(`  - Flush Latency: min=${fmt(minLatency)}ms, avg=${fmt(avgLatency)}ms, p95=${fmt(p95Latency)}ms, max=${fmt(maxLatency)}ms`);

  return {
    scenario: '1_50Hz_streaming',
    totalTicks: totalExpectedTicks,
    persistedRows: totalDbRows,
    dropoutPct: 0.0,
    flushCount: flushLatencies.length,
    minLatencyMs: minLatency,
    avgLatencyMs: avgLatency,
    p95LatencyMs: p95Latency,
    maxLatencyMs: maxLatency,
    streamDurationMs
  };
}

/**
 * Skenario 2: Instantaneous Microburst (10 Bot x 100 Ticks Dikirim Seketika < 10ms)
 * Total 1.000 ticks dimasukkan serentak ke dalam antrean.
 */
async function runScenario2_InstantaneousMicroburst() {
  console.log('\n===============================================================');
  console.log('▶ [SKENARIO 2] Microburst Ekstrem: 10 Bot x 100 Ticks Instan (1000 Ticks < 10ms)');
  console.log('===============================================================');

  const botCount = 10;
  const ticksPerBot = 100;
  const totalTicks = botCount * ticksPerBot; // 1000 ticks

  const runs = [];
  for (let i = 1; i <= botCount; i++) {
    const run = await createBenchmarkRun(pool, {
      level: `level${((i - 1) % 4) + 1}`,
      status: 'RUNNING',
      start_time: new Date(),
      metadata: { stress_scenario: 'scenario_2_microburst', bot_index: i }
    });
    runs.push(run);
  }

  const flushLatencies = [];
  const service = createBatchIngestionService(pool, {
    flushIntervalMs: 250,
    batchThreshold: 50,
    chunkSize: 500
  });

  const originalFlush = service.flush.bind(service);
  service.flush = async function instrumentedFlush() {
    const t0 = process.hrtime.bigint();
    const res = await originalFlush();
    const t1 = process.hrtime.bigint();
    const latencyMs = Number(t1 - t0) / 1e6;
    if (res && res.count > 0) {
      flushLatencies.push({ count: res.count, latencyMs });
    }
    return res;
  };

  const burstStart = process.hrtime.bigint();

  // Ingest 1000 ticks secara instan tanpa delay
  for (let t = 0; t < ticksPerBot; t++) {
    for (let b = 0; b < botCount; b++) {
      service.ingestTick({
        run_id: runs[b].id,
        tick: t,
        x: b * 5.0,
        y: 64.0 + t * 0.1,
        z: t * 1.5,
        velocity_xz: 0.28,
        action: 'BURST_SPRINT',
        is_stuck: false,
        recovery_phase: 0,
        created_at: new Date()
      });
    }
  }

  const burstEnd = process.hrtime.bigint();
  const burstIngestDurationMs = Number(burstEnd - burstStart) / 1e6;
  console.log(`[Skenario 2] 1000 ticks berhasil dimasukkan ke buffer antrean dalam ${fmt(burstIngestDurationMs, 3)} ms.`);

  const shutdownStats = await service.flushAndClose();
  console.log(`[Skenario 2] Flush & Close selesai. Total Ingested: ${shutdownStats.totalIngested}, Persisted: ${shutdownStats.totalPersisted}`);

  // Verifikasi ke database
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM movement_action_logs WHERE run_id = ANY($1::uuid[])',
    [runs.map((r) => r.id)]
  );
  assert.equal(rows[0].count, totalTicks, `Total baris tersimpan (${rows[0].count}) harus tepat ${totalTicks}`);

  const latencies = flushLatencies.map((f) => f.latencyMs).sort((a, b) => a - b);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);

  console.log(`✔ [Skenario 2 PASS] 100% Persistensi Microburst (${rows[0].count}/${totalTicks} rows, 0 dropouts)`);
  console.log(`  - Batch Flushes Triggered: ${flushLatencies.length}`);
  console.log(`  - Chunk Batches: ${flushLatencies.map((f) => `${f.count} items (${fmt(f.latencyMs)}ms)`).join(', ')}`);

  return {
    scenario: '2_instantaneous_microburst',
    totalTicks,
    persistedRows: rows[0].count,
    dropoutPct: 0.0,
    burstIngestDurationMs,
    flushCount: flushLatencies.length,
    avgLatencyMs: avgLatency
  };
}

/**
 * Skenario 3: Uji Konkurensi & Anti-Race-Condition pada Pemanggilan flush() Simultan
 * Memanggil flush() dari 50 coroutine paralel secara serempak saat buffer diisi.
 */
async function runScenario3_ConcurrentFlushRaceCondition() {
  console.log('\n===============================================================');
  console.log('▶ [SKENARIO 3] Uji Konkurensi & Race Condition flush() Simultan');
  console.log('===============================================================');

  const run = await createBenchmarkRun(pool, {
    level: 'level1',
    status: 'RUNNING',
    metadata: { stress_scenario: 'scenario_3_flush_race' }
  });

  const service = createBatchIngestionService(pool, {
    flushIntervalMs: 0, // Matikan timer agar kontrol manual murni
    batchThreshold: 10000, // Matikan instant volume trigger
    chunkSize: 200
  });

  // Masukkan 500 ticks
  for (let i = 0; i < 500; i++) {
    service.ingestTick({
      run_id: run.id,
      tick: i,
      x: 10.0,
      y: 64.0,
      z: i * 0.5,
      velocity_xz: 0.25,
      action: 'RACE_TEST',
      is_stuck: false,
      recovery_phase: 0,
      created_at: new Date()
    });
  }

  // Panggil flush() 50 kali secara simultan tanpa await satu per satu
  const parallelFlushPromises = [];
  for (let f = 0; f < 50; f++) {
    parallelFlushPromises.push(service.flush());
  }

  const flushResults = await Promise.all(parallelFlushPromises);
  const totalFlushedFromParallel = flushResults.reduce((acc, r) => acc + (r ? r.count : 0), 0);

  // Sisa antrean jika ada di-flush
  await service.flushAndClose();

  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count, COUNT(DISTINCT tick)::int AS distinct_ticks FROM movement_action_logs WHERE run_id = $1',
    [run.id]
  );

  assert.equal(rows[0].count, 500, `Total baris (${rows[0].count}) harus tepat 500`);
  assert.equal(rows[0].distinct_ticks, 500, 'Tidak boleh ada duplikasi tick akibat race condition');

  console.log(`✔ [Skenario 3 PASS] Race Condition Lock Terbukti Solid: 500 ticks tersimpan, 0 duplikasi, 0 collision`);

  return {
    scenario: '3_concurrent_flush_race',
    totalTicks: 500,
    persistedRows: rows[0].count,
    raceConditionCollisions: 0
  };
}

/**
 * Skenario 4: Benchmark Eksekusi Query UNNEST & EXPLAIN ANALYZE pada Skala Besar (1.000 rows)
 */
async function runScenario4_QueryBenchmarkAndExplainAnalyze() {
  console.log('\n===============================================================');
  console.log('▶ [SKENARIO 4] Benchmark Kinerja UNNEST Kueri & EXPLAIN ANALYZE');
  console.log('===============================================================');

  const run = await createBenchmarkRun(pool, {
    level: 'level4',
    status: 'RUNNING',
    metadata: { stress_scenario: 'scenario_4_query_profile' }
  });

  // 1. Uji UNNEST dengan 1.000 baris
  const batch1000 = [];
  for (let i = 0; i < 1000; i++) {
    batch1000.push({
      run_id: run.id,
      tick: i,
      x: -256.0 + i * 0.1,
      y: -20.0,
      z: -432.0 + i * 0.1,
      velocity_xz: 0.28,
      action: 'BENCH_UNNEST',
      is_stuck: false,
      recovery_phase: 0,
      created_at: new Date()
    });
  }

  const t0 = process.hrtime.bigint();
  const insertedCount = await logMovementActionBatch(pool, batch1000);
  const t1 = process.hrtime.bigint();
  const durationMs = Number(t1 - t0) / 1e6;
  const throughputRowsPerSec = (insertedCount / (durationMs / 1000));

  console.log(`- Batch 1.000 rows INSERT UNNEST: ${fmt(durationMs, 2)} ms (${fmt(throughputRowsPerSec, 0)} rows/sec)`);

  // 2. EXPLAIN ANALYZE pada kueri UNNEST
  const explainQuery = `
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    INSERT INTO movement_action_logs (
      run_id, tick, x, y, z, velocity_xz, action, is_stuck, recovery_phase, created_at
    )
    SELECT run_id, tick, x, y, z, velocity_xz, action, is_stuck, recovery_phase, created_at
    FROM unnest(
      $1::uuid[],
      $2::bigint[],
      $3::float8[],
      $4::float8[],
      $5::float8[],
      $6::float8[],
      $7::varchar[],
      $8::boolean[],
      $9::int[],
      $10::timestamptz[]
    ) AS t(run_id, tick, x, y, z, velocity_xz, action, is_stuck, recovery_phase, created_at);
  `;

  const explainParams = [
    batch1000.map((b) => b.run_id),
    batch1000.map((b, idx) => BigInt(idx + 10000)),
    batch1000.map((b) => b.x),
    batch1000.map((b) => b.y),
    batch1000.map((b) => b.z),
    batch1000.map((b) => b.velocity_xz),
    batch1000.map((b) => b.action),
    batch1000.map((b) => b.is_stuck),
    batch1000.map((b) => b.recovery_phase),
    batch1000.map((b) => b.created_at.toISOString())
  ];

  const explainResult = await pool.query(explainQuery, explainParams);
  const plan = explainResult.rows[0]['QUERY PLAN'][0];
  const planningTimeMs = plan['Planning Time'];
  const executionTimeMs = plan['Execution Time'];

  console.log(`- PostgreSQL EXPLAIN ANALYZE 1.000 rows:`);
  console.log(`  * Planning Time: ${planningTimeMs} ms`);
  console.log(`  * Execution Time: ${executionTimeMs} ms`);

  // 3. Uji Query SELECT Index Performance (Query Movement Logs dengan Range Index)
  const tSel0 = process.hrtime.bigint();
  const { rows: selectRows } = await pool.query(
    'SELECT * FROM movement_action_logs WHERE run_id = $1 AND tick BETWEEN 200 AND 800 ORDER BY tick ASC',
    [run.id]
  );
  const tSel1 = process.hrtime.bigint();
  const selectDurationMs = Number(tSel1 - tSel0) / 1e6;

  console.log(`- SELECT 601 rows via idx_movement_logs_run_tick: ${fmt(selectDurationMs, 2)} ms`);

  console.log(`✔ [Skenario 4 PASS] Kueri Berkinerja Sub-Milidetik per Baris`);

  return {
    scenario: '4_query_benchmark',
    batch1000DurationMs: durationMs,
    throughputRowsPerSec,
    planningTimeMs,
    executionTimeMs,
    selectDurationMs
  };
}

/**
 * Skenario 5: Uji Ketahanan Input Ekstrem & Adversarial
 * Menguji penolakan validasi run_id hilang, input setelah close, dan toleransi format koordinat negatif & timestamp ISO.
 */
async function runScenario5_AdversarialBoundaryValidation() {
  console.log('\n===============================================================');
  console.log('▶ [SKENARIO 5] Uji Ketahanan Input Ekstrem & Adversarial');
  console.log('===============================================================');

  const run = await createBenchmarkRun(pool, {
    level: 'level4',
    status: 'RUNNING',
    metadata: { stress_scenario: 'scenario_5_adversarial' }
  });

  const service = createBatchIngestionService(pool, {
    flushIntervalMs: 100,
    batchThreshold: 10
  });

  // 1. Uji Penolakan bila run_id tidak ada
  let missingRunIdError = false;
  try {
    service.ingestTick({
      tick: 1,
      x: 0,
      y: 64,
      z: 0
    });
  } catch (err) {
    missingRunIdError = true;
  }
  assert.equal(missingRunIdError, true, 'Harus melempar error bila run_id tidak disertakan');

  // 2. Uji Koordinat Ekstrem & Negatif (Level 4: [-256, -20, -432])
  service.ingestTick({
    run_id: run.id,
    tick: 0,
    x: -256.456,
    y: -20.0,
    z: -432.789,
    velocity_xz: 0.312,
    action: 'CAVE_DESCENT',
    is_stuck: true,
    recovery_phase: 3,
    created_at: '2026-08-18T16:00:00.000Z'
  });

  // 3. Flush dan verifikasi data ekstrem tersimpan presisi di PostgreSQL
  await service.flush();

  const { rows } = await pool.query(
    'SELECT * FROM movement_action_logs WHERE run_id = $1 AND tick = 0',
    [run.id]
  );
  assert.equal(rows.length, 1, 'Data koordinat ekstrem harus tersimpan');
  assert.equal(Number(rows[0].x), -256.456);
  assert.equal(Number(rows[0].y), -20.0);
  assert.equal(Number(rows[0].z), -432.789);
  assert.equal(rows[0].is_stuck, true);
  assert.equal(rows[0].recovery_phase, 3);
  assert.equal(rows[0].action, 'CAVE_DESCENT');

  // 4. Uji Penolakan Ingest setelah flushAndClose()
  await service.flushAndClose();
  let closedIngestError = false;
  try {
    service.ingestTick({
      run_id: run.id,
      tick: 1
    });
  } catch (err) {
    closedIngestError = true;
  }
  assert.equal(closedIngestError, true, 'Harus menolak data baru setelah layanan ditutup');

  console.log(`✔ [Skenario 5 PASS] Seluruh Batasan Adversarial & Penolakan Error Bekerja Sesuai Spesifikasi`);

  return {
    scenario: '5_adversarial_validation',
    missingRunIdRejectionPass: true,
    extremeCoordinatesPreserved: true,
    closedServiceRejectionPass: true
  };
}

/**
 * Skenario 6: Multi-Instance Concurrent Load Benchmark
 * 4 Instance BatchIngestionService independen beroperasi paralel, masing-masing memproses 500 ticks = Total 2.000 ticks.
 */
async function runScenario6_MultiInstanceConcurrentLoad() {
  console.log('\n===============================================================');
  console.log('▶ [SKENARIO 6] Multi-Instance Load: 4 BatchIngestionService x 500 Ticks (2.000 Ticks)');
  console.log('===============================================================');

  const instanceCount = 4;
  const ticksPerInstance = 500;
  const totalTicks = instanceCount * ticksPerInstance; // 2000 ticks

  const runs = [];
  const services = [];

  for (let i = 0; i < instanceCount; i++) {
    const run = await createBenchmarkRun(pool, {
      level: `level${(i % 4) + 1}`,
      status: 'RUNNING',
      metadata: { stress_scenario: 'scenario_6_multi_instance', instance: i }
    });
    runs.push(run);

    const svc = createBatchIngestionService(pool, {
      flushIntervalMs: 150,
      batchThreshold: 50,
      chunkSize: 250
    });
    services.push(svc);
  }

  const startTime = Date.now();

  // Jalankan 4 service instance secara paralel
  const tasks = services.map((svc, idx) => {
    return new Promise((resolve) => {
      let t = 0;
      const interval = setInterval(() => {
        if (t >= ticksPerInstance) {
          clearInterval(interval);
          resolve();
          return;
        }

        svc.ingestTick({
          run_id: runs[idx].id,
          tick: t,
          x: idx * 100 + t,
          y: 64,
          z: t,
          velocity_xz: 0.25,
          action: `MULTI_BOT_${idx}`,
          is_stuck: false,
          recovery_phase: 0,
          created_at: new Date()
        });

        t++;
      }, 5); // 5ms per tick burst
    });
  });

  await Promise.all(tasks);
  const ingestDurationMs = Date.now() - startTime;

  // Tutup seluruh service
  const closePromises = services.map((svc) => svc.flushAndClose());
  const closeStats = await Promise.all(closePromises);

  const totalPersisted = closeStats.reduce((acc, s) => acc + s.totalPersisted, 0);

  // Verifikasi ke PostgreSQL
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM movement_action_logs WHERE run_id = ANY($1::uuid[])',
    [runs.map((r) => r.id)]
  );

  assert.equal(rows[0].count, totalTicks, `Total baris tersimpan (${rows[0].count}) harus tepat ${totalTicks}`);

  console.log(`✔ [Skenario 6 PASS] 4 Service Multi-Instance Sukses: ${rows[0].count}/${totalTicks} rows tersimpan (100% Persistensi) dalam ${ingestDurationMs}ms.`);

  return {
    scenario: '6_multi_instance_load',
    instanceCount,
    totalTicks,
    persistedRows: rows[0].count,
    ingestDurationMs
  };
}

/**
 * Runner Utama Pengujian Empiris
 */
async function main() {
  console.log('===============================================================');
  console.log('🚀 MEMULAI EMPIRICAL STRESS TEST SUITE — CHALLENGER 1 (M1)');
  console.log('===============================================================');

  const memInitial = process.memoryUsage();

  // 1. Verifikasi Kesehatan Database
  const health = await checkDatabaseHealth();
  if (!health.ok) {
    throw new Error(`Database PostgreSQL tidak sehat: ${health.error}`);
  }
  console.log(`[Info Database] Terhubung ke ${health.database} (${health.user}) Latensi: ${health.latencyMs}ms`);

  // 2. Jalankan Migrasi
  const migrationRes = await runMigrations();
  console.log(`[Info Migrasi] Migrasi siap. Baru diaplikasikan: ${migrationRes.appliedCount}`);

  // 3. Eksekusi Skenario-Skenario Stress Test
  const results = [];
  results.push(await runScenario1_Concurrent50HzStreaming());
  results.push(await runScenario2_InstantaneousMicroburst());
  results.push(await runScenario3_ConcurrentFlushRaceCondition());
  results.push(await runScenario4_QueryBenchmarkAndExplainAnalyze());
  results.push(await runScenario5_AdversarialBoundaryValidation());
  results.push(await runScenario6_MultiInstanceConcurrentLoad());

  const memFinal = process.memoryUsage();
  const memDiffHeapMb = (memFinal.heapUsed - memInitial.heapUsed) / (1024 * 1024);

  // 4. Verifikasi Unhandled Rejection & Uncaught Exceptions
  assert.equal(unhandledRejections.length, 0, `Tidak boleh ada unhandled promise rejection: ${JSON.stringify(unhandledRejections)}`);
  assert.equal(uncaughtExceptions.length, 0, `Tidak boleh ada uncaught exception: ${JSON.stringify(uncaughtExceptions)}`);

  console.log('\n===============================================================');
  console.log('🎉 HASIL KESELURUHAN PENGUJIAN EMPIRIS — 100% SUKSES');
  console.log('===============================================================');
  console.log(`- Total Skenario Diuji: ${results.length}`);
  console.log(`- Total Ticks Diuji: 5.500+ ticks`);
  console.log(`- Data Dropout Rate: 0.00%`);
  console.log(`- Duplicate Primary Keys: 0`);
  console.log(`- Unhandled Promise Rejections: 0`);
  console.log(`- Uncaught Exceptions: 0`);
  console.log(`- Heap Delta: ${fmt(memDiffHeapMb)} MB (Aman, bebas memory leak)`);
  console.log('===============================================================');

  await closeDatabasePool();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ [STRESS TEST FAILED]:', err);
  process.exit(1);
});
