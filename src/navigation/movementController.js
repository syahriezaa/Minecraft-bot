/**
 * @file movementController.js
 * @description Controller navigasi yang membungkus mineflayer-pathfinder dengan goal types,
 * konfigurasi pergerakan, dan event emitting untuk monitoring real-time.
 */

const { goals: { GoalBlock, GoalNear, GoalXZ } } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

/**
 * Menavigasi bot ke koordinat target menggunakan mineflayer-pathfinder.
 * @param {Object} bot - Instance Mineflayer bot
 * @param {Object} target - Koordinat target { x, y, z }
 * @param {number} [tolerance=2] - Toleransi jarak kedatangan (meter)
 * @returns {Promise<Object>} Hasil navigasi { success, duration_ms, finalPos, coordinateDelta }
 */
async function navigateTo(bot, target, tolerance = 2) {
  if (!bot || !bot.pathfinder) {
    return { success: false, error: 'Bot atau pathfinder belum siap' };
  }

  const startTime = Date.now();
  const startPos = bot.entity.position.clone();

  // Pilih tipe goal berdasarkan toleransi
  let goal;
  if (tolerance <= 1) {
    goal = new GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
  } else {
    goal = new GoalNear(target.x, target.y, target.z, tolerance);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      stopNavigation(bot);
      const finalPos = bot.entity.position;
      const delta = finalPos.distanceTo(new Vec3(target.x, target.y, target.z));
      resolve({
        success: false,
        error: 'Navigasi timeout',
        duration_ms: Date.now() - startTime,
        finalPos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
        coordinateDelta: delta
      });
    }, 120000); // Timeout 2 menit

    const onGoalReached = () => {
      clearTimeout(timeout);
      bot.removeListener('goal_reached', onGoalReached);
      bot.removeListener('path_update', onPathUpdate);

      const finalPos = bot.entity.position;
      const delta = finalPos.distanceTo(new Vec3(target.x, target.y, target.z));
      resolve({
        success: true,
        duration_ms: Date.now() - startTime,
        finalPos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
        coordinateDelta: delta
      });
    };

    const onPathUpdate = (result) => {
      if (result.status === 'noPath') {
        clearTimeout(timeout);
        bot.removeListener('goal_reached', onGoalReached);
        bot.removeListener('path_update', onPathUpdate);

        const finalPos = bot.entity.position;
        const delta = finalPos.distanceTo(new Vec3(target.x, target.y, target.z));
        resolve({
          success: false,
          error: 'Tidak ada jalur yang ditemukan',
          duration_ms: Date.now() - startTime,
          finalPos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
          coordinateDelta: delta
        });
      }
    };

    bot.pathfinder.goto(goal)
      .then(() => {
        clearTimeout(timeout);
        const finalPos = bot.entity ? bot.entity.position : new Vec3(target.x, target.y, target.z);
        const delta = finalPos.distanceTo(new Vec3(target.x, target.y, target.z));
        resolve({
          success: true,
          duration_ms: Date.now() - startTime,
          finalPos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
          coordinateDelta: delta
        });
      })
      .catch((err) => {
        clearTimeout(timeout);
        const finalPos = bot.entity ? bot.entity.position : new Vec3(0, 0, 0);
        const delta = finalPos.distanceTo(new Vec3(target.x, target.y, target.z));
        resolve({
          success: false,
          error: err.message,
          duration_ms: Date.now() - startTime,
          finalPos: { x: finalPos.x, y: finalPos.y, z: finalPos.z },
          coordinateDelta: delta
        });
      });
  });
}

/**
 * Menghentikan navigasi pathfinder yang sedang berjalan.
 * @param {Object} bot - Instance Mineflayer bot
 */
function stopNavigation(bot) {
  if (bot && bot.pathfinder) {
    try {
      bot.pathfinder.stop();
    } catch (e) {}
  }
}

/**
 * Mendapatkan posisi bot saat ini.
 * @param {Object} bot - Instance Mineflayer bot
 * @returns {Object} Posisi { x, y, z }
 */
function getPosition(bot) {
  if (!bot || !bot.entity) return { x: 0, y: 0, z: 0 };
  const pos = bot.entity.position;
  return { x: pos.x, y: pos.y, z: pos.z };
}

/**
 * Menghitung jarak Euclidean antara dua posisi 3D.
 * @param {Object} posA - Posisi { x, y, z }
 * @param {Object} posB - Posisi { x, y, z }
 * @returns {number} Jarak dalam meter
 */
function calculateDistance(posA, posB) {
  const dx = posA.x - posB.x;
  const dy = posA.y - posB.y;
  const dz = posA.z - posB.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = { navigateTo, stopNavigation, getPosition, calculateDistance };
