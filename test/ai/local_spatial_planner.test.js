const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LocalSpatialPlanner } = require('../../src/ai/localSpatialPlanner');
const block = name => ({ name, boundingBox: name === 'air' ? 'empty' : 'block' });

test('semua role dapat menemukan pijakan pada medan aktual tanpa landmark tetap', () => {
  const planner = new LocalSpatialPlanner(p => block(p.y < 0 ? 'stone' : 'air'), { radius: 4 });
  const result = planner.selectTarget({ x: 0, y: 0, z: 0 }, [{ pos: { x: 3, y: -1, z: 0 } }]);
  assert.equal(result.status, 'REACHABLE');
  assert.ok(result.stance.path.every(p => !(p.x === 3 && p.z === 0 && p.y === 0)));
});

test('jalur turun satu blok dikenali tetapi jurang dua blok tidak dianggap bisa dipulangi', () => {
  const planner = new LocalSpatialPlanner(p => block(p.y < (p.x < 0 ? 0 : p.x < 2 ? -1 : -3) ? 'stone' : 'air'), { radius: 4 });
  const survey = planner.survey({ x: -1, y: 0, z: 0 });
  assert.ok(survey.nodes.has('0,-1,0'));
  assert.ok(!survey.nodes.has('2,-3,0'));
});

test('air/lava dan chunk tidak diketahui bukan pijakan aman', () => {
  for (const name of ['water', 'lava']) {
    const planner = new LocalSpatialPlanner(p => block(p.y < 0 ? name : 'air'));
    assert.equal(planner.survey({ x: 0, y: 0, z: 0 }).nodes.size, 0);
  }
  const unknown = new LocalSpatialPlanner(() => null);
  assert.equal(unknown.selectTarget({ x: 0, y: 0, z: 0 }, [{ pos: { x: 0, y: -1, z: 0 } }]).status, 'NEEDS_SURVEY');
});

test('target di balik dinding tidak dipilih dari pijakan palsu', () => {
  const planner = new LocalSpatialPlanner(p => block(p.y < 0 || p.x === 1 ? 'stone' : 'air'), { radius: 4 });
  const result = planner.selectTarget({ x: 0, y: 0, z: 0 }, [{ pos: { x: 2, y: 0, z: 0 } }]);
  assert.equal(result.target, undefined);
});

test('anggaran node dibatasi dan dilaporkan sebagai survei parsial', () => {
  const planner = new LocalSpatialPlanner(p => block(p.y < 0 ? 'stone' : 'air'), { maxNodes: 8 });
  const survey = planner.survey({ x: 0, y: 0, z: 0 });
  assert.equal(survey.nodes.size, 8);
  assert.equal(survey.truncated, true);
});

test('adapter bersama memilih pijakan kerja dan menyerahkannya ke pathfinder', async () => {
  const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');
  let goal;
  const bot = { _client: {}, entity: { position: { x: 0.5, y: 0, z: 0.5 } },
    blockAt: p => block(p.y < 0 || p.x === 5 && p.y === 0 && p.z === 0 ? 'stone' : 'air'),
    pathfinder: { goto: async g => { goal = g; }, setGoal: () => {} } };
  const adapter = new MineflayerRoleAdapter(bot, { sharedWorld: false });
  assert.equal(await adapter.navigateNear({ x: 5, y: 0, z: 0 }, 2), true);
  assert.equal(goal.rangeSq, 0);
  assert.notEqual(goal.x, 5);
});

test('survei bertahap memakai pijakan terhubung dan memindai ulang setelah bergerak', async () => {
  const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');
  const bot = { entity: { position: { x: 0.5, y: 0, z: 0.5 } },
    blockAt: p => block(p.y < 0 ? 'stone' : 'air'),
    pathfinder: { goto: async g => { bot.entity.position = { x: g.x+.5, y: g.y, z: g.z+.5 }; }, setGoal: () => {} } };
  const adapter = new MineflayerRoleAdapter(bot, { sharedWorld: false });
  const result = await adapter.approachReachableWork([{ pos: { x: 20, y: -1, z: 0 } }]);
  assert.equal(result.status, 'REACHABLE');
  assert.ok(bot.entity.position.x > 0.5);
});
