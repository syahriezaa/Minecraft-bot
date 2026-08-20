/**
 * @file environment.js
 * @description Modul konfigurasi terpusat untuk memuat dan memvalidasi variabel lingkungan sistem.
 */

const dotenv = require('dotenv');
const path = require('path');

// Muat konfigurasi dari berkas .env di root proyek jika tersedia
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const environment = {
  // Mode Operasional Aplikasi
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',

  // Konfigurasi Database PostgreSQL
  database: {
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.PGPORT || process.env.DB_PORT || '5432', 10),
    user: process.env.PGUSER || process.env.DB_USER || process.env.USER || 'syahriezas',
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD || '',
    database: process.env.PGDATABASE || process.env.DB_NAME || 'minecraft_companion',
    connectionString: process.env.DATABASE_URL || null,
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || '20', 10),
      min: parseInt(process.env.DB_POOL_MIN || '2', 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000', 10),
      statementTimeoutMillis: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '10000', 10)
    }
  },

  // Konfigurasi Web Dashboard & Telemetry Hub (Port 8080)
  server: {
    port: parseInt(process.env.PORT || '8080', 10),
    host: process.env.HOST || '0.0.0.0'
  },

  // Konfigurasi Server Headless Minecraft Arena & Bot
  minecraft: {
    host: process.env.MC_HOST || '127.0.0.1',
    port: parseInt(process.env.MC_PORT || '25565', 10),
    version: process.env.MC_VERSION || '1.20.1',
    botUsername: process.env.MC_BOT_USERNAME || 'AutonomousCompanion'
  },

  // Konfigurasi DeepSeek AI Brain
  ai: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    timeoutMs: parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '30000', 10)
  },

  // Konfigurasi Batch Ingestion Telemetri (20 Hz)
  telemetry: {
    flushIntervalMs: parseInt(process.env.TELEMETRY_FLUSH_INTERVAL_MS || '250', 10),
    batchThreshold: parseInt(process.env.TELEMETRY_BATCH_THRESHOLD || '50', 10),
    maxBufferSize: parseInt(process.env.TELEMETRY_MAX_BUFFER_SIZE || '5000', 10)
  }
};

module.exports = environment;
