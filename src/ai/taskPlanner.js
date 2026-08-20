/**
 * @file taskPlanner.js
 * @description Pengatur alur kerja tugas AI Brain. Menerima tool calls dari DeepSeek AI
 * dan mengeksekusinya secara berurutan pada bot Mineflayer.
 */

const { WEAPON_COOLDOWNS_MS, AI_TASKS } = require('../config/constants');

class TaskPlanner {
  constructor(options = {}) {
    this.bot = options.bot || null;
    this.movementController = options.movementController || null;
    this.currentTask = null;
    this.taskQueue = [];
    this.isExecuting = false;
    this.eventListeners = new Map();
  }

  /**
   * Menghubungkan bot dan controller ke planner.
   * @param {Object} bot - Instance Mineflayer bot
   * @param {Object} movementController - Controller navigasi
   */
  attach(bot, movementController) {
    this.bot = bot;
    this.movementController = movementController;
  }

  /**
   * Mendaftarkan event listener.
   * @param {string} event - Nama event
   * @param {Function} callback - Fungsi callback
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  /**
   * Memicu event ke semua listener terdaftar.
   * @param {string} event - Nama event
   * @param {Object} data - Data event
   */
  emit(event, data) {
    const listeners = this.eventListeners.get(event) || [];
    for (const cb of listeners) {
      try { cb(data); } catch (e) { console.error('[TaskPlanner] Error di event listener:', e); }
    }
  }

  /**
   * Mengeksekusi daftar tool calls dari respons AI.
   * @param {Array} toolCalls - Daftar tool call dari DeepSeek
   * @returns {Promise<Array>} Hasil eksekusi setiap tool call
   */
  async executeToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

    this.isExecuting = true;
    const results = [];

    for (const call of toolCalls) {
      this.currentTask = call.name;
      this.emit('task_start', { task: call.name, args: call.arguments });

      try {
        let result;
        switch (call.name) {
          case 'navigate_to':
            result = await this._executeNavigate(call.arguments);
            break;
          case 'farm_mobs':
            result = await this._executeFarmMobs(call.arguments);
            break;
          case 'sort_chests':
            result = await this._executeSortChests(call.arguments);
            break;
          case 'incinerate_trash':
            result = await this._executeIncinerateThrash(call.arguments);
            break;
          default:
            result = { success: false, error: `Tool '${call.name}' tidak dikenali` };
        }

        results.push({ id: call.id, name: call.name, result });
        this.emit('task_complete', { task: call.name, result });
      } catch (error) {
        const errResult = { success: false, error: error.message };
        results.push({ id: call.id, name: call.name, result: errResult });
        this.emit('task_error', { task: call.name, error: error.message });
      }
    }

    this.currentTask = null;
    this.isExecuting = false;
    return results;
  }

  /**
   * Eksekusi navigasi ke koordinat target.
   * @private
   */
  async _executeNavigate(args) {
    if (!this.movementController) {
      return { success: false, error: 'MovementController belum terhubung' };
    }

    const { x, y, z, tolerance = 2 } = args;
    this.emit('task_step', { task: 'navigate_to', step: 'Memulai navigasi', target: { x, y, z } });

    const result = await this.movementController.navigateTo(this.bot, { x, y, z }, tolerance);
    return result;
  }

  /**
   * Eksekusi farming monster dengan cooldown senjata.
   * @private
   */
  async _executeFarmMobs(args) {
    if (!this.bot) return { success: false, error: 'Bot belum terhubung' };

    const { target = 'zombie', durationSeconds = 60, weapon = 'sword' } = args;
    const cooldownMs = WEAPON_COOLDOWNS_MS[weapon] || WEAPON_COOLDOWNS_MS.default;
    const endTime = Date.now() + (durationSeconds * 1000);
    let killCount = 0;

    this.emit('task_step', { task: 'farm_mobs', step: `Memulai farming ${target} selama ${durationSeconds}s` });

    while (Date.now() < endTime) {
      // Cari monster terdekat
      const mob = this.bot.nearestEntity(entity => {
        return entity.type === 'mob' && entity.name === target && entity.position.distanceTo(this.bot.entity.position) < 5;
      });

      if (mob) {
        await this.bot.lookAt(mob.position.offset(0, mob.height * 0.85, 0));
        this.bot.attack(mob);
        killCount++;
        this.emit('task_step', { task: 'farm_mobs', step: `Menyerang ${target} #${killCount}` });
      }

      // Tunggu cooldown senjata
      await new Promise(resolve => setTimeout(resolve, cooldownMs));
    }

    return { success: true, killCount, durationSeconds, target };
  }

  /**
   * Eksekusi penyortiran item ke peti.
   * @private
   */
  async _executeSortChests(args) {
    if (!this.bot) return { success: false, error: 'Bot belum terhubung' };

    const { chestCoords = [], targetCategory = 'all' } = args;
    let sortedCount = 0;

    for (const coord of chestCoords) {
      this.emit('task_step', { task: 'sort_chests', step: `Membuka peti di (${coord.x}, ${coord.y}, ${coord.z})` });

      try {
        const chestBlock = this.bot.blockAt(new (require('vec3'))(coord.x, coord.y, coord.z));
        if (!chestBlock) continue;

        const chest = await this.bot.openContainer(chestBlock);
        // Pindahkan item yang sesuai dari inventaris ke peti
        for (const item of this.bot.inventory.items()) {
          if (this._matchesCategory(item, targetCategory)) {
            try {
              await chest.deposit(item.type, null, item.count);
              sortedCount++;
            } catch (e) { /* Peti penuh atau item tidak cocok */ }
          }
        }
        chest.close();
      } catch (e) {
        console.error(`[TaskPlanner] Gagal membuka peti di (${coord.x}, ${coord.y}, ${coord.z}):`, e.message);
      }
    }

    return { success: true, sortedCount, category: targetCategory };
  }

  /**
   * Eksekusi pembakaran sampah di kolam lava/api.
   * @private
   */
  async _executeIncinerateThrash(args) {
    if (!this.bot) return { success: false, error: 'Bot belum terhubung' };

    const { hazardCoord, hazardType = 'lava', items = [] } = args;
    let burnedCount = 0;

    this.emit('task_step', { task: 'incinerate_trash', step: `Menuju kolam ${hazardType} di (${hazardCoord.x}, ${hazardCoord.y}, ${hazardCoord.z})` });

    // Navigasi ke posisi aman di dekat kolam bahaya
    if (this.movementController) {
      await this.movementController.navigateTo(this.bot, {
        x: hazardCoord.x,
        y: hazardCoord.y + 1,
        z: hazardCoord.z + 2
      }, 1.5);
    }

    // Buang item sampah ke arah bahaya
    for (const itemName of items) {
      const invItem = this.bot.inventory.items().find(i => i.name === itemName);
      if (invItem) {
        try {
          await this.bot.lookAt(new (require('vec3'))(hazardCoord.x, hazardCoord.y, hazardCoord.z));
          await this.bot.toss(invItem.type, null, invItem.count);
          burnedCount++;
          this.emit('task_step', { task: 'incinerate_trash', step: `Membuang ${itemName} x${invItem.count} ke ${hazardType}` });
        } catch (e) { /* Item tidak ada di inventaris */ }
      }
    }

    return { success: true, burnedCount, hazardType };
  }

  /**
   * Memeriksa apakah item cocok dengan kategori target.
   * @private
   */
  _matchesCategory(item, category) {
    if (category === 'all') return true;
    const name = item.name.toLowerCase();
    const categories = {
      weapons: ['sword', 'axe', 'bow', 'crossbow', 'trident'],
      armor: ['helmet', 'chestplate', 'leggings', 'boots', 'shield'],
      food: ['bread', 'steak', 'porkchop', 'chicken', 'apple', 'carrot', 'potato'],
      drops: ['rotten_flesh', 'bone', 'arrow', 'string', 'spider_eye', 'gunpowder'],
      trash: ['poisonous_potato', 'wooden_hoe', 'leather_boots', 'chainmail']
    };
    const patterns = categories[category] || [];
    return patterns.some(p => name.includes(p));
  }

  /**
   * Mengembalikan status tugas saat ini.
   */
  getStatus() {
    return {
      isExecuting: this.isExecuting,
      currentTask: this.currentTask,
      queueLength: this.taskQueue.length
    };
  }
}

module.exports = { TaskPlanner };
