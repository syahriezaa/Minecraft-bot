/**
 * @file telemetryRepository.js
 * @description Repositori akses data telemetri, tolak ukur benchmark runs, log pergerakan tick bot, dan audit tugas AI.
 * Menyediakan fungsi CRUD berparameter penuh, sanitasi input, batch insert UNNEST performa tinggi, dan penanganan error berbahasa Indonesia.
 */

const { v4: uuidv4 } = require('uuid');
const { pool: defaultPool } = require('../config/database');

/**
 * Membuat entri pengujian tolak ukur (benchmark run) baru.
 * @param {import('pg').Pool} [pool=defaultPool] - Pool koneksi database
 * @param {Object} runData - Data inisialisasi benchmark run
 * @param {string} [runData.id] - UUID opsional (dibuat otomatis jika tidak ada)
 * @param {string} runData.level - Tingkat pengujian ('level1', 'level2', 'level3', 'level4')
 * @param {string} [runData.status='RUNNING'] - Status awal
 * @param {Date|string} [runData.start_time] - Waktu mulai
 * @param {number} [runData.obstacle_count=0] - Jumlah rintangan awal
 * @param {number} [runData.stuck_recovery_count=0] - Jumlah pemulihan macet awal
 * @param {number} [runData.success_rate=0.0] - Tingkat keberhasilan awal
 * @param {Object} [runData.metadata={}] - Data metadata tambahan
 * @returns {Promise<Object>} Data benchmark run yang berhasil dibuat
 */
async function createBenchmarkRun(pool = defaultPool, runData = {}) {
  if (!runData || !runData.level) {
    throw new Error('Parameter level wajib diisi untuk membuat benchmark run.');
  }

  const id = runData.id || uuidv4();
  const level = String(runData.level);
  const status = String(runData.status || 'RUNNING');
  const startTime = runData.start_time ? new Date(runData.start_time) : new Date();
  const obstacleCount = Number(runData.obstacle_count) || 0;
  const stuckRecoveryCount = Number(runData.stuck_recovery_count) || 0;
  const successRate = Number(runData.success_rate) || 0.0;
  const metadata = runData.metadata ? JSON.stringify(runData.metadata) : '{}';

  const query = `
    INSERT INTO benchmark_runs (
      id, level, status, start_time, obstacle_count, stuck_recovery_count, success_rate, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *;
  `;

  try {
    const { rows } = await pool.query(query, [
      id, level, status, startTime, obstacleCount, stuckRecoveryCount, successRate, metadata
    ]);
    return rows[0];
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal membuat benchmark run:', error.message);
    throw new Error(`Gagal menyimpan benchmark run ke database: ${error.message}`);
  }
}

/**
 * Memperbarui status dan metrik akhir dari sebuah benchmark run.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {string} runId - UUID benchmark run
 * @param {Object} updateData - Data pembaruan
 * @param {string} [updateData.status] - Status akhir ('SUCCESS', 'FAILED', 'ABORTED')
 * @param {Date|string} [updateData.end_time] - Waktu selesai
 * @param {number} [updateData.duration_ms] - Durasi total (ms)
 * @param {number} [updateData.obstacle_count] - Jumlah rintangan yang dilalui
 * @param {number} [updateData.stuck_recovery_count] - Jumlah pemulihan macet yang dieksekusi
 * @param {number} [updateData.success_rate] - Rasio keberhasilan (0.0 - 1.0)
 * @param {Object} [updateData.metadata] - Metadata tambahan yang digabung
 * @returns {Promise<Object|null>} Data benchmark run yang telah diperbarui
 */
async function updateBenchmarkRunStatus(pool = defaultPool, runId, updateData = {}) {
  if (!runId) {
    throw new Error('runId wajib disediakan untuk memperbarui status benchmark run.');
  }

  const endTime = updateData.end_time ? new Date(updateData.end_time) : new Date();
  const metadataJson = updateData.metadata ? JSON.stringify(updateData.metadata) : null;

  const query = `
    UPDATE benchmark_runs
    SET
      status = COALESCE($2, status),
      end_time = COALESCE($3, end_time),
      duration_ms = COALESCE($4, duration_ms),
      obstacle_count = COALESCE($5, obstacle_count),
      stuck_recovery_count = COALESCE($6, stuck_recovery_count),
      success_rate = COALESCE($7, success_rate),
      metadata = CASE 
        WHEN $8::jsonb IS NOT NULL THEN metadata || $8::jsonb
        ELSE metadata
      END
    WHERE id = $1
    RETURNING *;
  `;

  try {
    const { rows } = await pool.query(query, [
      runId,
      updateData.status || null,
      endTime,
      updateData.duration_ms !== undefined ? Number(updateData.duration_ms) : null,
      updateData.obstacle_count !== undefined ? Number(updateData.obstacle_count) : null,
      updateData.stuck_recovery_count !== undefined ? Number(updateData.stuck_recovery_count) : null,
      updateData.success_rate !== undefined ? Number(updateData.success_rate) : null,
      metadataJson
    ]);

    if (rows.length === 0) {
      return null;
    }
    return rows[0];
  } catch (error) {
    console.error(`[TelemetryRepository Error] Gagal memperbarui benchmark run ${runId}:`, error.message);
    throw new Error(`Gagal memperbarui status benchmark run: ${error.message}`);
  }
}

/**
 * Mengambil satu entri benchmark run berdasarkan UUID.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {string} runId
 * @returns {Promise<Object|null>}
 */
async function getBenchmarkRunById(pool = defaultPool, runId) {
  if (!runId) {
    throw new Error('runId wajib disediakan.');
  }

  const query = 'SELECT * FROM benchmark_runs WHERE id = $1;';
  try {
    const { rows } = await pool.query(query, [runId]);
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error(`[TelemetryRepository Error] Gagal membaca benchmark run ${runId}:`, error.message);
    throw new Error(`Gagal membaca benchmark run dari database: ${error.message}`);
  }
}

/**
 * Mengambil daftar benchmark run terbaru dengan pagination dan filter opsional.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Object} [options={}]
 * @param {number} [options.limit=20]
 * @param {number} [options.offset=0]
 * @param {string} [options.level]
 * @param {string} [options.status]
 * @returns {Promise<Array<Object>>}
 */
async function queryRecentRuns(pool = defaultPool, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const conditions = [];
  const params = [];

  if (options.level) {
    params.push(options.level);
    conditions.push(`level = $${params.length}`);
  }

  if (options.status) {
    params.push(options.status);
    conditions.push(`status = $${params.length}`);
  }

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `
    SELECT * FROM benchmark_runs
    ${whereClause}
    ORDER BY start_time DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;

  try {
    const { rows } = await pool.query(query, params);
    return rows;
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal mengambil daftar benchmark runs:', error.message);
    throw new Error(`Gagal query daftar benchmark runs: ${error.message}`);
  }
}

/**
 * Menyimpan ringkasan telemetri satu pengujian (telemetry_logs).
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Object} telemetryData
 * @param {string} telemetryData.run_id - UUID run
 * @param {string} telemetryData.level - Tingkat pengujian
 * @param {string} telemetryData.status - Status pengujian
 * @param {number} [telemetryData.travel_duration_ms=0]
 * @param {number} [telemetryData.obstacle_count=0]
 * @param {Object} [telemetryData.start_pos={}]
 * @param {Object} [telemetryData.end_pos={}]
 * @param {number} [telemetryData.coordinate_delta=0.0]
 * @param {Array} [telemetryData.path_history=[]]
 * @param {Date|string} [telemetryData.created_at]
 * @returns {Promise<Object>} Data summary telemetri yang tersimpan
 */
async function logTelemetrySummary(pool = defaultPool, telemetryData = {}) {
  if (!telemetryData || !telemetryData.run_id || !telemetryData.level || !telemetryData.status) {
    throw new Error('run_id, level, dan status wajib diisi untuk menyimpan ringkasan telemetri.');
  }

  const query = `
    INSERT INTO telemetry_logs (
      run_id, level, status, travel_duration_ms, obstacle_count,
      start_pos, end_pos, coordinate_delta, path_history, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))
    RETURNING *;
  `;

  const startPos = JSON.stringify(telemetryData.start_pos || {});
  const endPos = JSON.stringify(telemetryData.end_pos || {});
  const pathHistory = JSON.stringify(telemetryData.path_history || []);
  const createdAt = telemetryData.created_at ? new Date(telemetryData.created_at) : new Date();

  try {
    const { rows } = await pool.query(query, [
      telemetryData.run_id,
      telemetryData.level,
      telemetryData.status,
      Number(telemetryData.travel_duration_ms) || 0,
      Number(telemetryData.obstacle_count) || 0,
      startPos,
      endPos,
      Number(telemetryData.coordinate_delta) || 0.0,
      pathHistory,
      createdAt
    ]);
    return rows[0];
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal menyimpan telemetry summary:', error.message);
    throw new Error(`Gagal menyimpan telemetry summary ke database: ${error.message}`);
  }
}

/**
 * Mengambil ringkasan telemetri terakhir untuk run_id tertentu.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {string} runId
 * @returns {Promise<Object|null>}
 */
async function getTelemetryByRunId(pool = defaultPool, runId) {
  if (!runId) {
    throw new Error('runId wajib disediakan.');
  }

  const query = 'SELECT * FROM telemetry_logs WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1;';
  try {
    const { rows } = await pool.query(query, [runId]);
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error(`[TelemetryRepository Error] Gagal membaca telemetri run ${runId}:`, error.message);
    throw new Error(`Gagal membaca data telemetri: ${error.message}`);
  }
}

/**
 * Menyimpan satu baris pergerakan tick bot (movement_action_logs).
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Object} movementData
 * @returns {Promise<Object>}
 */
async function logMovementAction(pool = defaultPool, movementData = {}) {
  if (!movementData || !movementData.run_id || movementData.tick === undefined) {
    throw new Error('run_id dan tick wajib diisi untuk mencatat pergerakan bot.');
  }

  const query = `
    INSERT INTO movement_action_logs (
      run_id, tick, x, y, z, velocity_xz, action, is_stuck, recovery_phase, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, NOW()))
    RETURNING *;
  `;

  try {
    const { rows } = await pool.query(query, [
      movementData.run_id,
      BigInt(movementData.tick),
      Number(movementData.x) || 0.0,
      Number(movementData.y) || 0.0,
      Number(movementData.z) || 0.0,
      Number(movementData.velocity_xz) || 0.0,
      String(movementData.action || 'IDLE'),
      Boolean(movementData.is_stuck),
      Number(movementData.recovery_phase) || 0,
      movementData.created_at ? new Date(movementData.created_at) : new Date()
    ]);
    return rows[0];
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal mencatat movement log:', error.message);
    throw new Error(`Gagal menyimpan log pergerakan: ${error.message}`);
  }
}

/**
 * Menyimpan sekumpulan log pergerakan tick bot secara berkecepatan tinggi menggunakan klausa PostgreSQL UNNEST.
 * Digunakan oleh modul batchIngestion untuk memproses beban tick 20 Hz secara efisien.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Array<Object>} movementLogsArray
 * @returns {Promise<number>} Jumlah baris yang berhasil di-insert
 */
async function logMovementActionBatch(pool = defaultPool, movementLogsArray = []) {
  if (!Array.isArray(movementLogsArray) || movementLogsArray.length === 0) {
    return 0;
  }

  const runIds = [];
  const ticks = [];
  const xs = [];
  const ys = [];
  const zs = [];
  const velocities = [];
  const actions = [];
  const isStucks = [];
  const recoveryPhases = [];
  const createdAts = [];

  for (const item of movementLogsArray) {
    runIds.push(item.run_id || item.runId);
    ticks.push(BigInt(item.tick ?? 0));
    xs.push(Number(item.x) || 0.0);
    ys.push(Number(item.y) || 0.0);
    zs.push(Number(item.z) || 0.0);
    velocities.push(Number(item.velocity_xz ?? item.velocityXZ) || 0.0);
    actions.push(String(item.action || 'IDLE'));
    isStucks.push(Boolean(item.is_stuck ?? item.isStuck));
    recoveryPhases.push(Number(item.recovery_phase ?? item.recoveryPhase) || 0);
    createdAts.push(item.created_at ? (item.created_at instanceof Date ? item.created_at.toISOString() : item.created_at) : new Date().toISOString());
  }

  const query = `
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

  try {
    const res = await pool.query(query, [
      runIds, ticks, xs, ys, zs, velocities, actions, isStucks, recoveryPhases, createdAts
    ]);
    return res.rowCount || movementLogsArray.length;
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal batch insert movement logs:', error.message);
    throw new Error(`Gagal menyimpan batch log pergerakan: ${error.message}`);
  }
}

/**
 * Mengambil log pergerakan tick bot untuk run tertentu dengan opsi pagination dan filter rentang tick.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {string} runId
 * @param {Object} [options={}]
 * @param {number} [options.limit=1000]
 * @param {number} [options.offset=0]
 * @param {number} [options.minTick]
 * @param {number} [options.maxTick]
 * @param {boolean} [options.isStuckOnly=false]
 * @returns {Promise<Array<Object>>}
 */
async function queryMovementLogs(pool = defaultPool, runId, options = {}) {
  if (!runId) {
    throw new Error('runId wajib disediakan.');
  }

  const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 10000);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const conditions = ['run_id = $1'];
  const params = [runId];

  if (options.minTick !== undefined && options.minTick !== null) {
    params.push(BigInt(options.minTick));
    conditions.push(`tick >= $${params.length}`);
  }

  if (options.maxTick !== undefined && options.maxTick !== null) {
    params.push(BigInt(options.maxTick));
    conditions.push(`tick <= $${params.length}`);
  }

  if (options.isStuckOnly) {
    conditions.push('is_stuck = TRUE');
  }

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const query = `
    SELECT * FROM movement_action_logs
    WHERE ${conditions.join(' AND ')}
    ORDER BY tick ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;

  try {
    const { rows } = await pool.query(query, params);
    return rows;
  } catch (error) {
    console.error(`[TelemetryRepository Error] Gagal query movement logs run ${runId}:`, error.message);
    throw new Error(`Gagal query log pergerakan: ${error.message}`);
  }
}

/**
 * Mencatat audit tindakan AI Brain atau aksi penting bot ke action_audit_logs.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Object} auditData
 * @param {string} [auditData.run_id] - UUID run opsional
 * @param {string} auditData.task - Nama tugas AI ('ZOMBIE_FARM', 'CHEST_SORT', 'TRASH_INCINERATE', 'NAVIGATE')
 * @param {string} auditData.action_type - Jenis aksi
 * @param {Object} [auditData.payload={}] - Payload masukan aksi
 * @param {Object} [auditData.result={}] - Hasil eksekusi aksi
 * @param {Date|string} [auditData.created_at]
 * @returns {Promise<Object>}
 */
async function logActionAudit(pool = defaultPool, auditData = {}) {
  if (!auditData || !auditData.task || !auditData.action_type) {
    throw new Error('task dan action_type wajib diisi untuk mencatat audit tindakan.');
  }

  const query = `
    INSERT INTO action_audit_logs (
      run_id, task, action_type, payload, result, created_at
    ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()))
    RETURNING *;
  `;

  const runId = auditData.run_id || null;
  const payload = JSON.stringify(auditData.payload || {});
  const result = JSON.stringify(auditData.result || {});
  const createdAt = auditData.created_at ? new Date(auditData.created_at) : new Date();

  try {
    const { rows } = await pool.query(query, [
      runId, String(auditData.task), String(auditData.action_type), payload, result, createdAt
    ]);
    return rows[0];
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal mencatat action audit log:', error.message);
    throw new Error(`Gagal menyimpan audit log tindakan: ${error.message}`);
  }
}

/**
 * Mengambil log audit tindakan dengan filter dan pagination.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {Object} [options={}]
 * @param {string} [options.runId]
 * @param {string} [options.task]
 * @param {string} [options.actionType]
 * @param {number} [options.limit=100]
 * @param {number} [options.offset=0]
 * @returns {Promise<Array<Object>>}
 */
async function queryActionAudits(pool = defaultPool, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const conditions = [];
  const params = [];

  if (options.runId) {
    params.push(options.runId);
    conditions.push(`run_id = $${params.length}`);
  }

  if (options.task) {
    params.push(options.task);
    conditions.push(`task = $${params.length}`);
  }

  if (options.actionType) {
    params.push(options.actionType);
    conditions.push(`action_type = $${params.length}`);
  }

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `
    SELECT * FROM action_audit_logs
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx};
  `;

  try {
    const { rows } = await pool.query(query, params);
    return rows;
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal query action audit logs:', error.message);
    throw new Error(`Gagal query audit log: ${error.message}`);
  }
}

/**
 * Menghitung metrik tolak ukur agregat (tingkat keberhasilan, rata-rata durasi, rintangan, pemulihan macet).
 * @param {import('pg').Pool} [pool=defaultPool]
 * @param {string} [level=null] - Level spesifik opsional ('level1', 'level2', dll)
 * @returns {Promise<Array<Object>>}
 */
async function getAggregateBenchmarkStats(pool = defaultPool, level = null) {
  const params = [];
  let whereClause = '';

  if (level) {
    params.push(level);
    whereClause = 'WHERE level = $1';
  }

  const query = `
    SELECT
      level,
      COUNT(*)::int AS total_runs,
      COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS successful_runs,
      COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed_runs,
      ROUND(
        (COUNT(*) FILTER (WHERE status = 'SUCCESS')::numeric / NULLIF(COUNT(*)::numeric, 0) * 100), 2
      )::float AS success_rate_pct,
      COALESCE(AVG(duration_ms)::int, 0) AS avg_duration_ms,
      COALESCE(SUM(obstacle_count)::int, 0) AS total_obstacles,
      COALESCE(SUM(stuck_recovery_count)::int, 0) AS total_stuck_recoveries
    FROM benchmark_runs
    ${whereClause}
    GROUP BY level
    ORDER BY level ASC;
  `;

  try {
    const { rows } = await pool.query(query, params);
    return rows;
  } catch (error) {
    console.error('[TelemetryRepository Error] Gagal menghitung agregat statistik benchmark:', error.message);
    throw new Error(`Gagal menghitung statistik benchmark: ${error.message}`);
  }
}

module.exports = {
  createBenchmarkRun,
  updateBenchmarkRunStatus,
  getBenchmarkRunById,
  queryRecentRuns,
  logTelemetrySummary,
  getTelemetryByRunId,
  logMovementAction,
  logMovementActionBatch,
  queryMovementLogs,
  logActionAudit,
  queryActionAudits,
  getAggregateBenchmarkStats
};
