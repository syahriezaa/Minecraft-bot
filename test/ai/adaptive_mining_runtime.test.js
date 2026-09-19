const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runAdaptiveMiningFrontier } = require('../../src/ai/adaptiveMiningRuntime');

function adapterWithFill(state, reservations = null) {
  return {
    bot: {},
    getInventoryFreeSlotCount: () => 36 - state.occupied,
    getInventoryItems: () => Array.from({ length: state.occupied }, () => ({ name: 'stone' })),
    sharedWorldObserver: reservations ? { reservations } : null
  };
}

test('runtime frontier memperluas ke timur tanpa batch sampai target inventory tercapai', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adaptive-frontier-'));
  const checkpointFile = path.join(dir, 'worker.json');
  const state = { occupied: 0 };
  const visited = [];
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 },
    adapter: adapterWithFill(state),
    seedBounds: { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 },
    checkpointFile,
    minInventoryFillRatio: 0.75,
    survey: (_adapter, bounds) => ({ bounds, classification: 'SAFE', mineable: true, confidence: 1 }),
    excavate: async options => {
      visited.push(options.bounds);
      assert.equal(options.stateDriven, true);
      assert.equal(options.maxBlocks, Number.MAX_SAFE_INTEGER);
      state.occupied += 9;
      return { status: 'COMPLETE', reason: 'EXCAVATED', cleared: 20 };
    }
  });
  assert.equal(result.reason, 'INVENTORY_TARGET');
  assert.equal(result.cleared, 60);
  assert.equal(visited.length, 3);
  assert.deepEqual(visited.map(bounds => bounds.minX), [-66, -62, -58]);
  const saved = JSON.parse(await fs.readFile(`${checkpointFile}.frontier.json`, 'utf8'));
  assert.equal(saved.bounds.minX, -58);
  await fs.rm(dir, { recursive: true, force: true });
});

test('runtime frontier berhenti aman ketika sel berikutnya adalah laut', async () => {
  const state = { occupied: 2 };
  let surveys = 0;
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 },
    adapter: adapterWithFill(state),
    seedBounds: { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 },
    minInventoryFillRatio: 0.75,
    survey: (_adapter, bounds) => {
      surveys += 1;
      return surveys === 1
        ? { bounds, classification: 'SAFE', mineable: true }
        : { bounds, classification: 'OCEAN', mineable: false };
    },
    excavate: async () => ({ status: 'COMPLETE', reason: 'EXCAVATED', cleared: 12 })
  });
  assert.equal(result.reason, 'FRONTIER_OCEAN');
  assert.equal(result.cleared, 12);
  assert.equal(surveys, 2);
});

test('runtime melewati frontier terlindungi lalu berhenti saat mencapai laut', async () => {
  const state = { occupied: 0 };
  let surveys = 0;
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 },
    adapter: adapterWithFill(state),
    seedBounds: { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 },
    survey: (_adapter, bounds) => {
      surveys += 1;
      return surveys === 1
        ? { bounds, classification: 'PROTECTED', mineable: false }
        : { bounds, classification: 'OCEAN', mineable: false };
    },
    excavate: async () => { throw new Error('sel terlindungi tidak boleh digali'); }
  });
  assert.equal(result.reason, 'FRONTIER_OCEAN');
  assert.equal(surveys, 2);
});

test('runtime frontier memakai lease eksklusif per sel', async () => {
  const state = { occupied: 0 };
  const events = [];
  const reservations = {
    acquire: (_context, resources, ttl) => { events.push(['acquire', resources[0], ttl]); return { token: 'lease', count: 1, ttl }; },
    renew: () => true,
    release: lease => events.push(['release', lease.token])
  };
  const bot = {
    health: 20, food: 20, game: { dimension: 'overworld' },
    _client: { options: { host: 'test.local', port: 25565 } }
  };
  const result = await runAdaptiveMiningFrontier({
    bot,
    adapter: adapterWithFill(state, reservations),
    seedBounds: { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 },
    survey: (_adapter, bounds) => ({ bounds, classification: 'SAFE', mineable: true }),
    excavate: async () => { state.occupied = 27; return { status: 'PAUSED', reason: 'CARRY_TARGET', cleared: 8 }; }
  });
  assert.equal(result.reason, 'CARRY_TARGET');
  assert.match(events[0][1], /^mining-cell:mining:/);
  assert.deepEqual(events.at(-1), ['release', 'lease']);
});

test('runtime menyiapkan dan memuat sel aktif sebelum melakukan survei', async () => {
  const state = { occupied: 0 };
  const order = [];
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 },
    adapter: adapterWithFill(state),
    seedBounds: { minX: -66, maxX: -63, minZ: -406, maxZ: -400, floorY: 40, maxY: 80 },
    prepareCell: async cell => { order.push(`prepare:${cell.bounds.minX}`); return false; },
    survey: () => { order.push('survey'); return { classification: 'SAFE', mineable: true }; },
    excavate: async () => { order.push('excavate'); return { status: 'COMPLETE', reason: 'EXCAVATED', cleared: 1 }; }
  });
  assert.equal(result.reason, 'FRONTIER_UNREACHABLE');
  assert.deepEqual(order, ['prepare:-66']);
});

test('runtime meneruskan permukaan hasil survei sebagai batas atas penggalian', async () => {
  const state = { occupied: 0 };
  let excavationBounds;
  const seedBounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 80 };
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 },
    adapter: adapterWithFill(state),
    seedBounds,
    survey: () => ({
      classification: 'SAFE', mineable: true,
      surface: { minY: 61, maxY: 68, columns: 16, scanTop: 104 },
      excavationBounds: { ...seedBounds, maxY: 68 }
    }),
    excavate: async options => {
      excavationBounds = options.bounds;
      state.occupied = 27;
      return { status: 'PAUSED', reason: 'CARRY_TARGET', cleared: 4 };
    }
  });
  assert.equal(result.reason, 'CARRY_TARGET');
  assert.deepEqual(excavationBounds, { ...seedBounds, maxY: 68 });
});

test('runtime meneruskan topologi rongga 3D ke executor', async () => {
  const state = { occupied: 0 };
  const seedBounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 20 };
  const voidTopology = {
    caveColumns: ['1,1'], ravineColumns: [], boundaryColumns: ['1,1', '1,2'],
    evidence: { caveColumns: 1 }, policy: { maxSafeDrop: 1, ravineDepth: 4 }
  };
  let received;
  let receivedPolicy;
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 }, adapter: adapterWithFill(state), seedBounds,
    survey: () => ({ classification: 'CAVE_EDGE', mineable: true, restricted: true,
      excavationBounds: seedBounds, voidTopology }),
    excavate: async options => {
      received = options.voidTopology;
      receivedPolicy = options.allowSafeVoidBoundary;
      state.occupied = 27;
      return { status: 'PAUSED', reason: 'CARRY_TARGET', cleared: 2 };
    }
  });
  assert.equal(result.reason, 'CARRY_TARGET');
  assert.equal(received, voidTopology);
  assert.equal(receivedPolicy, true);
});

test('runtime melanjutkan ke frontier berikutnya setelah edge void habis', async () => {
  const state = { occupied: 0 };
  const seedBounds = { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 20 };
  let surveys = 0;
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 }, adapter: adapterWithFill(state), seedBounds,
    survey: (_adapter, bounds) => {
      surveys += 1;
      return surveys === 1
        ? { bounds, classification: 'CAVE_EDGE', restricted: true, mineable: true, voidTopology: { policy: {} } }
        : { bounds, classification: 'SAFE', mineable: true, voidTopology: { policy: {} } };
    },
    excavate: async () => {
      if (surveys === 1) return { status: 'PAUSED', reason: 'VOID_BOUNDARY', cleared: 0 };
      state.occupied = 27;
      return { status: 'COMPLETE', reason: 'EXCAVATED', cleared: 1 };
    }
  });
  assert.equal(result.reason, 'INVENTORY_TARGET');
  assert.equal(surveys, 2);
});

test('runtime meneruskan footprint akses ke survei struktur', async () => {
  const state = { occupied: 0 };
  const protectedCells = ['0,3,0'];
  let surveyOptions;
  const result = await runAdaptiveMiningFrontier({
    bot: { health: 20, food: 20 }, adapter: adapterWithFill(state),
    seedBounds: { minX: 0, maxX: 3, minZ: 0, maxZ: 3, floorY: 0, maxY: 4 },
    protectedCells,
    survey: (_adapter, bounds, options) => {
      surveyOptions = options;
      return { classification: 'SAFE', mineable: true, excavationBounds: bounds };
    },
    excavate: async () => {
      state.occupied = 27;
      return { status: 'PAUSED', reason: 'CARRY_TARGET', cleared: 1 };
    }
  });
  assert.equal(result.reason, 'CARRY_TARGET');
  assert.equal(surveyOptions.ignoredStructureCells, protectedCells);
});
