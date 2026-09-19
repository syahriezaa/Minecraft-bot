const { Vec3 } = require('vec3');
const { SharedWorldMemory } = require('./sharedWorldMemory');
const { SwarmReservations } = require('./swarmReservations');
const { installCoordinatedActions } = require('./coordinatedActions');
const { analyzeSpatialRegion } = require('./semanticSpatialAnalysis');
const { StructureRegistry } = require('./structureRegistry');
const { SwarmTaskBoard } = require('./swarmTaskBoard');
const attached = new WeakMap();

function worldContext(bot) {
  const connection = bot?._client?.options;
  const socket = bot?._client?.socket;
  const host = connection?.host || socket?._host || socket?.remoteAddress;
  const port = connection?.port || socket?.remotePort || 25565;
  const world = process.env.MC_WORLD_ID || (host ? `${host}:${port}` : null);
  const dimension = bot?.game?.dimension;
  return world && typeof dimension === 'string' ? { world, dimension } : null;
}

function attachSharedWorldObserver(bot, {
  store,
  log = () => {},
  intervalMs = Number(process.env.SHARED_WORLD_OBSERVER_INTERVAL_MS) || 10000,
  sampleRadius = Number(process.env.SHARED_WORLD_SAMPLE_RADIUS) || 2,
  sampleBelow = Number(process.env.SHARED_WORLD_SAMPLE_BELOW) || 2,
  sampleAbove = Number(process.env.SHARED_WORLD_SAMPLE_ABOVE) || 3,
  coordinateMovement = true,
  spatialSampling = true,
  occupancyIntervalMs = 500,
  flushIntervalMs = 1000,
  agent = null
} = {}) {
  if (!bot?.on || typeof bot.blockAt !== 'function') return null;
  if (attached.has(bot)) return attached.get(bot);
  if (!store && (!bot._client || process.env.SHARED_WORLD_ENABLED === 'false')) return null;
  let memory;
  try { memory = store || new SharedWorldMemory(); }
  catch (error) { log(`Memori dunia tidak aktif: ${error.message}`); return null; }
  const reservations = new SwarmReservations(memory);
  const structures = new StructureRegistry(memory);
  const taskBoard = new SwarmTaskBoard(memory);
  // Kunci aksi objek tetap aktif untuk semua role. Koordinasi koridor gerak
  // dapat dimatikan tanpa ikut menonaktifkan kunci pohon, blok, dan container.
  const actions = installCoordinatedActions(bot, reservations, () => worldContext(bot), log, { coordinateMovement });
  let pending = new Map();
  let stopped = false;
  let lastErrorAt = 0;
  let lastAnalysisAt = 0;
  let agentRegistered = false;
  const ensureAgent = () => {
    const context = worldContext(bot);
    if (!agent || !context) return null;
    if (!agentRegistered) {
      try {
        taskBoard.registerAgent({ id: agent.id || bot.username || 'worker', ...context,
          capabilities: agent.capabilities || ['generic'], metadata: agent.metadata || {} });
        agentRegistered = true;
      } catch (error) {
        report(error);
        return null;
      }
    }
    return context;
  };
  const heartbeatAgent = status => {
    const context = ensureAgent();
    if (!context) return;
    const position = bot.entity?.position;
    try {
      taskBoard.heartbeatAgent(agent.id || bot.username || 'worker', {
        ...context,
        status,
        position: position ? { x: position.x, y: position.y, z: position.z } : null,
        snapshot: {
          health: bot.health ?? null,
          food: bot.food ?? null,
          inventoryFreeSlots: typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null
        }
      });
    } catch (error) { report(error); }
  };
  const report = error => {
    if (Date.now() - lastErrorAt > 30000) {
      log(`Pembaruan memori dunia tertunda: ${error.message}`);
      lastErrorAt = Date.now();
    }
  };

  function observe(block) {
    if (stopped || !block?.position || !block.name) return;
    const context = worldContext(bot);
    if (!context) return;
    const { x, y, z } = block.position;
    if (![x, y, z].every(Number.isInteger)) return;
    const key = JSON.stringify([context.world, context.dimension, x, y, z]);
    // Salin nilai sekarang: objek Mineflayer dapat berubah sebelum flush berikutnya.
    pending.set(key, { ...context, observedAt: Date.now(), block: {
      name: block.name, position: { x, y, z },
      properties: typeof block.getProperties === 'function' ? block.getProperties() : {}
    } });
    if (pending.size >= 2048) flush();
    if (pending.size > 4096) pending.delete(pending.keys().next().value);
  }

  function flush() {
    if (!pending.size) return;
    const groups = new Map();
    for (const row of pending.values()) {
      const key = JSON.stringify([row.world, row.dimension, row.observedAt]);
      if (!groups.has(key)) groups.set(key, { world: row.world, dimension: row.dimension,
        observedAt: row.observedAt, observer: bot.username || 'worker', blocks: [] });
      groups.get(key).blocks.push(row.block);
    }
    try {
      for (const group of groups.values()) {
        memory.observe(group);
        structures.observe(group,group.blocks);
      }
      pending = new Map();
    } catch (error) { report(error); }
  }

  function sample() {
    const p = bot.entity?.position;
    if (!p || !worldContext(bot)) return;
    try {
      heartbeatAgent('ONLINE');
      const radius = Math.max(1, Math.min(4, Math.floor(sampleRadius)));
      const below = Math.max(0, Math.min(4, Math.floor(sampleBelow)));
      const above = Math.max(1, Math.min(5, Math.floor(sampleAbove)));
      const blocks = [];
      // Default 5 x 6 x 5 = 150 blok per siklus. Ini tetap spatial 3D, tetapi
      // tidak membuat setiap worker berebut lock SQLite dengan batch 567 blok.
      for (let x = -radius; x <= radius; x++) for (let y = -below; y <= above; y++) for (let z = -radius; z <= radius; z++) {
        const block = bot.blockAt(new Vec3(Math.floor(p.x) + x, Math.floor(p.y) + y, Math.floor(p.z) + z));
        observe(block);
        if (block) blocks.push(block);
      }
      flush();
      if (Date.now()-lastAnalysisAt >= 15000) {
        const bounds = { min: { x: Math.floor(p.x)-radius, y: Math.floor(p.y)-below, z: Math.floor(p.z)-radius },
          max: { x: Math.floor(p.x)+radius+1, y: Math.floor(p.y)+above+1, z: Math.floor(p.z)+radius+1 } };
        memory.saveAnalysis({ ...worldContext(bot), observer: bot.username || 'worker' },
          analyzeSpatialRegion({ blocks, bounds, entities: Object.values(bot.entities || {}) }));
        lastAnalysisAt = Date.now();
      }
    } catch (error) { report(error); }
  }
  const crops=new Set(['wheat','carrots','potatoes','beetroots','nether_wart']);
  const onUpdate = (oldBlock, newBlock) => {
    observe(newBlock);
    if(!oldBlock||!newBlock||oldBlock.name===newBlock.name)return;
    try {
      if(crops.has(oldBlock.name)&&['air','cave_air'].includes(newBlock.name))memory.recordActivity(worldContext(bot),'crop_removed',newBlock.position);
      if(crops.has(newBlock.name)&&['air','cave_air'].includes(oldBlock.name))memory.recordActivity(worldContext(bot),'crop_planted',newBlock.position);
    } catch(error) {report(error);}
  };
  const timer = spatialSampling ? setInterval(sample, intervalMs) : null;
  timer?.unref?.();
  const occupancyTimer = setInterval(() => {
    const p=bot.entity?.position;
    if(!p || stopped) return;
    try { reservations.occupy(worldContext(bot),[p,{x:p.x,y:Math.floor(p.y)+1,z:p.z}]); }
    catch(error) { report(error); }
  }, Math.max(500, Number(occupancyIntervalMs) || 500));
  occupancyTimer.unref?.();
  const flushTimer = spatialSampling ? null : setInterval(flush, Math.max(250, Number(flushIntervalMs) || 1000));
  flushTimer?.unref?.();
  function stop() {
    if (stopped) return;
    heartbeatAgent('STOPPED');
    if (timer) clearInterval(timer);
    clearInterval(occupancyTimer);
    if (flushTimer) clearInterval(flushTimer);
    bot.removeListener('blockUpdate', onUpdate);
    bot.removeListener('end', stop);
    flush();
    stopped = true;
    actions?.close();
    reservations.close();
    if (!store) memory.close();
    attached.delete(bot);
  }
  bot.on('blockUpdate', onUpdate);
  bot.once('end', stop);
  ensureAgent();
  const observer = { observe, flush, sample, stop, memory, reservations, actions, structures, taskBoard,
    spatialSampling: Boolean(spatialSampling) };
  attached.set(bot, observer);
  return observer;
}

module.exports = { attachSharedWorldObserver, worldContext };
