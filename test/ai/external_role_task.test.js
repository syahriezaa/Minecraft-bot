const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');
const { claimExternalRoleTask } = require('../../src/ai/externalRoleTask');

test('external role mengambil task yang ditujukan kepadanya dan menyelesaikan lease', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const board = new SwarmTaskBoard(memory);
  const context = { world: 'server:25565', dimension: 'overworld' };
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, id: 'builder-task', type: 'BUILD_STORAGE', capability: 'build',
    payload: { allowedAgents: ['BuildBot1'] } });
  const bot = { username: 'BuildBot1', game: { dimension: 'overworld' }, entity: { position: { x: 1, y: 70, z: 2 } },
    _client: { options: { host: 'server', port: 25565 } } };
  const adapter = { bot, options: { capabilities: ['build'] }, getPosition: () => bot.entity.position,
    sharedWorldObserver: { taskBoard: board } };
  const lease = claimExternalRoleTask(adapter, { taskTypes: ['BUILD_STORAGE'], capabilities: ['build'] });
  assert.equal(lease.task.id, 'builder-task');
  assert.equal(lease.complete({ built: 10, verification: {
    status: 'VERIFIED', observedAt: Date.now(),
    checks: [{ name: 'blueprint_remaining_blocks', passed: true, expected: 0, actual: 0 }]
  } }), true);
  assert.equal(board.listTasks({ goalId: goal.id })[0].status, 'COMPLETED');
});
