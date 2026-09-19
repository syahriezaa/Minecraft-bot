const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');
const { AgentRuntime, UniversalSafetyPolicy } = require('../../src/ai/agentRuntime');

test('agent runtime mengambil task, memeriksa policy, dan menyimpan hasil terverifikasi', async t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const board = new SwarmTaskBoard(memory);
  const context = { world: 'world', dimension: 'overworld' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'DO_WORK', capability: 'build', payload: { amount: 3 } });
  const runtime = new AgentRuntime({
    board,
    agentId: 'worker-1',
    context,
    capabilities: ['build'],
    snapshot: () => ({ health: 20, food: 20, position: { x: 0, y: 64, z: 0 } }),
    handlers: { DO_WORK: async task => ({ success: true, verified: true, built: task.payload.amount }) }
  });
  const result = await runtime.runOnce();
  assert.equal(result.status, 'COMPLETED');
  assert.equal(board.listTasks({ goalId: goal.id })[0].result.built, 3);
});

test('universal safety policy menolak kerja mutasi saat survival tidak aman', async t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const board = new SwarmTaskBoard(memory);
  const context = { world: 'world', dimension: 'overworld' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'MINE_CELL', capability: 'mine', payload: { mutatesWorld: true } });
  let called = false;
  const runtime = new AgentRuntime({
    board,
    agentId: 'miner-1',
    context,
    capabilities: ['mine'],
    policy: new UniversalSafetyPolicy(),
    snapshot: () => ({ health: 5, food: 20 }),
    handlers: { MINE_CELL: async () => { called = true; return { success: true, verified: true }; } }
  });
  const result = await runtime.runOnce();
  assert.equal(result.status, 'DEFERRED');
  assert.equal(result.reason, 'LOW_HEALTH');
  assert.equal(called, false);
});

