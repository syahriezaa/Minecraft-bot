/**
 * Modul Konfigurasi Koneksi Pool Database PostgreSQL
 * Mengelola koneksi pg.Pool dengan penanganan error tangguh,
 * mekanisme retry pemeriksaan kesehatan, serta eksekusi kueri terparameterisasi.
 */

const { Pool } = require('pg');
const environment = require('./environment');

// Konfigurasi pool pg dari variabel lingkungan
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

// Event listener untuk memantau status pool
pool.on('connect', (client) => {
  // Debug log dalam bahasa Inggris diperbolehkan
  // console.debug('[DB_POOL] Klien baru berhasil terhubung ke PostgreSQL');
});

pool.on('error', (err, client) => {
  // Tangkap error tak terduga pada klien idle agar proses Node.js tidak mengalami crash fatal
  console.error('Terjadi kesalahan tak terduga pada pool klien database idle PostgreSQL:', err.message);
});

/**
 * Eksekusi kueri SQL terparameterisasi dengan pengukuran waktu dan pembungkusan error.
 * @param {string} text - Perintah SQL terparameterisasi ($1, $2, dst.)
 * @param {Array} params - Nilai parameter kueri
 * @returns {Promise<import('pg').QueryResult>} Hasil eksekusi kueri
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    // Log debug performa kueri
    if (process.env.DEBUG_SQL === 'true') {
      console.debug('[SQL_EXEC]', { text, durationMs: duration, rowCount: result.rowCount });
    }
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[SQL_ERROR] Gagal mengeksekusi kueri SQL (${duration}ms):`, {
      pesan: error.message,
      kode: error.code,
      kueri: text
    });
    // Bungkus error dengan pesan Bahasa Indonesia yang informatif
    const wrappedError = new Error(`Kueri database gagal dieksekusi: ${error.message}`);
    wrappedError.originalError = error;
    wrappedError.code = error.code;
    throw wrappedError;
  }
}

/**
 * Mengambil satu klien dari pool untuk transaksi bertingkat (BEGIN/COMMIT/ROLLBACK).
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  try {
    const client = await pool.connect();
    return client;
  } catch (error) {
    console.error('Gagal memperoleh klien dari pool database PostgreSQL:', error.message);
    throw new Error(`Gagal memperoleh koneksi database: ${error.message}`);
  }
}

/**
 * Memeriksa kesehatan koneksi database PostgreSQL dengan mekanisme retry dan exponential backoff.
 * @param {number} maxRetries - Jumlah percobaan maksimum (default: 3)
 * @param {number} initialDelayMs - Jeda awal antar percobaan dalam milidetik (default: 1000)
 * @returns {Promise<{ ok: boolean, database?: string, user?: string, version?: string, latencyMs?: number, error?: string }>}
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
 * Menutup seluruh koneksi pada pool secara anggun (graceful shutdown).
 */
async function closeDatabasePool() {
  try {
    await pool.end();
    // Debug log
    // console.debug('[DB_POOL] Pool koneksi database PostgreSQL berhasil ditutup');
  } catch (error) {
    console.error('Terjadi kesalahan saat menutup pool database PostgreSQL:', error.message);
  }
}

module.exports = {
  pool,
  query,
  getClient,
  checkDatabaseHealth,
  closeDatabasePool
};
