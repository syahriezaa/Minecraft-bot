/**
 * @file waypointGraph.js
 * @description Graf waypoint makro hierarkis untuk navigasi jarak jauh Level 4.
 * Mendefinisikan rantai waypoint dari permukaan ke farm spawner bawah tanah [-256, -20, -432].
 */

const { TARGET_SPAWNER_COORDINATES } = require('../config/constants');

// Rantai waypoint makro untuk navigasi Level 4
const MACRO_WAYPOINTS = Object.freeze([
  { id: 'surface', x: 0, y: 64, z: 0, label: 'Permukaan (Titik Awal)' },
  { id: 'cave_entrance', x: -50, y: 45, z: -80, label: 'Pintu Masuk Gua' },
  { id: 'mid_tunnel_1', x: -120, y: 25, z: -200, label: 'Terowongan Tengah 1' },
  { id: 'mid_tunnel_2', x: -190, y: 5, z: -320, label: 'Terowongan Tengah 2' },
  { id: 'deep_approach', x: -240, y: -15, z: -400, label: 'Pendekatan Dalam' },
  { id: 'spawner_farm', x: TARGET_SPAWNER_COORDINATES.x, y: TARGET_SPAWNER_COORDINATES.y, z: TARGET_SPAWNER_COORDINATES.z, label: 'Farm Spawner Zombie' }
]);

/**
 * Menghitung jarak Euclidean 3D antara dua posisi.
 * @param {Object} a - Posisi { x, y, z }
 * @param {Object} b - Posisi { x, y, z }
 * @returns {number} Jarak dalam meter
 */
function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Mendapatkan waypoint berikutnya yang harus dituju berdasarkan posisi saat ini.
 * @param {Object} currentPos - Posisi bot saat ini { x, y, z }
 * @param {Object} [finalGoal=null] - Tujuan akhir opsional { x, y, z }
 * @returns {Object|null} Waypoint berikutnya { id, x, y, z, label, index }
 */
function getNextWaypoint(currentPos, finalGoal = null) {
  // Temukan waypoint terdekat yang sudah dilewati
  let closestIndex = 0;
  let closestDist = Infinity;

  for (let i = 0; i < MACRO_WAYPOINTS.length; i++) {
    const dist = distance3D(currentPos, MACRO_WAYPOINTS[i]);
    if (dist < closestDist) {
      closestDist = dist;
      closestIndex = i;
    }
  }

  // Jika sudah dekat dengan waypoint terakhir (farm spawner), kembalikan null
  if (closestIndex === MACRO_WAYPOINTS.length - 1 && closestDist < 5) {
    return null; // Sudah tiba di tujuan akhir
  }

  // Kembalikan waypoint berikutnya dalam rantai
  const nextIndex = Math.min(closestIndex + 1, MACRO_WAYPOINTS.length - 1);

  // Jika sudah sangat dekat dengan waypoint saat ini, lompat ke berikutnya
  if (closestDist < 3 && nextIndex < MACRO_WAYPOINTS.length) {
    const skipIndex = Math.min(nextIndex + 1, MACRO_WAYPOINTS.length - 1);
    return { ...MACRO_WAYPOINTS[skipIndex], index: skipIndex };
  }

  return { ...MACRO_WAYPOINTS[nextIndex], index: nextIndex };
}

/**
 * Memeriksa apakah posisi saat ini berada dalam toleransi waypoint.
 * @param {Object} pos - Posisi { x, y, z }
 * @param {Object} waypoint - Waypoint { x, y, z }
 * @param {number} [tolerance=3] - Toleransi jarak (meter)
 * @returns {boolean}
 */
function isAtWaypoint(pos, waypoint, tolerance = 3) {
  return distance3D(pos, waypoint) <= tolerance;
}

/**
 * Mendapatkan seluruh daftar waypoint makro.
 * @returns {Array} Daftar waypoint
 */
function getAllWaypoints() {
  return [...MACRO_WAYPOINTS];
}

/**
 * Mendapatkan persentase progres navigasi berdasarkan posisi saat ini.
 * @param {Object} currentPos - Posisi bot saat ini { x, y, z }
 * @returns {number} Persentase progres (0-100)
 */
function getProgressPercentage(currentPos) {
  const totalDistance = distance3D(MACRO_WAYPOINTS[0], MACRO_WAYPOINTS[MACRO_WAYPOINTS.length - 1]);
  const remaining = distance3D(currentPos, MACRO_WAYPOINTS[MACRO_WAYPOINTS.length - 1]);
  const progress = Math.max(0, Math.min(100, ((totalDistance - remaining) / totalDistance) * 100));
  return Math.round(progress * 10) / 10;
}

module.exports = { MACRO_WAYPOINTS, getNextWaypoint, isAtWaypoint, getAllWaypoints, getProgressPercentage, distance3D };
