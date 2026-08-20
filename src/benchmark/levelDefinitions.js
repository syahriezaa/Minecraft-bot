/**
 * @file levelDefinitions.js
 * @description Re-export konfigurasi benchmark dengan fungsi helper runtime.
 */

const { BENCHMARK_CONFIGS } = require('../config/constants');

/**
 * Mendapatkan posisi awal untuk level tertentu.
 * @param {number} level - Nomor level (1-4)
 * @returns {Object} Posisi awal { x, y, z }
 */
function getStartPosition(level) {
  const config = BENCHMARK_CONFIGS[`level${level}`];
  if (!config) throw new Error(`Level ${level} tidak valid`);
  return { ...config.startCoord };
}

/**
 * Mendapatkan posisi target untuk level tertentu.
 * @param {number} level - Nomor level (1-4)
 * @returns {Object} Posisi target { x, y, z }
 */
function getTargetPosition(level) {
  const config = BENCHMARK_CONFIGS[`level${level}`];
  if (!config) throw new Error(`Level ${level} tidak valid`);
  return { ...config.targetCoord };
}

/**
 * Mendapatkan timeout untuk level tertentu.
 * @param {number} level - Nomor level (1-4)
 * @returns {number} Timeout dalam milidetik
 */
function getTimeout(level) {
  const config = BENCHMARK_CONFIGS[`level${level}`];
  if (!config) throw new Error(`Level ${level} tidak valid`);
  return config.timeoutMs;
}

/**
 * Menghitung jarak Euclidean antara dua posisi 3D.
 * @param {Object} actualPos - Posisi aktual { x, y, z }
 * @param {Object} targetPos - Posisi target { x, y, z }
 * @returns {number} Jarak dalam meter
 */
function calculateCoordinateDelta(actualPos, targetPos) {
  const dx = actualPos.x - targetPos.x;
  const dy = actualPos.y - targetPos.y;
  const dz = actualPos.z - targetPos.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = { getStartPosition, getTargetPosition, getTimeout, calculateCoordinateDelta, BENCHMARK_CONFIGS };
