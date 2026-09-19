const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QUARRY_BOUNDS, parseQuarryBounds, quarryFloor, inventoryFill, surveyStorageQuarry, planSurfaceFlattening } = require('../../src/ai/storageRoomQuarry');
const { excavateStorageQuarry } = require('../../src/ai/storageRoomQuarry');
const { supplyQuarryAccessMaterials, countQuarryMaterials, shouldDeliverQuarryResult,
  frontierApproachTarget, isImmediateCarrySafetyOverride,
  shouldRecoverQuarrySpawnToBase, followQuarryAccessPath, returnToBaseFromQuarry } = require('../../src/ai/runStorageRoomQuarry');

test('material akses tetap diantar walau checkpoint quarry tidak menghasilkan blok baru', () => {
  const adapter = { getItemCount: name => name === 'cobblestone' ? 44 : 0 };
  assert.equal(countQuarryMaterials(adapter), 44);
  assert.equal(shouldDeliverQuarryResult({ cleared: 0 }, 44), true);
  assert.equal(shouldDeliverQuarryResult({ cleared: 0 }, 0), false);
  assert.equal(shouldDeliverQuarryResult({ cleared: 3 }, 0), true);
});

test('mode permukaan mendekati XZ frontier dari lapisan atas sebelum menggali turun', () => {
  const bounds = { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 };
  assert.deepEqual(frontierApproachTarget(bounds, 'surface_to_floor'), {
    x: -67, y: 77, z: -403, goalXZOnly: true, minimumY: 56
  });
  assert.deepEqual(frontierApproachTarget(bounds, 'depth_first'), {
    x: -67, y: 41, z: -403, goalXZOnly: false, minimumY: 40
  });
  assert.deepEqual(frontierApproachTarget(bounds, 'strip_surface_to_floor'), {
    x: -67, y: 77, z: -403, goalXZOnly: true, minimumY: 56
  });
});

test('frontier sementara tidak terjangkau memulangkan muatan lalu retry', () => {
  assert.equal(isImmediateCarrySafetyOverride('FRONTIER_UNREACHABLE'), true);
  assert.equal(isImmediateCarrySafetyOverride('FRONTIER_UNKNOWN'), true);
  assert.equal(isImmediateCarrySafetyOverride('NO_SAFE_TARGET'), true);
  assert.equal(isImmediateCarrySafetyOverride('SURVIVAL'), true);
  assert.equal(isImmediateCarrySafetyOverride('LIQUID_OR_UNKNOWN_NEIGHBOUR'), true);
  assert.equal(isImmediateCarrySafetyOverride('INVENTORY_FULL'), true);
  assert.equal(isImmediateCarrySafetyOverride('MISSING_pickaxe'), true);
  assert.equal(isImmediateCarrySafetyOverride('MISSING_shovel'), true);
  assert.equal(isImmediateCarrySafetyOverride('DIG_UNCONFIRMED'), true);
});

test('restart di koridor quarry melanjutkan pekerjaan tanpa teleport ke base', () => {
  const bounds = { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 };
  assert.equal(shouldRecoverQuarrySpawnToBase({ x: -64, y: 40, z: -403 }, bounds), false);
  assert.equal(shouldRecoverQuarrySpawnToBase({ x: -64, y: 37, z: -403 }, bounds), true);
  assert.equal(shouldRecoverQuarrySpawnToBase({ x: -80, y: 20, z: -403 }, bounds), false);
});

test('return dari dasar quarry wajib mengikuti access path terverifikasi sebelum jalan ke base', async () => {
  const bounds = { minX: 0, maxX: 2, minZ: 0, maxZ: 2, floorY: 40, maxY: 90 };
  const accessPath = [
    { x: 0, y: 79, z: 0 },
    { x: 1, y: 78, z: 0 },
    { x: 2, y: 77, z: 0 }
  ];
  const bot = { entity: { position: { x: 2.5, y: 78, z: 0.5 } } };
  const visited = [];
  const adapter = {
    navigateNear: async pos => {
      visited.push(pos);
      bot.entity.position = { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5 };
      return true;
    }
  };
  const result = await followQuarryAccessPath({ bot, adapter, accessPath, bounds });
  assert.equal(result.success, true);
  assert.equal(result.usedAccessPath, true);
  assert.deepEqual(visited, [
    { x: 2, y: 78, z: 0 },
    { x: 1, y: 79, z: 0 },
    { x: 0, y: 80, z: 0 }
  ]);
});

test('return ke base gagal deterministik bila miner di quarry tidak punya access path', async () => {
  const bounds = { minX: 0, maxX: 2, minZ: 0, maxZ: 2, floorY: 40, maxY: 80 };
  let walkCalled = false;
  const result = await returnToBaseFromQuarry({
    bot: { entity: { position: { x: 1.5, y: 50, z: 1.5 } } },
    adapter: { navigateNear: async () => true },
    bounds,
    accessPath: [],
    walk: async () => { walkCalled = true; return { success: true }; }
  });
  assert.equal(result.success, false);
  assert.match(result.reason, /NO_VERIFIED_ACCESS_PATH/);
  assert.equal(walkCalled, false);
});

test('return memakai emergency exit hanya ketika checkpoint akses tidak valid', async () => {
  let emergencyCalled = false;
  const result = await returnToBaseFromQuarry({
    bot: { entity: { position: { x: 1.5, y: 50, z: 1.5 } } },
    adapter: { navigateNear: async () => true },
    bounds: { minX: 0, maxX: 2, minZ: 0, maxZ: 2, floorY: 40, maxY: 80 },
    accessPath: [],
    emergencyExit: async () => { emergencyCalled = true; return { success: true, reason: 'EMERGENCY_STAGING_EXIT' }; }
  });
  assert.equal(result.success, true);
  assert.equal(result.emergency, true);
  assert.equal(emergencyCalled, true);
});

test('quarry dapat memakai dirt dari chest tanah untuk memutus deadlock akses awal', async () => {
  let dirt = 0;
  const calls = [];
  const adapter = {
    getItemCount: name => name === 'dirt' ? dirt : 0,
    withdrawFromChest: async (source, names, count) => {
      calls.push({ source, name: names[0], count });
      if (names[0] !== 'dirt') return { withdrawn: 0 };
      dirt += count;
      return { withdrawn: count };
    }
  };
  const available = await supplyQuarryAccessMaterials({
    bot: {}, adapter, target: 8, log: () => {},
    withLock: async (action, options) => {
      assert.match(options.resourceKey, /^chest:/);
      return action();
    }
  });
  assert.equal(available, 8);
  assert.equal(calls[0].name, 'dirt');
});

test('inventory fill menghitung target 75 persen berdasarkan slot, bukan jumlah item', () => {
  const adapter = {
    getInventoryFreeSlotCount: () => 9,
    getInventoryItems: () => Array.from({ length: 27 }, (_, index) => ({ name: 'stone', count: 64, slot: index + 9 }))
  };
  assert.deepEqual(inventoryFill(adapter), { ratio: 0.75, occupiedSlots: 27, capacitySlots: 36, freeSlots: 9 });
});

test('quarry survey has bounded dimensions and leaves a stair edge', () => {
  assert.equal(QUARRY_BOUNDS.maxX - QUARRY_BOUNDS.minX + 1, 24);
  assert.equal(QUARRY_BOUNDS.maxZ - QUARRY_BOUNDS.minZ + 1, 20);
  assert.ok(quarryFloor(QUARRY_BOUNDS.minX, QUARRY_BOUNDS.maxZ) >= QUARRY_BOUNDS.floorY);
});

test('quarry bounds parser accepts a bounded worker region', () => {
  assert.deepEqual(parseQuarryBounds('-66,-55,-408,-399,60,80'), {
    minX: -66, maxX: -55, minZ: -408, maxZ: -399, floorY: 60, maxY: 80
  });
});

test('quarry plan never targets floor blocks or unknown/liquid blocks', () => {
  const adapter = { blockAt: pos => pos.y === 60 ? { name: 'stone' } : pos.y === 62 ? { name: 'stone' } : { name: 'air' } };
  const plan = surveyStorageQuarry(adapter);
  assert.ok(plan.actions.every(action => action.pos.y > 60));
  assert.equal(plan.blockers.length, 0);
});

test('surface mode excavates the highest layer before descending', async () => {
  const remaining = new Set(['1,4,1', '1,3,1', '1,2,1']);
  const dug = [];
  const adapter = {
    blockAt: pos => ({
      name: remaining.has(`${pos.x},${pos.y},${pos.z}`) ? 'stone' : 'air',
      position: pos,
      boundingBox: remaining.has(`${pos.x},${pos.y},${pos.z}`) ? 'block' : 'empty'
    }),
    getInventoryFreeSlotCount: () => 36,
    getInventoryItems: () => [],
    getItemCount: name => name === 'iron_pickaxe' ? 1 : 0,
    getEntities: () => [],
    isQuarryOverheadSafe: () => true,
    dig: async block => {
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      dug.push(block.position.y);
      remaining.delete(key);
    }
  };
  const result = await excavateStorageQuarry({
    bot: { health: 20, food: 20, entity: { position: { x: 1, y: 5, z: 0 } } },
    adapter,
    maxBlocks: 2,
    minInventoryFillRatio: 0,
    bounds: { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 5 },
    mode: 'surface_to_floor'
  });
  assert.equal(result.reason, 'BATCH_LIMIT');
  assert.deepEqual(dug, [4, 3]);
});

test('world changes are blockers, never implicit excavation permission', () => {
  const adapter = { blockAt: pos => pos.y === 65 ? { name: 'obsidian' } : { name: 'air' } };
  const plan = surveyStorageQuarry(adapter);
  assert.ok(plan.blockers.length > 0);
  assert.equal(plan.actions.some(action => action.pos.y === 65), false);
});

test('quarry menambang kolom aman dan menunda boundary cave/ravine', () => {
  const localBounds = { minX: 0, maxX: 4, minZ: 0, maxZ: 4, floorY: 0, maxY: 5 };
  const adapter = { blockAt: pos => ({ name: pos.y <= 4 ? 'stone' : 'air' }) };
  const plan = surveyStorageQuarry(adapter, localBounds, [], { voidTopology: {
    boundaryColumns: ['2,2', '2,1', '2,3', '1,2', '3,2'],
    ravineColumns: ['2,2'], evidence: { ravineColumns: 1 }, policy: { maxSafeDrop: 1, ravineDepth: 4 }
  } });
  assert.ok(plan.actions.length > 0);
  assert.ok(plan.deferred.some(item => item.reason === 'RAVINE_BOUNDARY'));
  assert.ok(plan.deferred.some(item => item.reason === 'CAVE_BOUNDARY'));
  assert.equal(plan.actions.some(item => item.pos.x === 2 && item.pos.z === 2), false);
});

test('quarry edge hanya membuka target boundary untuk pemeriksaan voxel 3D', () => {
  const localBounds = { minX: 0, maxX: 2, minZ: 0, maxZ: 2, floorY: 0, maxY: 5 };
  const adapter = { blockAt: pos => ({ name: pos.y <= 4 ? 'stone' : 'air' }) };
  const plan = surveyStorageQuarry(adapter, localBounds, [], {
    allowSafeVoidBoundary: true,
    voidTopology: {
      boundaryColumns: ['1,1', '1,0'], ravineColumns: ['1,1'],
      evidence: { ravineColumns: 1 }, policy: { maxSafeDrop: 1, ravineDepth: 4 }
    }
  });
  assert.ok(plan.actions.some(item => item.pos.x === 1 && item.pos.z === 1));
  assert.equal(plan.deferred.length, 0);
});

test('strip mode menyelesaikan satu layer horizontal dari permukaan sebelum turun', () => {
  const bounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 4 };
  const adapter = { blockAt: pos => ({ name: pos.y > 0 && pos.y <= 4 ? 'stone' : 'air' }) };
  const plan = surveyStorageQuarry(adapter, bounds, [], { mode: 'strip_surface_to_floor' });
  const layers = plan.actions.map(action => action.pos.y);
  assert.ok(layers.length >= 8);
  assert.deepEqual(layers, [...layers].sort((a, b) => b - a));
  const firstLowerLayer = layers.findIndex(y => y < layers[0]);
  assert.ok(firstLowerLayer > 0);
  assert.ok(layers.slice(0, firstLowerLayer).every(y => y === layers[0]));
});

test('strip mode tidak meneruskan target layer bawah ke pemilih pathfinding', async () => {
  const remaining = new Set(['0,4,0', '1,4,0', '0,3,0']);
  const seen = [];
  const adapter = {
    blockAt: pos => ({ name: remaining.has(`${pos.x},${pos.y},${pos.z}`) ? 'stone' : 'air', position: pos,
      boundingBox: remaining.has(`${pos.x},${pos.y},${pos.z}`) ? 'block' : 'empty' }),
    approachReachableWork: async actions => {
      seen.push(actions.map(action => action.pos.y));
      return { target: actions[0], stance: null };
    },
    getInventoryFreeSlotCount: () => 36,
    getInventoryItems: () => [],
    getItemCount: name => name === 'iron_pickaxe' ? 1 : 0,
    getEntities: () => [],
    isQuarryOverheadSafe: () => true,
    dig: async block => remaining.delete(`${block.position.x},${block.position.y},${block.position.z}`)
  };
  const result = await excavateStorageQuarry({
    bot: { health: 20, food: 20, entity: { position: { x: 0, y: 5, z: 0 } } },
    adapter, bounds: { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 4 },
    maxBlocks: 3, minInventoryFillRatio: 0, mode: 'strip_surface_to_floor'
  });
  assert.deepEqual(seen, [[4, 4], [4], [3]]);
  assert.equal(result.cleared, 3);
});

test('surface flatten merencanakan hanya blok di atas level permukaan bersama', () => {
  const adapter = {
    blockAt: pos => {
      const top = pos.x === 0 ? 4 : pos.z === 0 ? 3 : 2;
      return pos.y <= top ? { name: 'stone' } : { name: 'air' };
    }
  };
  const plan = planSurfaceFlattening(adapter, { minX: 0, maxX: 1, minZ: 0, maxZ: 1, floorY: 0, maxY: 6 });
  assert.equal(plan.targetY, 3);
  assert.equal(plan.actions.length, 2);
  assert.ok(plan.actions.every(action => action.pos.y > 3));
});

test('quarry melewati stance yang tidak terjangkau tanpa membatalkan antrean', async () => {
  const blocks = new Map([
    ['1,2,1', { name: 'stone' }],
    ['1,1,1', { name: 'stone' }]
  ]);
  let selections = 0;
  let digs = 0;
  const adapter = {
    blockAt: pos => ({ ...(blocks.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air' }), position: pos, boundingBox: blocks.has(`${pos.x},${pos.y},${pos.z}`) ? 'block' : 'empty' }),
    approachReachableWork: async actions => ({
      target: actions[0],
      stance: selections++ === 0 ? { position: { x: 0, y: 2, z: 1 } } : null
    }),
    navigateNear: async () => false,
    getInventoryFreeSlotCount: () => 36,
    getInventoryItems: () => [],
    getItemCount: name => name === 'iron_pickaxe' ? 1 : 0,
    getEntities: () => [],
    isQuarryOverheadSafe: () => true,
    dig: async block => { digs += 1; blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`); }
  };
  const result = await excavateStorageQuarry({
    bot: { health: 20, food: 20, entity: { position: { x: 1, y: 3, z: 1 } } },
    adapter, maxBlocks: 1, minInventoryFillRatio: 0,
    bounds: { minX: 0, maxX: 2, minZ: 0, maxZ: 2, floorY: 0, maxY: 3 }
  });
  assert.equal(digs, 1);
  assert.equal(result.cleared, 1);
  assert.equal(result.reason, 'NO_REACHABLE_TARGET');
});

test('quarry resume skips blocks already confirmed in checkpoint', async () => {
  const first = `${QUARRY_BOUNDS.minX + 3},70,${QUARRY_BOUNDS.minZ}`;
  const second = `${QUARRY_BOUNDS.minX + 3},70,${QUARRY_BOUNDS.minZ + 1}`;
  const blocks = new Map([[first, { name: 'stone' }], [second, { name: 'stone' }]]);
  let digs = 0;
  const adapter = {
    blockAt: pos => ({ ...(blocks.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air' }), position: pos }),
    getInventoryFreeSlotCount: () => 20,
    getItemCount: name => name === 'iron_pickaxe' ? 1 : 0,
    getEntities: () => [],
    isQuarryOverheadSafe: () => true,
    dig: async block => { digs += 1; blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`); }
  };
  const bot = { health: 20, food: 20, entity: { position: { y: 70 } } };
  const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarry-resume-'));
  const checkpointFile = path.join(checkpointDir, 'checkpoint.json');
  await fs.writeFile(checkpointFile, JSON.stringify({ completed: [first], phase: 'quarry' }));
  const result = await excavateStorageQuarry({ bot, adapter, maxBlocks: 1, checkpointFile });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.cleared, 1);
  assert.equal(digs, 1);
  const saved = JSON.parse(await fs.readFile(checkpointFile, 'utf8'));
  assert.deepEqual(new Set(saved.completed), new Set([first, second]));
  await fs.rm(checkpointDir, { recursive: true, force: true });
});

test('quarry mengejar 75 persen slot sebelum berhenti melewati batch minimum', async () => {
  const blocks = new Set(Array.from({ length: 80 }, (_, index) => `0,${index + 1},0`));
  let digs = 0;
  const adapter = {
    blockAt: pos => blocks.has(`${pos.x},${pos.y},${pos.z}`) ? { name: 'stone', position: pos, boundingBox: 'block' } : { name: 'air', position: pos },
    getInventoryFreeSlotCount: () => Math.max(0, 36 - Math.floor(digs / 2)),
    getInventoryItems: () => Array.from({ length: 36 - Math.max(0, 36 - Math.floor(digs / 2)) }, () => ({ name: 'stone', count: 64 })),
    getItemCount: name => name === 'iron_pickaxe' ? 1 : 0,
    getEntities: () => [],
    isQuarryOverheadSafe: () => true,
    dig: async block => { digs += 1; blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`); }
  };
  const result = await excavateStorageQuarry({
    bot: { health: 20, food: 20, entity: { position: { x: 0, y: 1, z: 0 } } },
    adapter, maxBlocks: 1, minInventoryFillRatio: 0.75,
    bounds: { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 80 }
  });
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.reason, 'CARRY_TARGET');
  assert.equal(result.inventoryOccupiedSlots, 27);
  assert.ok(digs >= 54, `quarry hanya menggali ${digs} blok`);
});

test('mode state-driven berhenti pada target inventory walau cap kompatibilitas masih besar', async () => {
  const blocks = new Set(Array.from({ length: 80 }, (_, index) => `0,${index + 1},0`));
  let digs = 0;
  const adapter = {
    blockAt: pos => blocks.has(`${pos.x},${pos.y},${pos.z}`)
      ? { name: 'stone', position: pos, boundingBox: 'block' }
      : { name: 'air', position: pos },
    getInventoryFreeSlotCount: () => Math.max(0, 36 - Math.floor(digs / 2)),
    getInventoryItems: () => Array.from({ length: Math.floor(digs / 2) }, () => ({ name: 'stone' })),
    getItemCount: name => name === 'iron_pickaxe' ? 1 : 0,
    getEntities: () => [],
    isQuarryOverheadSafe: () => true,
    dig: async block => { digs += 1; blocks.delete(`${block.position.x},${block.position.y},${block.position.z}`); }
  };
  const result = await excavateStorageQuarry({
    bot: { health: 20, food: 20, entity: { position: { x: 0, y: 1, z: 0 } } },
    adapter,
    maxBlocks: 1000,
    stateDriven: true,
    minInventoryFillRatio: 0.75,
    bounds: { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 80 }
  });
  assert.equal(result.reason, 'CARRY_TARGET');
  assert.equal(digs, 54);
  assert.equal(result.inventoryFillRatio, 0.75);
});
