const { test } = require('node:test');
const assert = require('node:assert/strict');
const { surveyStorageQuarry } = require('../../src/ai/storageRoomQuarry');
const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmReservations } = require('../../src/ai/swarmReservations');
const { StructureRegistry } = require('../../src/ai/structureRegistry');

const bounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 5 };

test('core work takes priority over widening and surface targets sort first', () => {
  const plan = surveyStorageQuarry({
    blockAt: p => ({ name: p.x === 2 && p.z === 2 && [2, 4].includes(p.y) ? 'stone' : 'air' }),
    isQuarryExpansionColumnSafe: () => { throw new Error('must not expand yet'); }
  }, bounds);
  assert.deepEqual(plan.actions.map(a => a.pos.y), [4, 2]);
  assert.deepEqual(plan.surface, { minY: 4, maxY: 4, columns: 1 });
  assert.equal(plan.expanded, false);
});

test('only verified columns in the first perimeter ring can be added', () => {
  const plan = surveyStorageQuarry({
    blockAt: p => ({ name: p.x < 0 && p.y === 2 ? 'stone' : 'air' }),
    isQuarryExpansionColumnSafe: p => p.x === -1 && p.z === 1
  }, bounds);
  assert.equal(plan.expanded, true);
  assert.deepEqual(plan.actions.map(a => a.pos), [{ x: -1, y: 2, z: 1 }]);
});

test('unknown core terrain cannot be bypassed by expanding', () => {
  const plan = surveyStorageQuarry({ blockAt: () => null,
    isQuarryExpansionColumnSafe: () => { throw new Error('unsafe bypass'); } }, bounds);
  assert.equal(plan.expanded, false);
  assert.ok(plan.blockers.length);
});

function fixture(t) {
  const memory = new SharedWorldMemory(':memory:');
  const reservations = new SwarmReservations(memory);
  const registry = new StructureRegistry(memory);
  const bot = { _client: { options: { host: 'test', port: 25565 } },
    game: { dimension: 'overworld', minY: 0, height: 12 },
    blockAt: p => ({ name: p.y <= 5 ? 'stone' : 'air', position: p }) };
  const adapter = new MineflayerRoleAdapter(bot, { sharedWorld: false });
  adapter.sharedWorldObserver = { memory, reservations };
  t.after(() => { reservations.close(); memory.close(); });
  const context = require('../../src/ai/sharedWorldObserver').worldContext(bot);
  return { bot, adapter, memory, registry, context };
}

test('expansion rejects unknown cells, liquids and construction above excavation height', t => {
  const { bot, adapter } = fixture(t);
  assert.equal(adapter.isQuarryExpansionColumnSafe({ x: -1, z: 1 }, bounds), true);
  for (const name of [null, 'water', 'chest', 'farmland', 'oak_planks', 'torch', 'cobblestone']) {
    bot.blockAt = p => p.y === 10 ? name && { name } : { name: 'air' };
    assert.equal(adapter.isQuarryExpansionColumnSafe({ x: -1, z: 1 }, bounds), false, String(name));
  }
});

test('known structure footprints and other worker leases prevent undermining', t => {
  const { adapter, registry, memory, context } = fixture(t);
  registry.observe(context, [{ name: 'chest', position: { x: -1, y: 10, z: 1 } }]);
  assert.equal(adapter.isQuarryExpansionColumnSafe({ x: -1, z: 1 }, bounds), false);
  const other = new SwarmReservations(memory);
  try {
    other.acquire(context, ['cell:4,4,1']);
    assert.equal(adapter.isQuarryExpansionColumnSafe({ x: 4, z: 1 }, bounds), false);
  } finally { other.close(); }
});

test('missing shared memory or height metadata never grants expansion', t => {
  const { bot, adapter } = fixture(t);
  delete bot.game.height;
  assert.equal(adapter.isQuarryExpansionColumnSafe({ x: -1, z: 1 }, bounds), false);
});

test('overhead mining allows surveyed natural stone but rejects falling blocks even far above', t => {
  const { bot, adapter } = fixture(t);
  const pos = { x: 0, y: 3, z: 0 };
  assert.equal(adapter.isQuarryOverheadSafe(pos), true);
  for (const name of ['sand', 'gravel', 'red_sand', 'white_concrete_powder', 'pointed_dripstone', 'water']) {
    bot.blockAt = p => ({ name: p.y === 10 ? name : 'stone', position: p });
    assert.equal(adapter.isQuarryOverheadSafe(pos), false, name);
  }
  bot.blockAt = p => p.y === 10 ? null : { name: 'stone', position: p };
  assert.equal(adapter.isQuarryOverheadSafe(pos), false);
});

test('overhead mining cannot undermine a known structure', t => {
  const { adapter, registry, context } = fixture(t);
  registry.observe(context, [{ name: 'oak_planks', position: { x: 0, y: 10, z: 0 } }]);
  assert.equal(adapter.isQuarryOverheadSafe({ x: 0, y: 3, z: 0 }), false);
});

for (const safe of [true, false]) {
  test(`quarry execution ${safe ? 'allows' : 'blocks'} overhead digging after safety check`, async t => {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'quarry-overhead-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    let digs = 0;
    let checks = 0;
    const adapter = {
      blockAt: p => ({ name: !digs && p.x === 2 && p.z === 2 && p.y === 4 ? 'stone' : 'air', position: p }),
      getInventoryFreeSlotCount: () => 10, getEntities: () => [], getItemCount: () => 1,
      isQuarryOverheadSafe: () => { checks++; return safe; },
      dig: async () => { digs++; }
    };
    const result = await require('../../src/ai/storageRoomQuarry').excavateStorageQuarry({
      adapter, bot: { health: 20, food: 20, entity: { position: { x: 2, y: 2, z: 1 } } },
      bounds, checkpointFile: path.join(dir, 'checkpoint.json')
    });
    assert.equal(checks, 1);
    assert.equal(digs, safe ? 1 : 0);
    assert.equal(result.reason, safe ? 'EXCAVATED' : 'UNSAFE_OVERHEAD');
  });
}

test('unsafe overhead is deferred without consuming the dig budget or marking it complete', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'quarry-deferred-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const checkpointFile = path.join(dir, 'checkpoint.json');
  const dug = [];
  const adapter = {
    blockAt: p => ({ name: p.x === 2 && p.y === 4 && [1, 2].includes(p.z) && !dug.includes(p.z) ? 'stone' : 'air', position: p }),
    approachReachableWork: async targets => ({ target: [...targets].sort((a, b) => a.pos.z - b.pos.z)[0] }),
    getInventoryFreeSlotCount: () => 10, getEntities: () => [], getItemCount: () => 1,
    isQuarryOverheadSafe: p => p.z === 2,
    dig: async b => { dug.push(b.position.z); }
  };
  const result = await require('../../src/ai/storageRoomQuarry').excavateStorageQuarry({
    adapter, bot: { health: 20, food: 20, entity: { position: { y: 2 } } }, bounds, maxBlocks: 1, checkpointFile
  });
  assert.deepEqual(dug, [2]);
  assert.equal(result.cleared, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.status, 'PAUSED');
  const saved = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
  assert.deepEqual(saved.completed, ['2,4,2']);
  assert.deepEqual(saved.deferred, [{ pos: { x: 2, y: 4, z: 1 }, reason: 'UNSAFE_OVERHEAD' }]);
});

test('native target selection prefers the highest safe layer before depth', () => {
  const bot = { entity: { position: { x: 0, y: 6, z: 0 } }, world: { raycast: () => null },
    pathfinder: { getPathTo: () => ({ status: 'success', path: [] }) } };
  const adapter = new MineflayerRoleAdapter(bot);
  const surface = { pos: { x: 1, y: 5, z: 0 }, priority: -5 };
  const deep = { pos: { x: 2, y: 2, z: 0 }, priority: -2 };
  assert.equal(adapter.selectReachableWork([surface, deep]).target, surface);
});

test('native survey continues beyond the first 24 targets', async () => {
  let calls = 0;
  const bot = { entity: { position: { x: 0, y: 6, z: 0 } }, world: { raycast: () => null },
    pathfinder: { getPathTo: () => ({ status: ++calls <= 24 ? 'noPath' : 'success', path: [] }) } };
  const adapter = new MineflayerRoleAdapter(bot);
  const targets = Array.from({ length: 25 }, (_, x) => ({ pos: { x, y: 2, z: 0 } }));
  assert.equal((await adapter.approachReachableWork(targets)).target, targets[24]);
  assert.equal(calls, 25);
});

test('completed pagination distinguishes inaccessible from incomplete searches', async () => {
  let timeout = false;
  const bot = { entity: { position: { x: 0, y: 6, z: 0 } }, world: { raycast: () => null },
    pathfinder: { getPathTo: () => ({ status: timeout ? 'timeout' : 'noPath', path: [] }) } };
  const adapter = new MineflayerRoleAdapter(bot);
  const targets = Array.from({ length: 25 }, (_, x) => ({ pos: { x, y: 2, z: 0 } }));
  assert.equal((await adapter.approachReachableWork(targets)).status, 'NEEDS_ACCESS');
  timeout = true;
  assert.equal((await adapter.approachReachableWork(targets)).status, 'NEEDS_SURVEY');
});

test('expansion is revalidated after navigation before modifying the world', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'quarry-expansion-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let safe = true;
  let digs = 0;
  const adapter = {
    blockAt: p => ({ name: p.x === -1 && p.z === 1 && p.y === 2 ? 'stone' : 'air', position: p }),
    isQuarryExpansionColumnSafe: p => safe && p.x === -1 && p.z === 1,
    approachReachableWork: async targets => ({ target: targets[0], stance: { position: { x: 0, y: 3, z: 1 } } }),
    navigateNear: async () => { safe = false; return true; },
    getInventoryFreeSlotCount: () => 10, getEntities: () => [],
    getItemCount: () => 1, dig: async () => { digs++; }
  };
  const result = await require('../../src/ai/storageRoomQuarry').excavateStorageQuarry({
    adapter, bot: { health: 20, food: 20 }, bounds, checkpointFile: path.join(dir, 'checkpoint.json')
  });
  assert.equal(result.reason, 'EXPANSION_NO_LONGER_SAFE');
  assert.equal(digs, 0);
});
