/**
 * @file batchIngestion.js
 * @description Mesin Ingestion Batch Telemetri Tick 20 Hz dengan Ring Buffer dan Dual-Trigger Flush.
 * Dirancang untuk menangani beban data berkecepatan tinggi dari Mineflayer tick loop (50ms),
 * melakukan pengelompokan (batching) ke PostgreSQL via UNNEST query, tahan terhadap kegagalan jaringan,
 * membatasi kapasitas memori (ring buffer capping), dan mendukung graceful shutdown.
 */

const EventEmitter = require('events');

/**
 * Konfigurasi default untuk batch ingestion telemetri.
 */
const DEFAULT_OPTIONS = {
  flushIntervalMs: 250,      // Interval flush otomatis berkala berdasarkan waktu (milidetik)
  batchThreshold: 50,        // Jumlah item antrean yang memicu flush instan (ambang batas batch)
  maxBufferSize: 5000,       // Kapasitas maksimum antrean sebelum data tertua dibuang (pencegah OOM)
  chunkSize: 500,            // Batas maksimum baris per satu query UNNEST ke PostgreSQL
  retryDelayMs: 500,         // Jeda awal percobaan ulang saat koneksi database gagal
  maxRetryDelayMs: 5000,     // Jeda maksimum percobaan ulang (exponential backoff)
  shutdownTimeoutMs: 5000    // Batas waktu pengosongan buffer saat proses shutdown
};

/**
 * Kelas BatchIngestionService
 * Mengelola antrean memori, timer flush 250ms, ambang batas batch 50 item,
 * query UNNEST PostgreSQL, pemulihan error jaringan, dan graceful shutdown.
 */
class BatchIngestionService extends EventEmitter {
  /**
   * @param {import('pg').Pool} pool - Pool koneksi PostgreSQL
   * @param {Object} [options={}] - Opsi konfigurasi layanan
   */
  constructor(pool, options = {}) {
    super();
    this.pool = pool;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_OPTIONS.flushIntervalMs;
    this.batchThreshold = options.batchThreshold ?? DEFAULT_OPTIONS.batchThreshold;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_OPTIONS.maxBufferSize;
    this.chunkSize = options.chunkSize ?? DEFAULT_OPTIONS.chunkSize;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_OPTIONS.retryDelayMs;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_OPTIONS.maxRetryDelayMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_OPTIONS.shutdownTimeoutMs;

    this.queue = [];
    this.timer = null;
    this.isFlushing = false;
    this.isClosed = false;
    this.currentRetryDelay = this.retryDelayMs;

    // Metrik performa dan pemantauan
    this.totalIngested = 0;
    this.totalPersisted = 0;
    this.totalDropped = 0;
    this.totalFlushErrors = 0;

    if (this.flushIntervalMs > 0) {
      this.startTimer();
    }
  }

  /**
   * Memulai interval timer pengosongan buffer secara berkala.
   */
  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.emit('timer_flush_error', err);
      });
    }, this.flushIntervalMs);

    // Unref timer agar tidak menahan proses Node.js keluar jika tidak ada event loop lain
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Menghentikan interval timer pengosongan buffer.
   */
  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Menerima satu data telemetri tick 20 Hz dari bot loop.
   * Operasi ini non-blocking dan sinkron ke antrean memori.
   * @param {Object} tickData - Data telemetri satu tick
   * @returns {boolean} Status keberhasilan penambahan ke antrean
   */
  ingestTick(tickData) {
    if (this.isClosed) {
      throw new Error('Layanan batch ingestion telah ditutup, tidak dapat menerima data baru.');
    }

    if (!tickData || (!tickData.run_id && !tickData.runId)) {
      throw new Error('Data telemetri tick tidak valid: run_id wajib disertakan.');
    }

    // Normalisasi dan sanitasi data tick
    const entry = {
      run_id: tickData.run_id || tickData.runId,
      tick: Number(tickData.tick ?? 0),
      x: Number(tickData.x ?? 0.0),
      y: Number(tickData.y ?? 0.0),
      z: Number(tickData.z ?? 0.0),
      velocity_xz: Number(tickData.velocity_xz ?? tickData.velocityXZ ?? 0.0),
      action: String(tickData.action || 'IDLE'),
      is_stuck: Boolean(tickData.is_stuck ?? tickData.isStuck ?? false),
      recovery_phase: Number(tickData.recovery_phase ?? tickData.recoveryPhase ?? 0),
      created_at: tickData.created_at ? new Date(tickData.created_at) : new Date()
    };

    // Perlindungan memory leak: ring buffer bounded overflow
    if (this.queue.length >= this.maxBufferSize) {
      this.queue.shift(); // Buang data tertua dari antrean
      this.totalDropped++;
      this.emit('buffer_overflow', {
        queueLength: this.queue.length,
        totalDropped: this.totalDropped
      });
      console.warn(`[PERINGATAN Telemetri] Buffer penuh (${this.maxBufferSize}), data tick tertua dibuang untuk mencegah kehabisan memori.`);
    }

    this.queue.push(entry);
    this.totalIngested++;

    // Dual-trigger: jika antrean mencapai ambang batas batch, lakukan flush instan tanpa menunggu interval timer
    if (this.queue.length >= this.batchThreshold && !this.isFlushing) {
      setImmediate(() => {
        this.flush().catch((err) => {
          this.emit('threshold_flush_error', err);
        });
      });
    }

    return true;
  }

  /**
   * Melakukan flush / persistensi sekumpulan data telemetri dari antrean ke PostgreSQL menggunakan UNNEST.
   * @returns {Promise<{ count: number }>}
   */
  async flush() {
    // Jika sedang dalam proses flush lain, antrean kosong, atau pool belum tersedia
    if (this.isFlushing || this.queue.length === 0 || !this.pool) {
      return { count: 0 };
    }

    this.isFlushing = true;
    const batchSize = Math.min(this.queue.length, this.chunkSize);
    const batch = this.queue.splice(0, batchSize);

    // Query UNNEST PostgreSQL berkecepatan tinggi dengan 10 array parameter konstan
    const query = `
      INSERT INTO movement_action_logs (
        run_id, tick, x, y, z, velocity_xz, action, is_stuck, recovery_phase, created_at
      )
      SELECT 
        u.run_id, u.tick, u.x, u.y, u.z, u.velocity_xz, u.action, u.is_stuck, u.recovery_phase, u.created_at
      FROM UNNEST(
        $1::uuid[],
        $2::bigint[],
        $3::double precision[],
        $4::double precision[],
        $5::double precision[],
        $6::double precision[],
        $7::varchar[],
        $8::boolean[],
        $9::integer[],
        $10::timestamptz[]
      ) AS u(run_id, tick, x, y, z, velocity_xz, action, is_stuck, recovery_phase, created_at);
    `;

    const params = [
      batch.map((i) => i.run_id),
      batch.map((i) => i.tick),
      batch.map((i) => i.x),
      batch.map((i) => i.y),
      batch.map((i) => i.z),
      batch.map((i) => i.velocity_xz),
      batch.map((i) => i.action),
      batch.map((i) => i.is_stuck),
      batch.map((i) => i.recovery_phase),
      batch.map((i) => (i.created_at instanceof Date ? i.created_at.toISOString() : i.created_at))
    ];

    try {
      await this.pool.query(query, params);

      this.totalPersisted += batch.length;
      this.currentRetryDelay = this.retryDelayMs; // Reset backoff jika berhasil
      this.isFlushing = false;

      this.emit('flushed', {
        count: batch.length,
        remainingInQueue: this.queue.length,
        totalPersisted: this.totalPersisted
      });

      // Jika masih ada sisa data di atas ambang batas, lanjutkan flush chunk berikutnya
      if (this.queue.length >= this.batchThreshold) {
        setImmediate(() => {
          this.flush().catch((err) => this.emit('error', err));
        });
      }

      return { count: batch.length };
    } catch (err) {
      this.totalFlushErrors++;

      // Strategi Ketahanan Koneksi: Kembalikan batch ke depan antrean agar tidak hilang
      this.queue.unshift(...batch);

      // Batasi ukuran antrean jika unshift menyebabkan kelebihan kapasitas
      if (this.queue.length > this.maxBufferSize) {
        const excess = this.queue.length - this.maxBufferSize;
        this.queue.splice(0, excess);
        this.totalDropped += excess;
      }

      this.isFlushing = false;

      // Exponential backoff untuk percobaan selanjutnya
      this.currentRetryDelay = Math.min(this.currentRetryDelay * 2, this.maxRetryDelayMs);

      const errorMessage = `Gagal menyimpan batch telemetri ke database: ${err.message}`;
      const wrappedError = new Error(errorMessage);
      this.emit('flush_error', {
        error: wrappedError,
        retainedQueueLength: this.queue.length,
        retryDelayMs: this.currentRetryDelay
      });

      throw wrappedError;
    }
  }

  /**
   * Menjalankan graceful shutdown: menghentikan penerimaan data baru, mematikan timer,
   * dan mengosongkan seluruh sisa antrean ke PostgreSQL hingga tuntas.
   * @param {number} [timeoutMs] - Batas waktu pengosongan buffer (ms)
   * @returns {Promise<Object>} Statistik akhir ingestion
   */
  async flushAndClose(timeoutMs = this.shutdownTimeoutMs) {
    this.isClosed = true;
    this.stopTimer();

    const startTime = Date.now();

    while (this.queue.length > 0) {
      if (Date.now() - startTime > timeoutMs) {
        const timeoutErr = new Error(
          `Batas waktu pengosongan buffer telemetri habis (${timeoutMs}ms). Sisa ${this.queue.length} item tidak tersimpan.`
        );
        this.emit('error', timeoutErr);
        throw timeoutErr;
      }

      try {
        await this.flush();
      } catch (err) {
        // Tunggu sejenak sesuai delay backoff sebelum mencoba kembali saat database bermasalah
        await new Promise((resolve) => setTimeout(resolve, this.currentRetryDelay));
      }
    }

    const stats = this.getStats();
    this.emit('closed', stats);
    return stats;
  }

  /**
   * Mengambil statistik operasional batch ingestion saat ini.
   * @returns {Object}
   */
  getStats() {
    return {
      queueLength: this.queue.length,
      totalIngested: this.totalIngested,
      totalPersisted: this.totalPersisted,
      totalDropped: this.totalDropped,
      totalFlushErrors: this.totalFlushErrors,
      isFlushing: this.isFlushing,
      isClosed: this.isClosed
    };
  }

  /**
   * Mengatur pool koneksi database baru (berguna untuk pengujian atau koneksi ulang).
   * @param {import('pg').Pool} newPool
   */
  setPool(newPool) {
    this.pool = newPool;
  }
}

/**
 * Fungsi pembantu untuk membuat instance BatchIngestionService baru.
 * @param {import('pg').Pool} pool
 * @param {Object} [options={}]
 * @returns {BatchIngestionService}
 */
function createBatchIngestionService(pool, options = {}) {
  return new BatchIngestionService(pool, options);
}

module.exports = {
  BatchIngestionService,
  createBatchIngestionService,
  DEFAULT_OPTIONS
};
