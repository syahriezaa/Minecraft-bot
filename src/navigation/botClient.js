/**
 * @file botClient.js
 * @description Inisialisasi dan manajemen lifecycle bot Mineflayer untuk koneksi ke server headless.
 * Mengkonfigurasi plugin mineflayer-pathfinder dan menyediakan wrapper event.
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');

/**
 * Membuat instance bot Mineflayer yang terhubung ke server flying-squid.
 * @param {Object} [options={}] - Opsi konfigurasi bot
 * @returns {Promise<Object>} Instance bot Mineflayer yang siap digunakan
 */
async function createBot(options = {}) {
  const botOptions = {
    host: options.host || '127.0.0.1',
    port: options.port || 25567,
    username: options.username || 'CompanionBot',
    version: options.version || '1.20.1',
    auth: 'offline',
    hideErrors: true,
    checkTimeoutInterval: 30000,
    ...options
  };

  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot(botOptions);
    let resolved = false;

    // Timeout koneksi: 15 detik
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Gagal terhubung ke server ${botOptions.host}:${botOptions.port} dalam 15 detik`));
      }
    }, 15000);

    bot.once('spawn', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      // Muat plugin pathfinder
      try {
        bot.loadPlugin(pathfinder);

        // Konfigurasi pergerakan pathfinder
        const mcData = require('minecraft-data')(bot.version);
        const movements = new Movements(bot, mcData);
        movements.canDig = true;
        movements.allow1by1towers = true;
        movements.allowSprinting = true;
        movements.allowParkour = true;
        movements.scafoldingBlocks = [];
        movements.maxDropDown = 4;
        bot.pathfinder.setMovements(movements);

        // Tingkatkan timeout pathfinder agar tidak crash di server lambat
        bot.pathfinder.thinkTimeout = 30000; // 30 detik (default: 5 detik)
      } catch (e) {
        console.error('[BotClient] Gagal memuat pathfinder plugin:', e.message);
      }

      console.log(`[BotClient] Bot '${botOptions.username}' berhasil terhubung ke ${botOptions.host}:${botOptions.port}`);
      resolve(bot);
    });

    bot.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    bot.on('kicked', (reason) => {
      console.error(`[BotClient] Bot ditendang dari server: ${reason}`);
    });
  });
}

/**
 * Memutuskan koneksi bot dari server secara graceful.
 * @param {Object} bot - Instance bot Mineflayer
 * @returns {Promise<boolean>}
 */
async function disconnectBot(bot) {
  if (!bot) return true;

  return new Promise((resolve) => {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch (e) { /* Bot sudah terputus */ }

    // Pastikan socket di-unref agar tidak menahan event loop
    if (bot._client && bot._client.socket) {
      try {
        bot._client.socket.unref();
        bot._client.socket.destroy();
      } catch (e) {}
    }

    resolve(true);
  });
}

module.exports = { createBot, disconnectBot };
