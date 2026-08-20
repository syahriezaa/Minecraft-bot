/**
 * @file runSurvivalRoleBot.js
 * @description Launcher satu bot Mineflayer dengan SurvivalRoleCoordinator.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const { createBot, disconnectBot } = require('../navigation/botClient');
const { SurvivalRoleCoordinator } = require('./survivalRoleCoordinator');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { WorldAwarenessEngine, estimateChunkScanCost, chunkRadiusToBlockRadius } = require('./worldAwarenessEngine');

function parseCoord(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(v => Number(v.trim()));
  if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) {
    throw new Error(`Format koordinat tidak valid: ${raw}. Pakai "x,y,z".`);
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function parseArea(raw) {
  if (!raw) return null;
  const [minRaw, maxRaw] = String(raw).split(':');
  const min = parseCoord(minRaw);
  const max = parseCoord(maxRaw);
  if (!min || !max) {
    throw new Error(`Format area tidak valid: ${raw}. Pakai "minX,minY,minZ:maxX,maxY,maxZ".`);
  }
  return { min, max };
}

function buildOptionsFromEnv(env = process.env) {
  const killCenter = parseCoord(env.MOB_FARM_CENTER);
  return {
    host: env.MC_HOST || 'atoms-girl.tun.ply.gg',
    port: Number(env.MC_PORT || 25565),
    username: env.MC_USERNAME || 'SurvivalRoleBot',
    version: env.MC_VERSION || '26.1.2',
    coordinator: {
      tickIntervalMs: Number(env.ROLE_TICK_MS || 750),
      awareness: {
        scanProfile: env.AWARENESS_SCAN_PROFILE || 'surface',
        chunkRadius: Number(env.AWARENESS_CHUNK_RADIUS || 6),
        verticalRadius: Number(env.AWARENESS_VERTICAL_RADIUS || 8),
        verticalBelow: env.AWARENESS_VERTICAL_BELOW ? Number(env.AWARENESS_VERTICAL_BELOW) : undefined,
        verticalAbove: env.AWARENESS_VERTICAL_ABOVE ? Number(env.AWARENESS_VERTICAL_ABOVE) : undefined,
        scanBudgetBlocksPerTick: Number(env.AWARENESS_SCAN_BUDGET || 2048)
      },
      farmerOptions: {
        farmArea: parseArea(env.FARM_AREA),
        depositChest: parseCoord(env.FARM_CHEST)
      },
      animalOptions: {
        scanRadius: Number(env.ANIMAL_SCAN_RADIUS || 24)
      },
      mobFarmOptions: {
        killChamber: killCenter ? {
          center: killCenter,
          radius: Number(env.MOB_FARM_RADIUS || 8)
        } : null,
        standbyPosition: parseCoord(env.MOB_STANDBY),
        retreatPosition: parseCoord(env.MOB_RETREAT)
      }
    }
  };
}

async function main() {
  const options = buildOptionsFromEnv();
  console.log(`[SurvivalRoleBot] Menghubungkan ${options.username} ke ${options.host}:${options.port} versi ${options.version}`);

  const bot = await createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version,
    auth: 'offline'
  });

  const awareness = new WorldAwarenessEngine({
    bot,
    ...options.coordinator.awareness,
    semanticAreas: [
      options.coordinator.farmerOptions.farmArea ? { name: 'farm', ...options.coordinator.farmerOptions.farmArea } : null,
      options.coordinator.mobFarmOptions.killChamber ? {
        name: 'mob_farm',
        min: {
          x: options.coordinator.mobFarmOptions.killChamber.center.x - options.coordinator.mobFarmOptions.killChamber.radius,
          y: options.coordinator.mobFarmOptions.killChamber.center.y - 4,
          z: options.coordinator.mobFarmOptions.killChamber.center.z - options.coordinator.mobFarmOptions.killChamber.radius
        },
        max: {
          x: options.coordinator.mobFarmOptions.killChamber.center.x + options.coordinator.mobFarmOptions.killChamber.radius,
          y: options.coordinator.mobFarmOptions.killChamber.center.y + 4,
          z: options.coordinator.mobFarmOptions.killChamber.center.z + options.coordinator.mobFarmOptions.killChamber.radius
        }
      } : null
    ].filter(Boolean)
  });

  const estimate = estimateChunkScanCost(options.coordinator.awareness.chunkRadius, options.coordinator.awareness.verticalRadius * 2 + 1);
  console.log(`[SurvivalRoleBot] Awareness radius=${options.coordinator.awareness.chunkRadius} chunk (${chunkRadiusToBlockRadius(options.coordinator.awareness.chunkRadius)} block), estimasi full scan=${estimate.totalBlocks} block, budget/tick=${options.coordinator.awareness.scanBudgetBlocksPerTick}`);

  setInterval(() => {
    const result = awareness.scanAround(bot.entity.position, {
      profile: options.coordinator.awareness.scanProfile,
      verticalBelow: options.coordinator.awareness.verticalBelow,
      verticalAbove: options.coordinator.awareness.verticalAbove
    });
    if (!result.complete) {
      console.log(`[SurvivalRoleBot] Awareness partial scan ${result.scanned} block, cache=${awareness.blocks.size}`);
    }
  }, Number(process.env.AWARENESS_SCAN_INTERVAL_MS || 1000)).unref();

  const adapter = new MineflayerRoleAdapter(bot, { worldAwareness: awareness });
  const coordinator = new SurvivalRoleCoordinator({
    adapter,
    ...options.coordinator
  });

  coordinator.on('action', action => {
    if (action.action !== 'idle') {
      console.log(`[SurvivalRoleBot] role=${action.role} action=${action.action}${action.target ? ` target=${action.target}` : ''}`);
    }
  });
  coordinator.on('error', err => {
    console.error(`[SurvivalRoleBot] Error engine: ${err.message}`);
  });

  coordinator.start();

  const shutdown = async () => {
    coordinator.stop();
    await disconnectBot(bot);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[SurvivalRoleBot] Gagal start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildOptionsFromEnv,
  parseArea,
  parseCoord
};
