/** Memperbaiki pasangan chest storage room yang terpasang sebagai single/menghadap salah. */
const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { buildMovements, walkToBase } = require('./walkToBase');
const { createStorageRoomBlueprint } = require('./storageRoomBlueprint');
const { supplyStorageMaterial } = require('./storageRoomMaterials');
const { withStorageLock } = require('./storageRoomLock');

const BASE = { x: -185, y: 71, z: -352 };

function parsePosition(raw, fallback) {
  const values = String(raw || '').split(',').map(Number);
  return values.length === 3 && values.every(Number.isInteger)
    ? { x: values[0], y: values[1], z: values[2] }
    : { ...fallback };
}

function properties(block) {
  return typeof block?.getProperties === 'function'
    ? block.getProperties() || {}
    : block?.properties || block?._properties || {};
}

function pairIsCorrect(left, right, pair) {
  const leftProps = properties(left);
  const rightProps = properties(right);
  return left?.name === 'chest' && right?.name === 'chest' &&
    leftProps.type === (pair.left.properties?.type || 'left') &&
    rightProps.type === (pair.right.properties?.type || 'right') &&
    leftProps.facing === (pair.left.properties?.facing || 'north') &&
    rightProps.facing === (pair.right.properties?.facing || 'north');
}

async function waitForAir(adapter, pos, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const block = adapter.blockAt(pos);
    if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function removeChest({ bot, adapter, pos, approachPos = pos, log }) {
  const block = adapter.blockAt(pos);
  if (!block || block.name !== 'chest') return true;
  if (!await adapter.navigateNear(approachPos, 3)) return false;
  // Adapter.dig menginjak posisi drop setelah menggali; bot.dig langsung
  // meninggalkan item chest di tanah dan membuat repair tampak kehabisan stok.
  if (typeof adapter.dig === 'function') {
    // Ambil kembali chest kosong yang dibongkar. Repair tidak boleh membuat
    // pasangan kehilangan stok hanya karena item drop tertinggal di lantai.
    if (!await adapter.dig(block, { collectDrops: true })) return false;
  } else await bot.dig(block);
  const removed = await waitForAir(adapter, pos);
  if (!removed) log(`Chest repair: blok di (${pos.x},${pos.y},${pos.z}) belum hilang setelah digali.`);
  return removed;
}

async function chestIsEmpty(adapter, pos) {
  if (typeof adapter.getChestContents !== 'function') return false;
  const items = await adapter.getChestContents(pos, { verify: false });
  return items.length === 0;
}

async function placeChest({ bot, adapter, pos, approachPos = pos, log }) {
  const below = adapter.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
  if (!below || below.boundingBox !== 'block') return false;
  if (!await adapter.navigateNear(approachPos, 3)) return false;
  if (!await adapter.equipItem('chest', 'hand')) return false;
  await adapter.placeBlockAt(pos, below, new Vec3(0, 1, 0), { facing: 'north' });
  const placed = adapter.blockAt(pos);
  if (placed?.name !== 'chest') {
    log(`Chest repair: placement tidak terkonfirmasi di (${pos.x},${pos.y},${pos.z}).`);
    return false;
  }
  return true;
}

function startStorageRoomChestRepair({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'ChestRepair',
  origin = parsePosition(process.env.STORAGE_ROOM_ORIGIN, { x: -110, y: 70, z: -400 }),
  maxPairs = Number(process.env.STORAGE_ROOM_CHEST_REPAIR_MAX_PAIRS) || 260,
  targetIds = String(process.env.STORAGE_ROOM_CHEST_REPAIR_IDS || '').split(',').map(value => value.trim()).filter(Boolean),
  restockLockPath = process.env.STORAGE_ROOM_RESTOCK_LOCK || 'data/storage-room-restock.lock',
  log = message => console.log(message)
} = {}) {
  const bot = mineflayer.createBot({ host, port, username: String(botName).slice(0, 16), version: process.env.MC_REMOTE_VERSION || '26.1', auth: 'offline', plugins: { time: false } });
  let finished = false;
  const finish = code => {
    if (finished) return;
    finished = true;
    bot.pathfinder?.setGoal(null);
    bot.clearControlStates?.();
    bot.quit();
    setTimeout(() => process.exit(code), 250);
  };

  bot.once('spawn', async () => {
    try {
      bot.loadPlugin(pathfinder);
      bot.pathfinder.setMovements(buildMovements(bot, { allowTerrainWork: false, allow1by1Towers: false, maxDropDown: 3 }));
      const adapter = new MineflayerRoleAdapter(bot, { log, coordinateMovement: false, capabilities: ['storage', 'repair'] });
      const arrival = await walkToBase({ bot, goal: origin, range: 4, maxGotoMs: 60000, settleMs: 1000, minimumY: 58, allowTerrainWork: false, allow1by1Towers: false, maxDropDown: 3, log });
      if (!arrival.success) { log(`Chest repair berhenti: worksite tidak terjangkau (${arrival.reason}).`); finish(2); return; }
      await bot.waitForChunksToLoad();
      const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
      const withLock = (action, options = {}) => withStorageLock(action, {
        lockPath: restockLockPath,
        log,
        resourceKey: options.resourceKey || 'chest-repair',
        resourceCapacity: 1,
        totalCapacity: 8,
        actionTimeoutMs: 60000
      });
      const walkToWorksite = async () => walkToBase({
        bot,
        goal: origin,
        range: 4,
        maxGotoMs: 60000,
        settleMs: 500,
        minimumY: 58,
        allowTerrainWork: false,
        allow1by1Towers: false,
        maxDropDown: 3,
        log
      });
      let atBase = false;
      const ensureChestStock = async () => {
        if (adapter.getItemCount('chest') >= 2) return true;
        // Live fallback scans are local to the bot. Restock from the known base
        // first so a worksite does not trigger a long scan of unrelated chests.
        if (!atBase) {
          const baseArrival = await walkToBase({
            bot,
            goal: BASE,
            range: 4,
            maxGotoMs: 60000,
            settleMs: 500,
            minimumY: 58,
            allowTerrainWork: false,
            allow1by1Towers: false,
            maxDropDown: 3,
            log
          });
          if (!baseArrival.success) {
            log(`Chest repair: base tidak terjangkau untuk restock (${baseArrival.reason}).`);
            return false;
          }
          atBase = true;
        }
        await supplyStorageMaterial({ bot, adapter, name: 'chest', required: 2, log, withLock, fallbackSearch: true, fallbackSearchCount: 16, fallbackMaxDistance: 48 });
        const stocked = adapter.getItemCount('chest') >= 2;
        if (stocked) {
          const worksiteArrival = await walkToWorksite();
          if (!worksiteArrival.success) {
            log(`Chest repair: restock berhasil tetapi worksite tidak terjangkau (${worksiteArrival.reason}).`);
            return false;
          }
          atBase = false;
        }
        return stocked;
      };
      let repaired = 0;
      let skippedNonEmpty = 0;
      let inspected = 0;
      for (const pair of blueprint.pairs.slice(0, Math.max(1, Math.min(blueprint.pairs.length, maxPairs)))) {
        if (atBase && !await walkToWorksite()) {
          log(`Chest repair berhenti: kembali ke worksite gagal sebelum ${pair.id}.`);
          break;
        }
        atBase = false;
        if (targetIds.length > 0 && !targetIds.includes(pair.id)) continue;
        const left = { x: origin.x + pair.left.x, y: origin.y + pair.left.y, z: origin.z + pair.left.z };
        const right = { x: origin.x + pair.right.x, y: origin.y + pair.right.y, z: origin.z + pair.right.z };
        const access = { x: origin.x + pair.access.x, y: origin.y + pair.access.y, z: origin.z + pair.access.z };
        const leftBlock = adapter.blockAt(left);
        const rightBlock = adapter.blockAt(right);
        if (pairIsCorrect(leftBlock, rightBlock, pair)) continue;
        const hasChest = leftBlock?.name === 'chest' || rightBlock?.name === 'chest';
        if (!hasChest && targetIds.length === 0) continue;
        inspected += 1;
        const empty = (!leftBlock || leftBlock.name !== 'chest' || await chestIsEmpty(adapter, left)) &&
          (!rightBlock || rightBlock.name !== 'chest' || await chestIsEmpty(adapter, right));
        if (!empty) {
          skippedNonEmpty += 1;
          log(`Chest repair melewati pasangan berisi item di (${right.x},${right.y},${right.z})/(${left.x},${left.y},${left.z}).`);
          continue;
        }
        // Ambil drop chest yang mungkin masih berada di sekitar pasangan dari
        // percobaan repair sebelumnya sebelum mencari sumber material jauh.
        await adapter.navigateNear(access, 0);
        const removedRight = await removeChest({ bot, adapter, pos: right, approachPos: access, log });
        const removedLeft = removedRight && await removeChest({ bot, adapter, pos: left, approachPos: access, log });
        if (!removedLeft) continue;
        // Chest kosong yang dibongkar akan kembali sebagai item. Pakai ulang item
        // tersebut terlebih dahulu agar repair tidak bergantung pada wood gatherer.
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!await ensureChestStock()) {
          log(`Chest repair ditunda setelah pembongkaran: dua item chest belum tersedia untuk ${pair.id}.`);
          continue;
        }
        const placedRight = await placeChest({ bot, adapter, pos: right, approachPos: access, log });
        const placedLeft = placedRight && await placeChest({ bot, adapter, pos: left, approachPos: access, log });
        await new Promise(resolve => setTimeout(resolve, 500));
        const verified = placedLeft && pairIsCorrect(adapter.blockAt(left), adapter.blockAt(right), pair);
        if (verified) {
          repaired += 1;
          log(`DOUBLE_CHEST_REPAIRED ${JSON.stringify({ id: pair.id, left, right })}`);
        } else {
          log(`Chest repair belum terverifikasi untuk pasangan ${pair.id}: ${JSON.stringify({ left: properties(adapter.blockAt(left)), right: properties(adapter.blockAt(right)) })}`);
        }
      }
      log(`CHEST_REPAIR_SUMMARY ${JSON.stringify({ inspected, repaired, skippedNonEmpty })}`);
      finish(0);
    } catch (error) {
      log(`Chest repair error: ${error.stack || error.message}`);
      finish(2);
    }
  });
  bot.on('error', error => log(`Chest repair koneksi error: ${error.message}`));
  bot.on('kicked', reason => log(`Chest repair dikick: ${JSON.stringify(reason)}`));
  return bot;
}

module.exports = { startStorageRoomChestRepair, pairIsCorrect };

if (require.main === module) startStorageRoomChestRepair();
