const { patchMineflayerVersionGate } = require('./src/network/mineflayerVersionPatch');
patchMineflayerVersionGate('26.1.2');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { walkToBase } = require('./src/ai/walkToBase');
const { MineflayerRoleAdapter } = require('./src/ai/mineflayerRoleAdapter');
const fs = require('fs');

const bot = mineflayer.createBot({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'LayoutProbe3',
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
  const positions = adapter.findChestPositions(64, 200)
    .filter((p) => p.x >= -182 && p.x <= -179 && p.z >= -354 && p.z <= -344 && p.y >= 71 && p.y <= 74);

  console.log('POSITIONS_TO_SCAN', positions.length);
  const layout = [];
  for (const pos of positions) {
    const items = await adapter.getChestContents(pos);
    console.log('SCANNED', pos.x, pos.y, pos.z, '->', items.map((i) => `${i.name}x${i.count}`).join(', ') || '(kosong)');
    layout.push({ x: pos.x, y: pos.y, z: pos.z, items });
  }
  fs.writeFileSync('/tmp/full_storage_layout.json', JSON.stringify(layout, null, 2));
  console.log('DONE');
  bot.quit();
  process.exit(0);
});
bot.on('error', (e) => { console.log('ERROR', e.message); process.exit(1); });
