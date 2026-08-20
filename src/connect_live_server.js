/**
 * @file connect_live_server.js
 * @description Menghubungkan Bot Otonom Headless ke Live Server (atoms-girl.tun.ply.gg:25565).
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');
const autoEat = require('mineflayer-auto-eat');

const SERVER_HOST = 'atoms-girl.tun.ply.gg';
const SERVER_PORT = 25565;
const BOT_USERNAME = 'Bot_Petani_AI';

console.log(`🌐 MENGHUBUNGKAN BOT KE LIVE SERVER: ${SERVER_HOST}:${SERVER_PORT}...`);

const bot = mineflayer.createBot({
  host: SERVER_HOST,
  port: SERVER_PORT,
  username: BOT_USERNAME,
  auth: 'offline',
  version: '1.21.1',
  protocolVersion: 767,
  checkTimeoutInterval: 60000
});

if (typeof autoEat === 'function') {
  bot.loadPlugin(autoEat);
} else if (autoEat && typeof autoEat.plugin === 'function') {
  bot.loadPlugin(autoEat.plugin);
}

bot.once('spawn', () => {
  console.log(`\n🎉 [LIVE SERVER] BERHASIL MASUK KE LIVE SERVER: ${SERVER_HOST}!`);
  console.log(`👤 Nama Bot : ${bot.username}`);
  console.log(`📍 Posisi   : (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
  console.log(`❤️ Darah    : ${bot.health}/20 | Makanan: ${bot.food}/20\n`);

  try {
    bot.loadPlugin(pathfinder);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);
    console.log('🧠 [Pathfinder] Mesin navigasi 3D aktif di live server!');
  } catch (e) {
    console.log('⚠️ [Pathfinder Note]:', e.message);
  }

  // Kirim salam ke chat live server
  setTimeout(() => {
    try {
      bot.chat('Halo semua! Bot AI Companion telah terhubung ke live server.');
      console.log('💬 [Chat] Pesan berhasil dikirim ke world live server.');
    } catch (e) {}
  }, 2000);
});

// Auto-Attack Zombie di sekitar jika ada
setInterval(() => {
  if (!bot.entity) return;

  const zombieTargets = ['zombie', 'zombie_villager', 'husk', 'drowned'];
  const target = bot.nearestEntity(e => 
    zombieTargets.includes(e.name) && 
    bot.entity.position.distanceTo(e.position) < 4.5
  );

  if (target) {
    bot.lookAt(target.position.offset(0, 1.6, 0));
    bot.attack(target);
    console.log(`⚔️ [Combat] Menebas ${target.name} di jarak ${bot.entity.position.distanceTo(target.position).toFixed(1)}m`);
  }
}, 1200);

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  console.log(`💬 <${username}> ${message}`);
});

bot.on('health', () => {
  console.log(`❤️ [Update Status] Health: ${bot.health}/20 | Food: ${bot.food}/20`);
});

bot.on('error', (err) => {
  console.error('❌ [Error]:', err.message);
});

bot.on('kicked', (reason) => {
  console.log('⚠️ [Kicked]:', reason);
});

bot.on('end', () => {
  console.log('🔌 [Koneksi Berakhir]: Bot keluar dari server.');
});
