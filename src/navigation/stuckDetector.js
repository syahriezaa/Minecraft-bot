/**
 * @file stuckDetector.js
 * @description Detektor kondisi macet (stuck) berbasis sliding window yang menganalisis
 * riwayat posisi bot selama WINDOW_TICKS terakhir untuk menentukan apakah bot terjebak.
 */

const { STUCK_DETECTION } = require('../config/constants');

class StuckDetector {
  constructor(options = {}) {
    this.windowSize = options.windowSize || STUCK_DETECTION.WINDOW_TICKS;
    this.minVelocityXZ = options.minVelocityXZ || STUCK_DETECTION.MIN_VELOCITY_XZ;
    this.minDistanceDelta = options.minDistanceDelta || STUCK_DETECTION.MIN_DISTANCE_DELTA;
    this.maxStuckDurationMs = options.maxStuckDurationMs || STUCK_DETECTION.MAX_STUCK_DURATION_MS;

    this.positionHistory = [];
    this.stuckStartTime = null;
    this.totalStuckCount = 0;
  }

  /**
   * Mencatat posisi bot pada tick saat ini ke dalam sliding window.
   * @param {Object} position - Posisi bot { x, y, z }
   * @param {number} [timestamp=Date.now()] - Waktu pencatatan
   */
  recordTick(position, timestamp = Date.now()) {
    this.positionHistory.push({
      x: position.x,
      y: position.y,
      z: position.z,
      timestamp
    });

    // Batasi ukuran window
    while (this.positionHistory.length > this.windowSize) {
      this.positionHistory.shift();
    }
  }

  /**
   * Memeriksa apakah bot sedang dalam kondisi macet (stuck).
   * Stuck = kecepatan horizontal < ambang batas DAN delta jarak < ambang batas selama > durasi maksimal.
   * @returns {boolean} True jika bot terdeteksi macet
   */
  isStuck() {
    if (this.positionHistory.length < 2) return false;

    const oldest = this.positionHistory[0];
    const newest = this.positionHistory[this.positionHistory.length - 1];

    // Hitung delta jarak horizontal (XZ plane)
    const dx = newest.x - oldest.x;
    const dz = newest.z - oldest.z;
    const distanceDeltaXZ = Math.sqrt(dx * dx + dz * dz);

    // Hitung kecepatan rata-rata horizontal
    const timeDeltaMs = newest.timestamp - oldest.timestamp;
    if (timeDeltaMs <= 0) return false;

    const velocityXZ = distanceDeltaXZ / (timeDeltaMs / 1000);

    // Evaluasi kondisi macet
    const isCurrentlyStuck = velocityXZ < this.minVelocityXZ && distanceDeltaXZ < this.minDistanceDelta;

    if (isCurrentlyStuck) {
      if (this.stuckStartTime === null) {
        this.stuckStartTime = oldest.timestamp;
      }

      const stuckDuration = Date.now() - this.stuckStartTime;
      if (stuckDuration >= this.maxStuckDurationMs) {
        this.totalStuckCount++;
        return true;
      }
    } else {
      this.stuckStartTime = null;
    }

    return false;
  }

  /**
   * Mendapatkan informasi diagnostik detektor saat ini.
   * @returns {Object} Info diagnostik
   */
  getDiagnostics() {
    if (this.positionHistory.length < 2) {
      return { velocityXZ: 0, distanceDelta: 0, stuckDurationMs: 0, isStuck: false };
    }

    const oldest = this.positionHistory[0];
    const newest = this.positionHistory[this.positionHistory.length - 1];
    const dx = newest.x - oldest.x;
    const dz = newest.z - oldest.z;
    const distanceDeltaXZ = Math.sqrt(dx * dx + dz * dz);
    const timeDeltaMs = newest.timestamp - oldest.timestamp;
    const velocityXZ = timeDeltaMs > 0 ? distanceDeltaXZ / (timeDeltaMs / 1000) : 0;

    return {
      velocityXZ: Math.round(velocityXZ * 1000) / 1000,
      distanceDelta: Math.round(distanceDeltaXZ * 1000) / 1000,
      stuckDurationMs: this.stuckStartTime ? Date.now() - this.stuckStartTime : 0,
      isStuck: this.isStuck(),
      totalStuckCount: this.totalStuckCount,
      windowSize: this.positionHistory.length
    };
  }

  /**
   * Mereset seluruh state detektor.
   */
  reset() {
    this.positionHistory = [];
    this.stuckStartTime = null;
  }
}

module.exports = { StuckDetector };
