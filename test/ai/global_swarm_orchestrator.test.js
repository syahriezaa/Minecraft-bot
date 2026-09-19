const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { GlobalSwarmOrchestrator } = require('../../src/ai/globalSwarmOrchestrator');

test('global orchestrator mengubah goal menjadi task graph bersama', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const orchestrator = new GlobalSwarmOrchestrator({ memory });
  const goal = orchestrator.submitGoal({ world: 'world', dimension: 'overworld', type: 'BUILD_STRUCTURE', payload: { name: 'storage' } });
  assert.equal(goal.status, 'ACTIVE');
  assert.deepEqual(new Set(goal.tasks.map(task => task.type)), new Set(['SURVEY_SITE', 'LANDSCAPE', 'GATHER_MATERIALS', 'SMELT', 'CRAFT', 'BUILD', 'AUDIT_STRUCTURE']));
  const status = orchestrator.getStatus({ world: 'world', dimension: 'overworld' });
  assert.equal(status.world, 'world');
  assert.equal(status.dimension, 'overworld');
  assert.equal(status.taskCounts.PENDING, 7);
});

test('goal tidak dikenal gagal atomik tanpa meninggalkan goal yatim', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const orchestrator = new GlobalSwarmOrchestrator({ memory });
  assert.throws(() => orchestrator.submitGoal({ world: 'w', dimension: 'd', type: 'UNKNOWN' }), /belum tersedia/);
  assert.equal(memory.db.prepare('SELECT COUNT(*) AS count FROM swarm_goals').get().count, 0);
});
