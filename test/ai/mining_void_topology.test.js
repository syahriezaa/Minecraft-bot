const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeMiningVoidTopology,
  inspectMiningTargetVoidRisk
} = require('../../src/ai/miningVoidTopology');

const bounds = { minX: 0, maxX: 4, minZ: 0, maxZ: 4, floorY: 0, maxY: 8 };

function block(name, position) {
  return { name, position, boundingBox: ['air', 'cave_air', 'void_air'].includes(name) ? 'empty' : 'block' };
}

test('topologi 3D menggabungkan cave tertutup menjadi satu komponen', () => {
  const adapter = {
    blockAt: pos => block(pos.x >= 1 && pos.x <= 3 && pos.z === 2 && [3, 4].includes(pos.y)
      ? 'cave_air' : pos.y <= 6 ? 'stone' : 'air', pos)
  };
  const topology = analyzeMiningVoidTopology(adapter, bounds);
  assert.deepEqual(new Set(topology.caveColumns), new Set(['1,2', '2,2', '3,2']));
  assert.equal(topology.ravineColumns.length, 0);
  assert.equal(topology.components.length, 1);
  assert.equal(topology.components[0].volume, 6);
  assert.equal(topology.evidence.largestVoidComponent, 6);
});

test('topologi 3D mengenali drop permukaan dalam sebagai ravine dan melindungi tepinya', () => {
  const adapter = {
    blockAt: pos => block(pos.y <= (pos.x === 2 && pos.z === 2 ? 1 : 7) ? 'stone' : 'air', pos)
  };
  const topology = analyzeMiningVoidTopology(adapter, bounds, { ravineDepth: 4 });
  assert.deepEqual(topology.ravineColumns, ['2,2']);
  assert.equal(topology.evidence.maxDropDepth, 6);
  assert.ok(topology.boundaryColumns.includes('2,1'));
  assert.ok(topology.boundaryColumns.includes('1,2'));
  assert.equal(topology.components[0].volume, 6);
});

test('pemeriksaan target menolak blok di atas void dalam tetapi menerima drop satu blok', () => {
  let deep = true;
  const adapter = {
    blockAt: pos => {
      if (pos.x === 2 && pos.z === 2 && pos.y === 5) return block('stone', pos);
      if (pos.x === 2 && pos.z === 2 && pos.y >= (deep ? 1 : 4) && pos.y < 5) return block('air', pos);
      return block('stone', pos);
    }
  };
  assert.deepEqual(inspectMiningTargetVoidRisk(adapter, { x: 2, y: 5, z: 2 }, bounds), {
    unsafe: true, reason: 'DEEP_VOID_BELOW', depth: 4
  });
  deep = false;
  assert.equal(inspectMiningTargetVoidRisk(adapter, { x: 2, y: 5, z: 2 }, bounds).unsafe, false);
});

test('pemeriksaan target fail closed ketika rongga belum tersurvei', () => {
  const adapter = { blockAt: pos => pos.y === 5 ? block('stone', pos) : null };
  assert.equal(inspectMiningTargetVoidRisk(adapter, { x: 2, y: 5, z: 2 }, bounds).reason, 'UNKNOWN_VOID');
});

test('koridor tangga terverifikasi tidak dianggap cave atau ravine alami', () => {
  const access = Array.from({ length: 6 }, (_, index) => `0,${index + 1},2`);
  const adapter = {
    blockAt: pos => block(pos.x === 0 && pos.z === 2 && pos.y > 1 && pos.y < 7
      ? 'air' : pos.y <= 7 ? 'stone' : 'air', pos)
  };
  const topology = analyzeMiningVoidTopology(adapter, bounds, { plannedAccessCells: access });
  assert.equal(topology.caveColumns.includes('0,2'), false);
  assert.equal(topology.ravineColumns.includes('0,2'), false);
  assert.ok(topology.policy.plannedAccessColumns.includes('0,2'));
});

test('pemeriksaan target menerima void samping yang merupakan koridor akses terverifikasi', () => {
  const adapter = {
    blockAt: pos => block(pos.x === 1 && pos.z === 2 && pos.y >= 1 && pos.y <= 5
      ? 'air' : 'stone', pos)
  };
  const result = inspectMiningTargetVoidRisk(adapter, { x: 2, y: 5, z: 2 }, bounds, {
    plannedAccessColumns: ['1,2']
  });
  assert.equal(result.unsafe, false);
});
