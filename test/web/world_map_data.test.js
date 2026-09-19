const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { StructureRegistry } = require('../../src/ai/structureRegistry');
const { SwarmReservations } = require('../../src/ai/swarmReservations');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');
const { WorldMapData, parseCellResource } = require('../../src/web/worldMapData');

test('world map memilih permukaan solid, struktur, landmark, bot, dan reservasi dalam viewport', t => {
  const memory = new SharedWorldMemory(':memory:');
  const structures = new StructureRegistry(memory);
  const context = { world: 'server:25565', dimension: 'overworld', observer: 'Explorer1', observedAt: 1000 };
  const blocks = [
    { name: 'stone', position: { x: 0, y: 63, z: 0 } },
    { name: 'air', position: { x: 0, y: 64, z: 0 } },
    { name: 'water', position: { x: 1, y: 62, z: 0 } },
    { name: 'oak_planks', position: { x: 2, y: 65, z: 2 } }
  ];
  memory.observe({ ...context, blocks });
  structures.observe(context, blocks);
  const reservations = new SwarmReservations(memory, 'worker-a', () => 1500);
  t.after(() => { reservations.close(); memory.close(); });
  reservations.acquire({ world: context.world, dimension: context.dimension }, ['cell:3,64,3'], 5000);
  memory.db.prepare('UPDATE reservations SET expiresAt=?').run(Date.now() + 5000);
  const service = new WorldMapData({
    memory,
    loadLandmarks: () => [{ id: 'home', shape: 'point', category: 'structure', position: { x: 2, y: 65, z: 2 } }],
    bots: () => [{ name: 'Explorer1', x: 1, y: 64, z: 1 }],
    miningStatus: () => ({ config: { regions: ['0,4,0,4,20,70'] } })
  });
  const map = service.snapshot({ centerX: 0, centerZ: 0, radius: 16 });
  assert.equal(map.blocks.find(block => block.x === 0 && block.z === 0).name, 'stone');
  assert.equal(map.structures.some(item => item.kind === 'building'), true);
  assert.equal(map.landmarks[0].id, 'home');
  assert.equal(map.bots[0].name, 'Explorer1');
  assert.deepEqual(map.reservations[0].position, { x: 3, y: 64, z: 3 });
  assert.equal(map.miningRegions[0].worker, 'ResourceW1');
});

test('slice hanya mengembalikan blok pada Y terpilih dan viewport membatasi data', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  new StructureRegistry(memory);
  memory.observe({ world: 'world', dimension: 'overworld', observer: 'bot', observedAt: 1, blocks: [
    { name: 'stone', position: { x: 0, y: 40, z: 0 } },
    { name: 'dirt', position: { x: 0, y: 41, z: 0 } },
    { name: 'diamond_ore', position: { x: 100, y: 40, z: 100 } }
  ] });
  const map = new WorldMapData({ memory }).snapshot({ mode: 'slice', y: 40, centerX: 0, centerZ: 0, radius: 16 });
  assert.deepEqual(map.blocks.map(block => block.name), ['stone']);
});

test('world map menampilkan worker child-process dari heartbeat shared swarm dengan namanya', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  new StructureRegistry(memory);
  const taskBoard = new SwarmTaskBoard(memory, { now: () => Date.now() });
  const context = { world: 'server:25565', dimension: 'overworld' };
  memory.observe({ ...context, observer: 'ResourceW2', observedAt: Date.now(), blocks: [
    { name: 'stone', position: { x: -63, y: 40, z: -397 } }
  ] });
  taskBoard.registerAgent({ id: 'ResourceW2', ...context, capabilities: ['miner'], metadata: { role: 'miner' } });
  taskBoard.heartbeatAgent('ResourceW2', { ...context, status: 'ONLINE',
    position: { x: -62.5, y: 47, z: -397.7 }, snapshot: { health: 18, inventoryFreeSlots: 12 } });

  const map = new WorldMapData({ memory }).snapshot({ centerX: -63, centerZ: -397, radius: 16 });
  assert.deepEqual(map.bots, [{
    id: 'ResourceW2', name: 'ResourceW2', role: 'miner', x: -62.5, y: 47, z: -397.7,
    status: 'ONLINE', health: 18, inventoryFreeSlots: 12, lastSeen: map.bots[0].lastSeen
  }]);
});

test('cell resource parser menolak resource non-posisi', () => {
  assert.deepEqual(parseCellResource('cell:-4,70,8'), { x: -4, y: 70, z: 8 });
  assert.equal(parseCellResource('mining-cell:abc'), null);
});
