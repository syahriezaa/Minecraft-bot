const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WoodGathererEngine, plantationGrid, plantationCandidateOffsets, evaluatePlantationSite, analyzeNaturalTree } = require('../../src/ai/woodGathererEngine');

function adapterFor(map) {
  return { blockAt: p => map.get(`${p.x},${p.y},${p.z}`) || { name: 'air', position: { ...p }, boundingBox: 'empty' } };
}

test('grid perkebunan berjarak empat blok dan tersusun rapi', () => {
  const grid = plantationGrid({ x: 0, z: 0 });
  assert.equal(grid.length, 12);
  assert.deepEqual([...new Set(grid.map(p => p.x))], [-6, -2, 2, 6]);
  assert.deepEqual([...new Set(grid.map(p => p.z))], [-4, 0, 4]);
});

test('survei perkebunan memperluas pencarian dalam cincin tanpa kandidat duplikat', () => {
  const candidates = plantationCandidateOffsets();
  assert.ok(candidates.length >= 64);
  assert.equal(new Set(candidates.map(([x, z]) => `${x},${z}`)).size, candidates.length);
  assert.ok(candidates.some(([x, z]) => Math.hypot(x, z) >= 100));
});

test('lokasi tanam harus jauh dari base, datar, dan bebas struktur', () => {
  const map = new Map();
  for (const p of plantationGrid({ x: 40, z: 0 })) map.set(`${p.x},70,${p.z}`, { name: 'grass_block', position: { x: p.x, y: 70, z: p.z }, boundingBox: 'block' });
  const adapter = adapterFor(map);
  assert.equal(evaluatePlantationSite(adapter, { x: 40, y: 71, z: 0 }, { base: { x: 0, y: 71, z: 0 } }).safe, true);
  assert.equal(evaluatePlantationSite(adapter, { x: 10, y: 71, z: 0 }, { base: { x: 0, y: 71, z: 0 } }).safe, false);
  assert.equal(evaluatePlantationSite(adapter, { x: 40, y: 71, z: 0 }, { base: { x: 0, y: 71, z: 0 }, structures: [{ minX: 38, maxX: 42, minZ: -2, maxZ: 2 }] }).safe, false);
});

test('vegetasi permukaan yang dapat diganti tidak membuat lahan aman ditolak', () => {
  const map = new Map();
  for (const p of plantationGrid({ x: 40, z: 0 })) {
    map.set(`${p.x},70,${p.z}`, { name: 'grass_block', position: { x: p.x, y: 70, z: p.z }, boundingBox: 'block' });
    map.set(`${p.x},71,${p.z}`, { name: 'short_grass', position: { x: p.x, y: 71, z: p.z }, boundingBox: 'empty' });
  }
  assert.equal(evaluatePlantationSite(adapterFor(map), { x: 40, y: 71, z: 0 }, { base: { x: 0, y: 71, z: 0 } }).safe, true);
});

test('survei menilai voxel sebelum meminta reservasi navigasi', async () => {
  const map = new Map();
  for (const p of plantationGrid({ x: -40, z: 0 })) map.set(`${p.x},70,${p.z}`, { name: 'grass_block', position: { x: p.x, y: 70, z: p.z }, boundingBox: 'block' });
  let navigationCalls = 0;
  const adapter = { ...adapterFor(map), navigateNear: async () => { navigationCalls += 1; return true; } };
  const engine = new WoodGathererEngine({ adapter, base: { x: 0, y: 71, z: 0 } });
  const site = await engine.surveyPlantation();
  assert.equal(site.safe, true);
  assert.equal(navigationCalls, 1);
  assert.deepEqual(site.center, { x: -40, y: 71, z: 0 });
});

test('survei membuka chunk yang belum diketahui lalu menilai ulang voxel', async () => {
  const map = new Map();
  let surveyCalls = 0;
  const adapter = {
    blockAt: p => map.get(`${p.x},${p.y},${p.z}`) || null,
    navigateNear: async () => true
  };
  const engine = new WoodGathererEngine({
    adapter,
    base: { x: 0, y: 71, z: 0 },
    surveyNavigate: async center => {
      surveyCalls += 1;
      for (const p of plantationGrid(center)) {
        map.set(`${p.x},70,${p.z}`, { name: 'grass_block', position: { x: p.x, y: 70, z: p.z }, boundingBox: 'block' });
        for (let y = 71; y <= 77; y += 1) map.set(`${p.x},${y},${p.z}`, { name: 'air', position: { x: p.x, y, z: p.z }, boundingBox: 'empty' });
      }
      return true;
    }
  });
  assert.ok(await engine.surveyPlantation());
  assert.equal(surveyCalls, 1);
});

test('hanya batang dengan kanopi daun dan tanpa blok bangunan dianggap pohon alami', () => {
  const map = new Map();
  for (let y = 64; y <= 68; y += 1) map.set(`0,${y},0`, { name: 'oak_log', position: { x: 0, y, z: 0 }, boundingBox: 'block' });
  for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) {
    if (x === 0 && z === 0) continue;
    map.set(`${x},68,${z}`, { name: 'oak_leaves', position: { x, y: 68, z }, boundingBox: 'block' });
  }
  const adapter = adapterFor(map);
  assert.equal(analyzeNaturalTree(adapter, map.get('0,64,0')).logs.length, 5);
  map.set('1,68,1', { name: 'oak_planks', position: { x: 1, y: 68, z: 1 }, boundingBox: 'block' });
  assert.equal(analyzeNaturalTree(adapter, map.get('0,64,0')), null);
});

test('pohon bercabang dihitung sebagai satu komponen dan minimal empat batang', () => {
  const map = new Map();
  const logs = [
    [0, 64, 0, 'oak_log'], [0, 65, 0, 'oak_log'], [0, 66, 0, 'oak_log'],
    [1, 66, 0, 'oak_wood'], [1, 66, 1, 'oak_wood']
  ];
  for (const [x, y, z, name] of logs) map.set(`${x},${y},${z}`, { name, position: { x, y, z }, boundingBox: 'block' });
  const logKeys = new Set(logs.map(([x, y, z]) => `${x},${y},${z}`));
  for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) {
    if (x === 0 && z === 0) continue;
    if (logKeys.has(`${x},66,${z}`)) continue;
    map.set(`${x},66,${z}`, { name: 'oak_leaves', position: { x, y: 66, z }, boundingBox: 'block' });
  }
  const tree = analyzeNaturalTree(adapterFor(map), map.get('0,64,0'));
  assert.equal(tree.logs.length, 5);
  assert.equal(tree.type, 'oak');
});

test('worker tidak memotong pohon yang sudah diklaim worker lain', async () => {
  const map = new Map();
  for (let y = 64; y <= 67; y += 1) map.set(`20,${y},0`, { name: 'oak_log', position: { x: 20, y, z: 0 }, boundingBox: 'block' });
  for (let x = 18; x <= 22; x += 1) for (let z = -2; z <= 2; z += 1) {
    if (x === 20 && z === 0) continue;
    map.set(`${x},67,${z}`, { name: 'oak_leaves', position: { x, y: 67, z }, boundingBox: 'block' });
  }
  const adapter = {
    ...adapterFor(map),
    findBlocksByNames: () => [map.get('20,64,0')],
    getPosition: () => ({ x: 20, y: 64, z: 0 }),
    navigateNear: async () => true,
    acquireSharedReservation: () => null,
    dig: async () => { throw new Error('Tidak boleh menggali pohon yang sudah diklaim'); }
  };
  const engine = new WoodGathererEngine({ adapter });
  const tree = engine.findTree(128);
  assert.ok(tree);
  assert.equal(await engine.harvest(tree), false);
  assert.equal(engine.metrics.trees, 0);
});

test('pencarian pohon menerima radius kerja yang lebih luas setelah kembali ke base', () => {
  const treeBlock = { name: 'oak_log', position: { x: 80, y: 64, z: 0 }, boundingBox: 'block' };
  const adapter = {
    findBlocksByNames: (_names, options) => {
      assert.equal(options.maxDistance, 128);
      return [treeBlock];
    },
    blockAt: position => {
      if (position.x === 80 && position.z === 0 && position.y >= 64 && position.y <= 68) {
        return { name: 'oak_log', position, boundingBox: 'block' };
      }
      if (position.x >= 78 && position.x <= 82 && position.z >= -2 && position.z <= 2 && position.y === 68) {
        return { name: 'oak_leaves', position, boundingBox: 'block' };
      }
      return { name: 'air', position, boundingBox: 'empty' };
    },
    getPosition: () => ({ x: 0, y: 71, z: 0 })
  };
  const engine = new WoodGathererEngine({ adapter, base: { x: 0, y: 71, z: 0 } });
  assert.equal(engine.findTree(128)?.bottom.x, 80);
});

test('pencarian pohon menolak log di bawah elevasi kerja agar tidak masuk gua', () => {
  const treeBlock = { name: 'oak_log', position: { x: 20, y: 43, z: 0 }, boundingBox: 'block' };
  const adapter = {
    findBlocksByNames: () => [treeBlock],
    blockAt: position => {
      if (position.x === 20 && position.z === 0 && position.y >= 43 && position.y <= 47) {
        return { name: 'oak_log', position, boundingBox: 'block' };
      }
      if (position.x >= 18 && position.x <= 22 && position.z >= -2 && position.z <= 2 && position.y === 47) {
        return { name: 'oak_leaves', position, boundingBox: 'block' };
      }
      return { name: 'air', position, boundingBox: 'empty' };
    },
    getPosition: () => ({ x: 0, y: 71, z: 0 })
  };
  const engine = new WoodGathererEngine({ adapter, minWorkY: 50 });
  assert.equal(engine.findTree(128), null);
});

test('pohon yang belum reachable tidak membuat worker mengulang target tanpa jeda', async () => {
  const treeBlock = { name: 'oak_log', position: { x: 20, y: 64, z: 0 }, boundingBox: 'block' };
  const adapter = {
    findBlocksByNames: () => [treeBlock],
    blockAt: position => {
      if (position.x === 20 && position.z === 0 && position.y >= 64 && position.y <= 68) {
        return { name: 'oak_log', position, boundingBox: 'block' };
      }
      if (position.x >= 18 && position.x <= 22 && position.z >= -2 && position.z <= 2 && position.y === 68) {
        return { name: 'oak_leaves', position, boundingBox: 'block' };
      }
      return { name: 'air', position, boundingBox: 'empty' };
    },
    getPosition: () => ({ x: 0, y: 71, z: 0 }),
    navigateNear: async () => false
  };
  const engine = new WoodGathererEngine({ adapter, unreachableRetryMs: 60000 });
  const tree = engine.findTree(128);
  assert.ok(tree);
  assert.equal(await engine.harvest(tree), false);
  assert.equal(engine.findTree(128), null);
});

test('pohon yang belum punya graph dicoba setelah warm-up survei chunk', async () => {
  const treeBlock = { name: 'oak_log', position: { x: 20, y: 64, z: 0 }, boundingBox: 'block' };
  const map = new Map();
  for (let y = 64; y <= 68; y += 1) map.set(`20,${y},0`, { name: 'oak_log', position: { x: 20, y, z: 0 }, boundingBox: 'block' });
  for (let x = 18; x <= 22; x += 1) for (let z = -2; z <= 2; z += 1) map.set(`${x},68,${z}`, { name: 'oak_leaves', position: { x, y: 68, z }, boundingBox: 'block' });
  let navigations = 0;
  const adapter = {
    findBlocksByNames: () => [treeBlock],
    blockAt: p => map.get(`${p.x},${p.y},${p.z}`) || { name: 'air', position: p, boundingBox: 'empty' },
    getPosition: () => ({ x: 0, y: 71, z: 0 }),
    navigateNear: async () => ++navigations > 1,
    dig: async () => true
  };
  const engine = new WoodGathererEngine({ adapter, surveyNavigate: async () => true });
  const result = await engine.harvest(engine.findTree(128));
  assert.equal(result, true);
  // Dua panggilan pertama membuka akses ke pohon; drop batang cukup dipungut
  // dari akar, jadi koordinat batang atas tidak lagi dijadikan target jalan.
  assert.equal(navigations, 4);
});

test('worker tidak menganggap akar dekat bila beda ketinggian terlalu jauh', async () => {
  const treeBlock = { name: 'oak_log', position: { x: 20, y: 64, z: 0 }, boundingBox: 'block' };
  const messages = [];
  const adapter = {
    findBlocksByNames: () => [treeBlock],
    blockAt: position => {
      if (position.x === 20 && position.z === 0 && position.y >= 64 && position.y <= 68) {
        return { name: 'oak_log', position, boundingBox: 'block' };
      }
      if (position.x >= 18 && position.x <= 22 && position.z >= -2 && position.z <= 2 && position.y === 68) {
        return { name: 'oak_leaves', position, boundingBox: 'block' };
      }
      return { name: 'air', position, boundingBox: 'empty' };
    },
    getPosition: () => ({ x: 20, y: 71, z: 0 }),
    bot: { canDigBlock: () => false, canSeeBlock: () => false },
    navigateNear: async () => false
  };
  const engine = new WoodGathererEngine({ adapter, surveyNavigate: async () => true, unreachableRetryMs: 60000, log: message => messages.push(message) });
  assert.equal(await engine.harvest(engine.findTree(128)), false);
  assert.ok(messages.some(message => message.includes('rute ke')));
  assert.equal(engine.findTree(128), null);
});

test('pohon dapat ditebang dari pijakan saat ini tanpa memaksa pathfinder masuk ke batang', async () => {
  const map = new Map();
  for (let y = 64; y <= 67; y += 1) map.set(`20,${y},0`, { name: 'oak_log', position: { x: 20, y, z: 0 }, boundingBox: 'block' });
  for (let x = 18; x <= 22; x += 1) for (let z = -2; z <= 2; z += 1) {
    if (x === 20 && z === 0) continue;
    map.set(`${x},67,${z}`, { name: 'oak_leaves', position: { x, y: 67, z }, boundingBox: 'block' });
  }
  let dug = false;
  const adapter = {
    ...adapterFor(map),
    findBlocksByNames: () => [map.get('20,64,0')],
    getPosition: () => ({ x: 20, y: 64, z: 1 }),
    bot: { canDigBlock: () => true, canSeeBlock: () => true },
    acquireSharedReservation: () => ({ release() {} }),
    navigateNear: async () => {
      if (!dug) throw new Error('navigateNear tidak boleh dipanggil sebelum akses langsung dipakai');
      return false;
    },
    dig: async () => { dug = true; return true; }
  };
  const engine = new WoodGathererEngine({ adapter });
  assert.equal(await engine.harvest(engine.findTree(128)), true);
  assert.equal(engine.metrics.logs, 4);
});
