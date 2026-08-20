/**
 * @file database.js
 * @description Modul pengelolaan koneksi pool PostgreSQL menggunakan pg.Pool.
 * Menyediakan kueri terparameterisasi, peminjaman klien transaksi,
 * pemeriksaan kesehatan berkala dengan retry exponential backoff, dan penutupan koneksi anggun.
 */

const { Pool } = require('pg');
const environment = require('./environment');

// Konfigurasi koneksi pool PostgreSQL
const poolConfig = environment.database.connectionString
  ? {
      connectionString: environment.database.connectionString,
      max: environment.database.pool.max,
      min: environment.database.pool.min,
      idleTimeoutMillis: environment.database.pool.idleTimeoutMillis,
      connectionTimeoutMillis: environment.database.pool.connectionTimeoutMillis,
      statement_timeout: environment.database.pool.statementTimeoutMillis
    }
  : {
      host: environment.database.host,
      port: environment.database.port,
      user: environment.database.user,
      password: environment.database.password,
      database: environment.database.database,
      max: environment.database.pool.max,
      min: environment.database.pool.min,
      idleTimeoutMillis: environment.database.pool.idleTimeoutMillis,
      connectionTimeoutMillis: environment.database.pool.connectionTimeoutMillis,
      statement_timeout: environment.database.pool.statementTimeoutMillis
    };

// Inisialisasi pool PostgreSQL
const pool = new Pool(poolConfig);

// Tangani event error pada klien idle agar tidak menyebabkan crash fatal pada aplikasi Node.js
pool.on('error', (err) => {
  console.error('[DB_POOL_ERROR] Terjadi kesalahan tak terduga pada klien PostgreSQL idle:', err.message);
});

/**
 * Mengeksekusi kueri SQL terparameterisasi dengan pencatatan waktu dan pembungkusan error.
 * @param {string} text - Teks kueri SQL berparameter ($1, $2, dst.)
 * @param {Array} [params=[]] - Parameter yang disanitasi
 * @returns {Promise<import('pg').QueryResult>} Hasil eksekusi kueri
 */
async function query(text, params = []) {
  const startTime = Date.now();
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    console.error(`[SQL_ERROR] Kueri gagal dieksekusi (${durationMs}ms):`, {
      message: error.message,
      code: error.code,
      query: text
    });
    const wrappedError = new Error(`Kueri database gagal dieksekusi: ${error.message}`);
    wrappedError.originalError = error;
    wrappedError.code = error.code;
    throw wrappedError;
  }
}

/**
 * Mengambil satu klien dari pool untuk transaksi bertingkat (BEGIN / COMMIT / ROLLBACK).
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  try {
    const client = await pool.connect();
    return client;
  } catch (error) {
    console.error('[DB_CLIENT_ERROR] Gagal meminjam klien dari pool PostgreSQL:', error.message);
    throw new Error(`Gagal memperoleh koneksi database dari pool: ${error.message}`);
  }
}

/**
 * Memeriksa kesehatan dan kesiapan koneksi database PostgreSQL dengan mekanisme retry dan exponential backoff.
 * @param {number} [maxRetries=3] - Jumlah percobaan maksimum
 * @param {number} [initialDelayMs=1000] - Jeda awal dalam milidetik
 * @returns {Promise<{ ok: boolean, database?: string, user?: string, version?: string, latencyMs?: number, error?: string, attemptsNeeded?: number }>}
 */
async function checkDatabaseHealth(maxRetries = 3, initialDelayMs = 1000) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (attempt < maxRetries) {
    attempt++;
    const startTime = Date.now();
    try {
      const result = await pool.query(
        `SELECT 
           1 AS alive, 
           current_database() AS current_db, 
           current_user AS current_usr, 
           version() AS db_version;`
      );
      const latencyMs = Date.now() - startTime;
      const row = result.rows[0];

      return {
        ok: true,
        database: row.current_db,
        user: row.current_usr,
        version: row.db_version,
        latencyMs,
        attemptsNeeded: attempt
      };
    } catch (err) {
      console.warn(`[DB_HEALTH_CHECK] Percobaan ke-${attempt} gagal terhubung ke PostgreSQL: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      } else {
        return {
          ok: false,
          error: `Gagal terhubung ke database PostgreSQL setelah ${maxRetries} percobaan: ${err.message}`,
          attemptsFailed: attempt
        };
      }
    }
  }

  return {
    ok: false,
    error: 'Pemeriksaan kesehatan database gagal tanpa hasil yang valid.'
  };
}

/**
 * Menutup pool koneksi database secara anggun (graceful shutdown).
 */
async function closeDatabasePool() {
  try {
    await pool.end();
  } catch (error) {
    console.error('[DB_CLOSE_ERROR] Terjadi kesalahan saat menutup pool database PostgreSQL:', error.message);
  }
}

module.exports = {
  pool,
  query,
  getClient,
  checkDatabaseHealth,
  closeDatabasePool
};
