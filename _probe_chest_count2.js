const { patchMineflayerVersionGate } = require('./src/network/mineflayerVersionPatch');
patchMineflayerVersionGate('26.1.2');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { walkToBase } = require('./src/ai/walkToBase');

const bot = mineflayer.createBot({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'LayoutProbe',
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

  const chestPositions = bot.findBlocks({
    matching: (b) => b && b.name === 'chest',
    maxDistance: 64,
    count: 200
  });
  const barrelPositions = bot.findBlocks({
    matching: (b) => b && b.name === 'barrel',
    maxDistance: 64,
    count: 200
  });
  console.log('TOTAL_CHEST', chestPositions.length);
  chestPositions.sort((a,b)=>a.y-b.y || a.x-b.x || a.z-b.z).forEach((p) => console.log('CHEST', p.x, p.y, p.z));
  console.log('TOTAL_BARREL', barrelPositions.length);
  barrelPositions.forEach((p) => console.log('BARREL', p.x, p.y, p.z));
  bot.quit();
  process.exit(0);
});
bot.on('error', (e) => { console.log('ERROR', e.message); process.exit(1); });
