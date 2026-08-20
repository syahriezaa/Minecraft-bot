const test = require('node:test');
const assert = require('node:assert');
const squid = require('flying-squid');
const defaultSettings = require('flying-squid/config/default-settings.json');
const mineflayer = require('mineflayer');
const { once } = require('events');

test('headless server lifecycle and bot connection', async (t) => {
  const serv = squid.createMCServer({
    ...defaultSettings,
    port: 25567,
    'max-players': 10,
    'online-mode': false,
    'everybody-op': true,
    logging: false,
    'view-distance': 4,
    worldFolder: undefined,
    generation: {
      name: 'superflat',
      options: { bottomId: 7, middleId: 1, topId: 2 }
    },
    version: '1.20.1'
  });

  await serv.waitForReady();
  assert.strictEqual(serv.isReady, true);

  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port: 25567,
    username: 'TestBot',
    version: '1.20.1'
  });

  await once(bot, 'spawn');
  assert.ok(bot.entity.position);

  // 1. Clean disconnect of bot
  bot.quit();
  bot._client?.socket?.destroy();
  await new Promise(r => setTimeout(r, 100));

  // 2. Teardown server
  if (serv.stopTickInterval) serv.stopTickInterval();
  for (const p of serv.players) {
    p._client?.socket?.destroy();
  }
  if (serv._server?.clients) {
    for (const id in serv._server.clients) {
      serv._server.clients[id]?.socket?.destroy();
    }
  }
  await serv.quit();

  if (serv._server?.socketServer) {
    serv._server.socketServer.close();
    serv._server.socketServer.unref();
  }

  // Check remaining active handles
  const handles = process._getActiveHandles();
  console.log('Remaining active handles count:', handles.length);
  for (const h of handles) {
    console.log('Handle:', h.constructor ? h.constructor.name : typeof h);
    if (typeof h.unref === 'function') h.unref();
  }
});
