const { test } = require('node:test');
const assert = require('node:assert/strict');
const { surveyAdaptiveMiningCell } = require('../../src/ai/adaptiveMiningSurvey');

const bounds = { minX: 0, maxX: 1, minZ: 0, maxZ: 1, floorY: 0, maxY: 4 };

function adapter(blockAt) {
  return { blockAt, bot: { game: { minY: 0, height: 8 } } };
}

test('survei frontier menerima terrain natural yang seluruh voxelnya dikenal', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({ name: pos.y <= 3 ? 'stone' : 'air' })), bounds, { aboveScanHeight: 1 });
  assert.equal(result.classification, 'SAFE');
  assert.deepEqual(result.surface, { minY: 3, maxY: 3, columns: 4, scanTop: 5 });
  assert.deepEqual(result.excavationBounds, { ...bounds, maxY: 3 });
});

test('survei permukaan memakai blok solid tertinggi setiap kolom', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({
    name: pos.y <= (pos.x === 0 ? 2 : 5) ? 'stone' : 'air'
  })), bounds, { aboveScanHeight: 2 });
  assert.equal(result.classification, 'SAFE');
  assert.deepEqual(result.surface, { minY: 2, maxY: 5, columns: 4, scanTop: 6 });
  assert.equal(result.excavationBounds.maxY, 5);
});

test('survei frontier fail closed untuk unknown dan struktur', () => {
  assert.equal(surveyAdaptiveMiningCell(adapter(() => null), bounds).classification, 'UNKNOWN');
  const structure = surveyAdaptiveMiningCell(adapter(pos => ({ name: pos.x === 1 && pos.y === 4 ? 'chest' : 'stone' })), bounds);
  assert.equal(structure.classification, 'PROTECTED');
});

test('struktur di luar bounds hanya menjadi evidence kedekatan, bukan memblokir seluruh frontier', () => {
  const memory = {
    db: {
      prepare: () => ({
        all: (_world, _dimension, minX) => minX < 0 ? [{ x: -2, y: 3, z: 0 }] : []
      })
    }
  };
  const miningAdapter = adapter(pos => ({ name: pos.y <= 3 ? 'stone' : 'air' }));
  miningAdapter.bot.game.dimension = 'overworld';
  miningAdapter.bot._client = { options: { host: 'test.local', port: 25565 } };
  miningAdapter.sharedWorldObserver = { memory };
  const result = surveyAdaptiveMiningCell(miningAdapter, bounds, { aboveScanHeight: 1, protectionMargin: 4 });
  assert.equal(result.classification, 'SAFE');
  assert.equal(result.evidence.nearbyStructure, true);
});

test('akses milik miner tidak diklasifikasikan sebagai struktur asing', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({
    name: pos.x === 0 && pos.z === 0 && pos.y === 3 ? 'stone_bricks' : pos.y <= 3 ? 'stone' : 'air'
  })), bounds, { aboveScanHeight: 1, ignoredStructureCells: ['0,3,0'] });
  assert.equal(result.classification, 'SAFE');
});

test('akses terverifikasi diteruskan ke analisis topologi rongga 3D', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({
    name: pos.x === 0 && pos.z === 0 && pos.y >= 1 && pos.y <= 3 ? 'air' : pos.y <= 4 ? 'stone' : 'air'
  })), bounds, { aboveScanHeight: 1, ignoredStructureCells: ['0,1,0'] });
  assert.ok(result.voidTopology.policy.plannedAccessColumns.includes('0,0'));
  assert.equal(result.voidTopology.caveColumns.includes('0,0'), false);
});

test('survei frontier mengenali hamparan air dalam sebagai laut', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({ name: pos.y >= 2 ? 'water' : 'stone' })), bounds, { aboveScanHeight: 1 });
  assert.equal(result.classification, 'OCEAN');
});

test('survei frontier mengklasifikasikan cave kering tanpa menolak seluruh sel aman', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({
    name: pos.x === 0 && pos.z === 0 && [2, 3].includes(pos.y)
      ? 'cave_air' : pos.y <= 5 ? 'stone' : 'air'
  })), bounds, { aboveScanHeight: 2 });
  assert.equal(result.classification, 'CAVE_EDGE');
  assert.equal(result.mineable, true);
  assert.equal(result.restricted, true);
  assert.deepEqual(result.voidTopology.caveColumns, ['0,0']);
  assert.ok(result.voidTopology.boundaryColumns.includes('1,0'));
});

test('survei frontier mengklasifikasikan ravine dari perbedaan permukaan 3D', () => {
  const result = surveyAdaptiveMiningCell(adapter(pos => ({
    name: pos.y <= (pos.x === 0 && pos.z === 0 ? 0 : 5) ? 'stone' : 'air'
  })), bounds, { aboveScanHeight: 2, ravineDepth: 4 });
  assert.equal(result.classification, 'RAVINE_EDGE');
  assert.equal(result.mineable, true);
  assert.deepEqual(result.voidTopology.ravineColumns, ['0,0']);
  assert.equal(result.evidence.maxDropDepth, 5);
});
