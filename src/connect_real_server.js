/**
 * @file connect_real_server.js
 * @description Menghubungkan Mineflayer bot otonom secara langsung ke Real Minecraft LAN Server (127.0.0.1:37842).
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');

console.log('🌐 MENGHUBUNGKAN BOT KE REAL MINECRAFT LAN SERVER (127.0.0.1:37842)...');

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 37842,
  username: 'AI_Companion',
  auth: 'offline',
  version: '1.21.1' // Forge 26.1.2 berbasis Minecraft 1.21.1
});

bot.once('spawn', () => {
  console.log('🎉 [REAL SERVER] BOT BERHASIL SPAWN & MASUK KE DUNIA MINECRAFT ASLI ANDA!');
  console.log(`📍 Posisi Bot: (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
  console.log(`❤️ Health: ${bot.health}/20 | Makanan: ${bot.food}/20`);

  // Kirim chat in-game
  try {
    bot.chat('Halo! Saya AI Companion otonom telah bergabung ke world Anda.');
  } catch (e) {}

  // Muat plugin pathfinder
  try {
    bot.loadPlugin(pathfinder);
    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    bot.pathfinder.setMovements(defaultMove);
    console.log('🧠 [Pathfinder] Mesin navigasi 3D aktif di server nyata!');
  } catch (e) {
    console.log('⚠️ [Pathfinder Note]:', e.message);
  }
});

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  console.log(`💬 [In-Game Chat] <${username}> ${message}`);

  if (message.toLowerCase().includes('sini') || message.toLowerCase().includes('come') || message.toLowerCase().includes('ikut')) {
    const player = bot.players[username];
    if (player && player.entity) {
      console.log(`🏃 Menuju ke pemain ${username} di (${player.entity.position.x.toFixed(1)}, ${player.entity.position.y.toFixed(1)}, ${player.entity.position.z.toFixed(1)})`);
      bot.pathfinder.goto(new GoalNear(player.entity.position.x, player.entity.position.y, player.entity.position.z, 2));
      bot.chat(`Siap! Saya sedang berlari menuju ke posisi Anda.`);
    }
  }
});

bot.on('error', (err) => {
  console.error('❌ [Error]:', err.message);
});

bot.on('kicked', (reason) => {
  console.log('⚠️ [Kicked]:', reason);
});
