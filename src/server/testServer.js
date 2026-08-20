/**
 * @file testServer.js
 * @description Peluncur server uji headless Minecraft in-process berbasis Node.js murni (flying-squid).
 * Berjalan tanpa dependensi Java pada port 25567, mendukung manipulasi blok dunia (setBlock, getBlock, resetWorld),
 * dan menyediakan mekanisme teardown graceful bebas kebocoran memori untuk automated test runner.
 */

const squid = require('flying-squid');
const defaultSettings = require('flying-squid/config/default-settings.json');
const Block = require('prismarine-block');
const World = require('prismarine-world');
const { Vec3 } = require('vec3');
const environment = require('../config/environment');

// Batas vertikal koordinat dunia Minecraft (1.18+)
const MIN_WORLD_Y = -64;
const MAX_WORLD_Y = 320;

// Pelacakan timer interval untuk mencegah hanging process saat testing
const activeIntervalTimers = new Set();
const nativeSetInterval = global.setInterval;
const nativeClearInterval = global.clearInterval;

// Intersepsi setInterval agar timer background (misal pembaruan latensi) tidak menahan event loop Node.js
if (!global._mcTestServerTimerHooked) {
  global.setInterval = function (...args) {
    const timer = nativeSetInterval.apply(this, args);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    activeIntervalTimers.add(timer);
    return timer;
  };

  global.clearInterval = function (timer) {
    activeIntervalTimers.delete(timer);
    return nativeClearInterval.apply(this, timer ? [timer] : []);
  };
  global._mcTestServerTimerHooked = true;
}

class HeadlessTestServer {
  constructor() {
    this.serverInstance = null;
    this.isRunning = false;
    this.currentOptions = null;
    this.BlockClass = null;
    this.port = 25567;
  }

  /**
   * Memulai server uji headless Minecraft in-process.
   * @param {Object} [options={}] - Opsi konfigurasi server
   * @returns {Promise<Object>} Instance server flying-squid yang siap
   */
  async startTestServer(options = {}) {
    // Idempotensi: jika server sudah berjalan, kembalikan instance saat ini
    if (this.isRunning && this.serverInstance) {
      return this.serverInstance;
    }

    const host = options.host || environment.minecraft?.host || '127.0.0.1';
    const port = options.port !== undefined ? Number(options.port) : (environment.minecraft?.port || 25567);
    const version = options.version || environment.minecraft?.version || '1.20.1';
    const logging = options.logging === true;

    this.port = port;
    this.BlockClass = Block(version);

    const mergedSettings = {
      ...defaultSettings,
      port,
      host,
      version,
      logging,
      'online-mode': false,
      'everybody-op': true,
      'max-players': options.maxPlayers || 10,
      'view-distance': options.viewDistance || 4,
      worldFolder: undefined, // In-memory world tanpa menulis ke file disk
      generation: options.generation || {
        name: 'superflat',
        options: {
          bottomId: 7, // bedrock
          middleId: 1, // stone
          topId: 2     // grass_block
        }
      },
      plugins: {}
    };

    this.currentOptions = mergedSettings;
    this.serverInstance = squid.createMCServer(mergedSettings);

    await this.serverInstance.waitForReady();
    this.isRunning = true;
    return this.serverInstance;
  }

  /**
   * Menghentikan server uji headless dan membersihkan seluruh socket dan timer secara graceful.
   * @returns {Promise<boolean>} Mengembalikan true jika server berhasil dihentikan
   */
  async stopTestServer() {
    // Idempotensi: jika sudah mati, selesaikan secara aman
    if (!this.isRunning || !this.serverInstance) {
      this.isRunning = false;
      this.serverInstance = null;
      return true;
    }

    const serv = this.serverInstance;

    // 1. Hentikan interval tick daylight cycle
    if (typeof serv.stopTickInterval === 'function') {
      try {
        serv.stopTickInterval();
      } catch (e) {}
    }

    // 2. Putus paksa dan unref seluruh socket pemain yang terhubung
    if (Array.isArray(serv.players)) {
      for (const player of serv.players) {
        try {
          if (player._client && player._client.socket) {
            player._client.socket.unref();
            player._client.socket.destroy();
          }
        } catch (e) {}
      }
    }

    // 3. Putus dan unref seluruh socket klien pada layer protokol minecraft
    if (serv._server && serv._server.clients) {
      for (const clientId in serv._server.clients) {
        try {
          const client = serv._server.clients[clientId];
          if (client && client.socket) {
            client.socket.unref();
            client.socket.destroy();
          }
        } catch (e) {}
      }
    }

    // 4. Tutup server flying-squid
    try {
      await serv.quit('Server uji headless dihentikan');
    } catch (e) {}

    // 5. Tutup dan unref socket listener TCP server
    if (serv._server && serv._server.socketServer) {
      try {
        serv._server.socketServer.unref();
        serv._server.socketServer.close();
      } catch (e) {}
    }

    // 6. Unref dan destroy seluruh handle Socket dan Server yang tersisa dari flying-squid / mineflayer
    if (typeof process._getActiveHandles === 'function') {
      try {
        const activeHandles = process._getActiveHandles();
        for (const handle of activeHandles) {
          if (handle && (handle.constructor.name === 'Socket' || handle.constructor.name === 'Server')) {
            if (typeof handle.unref === 'function') handle.unref();
            if (typeof handle.destroy === 'function') handle.destroy();
          }
        }
      } catch (e) {}
    }

    // 7. Bersihkan sisa timer aktif
    for (const timer of activeIntervalTimers) {
      nativeClearInterval(timer);
    }
    activeIntervalTimers.clear();

    this.isRunning = false;
    this.serverInstance = null;
    return true;
  }

  /**
   * Memeriksa status berjalan server.
   * @returns {boolean}
   */
  isServerRunning() {
    return Boolean(this.isRunning && this.serverInstance && this.serverInstance.isReady === true);
  }

  /**
   * Mereset seluruh blok dunia permainan ke generator default.
   * @param {Object} [generationOptions=null]
   * @returns {Promise<boolean>}
   */
  async resetWorld(generationOptions = null) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const WorldConstructor = World(serv.registry);
    const generations = squid.generations;

    const genConfig = generationOptions || this.currentOptions.generation;
    const genName = genConfig.name || 'superflat';
    const genOpts = { ...(genConfig.options || {}), registry: serv.registry };

    const generationModule = generations[genName] ? generations[genName] : require(genName);
    serv.overworld = new WorldConstructor(generationModule(genOpts));
    serv.overworld.blockEntityData = {};
    serv.overworld.portals = [];
    return true;
  }

  /**
   * Menempatkan blok pada koordinat dunia server.
   * @param {number} x - Koordinat X
   * @param {number} y - Koordinat Y (-64 s.d. 320)
   * @param {number} z - Koordinat Z
   * @param {string|number} blockNameOrId - Nama string atau ID angka blok
   * @param {Object} [properties={}] - Properti blok opsional (misal { facing: 'north' })
   * @returns {Promise<boolean>}
   */
  async setBlock(x, y, z, blockNameOrId, properties = {}) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    if (y < MIN_WORLD_Y || y > MAX_WORLD_Y) {
      throw new Error(`Koordinat vertikal Y=${y} di luar batas dunia Minecraft [${MIN_WORLD_Y}, ${MAX_WORLD_Y}].`);
    }

    const serv = this.serverInstance;
    const registry = serv.registry;

    let blockDef;
    if (typeof blockNameOrId === 'string') {
      blockDef = registry.blocksByName[blockNameOrId];
      if (!blockDef) {
        throw new Error(`Nama blok '${blockNameOrId}' tidak ditemukan dalam registri Minecraft versi ${registry.version.minecraftVersion}.`);
      }
    } else if (typeof blockNameOrId === 'number') {
      blockDef = registry.blocks[blockNameOrId];
      if (!blockDef) {
        throw new Error(`ID blok '${blockNameOrId}' tidak ditemukan dalam registri Minecraft versi ${registry.version.minecraftVersion}.`);
      }
    } else {
      throw new Error('Argumen blockNameOrId harus berupa string nama blok atau nomor ID blok.');
    }

    let stateId;
    if (properties && Object.keys(properties).length > 0 && this.BlockClass) {
      const blockObj = this.BlockClass.fromProperties(blockDef.id, properties, 0);
      stateId = blockObj.stateId;
    } else {
      stateId = blockDef.defaultState !== undefined
        ? blockDef.defaultState
        : (blockDef.minStateId !== undefined ? blockDef.minStateId : (blockDef.id << 4));
    }

    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    await serv.overworld.setBlockStateId(pos, stateId);

    // Kirim notifikasi perubahan blok ke bot/pemain jika ada yang sedang terhubung
    if (Array.isArray(serv.players) && serv.players.length > 0) {
      for (const player of serv.players) {
        if (player.world === serv.overworld && typeof player.sendBlock === 'function') {
          try {
            player.sendBlock(pos, stateId);
          } catch (e) {}
        }
      }
    }
    return true;
  }

  /**
   * Mengambil data blok pada koordinat dunia server.
   * @param {number} x - Koordinat X
   * @param {number} y - Koordinat Y (-64 s.d. 320)
   * @param {number} z - Koordinat Z
   * @returns {Promise<Object>} Objek blok PrismarineBlock
   */
  async getBlock(x, y, z) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    if (y < MIN_WORLD_Y || y > MAX_WORLD_Y) {
      throw new Error(`Koordinat vertikal Y=${y} di luar batas dunia Minecraft [${MIN_WORLD_Y}, ${MAX_WORLD_Y}].`);
    }

    const serv = this.serverInstance;
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = await serv.overworld.getBlock(pos);
    return block;
  }

  /**
   * Memindahkan (teleportasi) bot/pemain ke posisi target.
   * @param {string} username - Nama pemain atau bot
   * @param {number} x - Koordinat X
   * @param {number} y - Koordinat Y
   * @param {number} z - Koordinat Z
   * @returns {Promise<boolean>}
   */
  async teleportPlayer(username, x, y, z) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const player = serv.getPlayer(username);
    if (!player) {
      throw new Error(`Pemain atau bot '${username}' tidak ditemukan di server.`);
    }

    const targetVec = new Vec3(x, y, z);
    player.entity.position = targetVec;
    if (typeof player.sendInitialPosition === 'function') {
      player.sendInitialPosition();
    }
    return true;
  }

  /**
   * Mengembalikan instans server flying-squid yang mendasari untuk inspeksi langsung.
   * @returns {Object|null}
   */
  getServerInstance() {
    return this.serverInstance;
  }
}

// Instans Singleton bawaan untuk pemanggilan mudah lintas modul
const defaultServerInstance = new HeadlessTestServer();

module.exports = {
  HeadlessTestServer,
  startTestServer: (opts) => defaultServerInstance.startTestServer(opts),
  stopTestServer: () => defaultServerInstance.stopTestServer(),
  isServerRunning: () => defaultServerInstance.isServerRunning(),
  resetWorld: (opts) => defaultServerInstance.resetWorld(opts),
  setBlock: (x, y, z, nameOrId, props) => defaultServerInstance.setBlock(x, y, z, nameOrId, props),
  getBlock: (x, y, z) => defaultServerInstance.getBlock(x, y, z),
  teleportPlayer: (username, x, y, z) => defaultServerInstance.teleportPlayer(username, x, y, z),
  getServerInstance: () => defaultServerInstance.getServerInstance()
};
