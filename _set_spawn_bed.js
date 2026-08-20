const { patchMineflayerVersionGate } = require('./src/network/mineflayerVersionPatch');
patchMineflayerVersionGate('26.1.2');

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

const bot = mineflayer.createBot({
  host: 'atoms-girl.tun.ply.gg',
  port: 25565,
  username: 'AutoCompanionBot',
  version: '26.1.2',
  auth: 'offline',
  plugins: { time: false }
});

bot.once('spawn', async () => {
  console.log('Posisi sekarang:', bot.entity.position);
  bot.loadPlugin(pathfinder);
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.canOpenDoors = true;
  movements.allowParkour = true;
  bot.pathfinder.setMovements(movements);
  bot.pathfinder.thinkTimeout = 20000;

  console.log('Menunggu 5 detik supaya chunk sekitar sempat ter-load penuh...');
  await new Promise((r) => setTimeout(r, 5000));

  const beds = bot.findBlocks({
    matching: (block) => block && block.name.endsWith('_bed'),
    maxDistance: 64,
    count: 10
  }).map((pos) => bot.blockAt(pos));

  console.log(`Ditemukan ${beds.length} bed dalam radius 64 blok:`, beds.map((b) => `${b.name}@${b.position}`));

  if (beds.length === 0) {
    console.log('Tidak ada bed ditemukan dalam jangkauan - dunia sekitar mungkin belum ter-load penuh.');
    bot.quit();
    process.exit(0);
  }

  const target = beds[0];
  console.log(`Mencoba menuju bed di ${target.position}...`);
  try {
    await bot.pathfinder.goto(new GoalNear(target.position.x, target.position.y, target.position.z, 1));
    console.log('Sampai dekat bed. Posisi:', bot.entity.position);
    await bot.activateBlock(target);
    console.log('BERHASIL klik bed - spawn point seharusnya sudah ter-set di sini.');
  } catch (e) {
    console.log('GAGAL:', e.message);
  }

  bot.quit();
  process.exit(0);
});

bot.on('error', (e) => console.error('ERROR:', e.message));
bot.on('kicked', (r) => { console.error('DIKICK:', r); process.exit(1); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 60000);
