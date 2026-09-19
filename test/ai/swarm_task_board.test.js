const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');

function fixture(t) {
  let now = 1000;
  const memory = new SharedWorldMemory(':memory:');
  const board = new SwarmTaskBoard(memory, { now: () => now, defaultLeaseTtlMs: 5000 });
  t.after(() => memory.close());
  return { board, advance: ms => { now += ms; } };
}

test('task board memilih kerja berdasarkan capability dan dependency', t => {
  const { board } = fixture(t);
  const context = { world: 'world', dimension: 'overworld' };
  const goal = board.createGoal({ ...context, type: 'BUILD_STRUCTURE' });
  const survey = board.addTask({ ...context, goalId: goal.id, type: 'SURVEY_SITE', capability: 'survey', priority: 10 });
  board.addTask({ ...context, goalId: goal.id, type: 'BUILD', capability: 'build', dependencies: [survey.id] });

  assert.equal(board.claimTask({ ...context, agentId: 'builder-1', capabilities: ['build'] }), null);
  const claimedSurvey = board.claimTask({ ...context, agentId: 'scout-1', capabilities: ['survey'] });
  assert.equal(claimedSurvey.id, survey.id);
  assert.equal(board.completeTask({ taskId: survey.id, agentId: 'scout-1', leaseToken: claimedSurvey.leaseToken, result: { safe: true } }), true);
  assert.equal(board.claimTask({ ...context, agentId: 'builder-1', capabilities: ['build'] }).type, 'BUILD');
});

test('lease task memakai fencing token dan dapat direbut setelah expiry', t => {
  const { board, advance } = fixture(t);
  const context = { world: 'world', dimension: 'overworld' };
  const goal = board.createGoal({ ...context, type: 'MINE_RESOURCES' });
  const task = board.addTask({ ...context, goalId: goal.id, type: 'MINE_CELL', capability: 'mine' });
  const first = board.claimTask({ ...context, agentId: 'miner-1', capabilities: ['mine'] });
  assert.equal(board.claimTask({ ...context, agentId: 'miner-2', capabilities: ['mine'] }), null);
  advance(5001);
  const second = board.claimTask({ ...context, agentId: 'miner-2', capabilities: ['mine'] });
  assert.equal(second.id, task.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(board.completeTask({ taskId: task.id, agentId: 'miner-1', leaseToken: first.leaseToken }), false);
  assert.equal(board.completeTask({ taskId: task.id, agentId: 'miner-2', leaseToken: second.leaseToken }), true);
});

test('agent heartbeat dan task diisolasi per dunia', t => {
  const { board } = fixture(t);
  board.registerAgent({ id: 'worker', world: 'a', dimension: 'overworld', capabilities: ['survey'] });
  board.heartbeatAgent('worker', { world: 'a', dimension: 'overworld', status: 'IDLE', position: { x: 1, y: 2, z: 3 } });
  const goal = board.createGoal({ world: 'a', dimension: 'overworld', type: 'EXPLORE_AREA' });
  board.addTask({ world: 'a', dimension: 'overworld', goalId: goal.id, type: 'SURVEY', capability: 'survey' });
  assert.equal(board.claimTask({ world: 'b', dimension: 'overworld', agentId: 'worker', capabilities: ['survey'] }), null);
  assert.deepEqual(board.listAgents({ world: 'a', dimension: 'overworld' })[0].position, { x: 1, y: 2, z: 3 });
});

test('agent tanpa heartbeat menjadi offline dan registrasi ulang menghapus lokasi usang', t => {
  const { board, advance } = fixture(t);
  const context = { world: 'world', dimension: 'overworld' };
  board.registerAgent({ id: 'worker', ...context, capabilities: ['mine'] });
  board.heartbeatAgent('worker', { ...context, status: 'WORKING', position: { x: 5, y: 64, z: 8 }, snapshot: { health: 20 } });
  advance(45001);
  assert.equal(board.getAgent('worker', context).status, 'OFFLINE');
  assert.equal(board.listAgents(context)[0].status, 'OFFLINE');

  const restarted = board.registerAgent({ id: 'worker', ...context, capabilities: ['mine'] });
  assert.equal(restarted.status, 'STARTING');
  assert.equal(restarted.position, null);
  assert.deepEqual(restarted.snapshot, {});
});

test('agent yang dihentikan eksplisit tetap STOPPED walau heartbeat sudah tua', t => {
  const { board, advance } = fixture(t);
  const context = { world: 'world', dimension: 'overworld' };
  board.registerAgent({ id: 'worker', ...context });
  board.heartbeatAgent('worker', { ...context, status: 'STOPPED' });
  advance(60000);
  assert.equal(board.getAgent('worker', context).status, 'STOPPED');
});

test('agent hanya mengklaim jenis task yang memiliki handler lokal', t => {
  const { board } = fixture(t);
  const context = { world: 'w', dimension: 'd' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, id: 'farm-task', goalId: goal.id, type: 'HARVEST', capability: 'farm' });
  board.addTask({ ...context, id: 'repair-task', goalId: goal.id, type: 'REPAIR_FARM', capability: 'farm' });
  const claimed = board.claimTask({ ...context, agentId: 'farmer', capabilities: ['farm'], taskTypes: ['REPAIR_FARM'] });
  assert.equal(claimed.id, 'repair-task');
});

test('task deferred memakai backoff sebelum boleh diklaim ulang', t => {
  const { board, advance } = fixture(t);
  const context = { world: 'w', dimension: 'd' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  const task = board.addTask({ ...context, goalId: goal.id, type: 'WORK', capability: 'work' });
  const first = board.claimTask({ ...context, agentId: 'a', capabilities: ['work'] });
  assert.equal(board.deferTask({ taskId: task.id, agentId: 'a', leaseToken: first.leaseToken, reason: 'WAIT', retryDelayMs: 2000 }), true);
  assert.equal(board.claimTask({ ...context, agentId: 'b', capabilities: ['work'] }), null);
  advance(2001);
  assert.equal(board.claimTask({ ...context, agentId: 'b', capabilities: ['work'] }).id, task.id);
});

test('task setara dipilih berdasarkan kedekatan dan pembatas agent', t => {
  const { board } = fixture(t);
  const context = { world: 'w', dimension: 'd' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, id: 'far', goalId: goal.id, type: 'WORK', capability: 'work', payload: { target: { x: 100, y: 64, z: 0 } } });
  board.addTask({ ...context, id: 'near', goalId: goal.id, type: 'WORK', capability: 'work', payload: { target: { x: 5, y: 64, z: 0 } } });
  board.addTask({ ...context, id: 'reserved', goalId: goal.id, type: 'WORK', capability: 'work', priority: 10,
    payload: { target: { x: 1, y: 64, z: 0 }, allowedAgents: ['other'] } });
  const task = board.claimTask({ ...context, agentId: 'worker', capabilities: ['work'], position: { x: 0, y: 64, z: 0 } });
  assert.equal(task.id, 'near');
});

test('event history menyimpan lifecycle goal dan task secara terurut', t => {
  const { board } = fixture(t);
  const context = { world: 'w', dimension: 'd' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, id: 'event-task', type: 'WORK', capability: 'work' });
  const claimed = board.claimTask({ ...context, agentId: 'a', capabilities: ['work'] });
  board.completeTask({ taskId: claimed.id, agentId: 'a', leaseToken: claimed.leaseToken, result: { verified: true } });
  assert.deepEqual(board.listEvents({ goalId: goal.id }).map(event => event.kind),
    ['GOAL_CREATED', 'TASK_CREATED', 'TASK_CLAIMED', 'TASK_COMPLETED']);
});

test('cancel goal membatalkan task pending dan claimed beserta lease-nya', t => {
  const { board } = fixture(t);
  const context = { world: 'w', dimension: 'd' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, id: 'cancel-task', type: 'WORK', capability: 'work' });
  board.claimTask({ ...context, agentId: 'a', capabilities: ['work'] });
  assert.equal(board.cancelGoal(goal.id, 'STOP'), true);
  assert.equal(board.getGoal(goal.id).status, 'CANCELLED');
  const task = board.listTasks({ goalId: goal.id })[0];
  assert.equal(task.status, 'CANCELLED');
  assert.equal(task.leaseOwner, null);
  assert.equal(board.listEvents({ goalId: goal.id }).at(-1).kind, 'GOAL_CANCELLED');
});
