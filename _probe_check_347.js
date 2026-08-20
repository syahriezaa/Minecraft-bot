const { patchMineflayerVersionGate } = require('./src/network/mineflayerVersionPatch');
patchMineflayerVersionGate('26.1.2');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { walkToBase } = require('./src/ai/walkToBase');
const { MineflayerRoleAdapter } = require('./src/ai/mineflayerRoleAdapter');

const bot = mineflayer.createBot({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'LayoutProbe6',
  version: '26.1.2',
  auth: 'offline',
  plugins: { time: false }
});

bot.once('spawn', async () => {
  bot.loadPlugin(pathfinder);
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowParkour = true;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 20000;

  await walkToBase({ bot, goal: { x: -185, y: 71, z: -352 }, range: 4, settleMs: 4000, log: (m) => console.log('[walk]', m) });

  const adapter = new MineflayerRoleAdapter(bot);
  const items = await adapter.getChestContents({ x: -181, y: 71, z: -347 });
  console.log('CONTENTS -181,71,-347:', items.map((i) => `${i.name}x${i.count}`).join(', ') || '(kosong)');
  bot.quit();
  process.exit(0);
});
bot.on('error', (e) => { console.log('ERROR', e.message); process.exit(1); });
