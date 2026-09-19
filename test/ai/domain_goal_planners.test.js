const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDefaultPlannerRegistry } = require('../../src/ai/domainGoalPlanners');

test('semua domain menghasilkan task graph dengan capability dan dependency eksplisit', () => {
  const registry = createDefaultPlannerRegistry();
  for (const type of ['MINE_RESOURCES', 'BUILD_STRUCTURE', 'MAINTAIN_FARM', 'SORT_STORAGE', 'EXPLORE_AREA', 'DEFEND_AREA', 'CARE_ANIMALS']) {
    const tasks = registry.plan({ id: `goal-${type}`, type, payload: {} });
    assert.ok(tasks.length > 0, `${type} harus punya task`);
    assert.ok(tasks.every(task => task.type && task.capability && Array.isArray(task.dependencies)));
    const ids = new Set(tasks.map(task => task.id));
    assert.ok(tasks.every(task => task.dependencies.every(id => ids.has(id))), `${type} dependency harus lokal dan valid`);
  }
});

test('goal mining tidak menggunakan jumlah blok sebagai kondisi perilaku', () => {
  const tasks = createDefaultPlannerRegistry().plan({ id: 'mine', type: 'MINE_RESOURCES', payload: { seedX: -66, minZ: -406, maxZ: -379 } });
  assert.deepEqual(tasks.map(task => task.type), ['SURVEY_FRONTIER', 'ENSURE_ACCESS', 'MINE_CELL', 'HAUL_RESOURCES']);
  assert.ok(tasks.every(task => task.payload.maxBlocks === undefined && task.payload.batch === undefined));
});

test('storage construction hanya membuat task builder dan landscaper', () => {
  const registry = createDefaultPlannerRegistry();
  const full = registry.plan({ id: 'storage', type: 'STORAGE_ROOM_CONSTRUCTION', payload: {
    gathererCount: 4, materialsWorkerCount: 2, landscaperWorkerCount: 1, builderWorkerCount: 3,
    minerBotNames: ['m1', 'm2', 'm3', 'm4'], materialsBotNames: ['s1', 's2'],
    landscaperBotNames: ['land-1'], builderBotNames: ['build-1', 'build-2', 'build-3']
  } });
  assert.equal(full.length, 4);
  assert.deepEqual(full.map(task => task.type), ['LANDSCAPE_SITE', 'BUILD_STORAGE', 'BUILD_STORAGE', 'BUILD_STORAGE']);
  assert.deepEqual(full.map(task => task.payload.allowedAgents[0]), ['land-1', 'build-1', 'build-2', 'build-3']);
  assert.ok(full.every(task => !['MINING_SUPPLY', 'PREPARE_MATERIALS'].includes(task.type)));
});

test('materials worker memiliki task global yang dapat diklaim oleh bot smelting/crafting', () => {
  const tasks = createDefaultPlannerRegistry().plan({ id: 'materials', type: 'PREPARE_MATERIALS', payload: { botName: 'StorageMatUI' } });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].type, 'PREPARE_MATERIALS');
  assert.equal(tasks[0].capability, 'craft');
  assert.deepEqual(tasks[0].payload.allowedAgents, ['StorageMatUI']);
});

test('mining fleet membuat task miner mandiri dengan reservasi worker dan region', () => {
  const tasks = createDefaultPlannerRegistry().plan({ id: 'miners', type: 'MINING_FLEET', payload: {
    count: 2,
    workerNames: ['ResourceW1', 'ResourceW2'],
    regions: ['0,4,0,3,20,70', '0,4,4,7,20,70']
  } });
  assert.deepEqual(tasks.map(task => task.type), ['MINING_SUPPLY', 'MINING_SUPPLY']);
  assert.deepEqual(tasks.map(task => task.payload.allowedAgents[0]), ['ResourceW1', 'ResourceW2']);
  assert.deepEqual(tasks.map(task => task.payload.region), ['0,4,0,3,20,70', '0,4,4,7,20,70']);
});
