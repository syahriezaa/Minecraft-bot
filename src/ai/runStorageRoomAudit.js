/** Runner audit storage room read-only melalui Mineflayer. */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
patchMineflayerVersionGate(process.env.MC_REMOTE_VERSION || '26.1');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { walkToBase, buildMovements } = require('./walkToBase');
const { createStorageRoomBlueprint } = require('./storageRoomBlueprint');
const { auditStorageRoom } = require('./storageRoomAudit');

const BASE = { x: -185, y: 71, z: -352 };

async function waitForWorksiteChunks(bot, log) {
  let timer;
  try {
    await Promise.race([
      bot.waitForChunksToLoad(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('chunk worksite belum siap')), 15000); })
    ]);
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (error) {
    log(`PERINGATAN audit: chunk belum sepenuhnya tersinkron (${error.message}); hasil unknown akan dipertahankan sebagai blocker.`);
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrapTeleport(bot, origin, log) {
  if (typeof bot.chat !== 'function') return false;
  log(`Meminta teleport server-authoritative ke worksite (${origin.x},${origin.y},${origin.z})...`);
  bot.chat(`/tp @s ${origin.x} ${origin.y} ${origin.z}`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const position = bot.entity?.position;
    if (position && Math.hypot(position.x - origin.x, position.z - origin.z) <= 4 && Math.abs(position.y - origin.y) <= 4) {
      log('Teleport server-authoritative berhasil; posisi audit dikonfirmasi.');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  log('Teleport audit tidak terkonfirmasi; lanjut memakai pathfinding natural.');
  return false;
}

function parseOrigin(raw = process.env.STORAGE_ROOM_ORIGIN) {
  if (!raw) throw new Error('STORAGE_ROOM_ORIGIN wajib diberikan untuk audit.');
  const values = raw.split(',').map(Number);
  if (values.length !== 3 || !values.every(Number.isInteger)) throw new Error('STORAGE_ROOM_ORIGIN harus berbentuk x,y,z integer.');
  return { x: values[0], y: values[1], z: values[2] };
}

function startStorageRoomAudit({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'RoomAudit',
  origin = parseOrigin(),
  skipBaseWalk = process.env.STORAGE_ROOM_SKIP_BASE === '1',
  useServerTeleport = process.env.STORAGE_ROOM_TELEPORT === '1',
  minimumLight = Number(process.env.STORAGE_ROOM_MIN_LIGHT) || 8,
  log = message => console.log(message)
} = {}) {
  const bot = mineflayer.createBot({ host, port, username: String(botName).slice(0, 16), version: process.env.MC_REMOTE_VERSION || '26.1', auth: 'offline', plugins: { time: false } });
  let finished = false;
  const finish = code => {
    if (finished) return;
    finished = true;
    bot.quit();
    setTimeout(() => process.exit(code), 250);
  };
  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    bot.pathfinder.setMovements(buildMovements(bot));
    if (useServerTeleport) await bootstrapTeleport(bot, origin, log);
    if (!skipBaseWalk) {
      const walk = await walkToBase({ bot, goal: BASE, range: 4, settleMs: 1000, log });
      if (!walk.success) { log(`STOP audit: gagal ke base (${walk.reason})`); finish(2); return; }
    }
    // Audit harus membaca chunk di origin, bukan hanya chunk spawn/base. Tanpa perjalanan ini,
    // blockAt() mengembalikan null untuk seluruh blueprint dan hasilnya tampak seperti bangunan
    // hilang padahal data dunia belum pernah dikirim ke client.
    if (!skipBaseWalk || Math.hypot(bot.entity.position.x - origin.x, bot.entity.position.z - origin.z) > 8) {
      const worksiteWalk = await walkToBase({ bot, goal: origin, range: 4, maxGotoMs: 45000, settleMs: 1000, minimumY: 58, log });
      if (!worksiteWalk.success) { log(`STOP audit: gagal ke worksite (${worksiteWalk.reason})`); finish(2); return; }
    }
    await waitForWorksiteChunks(bot, log);
    const adapter = require('./mineflayerRoleAdapter').MineflayerRoleAdapter;
    const result = await auditStorageRoom({
      adapter: new adapter(bot, { log }),
      blueprint: createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' }),
      origin,
      minimumLight
    });
    log(`HASIL_AUDIT_STORAGE ${JSON.stringify(result)}`);
    finish(result.ok ? 0 : 2);
  });
  bot.on('error', error => log(`ERROR audit: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK audit: ${JSON.stringify(reason)}`));
  return bot;
}

module.exports = { startStorageRoomAudit, parseOrigin };

if (require.main === module) {
  try { startStorageRoomAudit(); } catch (error) { console.error(`GAGAL memulai audit: ${error.message}`); process.exitCode = 2; }
}
