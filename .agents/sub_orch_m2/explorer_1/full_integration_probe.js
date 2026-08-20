const squid = require('flying-squid');
const defaultSettings = require('flying-squid/config/default-settings.json');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const { Vec3 } = require('vec3');
const { once } = require('events');
const Block = require('prismarine-block');

// Global timer interception to ensure clean test exit
const trackedTimers = new Set();
const origSetInterval = global.setInterval;
const origClearInterval = global.clearInterval;

global.setInterval = function(...args) {
  const timer = origSetInterval.apply(this, args);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
  trackedTimers.add(timer);
  return timer;
};

global.clearInterval = function(timer) {
  trackedTimers.delete(timer);
  return origClearInterval.apply(this, timer ? [timer] : []);
};

class HeadlessTestServer {
  constructor() {
    this.serverInstance = null;
    this.isRunning = false;
    this.currentOptions = null;
    this.BlockClass = null;
  }

  async startTestServer(options = {}) {
    if (this.isRunning && this.serverInstance) {
      return this.serverInstance;
    }

    const host = options.host || '127.0.0.1';
    const port = options.port !== undefined ? Number(options.port) : 25567;
    const version = options.version || '1.20.1';
    const logging = options.logging === true;

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
      worldFolder: undefined,
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

  async stopTestServer() {
    if (!this.isRunning || !this.serverInstance) {
      this.isRunning = false;
      this.serverInstance = null;
      return true;
    }

    const serv = this.serverInstance;

    if (typeof serv.stopTickInterval === 'function') {
      serv.stopTickInterval();
    }

    if (Array.isArray(serv.players)) {
      for (const player of serv.players) {
        try {
          if (player._client && player._client.socket) {
            player._client.socket.destroy();
          }
        } catch (e) {}
      }
    }

    if (serv._server && serv._server.clients) {
      for (const clientId in serv._server.clients) {
        try {
          const client = serv._server.clients[clientId];
          if (client && client.socket) {
            client.socket.destroy();
          }
        } catch (e) {}
      }
    }

    try {
      await serv.quit('Server uji headless dihentikan');
    } catch (e) {}

    if (serv._server && serv._server.socketServer) {
      try {
        serv._server.socketServer.unref();
        serv._server.socketServer.close();
      } catch (e) {}
    }

    for (const timer of trackedTimers) {
      origClearInterval(timer);
    }
    trackedTimers.clear();

    this.isRunning = false;
    this.serverInstance = null;
    return true;
  }

  isServerRunning() {
    return this.isRunning && this.serverInstance !== null && this.serverInstance.isReady === true;
  }

  async resetWorld(generationOptions = null) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const World = require('prismarine-world')(serv.registry);
    const generations = squid.generations;

    const genConfig = generationOptions || this.currentOptions.generation;
    const genName = genConfig.name || 'superflat';
    const genOpts = { ...(genConfig.options || {}), registry: serv.registry };

    const generationModule = generations[genName] ? generations[genName] : require(genName);
    serv.overworld = new World(generationModule(genOpts));
    serv.overworld.blockEntityData = {};
    serv.overworld.portals = [];
    return true;
  }

  async setBlock(x, y, z, blockNameOrId, properties = {}) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
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
      stateId = blockDef.defaultState !== undefined ? blockDef.defaultState : (blockDef.minStateId !== undefined ? blockDef.minStateId : (blockDef.id << 4));
    }

    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    await serv.setBlock(serv.overworld, pos, stateId);
    return true;
  }

  async getBlock(x, y, z) {
    if (!this.isServerRunning()) {
      throw new Error('Server uji headless belum berjalan. Panggil startTestServer() terlebih dahulu.');
    }

    const serv = this.serverInstance;
    const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const block = await serv.overworld.getBlock(pos);
    return block;
  }

  getServerInstance() {
    return this.serverInstance;
  }
}

async function runTest() {
  console.log('=== MEMULAI PENGUJIAN INTEGRASI TEST SERVER & BOT HARNESS ===');
  const server = new HeadlessTestServer();

  console.log('1. Memulai server headless pada port 25567...');
  await server.startTestServer({ port: 25567, version: '1.20.1' });
  console.log('   Server berjalan:', server.isServerRunning());

  console.log('2. Membangun platform jalan pada Y=64 dari X=0 ke X=20...');
  for (let x = -2; x <= 20; x++) {
    for (let z = -2; z <= 2; z++) {
      await server.setBlock(x, 63, z, 'stone');
      await server.setBlock(x, 64, z, 'air');
      await server.setBlock(x, 65, z, 'air');
    }
  }

  const sampleBlock = await server.getBlock(0, 63, 0);
  console.log('   Verifikasi blok lantai pada (0, 63, 0):', sampleBlock.name);

  console.log('3. Menghubungkan bot Mineflayer dengan modul Pathfinder...');
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port: 25567,
    username: 'AutonomousNavigator',
    version: '1.20.1'
  });

  bot.loadPlugin(pathfinder);

  await once(bot, 'spawn');
  console.log('   Bot berhasil spawn pada koordinat:', bot.entity.position);

  // Teleport bot ke platform (0, 64, 0)
  const playerOnServer = server.getServerInstance().getPlayer('AutonomousNavigator');
  if (playerOnServer && playerOnServer.entity) {
    playerOnServer.entity.position = new Vec3(0, 64, 0);
    playerOnServer.sendInitialPosition();
  } else {
    bot.chat('/tp 0 64 0');
  }
  await new Promise(r => setTimeout(r, 200));
  console.log('   Posisi bot setelah berpindah ke start platform:', bot.entity.position);

  const defaultMove = new Movements(bot);
  defaultMove.allowParkour = false;
  defaultMove.canDig = false;
  bot.pathfinder.setMovements(defaultMove);

  console.log('4. Mengarahkan bot bergerak menuju (10, 64, 0)...');
  await bot.pathfinder.goto(new GoalBlock(10, 64, 0));
  console.log('   Bot telah mencapai tujuan! Posisi akhir:', bot.entity.position);

  console.log('5. Menguji getBlock pada target...');
  const targetFloor = await server.getBlock(10, 63, 0);
  console.log('   Blok di bawah target:', targetFloor.name);

  console.log('6. Menghentikan bot dan server secara graceful...');
  const botEndPromise = once(bot, 'end');
  bot.quit();
  await botEndPromise;

  await server.stopTestServer();
  console.log('   Server berhenti:', !server.isServerRunning());
  console.log('=== PENGUJIAN SELESAI DENGAN SUKSES 100% ===');
}

runTest().catch(err => {
  console.error('ERROR INTEGRASI:', err);
  process.exit(1);
});
