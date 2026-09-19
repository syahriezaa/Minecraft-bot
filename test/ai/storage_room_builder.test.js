const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { StorageRoomBuilder, orderedBlocks } = require('../../src/ai/storageRoomBuilder');
const { createStorageRoomBlueprint } = require('../../src/ai/storageRoomBlueprint');
const { partitionBlueprint, filterBlueprintPhases, getWorksiteGoal, isNearEntryApproach, isNearWorksite } = require('../../src/ai/runStorageRoomBuilder');

function fakeBuilder({ blocks, world = {}, inventory = {}, entities = [], options = {}, checkpointFile } = {}) {
  const placed = [];
  const navigated = [];
  const worldMap = new Map(Object.entries(world));
  const bot = {
    health: options.health ?? 20,
    food: options.food ?? 20,
    entity: { position: { x: 0, y: 64, z: 0 } },
    entities: Object.fromEntries(entities.map((entity, index) => [index, entity])),
    placeBlock: async (reference, face) => {
      if (options.placeBlockError) throw new Error(options.placeBlockError);
      const p = { x: reference.position.x + face.x, y: reference.position.y + face.y, z: reference.position.z + face.z };
      worldMap.set(`${p.x},${p.y},${p.z}`, { name: placed.find(x => x.position.x === p.x && x.position.y === p.y && x.position.z === p.z)?.name || 'stone_bricks', position: p });
      placed.push({ position: p, face });
    },
    _placed: placed,
    _world: worldMap
  };
  const adapter = {
    blockAt: (pos) => worldMap.get(`${pos.x},${pos.y},${pos.z}`) || { name: 'air', boundingBox: 'empty', position: { ...pos } },
    getItemCount: (name) => inventory[name] || 0,
    equipItem: async (name) => (inventory[name] || 0) > 0,
    navigateNear: async (pos) => { navigated.push(pos); return true; },
    getEntities: () => entities,
    getPosition: () => bot.entity.position,
    dig: async (block) => {
      if (!options.digDoesNotClear) worldMap.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty', position: block.position });
    }
  };
  return { builder: new StorageRoomBuilder({ bot, adapter, blueprint: { blocks }, origin: { x: 10, y: 64, z: 10 }, checkpointFile, options }), bot, navigated };
}

describe('StorageRoomBuilder', () => {
  test('menggunakan placement adapter dengan jump underfoot sesudah navigasi', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: { '10,63,10': { name: 'dirt', position: { x: 10, y: 63, z: 10 } } },
      inventory: { stone_bricks: 1 }, options: { checkpointReconcileDelayMs: 0 }
    });
    const actions = [];
    builder.adapter.navigateNear = async () => { actions.push('navigate'); return true; };
    builder.adapter.placeBlockAt = async (pos, reference, face) => {
      actions.push('jump-place');
      assert.deepEqual(pos, { x: 10, y: 64, z: 10 });
      await bot.placeBlock(reference, face);
    };
    assert.equal((await builder.build()).status, 'COMPLETE');
    assert.deepEqual(actions, ['navigate', 'jump-place']);
  });

  test('memindahkan bot keluar dari target sebelum placement adapter modern', async () => {
    const { builder, bot, navigated } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } },
        '8,63,10': { name: 'stone', position: { x: 8, y: 63, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { checkpointReconcileDelayMs: 0 }
    });
    bot.entity.position = { x: 10.2, y: 64, z: 10.2 };
    builder.adapter.navigateNear = async pos => {
      navigated.push(pos);
      bot.entity.position = { x: pos.x + 0.2, y: pos.y, z: pos.z + 0.2 };
      return true;
    };
    builder.adapter.placeBlockAt = async pos => {
      assert.notDeepEqual(
        { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) },
        pos,
        'adapter tidak boleh dipanggil saat bot masih berdiri di target'
      );
      builder.adapter.blockAt = current => current.x === pos.x && current.y === pos.y && current.z === pos.z
        ? { name: 'stone_bricks', position: { ...current } }
        : builder.adapter.blockAt(current);
    };
    assert.equal((await builder.build()).status, 'COMPLETE');
    assert.ok(navigated.length >= 2);
  });

  test('meneruskan facing blueprint saat memasang chest agar pasangan menjadi double chest', async () => {
    const { builder } = fakeBuilder({
      blocks: [{ x: 0, y: 1, z: 0, name: 'chest', phase: 'storage', properties: { facing: 'north', type: 'right' } }],
      world: { '10,64,10': { name: 'stone', position: { x: 10, y: 64, z: 10 } } },
      inventory: { chest: 1 }, options: { checkpointReconcileDelayMs: 0 }
    });
    let placementOptions;
    let placedTarget;
    const originalGetBlock = builder.getBlock.bind(builder);
    builder.adapter.placeBlockAt = async (pos, reference, face, options) => {
      placementOptions = options;
      placedTarget = { ...pos };
    };
    builder.getBlock = pos => placedTarget && pos.x === placedTarget.x && pos.y === placedTarget.y && pos.z === placedTarget.z
      ? { name: 'chest', position: { ...pos } }
      : originalGetBlock(pos);
    assert.equal((await builder.build()).status, 'COMPLETE');
    assert.deepEqual(placementOptions, { facing: 'north' });
  });

  test('blok tidak diketahui bukan konfirmasi penggalian selesai', async () => {
    const { builder } = fakeBuilder({ blocks: [], options: { placementVerifyTimeoutMs: 1 } });
    builder.adapter.blockAt = () => null;
    assert.equal(await builder.waitForAir({ x: 10, y: 64, z: 10 }), false);
  });

  test('hanya mengganti stone brick yang diizinkan eksplisit pada blok pintu', () => {
    const door = { x: 1, y: 1, z: 0, name: 'oak_door', phase: 'entry', replaceNames: ['stone_bricks'] };
    const { builder } = fakeBuilder({
      blocks: [door],
      world: { '11,65,10': { name: 'stone_bricks', position: { x: 11, y: 65, z: 10 } } }
    });
    const allowed = builder.checkTarget(door);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.requiresDig, true);
    builder.adapter.blockAt = pos => pos.x === 11 && pos.y === 65 && pos.z === 10
      ? { name: 'oak_planks', position: { ...pos } }
      : { name: 'air', boundingBox: 'empty', position: { ...pos } };
    assert.equal(builder.checkTarget(door).code, 'BLOCKED');
  });

  test('membuka pintu entry yang sudah terpasang tanpa meminta material', async () => {
    const { builder } = fakeBuilder({
      blocks: [{ x: 0, y: 1, z: 0, name: 'oak_door', phase: 'entry', properties: { half: 'lower', open: true } }],
      world: { '10,65,10': { name: 'oak_door', properties: { half: 'lower', open: false }, position: { x: 10, y: 65, z: 10 } } },
      options: { checkpointReconcileDelayMs: 0 }
    });
    let toggles = 0;
    builder.adapter.toggleDoor = async pos => {
      toggles += 1;
      builder.adapter.blockAt(pos).properties.open = true;
      return true;
    };

    const preflight = await builder.preflight({ maxBlocks: 1 });
    assert.deepEqual(preflight.requiredMaterials, {});
    assert.deepEqual(preflight.missingMaterials, {});
    const result = await builder.build({ maxBlocks: 1 });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(builder.adapter.blockAt({ x: 10, y: 65, z: 10 }).properties.open, true);
    assert.equal(toggles, 1);
  });

  test('membersihkan hanya blok dinding yang diizinkan untuk membuka jalan masuk', async () => {
    const opening = { x: 1, y: 1, z: 0, name: 'air', phase: 'entry', replaceNames: ['stone_bricks'] };
    const { builder } = fakeBuilder({
      blocks: [opening],
      world: { '11,65,10': { name: 'stone_bricks', position: { x: 11, y: 65, z: 10 } } },
      options: { placementVerifyTimeoutMs: 500, checkpointReconcileDelayMs: 0 }
    });
    const preflight = await builder.preflight();
    assert.deepEqual(preflight.requiredMaterials, {});
    assert.equal(builder.affordableBlockLimit(1), 1);
    const result = await builder.placeOne(opening);
    assert.equal(result.ok, true);
    assert.equal(builder.adapter.blockAt({ x: 11, y: 65, z: 10 }).name, 'air');
  });

  test('tetap restock saat prefix murah hanya berisi blok yang sudah terpasang', async () => {
    const inventory = {};
    const { builder } = fakeBuilder({
      blocks: [
        { x: 0, y: 1, z: 0, name: 'stone_bricks', phase: 'entry' },
        { x: 1, y: 1, z: 0, name: 'stone_bricks', phase: 'entry' }
      ],
      world: {
        '10,65,10': { name: 'stone_bricks', position: { x: 10, y: 65, z: 10 } },
        '11,64,10': { name: 'stone_bricks', position: { x: 11, y: 64, z: 10 } }
      },
      inventory,
      options: {
        checkpointReconcileDelayMs: 0,
        restockMaterials: async () => { inventory.stone_bricks = 1; }
      }
    });
    const result = await builder.build({ maxBlocks: 2 });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.built, 1);
  });

  test('preflight observasi tidak menyerang mob atau mengubah dunia', async () => {
    const { builder } = fakeBuilder({ blocks: [], entities: [{ name: 'zombie', position: { x: 1, y: 64, z: 1 } }] });
    builder.adapter.attack = async () => { throw new Error('observasi tidak boleh menyerang'); };
    const result = await builder.preflight();
    assert.equal(result.ok, false);
    assert.match(result.hazard, /zombie/);
  });
  test('membagi blueprint menjadi delapan segmen tanpa memotong pasangan double chest atau overlap blok', () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const parts = Array.from({ length: 8 }, (_, index) => partitionBlueprint(blueprint, index, 8));
    assert.equal(parts.reduce((total, part) => total + part.blocks.length, 0), blueprint.blocks.length);
    assert.equal(parts.reduce((total, part) => total + part.pairs.length, 0), blueprint.pairs.length);
    assert.equal(parts.reduce((total, part) => total + part.doubleChests, 0), 260);
    const seen = new Set();
    for (const part of parts) {
      for (const block of part.blocks) {
        const id = `${block.x},${block.y},${block.z}`;
        assert.equal(seen.has(id), false, `blok overlap ${id}`);
        seen.add(id);
      }
      for (const pair of part.pairs) {
        const minZ = Math.floor(part.workerIndex * blueprint.dimensions.depth / 8);
        assert.ok(pair.left.z >= minZ && pair.left.z < Math.floor((part.workerIndex + 1) * blueprint.dimensions.depth / 8));
      }
    }
  });

  test('menganggap bot yang sudah berada di dalam sayap sebagai dekat worksite sehingga tidak dipaksa menuju blok sudut', () => {
    const blueprint = createStorageRoomBlueprint({ minimumChests: 250, countAs: 'double' });
    const part = partitionBlueprint(blueprint, 0, 4);
    assert.equal(isNearWorksite({ x: -121, y: 67, z: -395 }, { origin: { x: -121, y: 70, z: -400 }, blueprint: part }), true);
    assert.equal(isNearWorksite({ x: -185, y: 71, z: -352 }, { origin: { x: -121, y: 70, z: -400 }, blueprint: part }), false);
  });

  test('mendekati fase pintu dari teras depan, bukan dari balik dinding', () => {
    const blueprint = filterBlueprintPhases(createStorageRoomBlueprint(), ['entry']);
    const goal = getWorksiteGoal({ x: -110, y: 70, z: -400 }, blueprint);
    assert.deepEqual(goal, { x: -89, y: 71, z: -404 });
    assert.equal(isNearEntryApproach({ x: -104, y: 64, z: -402 }, goal), false);
    assert.equal(isNearEntryApproach({ x: -90, y: 70, z: -404 }, goal), true);
  });

  test('mengurutkan fase fondasi dan entry sebelum dinding, rak, lampu, dan atap', () => {
    const blocks = orderedBlocks([
      { x: 0, y: 5, z: 0, name: 'stone_bricks', phase: 'roof' },
      { x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' },
      { x: 0, y: 1, z: 0, name: 'oak_door', phase: 'entry' },
      { x: 0, y: 1, z: 0, name: 'chest', phase: 'storage' },
      { x: 0, y: 1, z: 1, name: 'stone_bricks', phase: 'walls' }
    ]);
    assert.deepEqual(blocks.map(block => block.phase), ['floor', 'entry', 'walls', 'storage', 'roof']);
  });

  test('preflight menolak area yang belum diketahui atau cairan dan tidak melakukan placement', async () => {
    const { builder, bot } = fakeBuilder({ blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }], world: { '10,64,10': { name: 'water', position: { x: 10, y: 64, z: 10 } } }, inventory: { stone_bricks: 1 } });
    const result = await builder.build();
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.blocked[0].code, 'LIQUID');
    assert.equal(bot._placed.length, 0);
  });

  test('preflight menolak material kurang sebelum dunia disentuh', async () => {
    const { builder, bot } = fakeBuilder({ blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }], world: { '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } }, '10,63,10': { name: 'dirt', position: { x: 10, y: 63, z: 10 } } }, inventory: {} });
    const result = await builder.build();
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.missingMaterials.stone_bricks.required, 1);
    assert.equal(bot._placed.length, 0);
  });

  test('memasang satu blok lalu verifikasi dan bisa dilanjutkan dari checkpoint', async () => {
    const checkpointFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'storage-builder-')), 'checkpoint.json');
    const baseWorld = { '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } }, '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } }, '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } } };
    const first = fakeBuilder({ blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }], world: baseWorld, inventory: { stone_bricks: 1 }, checkpointFile });
    const result = await first.builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(first.bot._placed.length, 1);
    baseWorld['10,64,10'] = { name: 'stone_bricks', position: { x: 10, y: 64, z: 10 } };
    const second = fakeBuilder({ blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }], world: baseWorld, inventory: {}, checkpointFile });
    await second.builder.loadCheckpoint();
    assert.equal((await second.builder.build()).status, 'COMPLETE');
    assert.equal(second.bot._placed.length, 0);
  });

  test('memperbaiki checkpoint yang sudah menandai blok tetapi blok live hilang', async () => {
    const checkpointDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-builder-repair-'));
    const checkpointFile = path.join(checkpointDir, 'checkpoint.json');
    await fs.writeFile(checkpointFile, JSON.stringify({ completed: ['10,64,10'], phase: 'floor' }));
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      checkpointFile
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._placed.length, 1);
  });

  test('tidak meminta material untuk blok yang sudah ada walau checkpoint belum pernah dibuat', async () => {
    const { builder } = fakeBuilder({ blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }], world: { '10,64,10': { name: 'stone_bricks', position: { x: 10, y: 64, z: 10 } } }, inventory: {} });
    const result = await builder.preflight({ maxBlocks: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.requiredMaterials, {});
  });

  test('berhenti ketika creeper terlalu dekat', async () => {
    const { builder, bot } = fakeBuilder({ blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }], world: { '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } }, '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } } }, inventory: { stone_bricks: 1 }, entities: [{ name: 'creeper', position: { x: 2, y: 64, z: 2 } }] });
    bot.entity.position = { x: 0, y: 64, z: 0 };
    const result = await builder.build();
    assert.equal(result.status, 'BLOCKED');
    assert.match(result.hazard, /creeper/);
  });

  test('meminta restock ketika health rendah sebelum placement', async () => {
    let restockCalls = 0;
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: {
        health: 10,
        restockMaterials: async () => { restockCalls += 1; bot.health = 20; bot.food = 20; }
      }
    });
    const result = await builder.build({ maxBlocks: 1 });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(restockCalls, 1);
  });

  test('tidak memblokir pembangunan karena creeper terpisah beberapa blok di bawah lantai', async () => {
    const { builder } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      entities: [{ name: 'creeper', position: { x: 2, y: 59, z: 2 } }]
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
  });

  test('membuat fondasi pada kolom kosong sebelum memasang lantai', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 63, z: 10 } },
        '10,62,10': { name: 'stone', position: { x: 10, y: 62, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 2 },
      options: { allowFoundationFill: true }
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._placed.length, 2);
    assert.equal(bot._world.get('10,63,10').name, 'stone_bricks');
    assert.equal(bot._world.get('10,64,10').name, 'stone_bricks');
  });

  test('memindahkan bot keluar dari volume target sebelum placement fondasi', async () => {
    const { builder, bot, navigated } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } },
        '8,63,10': { name: 'stone', position: { x: 8, y: 63, z: 10 } }
      },
      inventory: { stone_bricks: 1 }
    });
    bot.entity.position = { x: 10.2, y: 64, z: 10.2 };
    const result = await builder.build({ maxBlocks: 1 });
    assert.equal(result.status, 'COMPLETE');
    assert.deepEqual(navigated[0], { x: 8, y: 64, z: 10 });
  });

  test('menggali blok natural yang diizinkan sebelum placement', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'dirt', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { allowExcavation: true }
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._placed.length, 1);
    assert.equal(bot._world.get('10,64,10').name, 'stone_bricks');
  });

  test('menggali log pohon yang menutup footprint builder tanpa membuka blok bangunan', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'oak_log', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { allowExcavation: true }
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._world.get('10,64,10').name, 'stone_bricks');
  });

  test('menggali cobblestone yang menghalangi lantai saat terrain work diizinkan', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'cobblestone', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { allowExcavation: true }
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._world.get('10,64,10').name, 'stone_bricks');
  });

  test('menggali flora dengan boundingBox kosong sebelum placement, bukan menganggapnya udara', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'walls' }],
      world: {
        '10,64,10': { name: 'dandelion', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { allowExcavation: true }
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._placed.length, 1);
    assert.equal(bot._world.get('10,64,10').name, 'stone_bricks');
  });

  test('mengganti torch lama yang berada di sel lantai blueprint', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'torch', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { allowExcavation: true }
    });
    const result = await builder.build();
    assert.equal(result.status, 'COMPLETE');
    assert.equal(bot._placed.length, 1);
    assert.equal(bot._world.get('10,64,10').name, 'stone_bricks');
  });

  test('pause dengan kode EXCAVATION bila server tidak mengonfirmasi blok natural sudah tergali', async () => {
    const { builder } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'dirt', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { allowExcavation: true, digDoesNotClear: true }
    });
    const result = await builder.build({ maxBlocks: 1 });
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.code, 'EXCAVATION');
  });

  test('menyimpan status paused saat server menolak placement, bukan crash', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [{ x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,64,10': { name: 'stone', position: { x: 11, y: 64, z: 10 } }
      },
      inventory: { stone_bricks: 1 },
      options: { placeBlockError: 'server belum mengonfirmasi blok' }
    });
    const result = await builder.build();
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.code, 'PLACEMENT');
    assert.equal(bot._placed.length, 0);
  });

  test('tetap mengerjakan prefix batch saat material hanya cukup sebagian', async () => {
    const { builder, bot } = fakeBuilder({
      blocks: [
        { x: 0, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' },
        { x: 1, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' },
        { x: 2, y: 0, z: 0, name: 'stone_bricks', phase: 'floor' }
      ],
      world: {
        '10,64,10': { name: 'air', boundingBox: 'empty', position: { x: 10, y: 64, z: 10 } },
        '11,64,10': { name: 'air', boundingBox: 'empty', position: { x: 11, y: 64, z: 10 } },
        '12,64,10': { name: 'air', boundingBox: 'empty', position: { x: 12, y: 64, z: 10 } },
        '10,63,10': { name: 'stone', position: { x: 10, y: 63, z: 10 } },
        '11,63,10': { name: 'stone', position: { x: 11, y: 63, z: 10 } },
        '12,63,10': { name: 'stone', position: { x: 12, y: 63, z: 10 } }
      },
      inventory: { stone_bricks: 2 },
      options: { restockMaterials: async () => { throw new Error('Jangan pulang saat masih ada bahan yang bisa dipasang.'); } }
    });
    const result = await builder.build({ maxBlocks: 3 });
    assert.equal(result.status, 'PAUSED');
    assert.equal(result.built, 2);
    assert.equal(result.remainingBlocks, 1);
    assert.equal(bot._placed.length, 2);
  });
});
