/**
 * @file migrations.js
 * @description Modul manajemen migrasi skema database PostgreSQL untuk minecraft_companion.
 * Mendukung migrasi transaksional DDL untuk 5 tabel resmi, pembuatan 10 indeks komposit,
 * pelacakan versi migrasi, idempotensi, dan fungsi reset skema.
 */

const { pool: defaultPool } = require('../config/database');

/**
 * Daftar definisi migrasi bertingkat.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: '001_initial_schema',
    up: async (client) => {
      // 1. Bersihkan tabel legacy atau tabel yang tidak kompatibel jika ada
      await client.query(`
        DROP TABLE IF EXISTS action_audit_logs CASCADE;
        DROP TABLE IF EXISTS movement_action_logs CASCADE;
        DROP TABLE IF EXISTS telemetry_logs CASCADE;
        DROP TABLE IF EXISTS benchmark_runs CASCADE;
      `);

      // 2. Buat tabel benchmark_runs
      await client.query(`
        CREATE TABLE IF NOT EXISTS benchmark_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          level VARCHAR(50) NOT NULL,
          status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'ABORTED')),
          start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          end_time TIMESTAMPTZ,
          duration_ms INT DEFAULT 0,
          obstacle_count INT DEFAULT 0,
          stuck_recovery_count INT DEFAULT 0,
          success_rate FLOAT DEFAULT 0.0,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // 3. Buat tabel telemetry_logs (ringkasan telemetri per run)
      await client.query(`
        CREATE TABLE IF NOT EXISTS telemetry_logs (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
          level VARCHAR(50) NOT NULL,
          status VARCHAR(20) NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'ABORTED')),
          travel_duration_ms INT DEFAULT 0,
          obstacle_count INT DEFAULT 0,
          start_pos JSONB NOT NULL DEFAULT '{}'::jsonb,
          end_pos JSONB NOT NULL DEFAULT '{}'::jsonb,
          coordinate_delta FLOAT DEFAULT 0.0,
          path_history JSONB DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // 4. Buat tabel movement_action_logs (telemetri frekuensi tinggi 20 Hz tick)
      await client.query(`
        CREATE TABLE IF NOT EXISTS movement_action_logs (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
          tick BIGINT NOT NULL,
          x FLOAT NOT NULL,
          y FLOAT NOT NULL,
          z FLOAT NOT NULL,
          velocity_xz FLOAT DEFAULT 0.0,
          action VARCHAR(100) NOT NULL,
          is_stuck BOOLEAN NOT NULL DEFAULT FALSE,
          recovery_phase INT NOT NULL DEFAULT 0 CHECK (recovery_phase BETWEEN 0 AND 4),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // 5. Buat tabel action_audit_logs (audit tugas AI dan bot)
      await client.query(`
        CREATE TABLE IF NOT EXISTS action_audit_logs (
          id BIGSERIAL PRIMARY KEY,
          run_id UUID REFERENCES benchmark_runs(id) ON DELETE SET NULL,
          task VARCHAR(100) NOT NULL,
          action_type VARCHAR(100) NOT NULL,
          payload JSONB DEFAULT '{}'::jsonb,
          result JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // 6. Buat indeks komposit dan B-Tree untuk performa kueri tinggi
      await client.query(`
        -- Indeks tabel benchmark_runs
        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_level_status ON benchmark_runs(level, status);
        CREATE INDEX IF NOT EXISTS idx_benchmark_runs_start_time ON benchmark_runs(start_time DESC);

        -- Indeks tabel telemetry_logs
        CREATE INDEX IF NOT EXISTS idx_telemetry_logs_run_id ON telemetry_logs(run_id);
        CREATE INDEX IF NOT EXISTS idx_telemetry_logs_level_status ON telemetry_logs(level, status);
        CREATE INDEX IF NOT EXISTS idx_telemetry_logs_created_at ON telemetry_logs(created_at DESC);

        -- Indeks tabel movement_action_logs (20 Hz queries & visualizer)
        CREATE INDEX IF NOT EXISTS idx_movement_logs_run_tick ON movement_action_logs(run_id, tick);
        CREATE INDEX IF NOT EXISTS idx_movement_logs_run_stuck ON movement_action_logs(run_id, is_stuck);
        CREATE INDEX IF NOT EXISTS idx_movement_logs_created_at ON movement_action_logs(created_at DESC);

        -- Indeks tabel action_audit_logs
        CREATE INDEX IF NOT EXISTS idx_action_audit_run_id ON action_audit_logs(run_id);
        CREATE INDEX IF NOT EXISTS idx_action_audit_task_created ON action_audit_logs(task, created_at DESC);
      `);
    },
    down: async (client) => {
      await client.query(`
        DROP TABLE IF EXISTS action_audit_logs CASCADE;
        DROP TABLE IF EXISTS movement_action_logs CASCADE;
        DROP TABLE IF EXISTS telemetry_logs CASCADE;
        DROP TABLE IF EXISTS benchmark_runs CASCADE;
      `);
    }
  },
  {
    version: 2,
    name: '002_terrain_surface_baseline',
    up: async (client) => {
      // Baseline permukaan dunia persisten (bukan cache per-sesi) - dikumpulkan pasif dari tiap
      // chunk nyata yang pernah dimuat bot manapun, plus opsional dari sesi eksplorasi khusus.
      // Menjawab batas "cache-frontier": A*/navigasi jarak jauh sebelumnya hanya bisa merencanakan
      // di area yang ter-cache pada SESI SAAT ITU SAJA - tabel ini membuat pengetahuan itu bertahan
      // lintas sesi dan bertumbuh dari waktu ke waktu.
      await client.query(`
        CREATE TABLE IF NOT EXISTS terrain_surface_baseline (
          x INT NOT NULL,
          z INT NOT NULL,
          surface_y INT NOT NULL,
          block_state_id INT,
          block_name VARCHAR(100),
          source VARCHAR(20) NOT NULL DEFAULT 'passive' CHECK (source IN ('passive', 'exploration')),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (x, z)
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_terrain_baseline_z ON terrain_surface_baseline(z);
        CREATE INDEX IF NOT EXISTS idx_terrain_baseline_updated_at ON terrain_surface_baseline(updated_at DESC);
      `);
    },
    down: async (client) => {
      await client.query(`DROP TABLE IF EXISTS terrain_surface_baseline CASCADE;`);
    }
  }
];

/**
 * Memastikan tabel schema_migrations tersedia untuk pencatatan versi migrasi.
 * @param {import('pg').PoolClient} client
 */
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

/**
 * Menjalankan semua migrasi yang belum diaplikasikan ke database secara transaksional.
 * @param {import('pg').Pool} [pool=defaultPool]
 * @returns {Promise<{ appliedCount: number, versions: number[] }>}
 */
async function runMigrations(pool = defaultPool) {
  const client = await pool.connect();
  const appliedVersions = [];

  try {
    await ensureMigrationsTable(client);

    // Ambil daftar migrasi yang sudah pernah diaplikasikan
    const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    const executedVersions = new Set(rows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (!executedVersions.has(migration.version)) {
        console.log(`[Database Migrasi] Menjalankan migrasi versi ${migration.version}: ${migration.name}...`);

        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW())',
            [migration.version, migration.name]
          );
          await client.query('COMMIT');
          appliedVersions.push(migration.version);
          console.log(`[Database Migrasi] Berhasil menerapkan migrasi versi ${migration.version}: ${migration.name}`);
        } catch (migrationErr) {
          await client.query('ROLLBACK');
          console.error(`[Database Migrasi Error] Gagal pada versi ${migration.version}:`, migrationErr.message);
          throw new Error(`Migrasi database gagal pada versi ${migration.version}: ${migrationErr.message}`);
        }
      }
    }

    return {
      appliedCount: appliedVersions.length,
      versions: appliedVersions
    };
  } finally {
    client.release();
  }
}

/**
 * Mereset database secara menyeluruh (menghapus seluruh tabel dan tabel schema_migrations).
 * @param {import('pg').Pool} [pool=defaultPool]
 */
async function resetDatabase(pool = defaultPool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      DROP TABLE IF EXISTS action_audit_logs CASCADE;
      DROP TABLE IF EXISTS movement_action_logs CASCADE;
      DROP TABLE IF EXISTS telemetry_logs CASCADE;
      DROP TABLE IF EXISTS benchmark_runs CASCADE;
      DROP TABLE IF EXISTS terrain_surface_baseline CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
    `);
    await client.query('COMMIT');
    console.log('[Database Migrasi] Database berhasil di-reset ke kondisi bersih.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Database Migrasi Error] Gagal mereset database:', err.message);
    throw new Error(`Gagal mereset database: ${err.message}`);
  } finally {
    client.release();
  }
}

// Eksekusi langsung melalui terminal CLI jika dijalankan via node
if (require.main === module) {
  const args = process.argv.slice(2);
  (async () => {
    try {
      if (args.includes('--reset')) {
        console.log('[CLI] Memulai reset database...');
        await resetDatabase();
        console.log('[CLI] Menjalankan migrasi ulang setelah reset...');
        await runMigrations();
      } else {
        console.log('[CLI] Menjalankan migrasi database up...');
        const result = await runMigrations();
        console.log(`[CLI] Selesai. Total migrasi baru diaplikasikan: ${result.appliedCount}`);
      }
      process.exit(0);
    } catch (err) {
      console.error('[CLI Error] Eksekusi migrasi gagal:', err.message);
      process.exit(1);
    }
  })();
}

module.exports = {
  MIGRATIONS,
  runMigrations,
  resetDatabase,
  ensureMigrationsTable
};
