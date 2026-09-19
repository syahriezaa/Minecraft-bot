/** Runner survei kandidat lokasi storage room; tidak pernah mengubah dunia. */

const { patchMineflayerVersionGate } = require('../network/mineflayerVersionPatch');
const SERVER_VERSION = process.env.MC_REMOTE_VERSION || '26.1';
patchMineflayerVersionGate(SERVER_VERSION);
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { walkToBase } = require('./walkToBase');
const { rankStorageSites } = require('./storageRoomSurvey');

const BASE = { x: -185, y: 71, z: -352 };

function startStorageRoomSurvey({
  host = process.env.MC_HOST || 'atoms-girl.tun.ply.gg',
  port = Number(process.env.MC_PORT) || 25565,
  botName = process.env.MC_BOT_NAME || 'RoomSurvey',
  center = BASE,
  radius = Number(process.env.STORAGE_SURVEY_RADIUS) || 64,
  step = Number(process.env.STORAGE_SURVEY_STEP) || 16,
  y = Number(process.env.STORAGE_SURVEY_Y) || center.y - 7,
  allowFoundationFill = process.env.STORAGE_SURVEY_ALLOW_TERRAIN_WORK === '1',
  allowExcavation = process.env.STORAGE_SURVEY_ALLOW_TERRAIN_WORK === '1',
  skipBaseWalk = process.env.STORAGE_SURVEY_SKIP_BASE === '1',
  startDelayMs = Number(process.env.STORAGE_SURVEY_START_DELAY_MS) || 0,
  log = message => console.log(message)
} = {}) {
  const username = String(botName).slice(0, 16);
  const bot = mineflayer.createBot({ host, port, username, version: SERVER_VERSION, auth: 'offline', plugins: { time: false } });
  let finished = false;
  const finish = () => { if (finished) return; finished = true; bot.quit(); setTimeout(() => process.exit(0), 250); };
  bot.once('spawn', async () => {
    bot.loadPlugin(pathfinder);
    log(`Spawn survei di (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
    if (!skipBaseWalk) {
      const result = await walkToBase({ bot, goal: BASE, range: 4, settleMs: 3000, log });
      if (!result.success) { log(`STOP survei: gagal ke base (${result.reason})`); finish(); return; }
    }
    if (startDelayMs > 0) await new Promise(resolve => setTimeout(resolve, startDelayMs));
    const adapter = new MineflayerRoleAdapter(bot, { capabilities: ['survey', 'audit'] });
    const sites = rankStorageSites({ adapter, center, radius, step, y, limit: 10, allowFoundationFill, allowExcavation });
    log(`HASIL_SURVEI ${JSON.stringify({ center, radius, step, y, allowFoundationFill, allowExcavation, sites })}`);
    finish();
  });
  bot.on('error', error => log(`ERROR survei: ${error.message}`));
  bot.on('kicked', reason => log(`DIKICK survei: ${JSON.stringify(reason)}`));
  return bot;
}

module.exports = { startStorageRoomSurvey };

if (require.main === module) startStorageRoomSurvey();
