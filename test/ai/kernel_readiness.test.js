const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmTaskBoard, isValidTaskVerification } = require('../../src/ai/swarmTaskBoard');
const { AgentRuntime } = require('../../src/ai/agentRuntime');
const { createEngineTaskHandlers } = require('../../src/ai/cooperativeAgent');
const { claimExternalRoleTask } = require('../../src/ai/externalRoleTask');
const { ChildProcessWatchdog } = require('../../src/ai/childProcessWatchdog');
const context = { world: 'test:25565', dimension: 'overworld' };

function fixture(t, options = {}) {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  const board = new SwarmTaskBoard(memory, options);
  return { memory, board };
}

test('autonomous work is preempted when health drops during execution', async t => {
  const { board } = fixture(t);
  let health = 20, canceled;
  const runtime = new AgentRuntime({ board, context, agentId: 'worker', watchdogIntervalMs: 10,
    snapshot: () => ({ health, food: 20 }), cancelActions: reason => { canceled = reason; } });
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const result = await runtime.runAutonomous(async ({ signal }) => {
    health = 2;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { success: true };
  });
  assert.equal(result.status, 'PREEMPTED');
  assert.equal(canceled, 'SAFETY:LOW_HEALTH');
  assert.equal(runtime.busy, false);
});

test('unsafe autonomous work never starts, but explicit recovery can eat', async t => {
  const { board } = fixture(t);
  const runtime = new AgentRuntime({ board, context, agentId: 'worker', snapshot: () => ({ food: 1 }) });
  let calls = 0;
  assert.equal((await runtime.runAutonomous(() => ++calls)).status, 'PREEMPTED');
  assert.equal(calls, 0);
  assert.equal(await runtime.runAutonomous(() => ++calls, { survival: true }), 1);
});

test('BUILD cannot complete from a boolean flag and an action name', async t => {
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'BUILD' });
  const runtime = new AgentRuntime({ board, context, agentId: 'worker', handlers: {
    BUILD: async () => ({ success: true, verified: true, action: 'build' })
  } });
  assert.equal((await runtime.runOnce()).reason, 'RESULT_NOT_VERIFIED');
  assert.notEqual(board.listTasks({ goalId: goal.id })[0].status, 'COMPLETED');
});

test('verification evaluates comparisons and rejects contradictory or decorative evidence', () => {
  const proof = check => ({ status: 'VERIFIED', observedAt: Date.now(), checks: [{ name: 'result', passed: true, ...check }] });
  assert.equal(isValidTaskVerification(proof({ expected: 1, actual: 0 })), false);
  assert.equal(isValidTaskVerification(proof({ evidence: { action: 'build' } })), false);
  assert.equal(isValidTaskVerification(proof({ expected: 0, actual: 4, operator: 'gt' })), true);
  assert.equal(isValidTaskVerification(proof({ expected: 0, actual: 0, operator: 'gt' })), false);
  assert.equal(isValidTaskVerification(proof({ expected: 0, actual: 0 })), true);
});

test('engine wrapper requires the requested block, not an unrelated inventory delta', async () => {
  let signature = 'bread:2', targetState = 'air';
  const task = { type: 'BUILD', payload: { target: { x: 1, y: 64, z: 1 }, expectedBlock: 'stone_bricks' } };
  const snapshot = () => ({ inventorySignature: signature, targetState, targetKnown: true });
  const handlers = createEngineTaskHandlers({}, { BUILD: {
    execute: async () => { signature = 'bread:1'; return { action: 'build', count: 0, verified: true }; }, verify: () => true
  } });
  assert.equal((await handlers.BUILD(task, { snapshot })).success, false);
  targetState = 'dirt';
  assert.equal((await handlers.BUILD(task, { snapshot })).success, false);
  const observed = createEngineTaskHandlers({}, { BUILD: {
    execute: async () => { targetState = 'stone_bricks'; return { action: 'build', verified: true }; }
  } });
  const result = await observed.BUILD(task, { snapshot });
  assert.equal(result.success, true);
  assert.equal(isValidTaskVerification(result.verification), true);
});

test('unverified deferrals exhaust retries and cancel dependent work', t => {
  let now = 10000;
  const { board } = fixture(t, { now: () => now, maxFailures: 3 });
  const goal = board.createGoal({ ...context, type: 'TEST' });
  const task = board.addTask({ ...context, goalId: goal.id, type: 'BUILD' });
  board.addTask({ ...context, goalId: goal.id, type: 'BUILD', dependencies: [task.id] });
  for (let i = 0; i < 3; i++) {
    const claim = board.claimTask({ ...context, agentId: 'worker' });
    assert.equal(board.deferTask({ taskId: claim.id, agentId: 'worker', leaseToken: claim.leaseToken,
      reason: 'RESULT_NOT_VERIFIED' }), true);
    now += 10000;
  }
  assert.equal(board.claimTask({ ...context, agentId: 'worker' }), null);
  assert.equal(board.getGoal(goal.id).status, 'FAILED');
  assert.deepEqual(board.listTasks({ goalId: goal.id }).map(t => t.status).sort(), ['CANCELLED', 'FAILED']);
});

test('changing defer reasons cannot evade a persisted limit and expired leases cannot mutate tasks', t => {
  let now = 10000;
  const { board, memory } = fixture(t, { now: () => now, maxDeferrals: 2 });
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'WORK' });
  const first = board.claimTask({ ...context, agentId: 'worker', ttlMs: 1000 });
  now += 1001;
  assert.equal(board.deferTask({ taskId: first.id, agentId: 'worker', leaseToken: first.leaseToken, reason: 'WAIT' }), false);
  assert.equal(board.failTask({ taskId: first.id, agentId: 'worker', leaseToken: first.leaseToken, error: 'late' }), false);
  for (let i = 0; i < 2; i++) {
    const restored = new SwarmTaskBoard(memory, { now: () => now, maxDeferrals: 2 });
    const claim = restored.claimTask({ ...context, agentId: 'worker' });
    restored.deferTask({ taskId: claim.id, agentId: 'worker', leaseToken: claim.leaseToken, reason: `WAIT_${i}` });
    now += 10000;
  }
  assert.equal(board.listTasks()[0].lastError, 'DEFERRAL_LIMIT');
});

test('external worker repeating identical repair reports still hits its stall limit', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'MINING_SUPPLY' });
  let quits = 0;
  const adapter = { sharedWorldObserver: { taskBoard: board }, getPosition: () => ({ x: 0, y: 64, z: 0 }),
    bot: { username: 'worker', game: { dimension: 'overworld' }, _client: { options: { host: 'test', port: 25565 } },
      quit: () => quits++ }, setTaskProgressReporter() {}, cancelActiveActions() {} };
  const lease = claimExternalRoleTask(adapter, { taskTypes: ['MINING_SUPPLY'], leaseTtlMs: 3000, stallTimeoutMs: 1000 });
  for (let i = 0; i < 6; i++) {
    lease.reportProgress({ phase: 'REPAIR_ACCESS', timestamp: Date.now() });
    t.mock.timers.tick(500);
  }
  assert.equal(lease.leaseLost, true);
  assert.equal(quits, 1);
  assert.equal(board.listTasks()[0].status, 'CLAIMED');
});

test('child watchdog ignores status churn and uses increasing verified work', () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => signals.push(signal);
  child.exitCode = child.signalCode = null;
  let now = 0;
  const watchdog = new ChildProcessWatchdog(child, { now: () => now, timeoutMs: 1000 });
  try {
    now = 800;
    assert.equal(watchdog.beat({ phase: 'BUILD', verifiedBlocks: 1 }), true);
    now = 1400;
    assert.equal(watchdog.beat({ phase: 'WAITING', verifiedBlocks: 1, timestamp: now }), false);
    watchdog._check();
    assert.deepEqual(signals, []);
    now = 1801;
    watchdog._check();
    assert.deepEqual(signals, ['SIGTERM']);
  } finally { watchdog.close(); }
});

test('verified progress resets the defer budget without resetting failed-result retries', t => {
  let now = 10000;
  const { board } = fixture(t, { now: () => now, maxDeferrals: 2 });
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'WORK' });
  for (let i = 0; i < 4; i++) {
    const claim = board.claimTask({ ...context, agentId: 'worker' });
    assert.ok(claim);
    assert.equal(board.noteTaskProgress({ taskId: claim.id, agentId: 'worker', leaseToken: 'stale' }), false);
    assert.equal(board.noteTaskProgress({ taskId: claim.id, agentId: 'worker', leaseToken: claim.leaseToken }), true);
    board.deferTask({ taskId: claim.id, agentId: 'worker', leaseToken: claim.leaseToken, reason: 'SESSION_CHECKPOINT' });
    now += 10000;
  }
  assert.equal(board.listTasks()[0].status, 'PENDING');
  assert.equal(board.listTasks()[0].deferrals, 1);
});

test('external real work keeps a lease alive but repeated waiting cannot extend it forever', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'MINING_SUPPLY' });
  const adapter = { sharedWorldObserver: { taskBoard: board }, getPosition: () => ({ x: 0, y: 64, z: 0 }),
    bot: { username: 'worker', game: { dimension: 'overworld' }, _client: { options: { host: 'test', port: 25565 } },
      quit() {} }, setTaskProgressReporter() {}, cancelActiveActions() {} };
  const lease = claimExternalRoleTask(adapter, { taskTypes: ['MINING_SUPPLY'], leaseTtlMs: 3000, stallTimeoutMs: 1000 });
  for (let i = 1; i <= 6; i++) {
    lease.reportProgress({ verifiedBlocks: i });
    t.mock.timers.tick(500);
  }
  assert.equal(lease.leaseLost, false);
  for (let i = 0; i < 6; i++) {
    lease.reportProgress({ phase: 'WAITING', expectedUntil: Date.now() + 999999 });
    t.mock.timers.tick(500);
  }
  assert.equal(lease.leaseLost, true);
});
