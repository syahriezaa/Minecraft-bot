/** Worker pondasi; penggalian awal hanya melalui mode eksplisit di luar footprint aktif. */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { claimExternalRoleTask } = require('./externalRoleTask');
const { walkToBase, buildMovements } = require('./walkToBase');
const { createStorageRoomBlueprint } = require('./storageRoomBlueprint');
const { StorageRoomLandscaper, NATURAL_NAMES } = require('./storageRoomLandscaper');
const { prepareStorageRoomTools } = require('./storageRoomToolPreparation');
const { auditStorageRoomSupport, maintainStorageRoomSupport, overlapsRelocatedFootprint, LANDSCAPE_DIRT_SOURCE } = require('./storageRoomSupportAudit');

const BASE = { x: -185, y: 71, z: -352 };
const FOOD_SOURCE = { x: -180, y: 72, z: -348 };
const LANDSCAPE_SOURCE = LANDSCAPE_DIRT_SOURCE;
const FOOD_NAMES = ['cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread', 'baked_potato'];

function parseOrigin(raw = process.env.STORAGE_ROOM_ORIGIN) {
  if (!raw) throw new Error('STORAGE_ROOM_ORIGIN wajib diberikan untuk landscaping.');
  const values = raw.split(',').map(Number);
  if (values.length !== 3 || !values.every(Number.isInteger)) throw new Error('STORAGE_ROOM_ORIGIN harus berbentuk x,y,z integer.');
  return { x: values[0], y: values[1], z: values[2] };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withSharedLock(lockPath, action, log) {
  if (!lockPath) return action();
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      const heartbeat = setInterval(() => fs.utimes(lockPath, new Date(), new Date()).catch(() => {}), 15000);
      try { return await action(); } finally {
        clearInterval(heartbeat);
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 180000) await fs.rm(lockPath, { recursive: true, force: true });
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      log('Landscaper menunggu worker lain selesai memakai chest sumber...');
      await sleep(2000);
    }
  }
}

async function prepareTools({ adapter, plan, execute = false, sourceDistance, sourceSearchCount,
  lockPath = 'data/storage-room-restock.lock', log = () => {} }) {
  if (!execute || !plan?.columns?.some(column => column.clear?.length)) return { ready: true, skipped: true };
  if (['unknown', 'liquid', 'blocked', 'height_limit'].some(name => plan.summary[name])) return { ready: false, reason: 'unsafe_plan' };
  return withSharedLock(lockPath, () => prepareStorageRoomTools({ adapter, execute: true, sourceDistance, sourceSearchCount, log }), log);
}

function createExcavationAdapter(adapter, plan, origin, blueprint) {
  const guarded = Object.create(adapter);
  const allowed = new Map(plan.columns.flatMap(column => column.clear.map(pos => [
    `${pos.x},${pos.y},${pos.z}`, adapter.blockAt(pos)?.name
  ])));
  guarded.dig = async block => {
    const pos = block?.position;
    if (!pos || overlapsRelocatedFootprint(origin, blueprint) || pos.x < origin.x || pos.x >= origin.x + blueprint.dimensions.width ||
      pos.z < origin.z || pos.z >= origin.z + blueprint.dimensions.depth || pos.y < origin.y) return false;
    const name = allowed.get(`${pos.x},${pos.y},${pos.z}`);
    if (!name || !NATURAL_NAMES.has(name) || /torch|^cobblestone$|^cobbled_deepslate$/.test(name)) return false;
    if (!await adapter.navigateNear(pos, 3)) return false;
    const live = adapter.blockAt(pos);
    if (live?.name !== name) return false;
    const tool = await adapter.equipBestToolForBlock(live);
    if (live.boundingBox !== 'empty' && (!tool || adapter.getItemCount(tool) < 1)) {
      throw new Error(`Penggalian ${name} ditolak: tool yang sesuai tidak tersedia.`);
    }
    await adapter.bot.dig(live);
    return true;
  };
  return guarded;
}

async function waitForChunks(bot, log) {
  let timer;
  try {
    await Promise.race([
      bot.waitForChunksToLoad(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('chunk landscaping belum siap')), 15000); })
    ]);
    await sleep(1000);
  } finally {
    clearTimeout(timer);
  }
}

async function restock({ adapter, bot, origin, fillMaterial, lockPath, sourceDistance, sourceSearchCount, log }) {
  const result = await withSharedLock(lockPath, async () => {
    let withdrawn = 0;
    let foodWithdrawn = 0;
    let dirtSource = LANDSCAPE_SOURCE;
    try {
      const direct = await adapter.withdrawFromChest(dirtSource, [fillMaterial], 2304);
      withdrawn = direct.withdrawn;
    } catch (error) {
      log(`Sumber material utama landscaping gagal: ${error.message}`);
      withdrawn = 0;
    }
    if (withdrawn === 0) {
      // Pencarian isi chest adalah fallback saja; navigasi ke 160 container dapat menahan worker
      // berulang kali pada chest yang terkubur/tidak terjangkau.
      dirtSource = await adapter.findMatchingChest([fillMaterial], { maxDistance: sourceDistance, count: sourceSearchCount });
      if (dirtSource) {
        const dirt = await adapter.withdrawFromChest(dirtSource, [fillMaterial], 2304);
        withdrawn = dirt.withdrawn;
      }
    }
    if (withdrawn > 0) {
      log(`Restock landscaping: ${withdrawn} ${fillMaterial} dari peti (${dirtSource.x},${dirtSource.y},${dirtSource.z}).`);
    } else {
      log(`Material landscaping ${fillMaterial} tidak ditemukan di peti sumber.`);
    }
    if ((bot.food ?? 20) < 18) {
      const food = await adapter.withdrawFromChest(FOOD_SOURCE, FOOD_NAMES, 32);
      foodWithdrawn = food.withdrawn;
      for (let bites = 0; bites < 16 && (bot.food ?? 20) < 18; bites += 1) {
        if (!await adapter.eatBestFood(FOOD_NAMES)) break;
      }
    }
    return { withdrawn, foodWithdrawn };
  }, log);
  if (result.withdrawn === 0 && adapter.getItemCount(fillMaterial) === 0) return false;
  return true;
}

function startStorageRoomLandscaper({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'StorageLand2',
  origin = parseOrigin(),
  execute = process.env.STORAGE_ROOM_EXECUTE === '1',
  skipBaseWalk = process.env.STORAGE_LANDSCAPE_SKIP_BASE === '1',
  maxRetries = Number(process.env.STORAGE_LANDSCAPE_MAX_RETRIES) || 20,
  pauseDelayMs = Number(process.env.STORAGE_LANDSCAPE_PAUSE_DELAY_MS) || 3000,
  checkpointFile = process.env.STORAGE_LANDSCAPE_CHECKPOINT || 'data/storage-room-landscape.json',
  restockLockPath = process.env.STORAGE_ROOM_RESTOCK_LOCK || 'data/storage-room-restock.lock',
  supportOnly = process.env.STORAGE_LANDSCAPE_SUPPORT_ONLY !== '0',
  supportAuditFile = process.env.STORAGE_LANDSCAPE_SUPPORT_AUDIT || 'data/storage-room-support-audit.json',
  fillMaterial = process.env.STORAGE_LANDSCAPE_FILL_MATERIAL || 'dirt',
  sourceDistance = Number(process.env.STORAGE_ROOM_SOURCE_DISTANCE) || 128,
  sourceSearchCount = Number(process.env.STORAGE_LANDSCAPE_SOURCE_SEARCH_COUNT) || 32,
  placementAttempts = Number(process.env.STORAGE_LANDSCAPE_PLACEMENT_ATTEMPTS) || 2,
  placementRetryDelayMs = Number(process.env.STORAGE_LANDSCAPE_PLACEMENT_RETRY_DELAY_MS) || 500,
  placementBackoffMs = Number(process.env.STORAGE_LANDSCAPE_PLACEMENT_BACKOFF_MS) || 750,
  maxRunMs = Number(process.env.STORAGE_LANDSCAPE_MAX_RUN_MS) || 450000,
  log = message => console.log(message)
} = {}) {
  const username = String(botName).slice(0, 16);
  const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
  if (overlapsRelocatedFootprint(origin, blueprint)) {
    if (origin.y !== 70) throw new Error('Footprint aktif wajib mempertahankan pondasi Y69 dan lantai Y70.');
    supportOnly = true;
  }
  if (!restockLockPath) throw new Error('Lock sumber bersama wajib diberikan.');
  if (!Number.isFinite(maxRunMs) || maxRunMs <= 0 || maxRunMs > 480000) throw new Error('Batas sesi wajib 1..480000ms.');
  log(`Menghubungkan landscaper ${username} ke ${host}:${port}...`);
  const bot = mineflayer.createBot({ host, port, username, version: process.env.MC_REMOTE_VERSION || '26.1', auth: 'offline', plugins: { time: false } });
  let finished = false;
  let spawnTimer;
  let runTimer;
  let roleTask = null;
  const reportWork = (phase, extra = {}) => {
    const details = { phase, ...extra };
    log(`WORK_EVENT ${JSON.stringify(details)}`);
    roleTask?.reportProgress(details);
  };
  const finish = (code, verification = null) => {
    if (finished) return;
    finished = true;
    if (roleTask) {
      if (code === 0 && verification) roleTask.complete({ exitCode: code, role: 'landscaper', verification });
      else roleTask.defer(`PROCESS_EXIT_${code}`, 5000);
      roleTask = null;
    }
    clearTimeout(spawnTimer);
    clearTimeout(runTimer);
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates();
    bot.quit();
    setTimeout(() => process.exit(code), 250);
  };
  const spawnTimeoutMs = Number(process.env.STORAGE_ROOM_SPAWN_TIMEOUT_MS) || 30000;
  spawnTimer = setTimeout(() => {
    if (finished) return;
    log(`STOP landscaping: event spawn tidak diterima setelah ${spawnTimeoutMs}ms.`);
    finish(2);
  }, spawnTimeoutMs);
  if (maxRunMs > 0) runTimer = setTimeout(() => {
    log('STOP landscaping: batas sesi tercapai; checkpoint dipertahankan.');
    finish(2);
  }, maxRunMs);
  bot.once('spawn', async () => {
    clearTimeout(spawnTimer);
    if (finished) return;
    try {
      bot.loadPlugin(pathfinder);
      bot.pathfinder.setMovements(buildMovements(bot, { allowTerrainWork: false, allow1by1Towers: false }));
      bot.pathfinder.thinkTimeout = 30000;
      const adapter = new MineflayerRoleAdapter(bot, { log, capabilities: ['landscape', 'access', 'survey'] });
      roleTask = claimExternalRoleTask(adapter, { taskTypes: ['LANDSCAPE_SITE'], capabilities: ['landscape'],
        stallTimeoutMs: 9 * 60 * 1000, log });
      log(`Spawn landscaper di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
      if (supportOnly) {
        await waitForChunks(bot, log);
        let audit = auditStorageRoomSupport({ adapter, origin, blueprint });
        if (audit.summary.unknown || audit.summary.floorUnknown) {
          const center = { x: origin.x + Math.floor(blueprint.dimensions.width / 2), y: origin.y,
            z: origin.z + Math.floor(blueprint.dimensions.depth / 2) };
          const arrival = await walkToBase({ bot, goal: center, range: 4, maxGotoMs: 45000, minimumY: 69,
            allowTerrainWork: false, allow1by1Towers: false, scaffoldingBlocks: [], log });
          if (!arrival.success) { log(`Audit pondasi: perjalanan tidak selesai (${arrival.reason}).`); }
          await waitForChunks(bot, log);
        }
        const result = await maintainStorageRoomSupport({ adapter, origin, blueprint, execute, log,
          restockDirt: async count => {
            const withdrawn = await withSharedLock(restockLockPath, async () => {
              const before = adapter.getItemCount('dirt');
              await adapter.withdrawFromChest(LANDSCAPE_SOURCE, ['dirt'], count);
              return Math.max(0, adapter.getItemCount('dirt') - before);
            }, log);
            const arrival = await walkToBase({ bot, goal: origin, range: 4, maxGotoMs: 45000, minimumY: 69,
              allowTerrainWork: false, allow1by1Towers: false, scaffoldingBlocks: [], log });
            if (!arrival.success) throw new Error('Gagal kembali ke pondasi setelah restock dirt.');
            await waitForChunks(bot, log);
            return withdrawn;
          }
        });
        result.connection = { username, host, port, version: bot.version, protocol: bot._client.protocolVersion };
        result.position = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
        result.movement = { canDig: bot.pathfinder.movements.canDig, allow1by1towers: bot.pathfinder.movements.allow1by1towers };
        await fs.mkdir(path.dirname(supportAuditFile), { recursive: true });
        await fs.writeFile(supportAuditFile, `${JSON.stringify(result, null, 2)}\n`);
        log(`SUPPORT_AUDIT ${JSON.stringify({ summary: result.final.summary, supportBlocks: result.final.supportBlocks,
          floorBlocks: result.final.floorBlocks, repairs: result.repairs, skipped: result.skipped, file: supportAuditFile })}`);
        reportWork(result.final.ok ? 'COMPLETE' : 'BLOCKED', {
          verifiedBlocks: Number(result.repairs) || 0,
          reason: result.final.ok ? undefined : 'SUPPORT_AUDIT_FAILED'
        });
        finish(result.final.ok ? 0 : 2, result.final.ok ? {
          status: 'VERIFIED', observedAt: Date.now(),
          checks: [{ name: 'support_audit', passed: true, expected: true, actual: result.final.ok }]
        } : null);
        return;
      }
      if (!skipBaseWalk) {
        const baseWalk = await walkToBase({ bot, goal: BASE, range: 4, settleMs: 2000, minimumY: 58, allowTerrainWork: false, allow1by1Towers: false, log });
        if (!baseWalk.success) { log(`STOP landscaping: gagal ke base (${baseWalk.reason})`); finish(2); return; }
      }
      await waitForChunks(bot, log);
      const landscaper = new StorageRoomLandscaper({
        bot, adapter, origin, blueprint, checkpointFile,
        options: { targetY: origin.y, fillMaterial, placementAttempts, placementRetryDelayMs, placementBackoffMs, log }
      });
      const worksite = { x: origin.x - 3, y: origin.y + 1, z: origin.z - 2 };
      const firstWorksite = await walkToBase({ bot, goal: worksite, range: 4, maxGotoMs: 45000, minimumY: 58, allowTerrainWork: false, allow1by1Towers: false, log });
      if (!firstWorksite.success) { log(`STOP landscaping: gagal menuju worksite (${firstWorksite.reason})`); finish(2); return; }
      await waitForChunks(bot, log);
      const initialPlan = landscaper.map();
      log(`Peta landscaping: ${JSON.stringify(initialPlan.summary)}`);
      const blockers = initialPlan.columns.filter(column => column.status !== 'OK').slice(0, 12).map(column => ({
        relative: column.relative,
        absolute: { x: origin.x + column.relative.x, z: origin.z + column.relative.z },
        status: column.status,
        surfaceY: column.surfaceY
      }));
      if (blockers.length) log(`Detail blocker landscaping: ${JSON.stringify(blockers)}`);
      if (initialPlan.summary.unknown || initialPlan.summary.liquid || initialPlan.summary.blocked || initialPlan.summary.height_limit) {
        log('STOP landscaping: area belum aman untuk diratakan; tidak ada mutasi dunia dilakukan.');
        finish(2);
        return;
      }
      if (!execute) {
        log('Mode observasi landscaping: tidak ada penggalian atau pengisian.');
        reportWork('COMPLETE', { verifiedBlocks: 0, reason: 'OBSERVE_ONLY' });
        finish(0);
        return;
      }
      const toolResult = await prepareTools({ adapter, plan: initialPlan, execute, sourceDistance, sourceSearchCount, lockPath: restockLockPath, log });
      if (!toolResult.ready) { log(`STOP landscaping: tool belum siap (${toolResult.reason}).`); finish(2); return; }
      landscaper.adapter = createExcavationAdapter(adapter, initialPlan, origin, blueprint);
      if (!toolResult.skipped) {
        const returned = await walkToBase({ bot, goal: worksite, range: 4, maxGotoMs: 45000, minimumY: 58,
          allowTerrainWork: false, allow1by1Towers: false, log });
        if (!returned.success) { log(`STOP landscaping: gagal kembali dari persiapan tool (${returned.reason}).`); finish(2); return; }
        await waitForChunks(bot, log);
      }
      let retries = 0;
      let result = await landscaper.build();
      log(`Hasil landscaping: ${JSON.stringify({ status: result.status, completed: result.completed, actions: result.actions, summary: result.plan?.summary, reason: result.reason })}`);
      reportWork(result.status === 'COMPLETE' ? 'COMPLETE' : result.status === 'BLOCKED' ? 'BLOCKED' : 'BUILD', {
        verifiedBlocks: Number(result.completed) || 0,
        reason: result.reason || undefined
      });
      while (result.status !== 'COMPLETE' && retries < maxRetries) {
        retries += 1;
        if (result.status === 'BLOCKED') { finish(2); return; }
        await sleep(pauseDelayMs);
        const baseWalk = await walkToBase({ bot, goal: BASE, range: 4, maxGotoMs: 45000, minimumY: 58, allowTerrainWork: false, allow1by1Towers: false, log });
        if (!baseWalk.success) { log(`STOP landscaping: gagal restock ke base (${baseWalk.reason})`); finish(2); return; }
        const restocked = await restock({ adapter, bot, origin, fillMaterial, lockPath: restockLockPath, sourceDistance, sourceSearchCount, log });
        if (!restocked && adapter.getItemCount(fillMaterial) === 0) {
          log(`STOP landscaping: ${fillMaterial} habis/tidak ditemukan setelah ${retries} percobaan.`);
          finish(2);
          return;
        }
        const returned = await walkToBase({ bot, goal: worksite, range: 4, maxGotoMs: 45000, minimumY: 58, allowTerrainWork: false, allow1by1Towers: false, log });
        if (!returned.success) { log(`STOP landscaping: gagal kembali ke worksite (${returned.reason})`); finish(2); return; }
        result = await landscaper.build();
        log(`Hasil landscaping retry ${retries}: ${JSON.stringify({ status: result.status, completed: result.completed, actions: result.actions, reason: result.reason })}`);
        reportWork(result.status === 'COMPLETE' ? 'COMPLETE' : result.status === 'BLOCKED' ? 'BLOCKED' : 'BUILD', {
          verifiedBlocks: Number(result.completed) || 0,
          reason: result.reason || undefined
        });
      }
      if (result.status === 'COMPLETE') {
        log('LANDSCAPE_READY: seluruh kolom area gudang sudah rata dan terverifikasi.');
        finish(0, {
          status: 'VERIFIED', observedAt: Date.now(),
          checks: [{ name: 'landscape_columns', passed: true, expected: 0, actual: result.plan?.summary?.blocked || 0 },
            { name: 'landscape_complete', passed: true, expected: 'COMPLETE', actual: result.status }]
        });
      } else {
        log(`STOP landscaping: retry maksimum tercapai (${maxRetries}).`);
        finish(2);
      }
    } catch (error) {
      if (!finished) { log(`STOP landscaping: ${error.stack || error.message}`); finish(2); }
    }
  });
  bot.on('error', error => log(`ERROR landscaping: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK landscaping: ${JSON.stringify(reason)}`));
  bot.on('end', () => { if (!finished) { log('Koneksi landscaping berakhir sebelum selesai.'); finish(2); } });
  return bot;
}

module.exports = { startStorageRoomLandscaper, parseOrigin, withSharedLock, prepareTools, createExcavationAdapter };

if (require.main === module) {
  try { startStorageRoomLandscaper(); } catch (error) { console.error(`GAGAL memulai landscaper: ${error.message}`); process.exitCode = 2; }
}
