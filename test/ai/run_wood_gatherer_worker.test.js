const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverUnsafeSpawn } = require('../../src/ai/runWoodGathererWorker');

const position = (x, y, z) => ({ x, y, z, floored() { return { x: Math.floor(this.x), y: Math.floor(this.y), z: Math.floor(this.z) }; } });

test('recoverUnsafeSpawn meminta teleport ketika spawn benar-benar terkurung', async () => {
  const bot = {
    entity: { position: position(-47, 53.4, -32) },
    blockAt: p => ({ name: 'stone', boundingBox: 'block', position: p }),
    chat(command) { assert.equal(command, '/tp @s -187 71 -343'); this.entity.position = position(-187, 71, -343); }
  };
  const logs = [];
  assert.equal(await recoverUnsafeSpawn(bot, message => logs.push(message)), true);
  assert.match(logs[0], /terkurung blok padat/);
});

test('recoverUnsafeSpawn tidak teleport worker yang berada di area outdoor', async () => {
  let teleported = false;
  const bot = {
    entity: { position: position(-47, 53.4, -32) },
    blockAt: p => p.y < 53 ? { name: 'grass_block', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p },
    chat() { teleported = true; }
  };
  assert.equal(await recoverUnsafeSpawn(bot, () => {}), true);
  assert.equal(teleported, false);
});
