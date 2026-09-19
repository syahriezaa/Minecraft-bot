const { test } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { SharedWorldMemory } = require('../../src/ai/sharedWorldMemory');
const { SwarmTaskBoard } = require('../../src/ai/swarmTaskBoard');
const { SwarmReservations } = require('../../src/ai/swarmReservations');
const { AgentRuntime } = require('../../src/ai/agentRuntime');
const { createCooperativeAgent, createEngineTaskHandlers } = require('../../src/ai/cooperativeAgent');
const { StructureRegistry } = require('../../src/ai/structureRegistry');
const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');

const context = { world: 'kernel-test', dimension: 'overworld' };

function fixture(t, options = {}) {
  const memory = new SharedWorldMemory(':memory:');
  const board = new SwarmTaskBoard(memory, options);
  t.after(() => memory.close());
  return { memory, board };
}

test('runtime stop aborts the active handler, waits for it and defers its lease', async t => {
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'WORK', capability: 'work' });
  let reachedHandler;
  const started = new Promise(resolve => { reachedHandler = resolve; });
  let actionContinued = false;
  let cleanupReason = null;
  const runtime = new AgentRuntime({
    board, agentId: 'worker', context, capabilities: ['work'],
    onTaskEnd: (_task, reason) => { cleanupReason = reason; },
    handlers: { WORK: async (task, { signal }) => {
      reachedHandler();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      if (!signal.aborted) actionContinued = true;
      return { success: true };
    } }
  });

  const run = runtime.runOnce();
  await started;
  await runtime.stop();
  assert.deepEqual(await run, { status: 'PREEMPTED', taskId: board.listTasks({ goalId: goal.id })[0].id, reason: 'STOPPED' });
  assert.equal(actionContinued, false);
  assert.equal(cleanupReason, 'STOPPED');
  assert.equal(board.listTasks({ goalId: goal.id })[0].status, 'PENDING');
  assert.equal(board.getAgent('worker', context).status, 'STOPPED');
});

test('runtime safety monitor preempts active work when health drops', async t => {
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  board.addTask({ ...context, goalId: goal.id, type: 'MINE_CELL', capability: 'mine', payload: { mutatesWorld: true } });
  let health = 20;
  let reachedHandler;
  const started = new Promise(resolve => { reachedHandler = resolve; });
  let canceled = null;
  const runtime = new AgentRuntime({
    board, agentId: 'miner', context, capabilities: ['mine'], safetyCheckIntervalMs: 100,
    snapshot: () => ({ health, food: 20 }), cancelActions: reason => { canceled = reason; },
    handlers: { MINE_CELL: async (task, { signal }) => {
      reachedHandler();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { success: true, verified: true };
    } }
  });
  const run = runtime.runOnce();
  await started;
  health = 5;
  const result = await run;
  assert.equal(result.status, 'PREEMPTED');
  assert.equal(result.reason, 'SAFETY:LOW_HEALTH');
  assert.equal(canceled, 'SAFETY:LOW_HEALTH');
  assert.equal(board.listTasks({ goalId: goal.id })[0].status, 'PENDING');
  await runtime.stop();
});

test('heartbeat error tidak meninggalkan runtime dalam kondisi busy', async t => {
  const { board } = fixture(t);
  const runtime = new AgentRuntime({ board, agentId: 'worker', context, handlers: {} });
  board.heartbeatAgent = () => { throw new Error('database temporarily unavailable'); };
  const result = await runtime.runOnce();
  assert.equal(result.status, 'FAILED');
  assert.equal(runtime.busy, false);
  assert.equal(runtime.activeRun, null);
});

test('adapter membatalkan placement jika lease hilang setelah navigasi', async () => {
  let placed = false;
  const adapter = new MineflayerRoleAdapter({ placeBlock: async () => { placed = true; } });
  adapter.equipItem = async () => true;
  adapter.navigateNear = async () => {
    adapter.cancelActiveActions('LEASE_LOST');
    return true;
  };
  await assert.rejects(adapter.placeSeed({ position: { x: 0, y: 64, z: 0 } }, 'wheat_seeds'), /LEASE_LOST/);
  assert.equal(placed, false);
});

test('cooperative snapshot reads target state with the shared memory API signature', async t => {
  const { memory, board } = fixture(t);
  const botContext = { ...context, world: 'kernel-test:25565' };
  const structures = new StructureRegistry(memory);
  const goal = board.createGoal({ ...botContext, type: 'TEST' });
  board.addTask({ ...botContext, goalId: goal.id, type: 'MINE_CELL', capability: 'mine', payload: { target: { x: 4, y: 64, z: -2 } } });
  memory.observe({ ...botContext, observer: 'scout', blocks: [{ name: 'stone', position: { x: 4, y: 64, z: -2 } }] });
  const adapter = {
    bot: { username: 'miner', _client: { options: { host: 'kernel-test' } }, game: { dimension: 'overworld' } },
    sharedWorldObserver: { memory, taskBoard: board, structures },
    getPosition: () => ({ x: 4, y: 64, z: -2 }), getHealth: () => 20, getFood: () => 20
  };
  const runtime = createCooperativeAgent(adapter, {
    capabilities: ['mine'], handlers: { MINE_CELL: async () => ({ success: true, verified: true,
      action: 'mine', count: 1, position: { x: 4, y: 64, z: -2 }, verification: {
        status: 'VERIFIED', observedAt: Date.now(), checks: [{ name: 'block', passed: true, expected: 'air', actual: 'air' }]
      } }) }
  });
  assert.equal((await runtime.runOnce()).status, 'COMPLETED');
});

test('engine task wrapper preserves an explicit failed or unverified action result', async () => {
  const handlers = createEngineTaskHandlers({}, {
    HARVEST: { execute: async () => ({ action: 'harvest', success: false, verified: false, reason: 'DIG_FAILED' }), actions: ['harvest'], mutatesWorld: true }
  });
  const result = await handlers.HARVEST({});
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'DIG_FAILED');
});

test('kegagalan terminal satu task tidak membatalkan sibling independen', t => {
  let now = 1000;
  const { board } = fixture(t, { now: () => now, maxFailures: 2 });
  const goal = board.createGoal({ ...context, type: 'TEST' });
  const first = board.addTask({ ...context, goalId: goal.id, id: 'first', type: 'WORK', capability: 'work' });
  const sibling = board.addTask({ ...context, goalId: goal.id, id: 'sibling', type: 'WORK', capability: 'work' });
  let task = board.claimTask({ ...context, agentId: 'worker', capabilities: ['work'], taskTypes: ['WORK'] });
  assert.equal(task.id, first.id);
  board.failTask({ taskId: task.id, agentId: 'worker', leaseToken: task.leaseToken, error: 'UNREACHABLE', retryable: true });
  now += 2000;
  task = board.claimTask({ ...context, agentId: 'worker', capabilities: ['work'], taskTypes: ['WORK'] });
  assert.equal(task.id, first.id);
  board.failTask({ taskId: task.id, agentId: 'worker', leaseToken: task.leaseToken, error: 'UNREACHABLE', retryable: true });
  assert.equal(board.listTasks({ goalId: goal.id }).find(row => row.id === sibling.id).status, 'PENDING');
  assert.equal(board.getGoal(goal.id).status, 'ACTIVE');
  const siblingLease = board.claimTask({ ...context, agentId: 'other-worker', capabilities: ['work'], taskTypes: ['WORK'] });
  assert.equal(siblingLease.id, sibling.id);
  board.completeTask({ taskId: sibling.id, agentId: 'other-worker', leaseToken: siblingLease.leaseToken });
  assert.equal(board.getGoal(goal.id).status, 'FAILED');
  assert.deepEqual(board.listEvents({ taskId: first.id }).filter(event => ['TASK_RETRY', 'TASK_FAILED'].includes(event.kind)).map(event => event.kind),
    ['TASK_RETRY', 'TASK_FAILED']);
});

test('dependency yang gagal membatalkan turunannya saja dan membiarkan kerja independen', t => {
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  const failed = board.addTask({ ...context, goalId: goal.id, id: 'failed-parent', type: 'WORK', capability: 'work' });
  const dependent = board.addTask({ ...context, goalId: goal.id, id: 'dependent', type: 'WORK', capability: 'work', dependencies: [failed.id] });
  const independent = board.addTask({ ...context, goalId: goal.id, id: 'independent', type: 'WORK', capability: 'work' });
  const lease = board.claimTask({ ...context, agentId: 'worker', capabilities: ['work'], taskTypes: ['WORK'] });
  board.failTask({ taskId: lease.id, agentId: 'worker', leaseToken: lease.leaseToken, error: 'BROKEN', retryable: false });
  const rows = board.listTasks({ goalId: goal.id });
  assert.equal(rows.find(row => row.id === dependent.id).status, 'CANCELLED');
  assert.equal(rows.find(row => row.id === independent.id).status, 'PENDING');
  assert.equal(board.getGoal(goal.id).status, 'ACTIVE');
});

test('watchdog mengarantina handler yang mengabaikan timeout dan tidak melepas lease prematur', async t => {
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  const task = board.addTask({ ...context, goalId: goal.id, type: 'WORK', capability: 'work' });
  let canceled = null;
  let cancelCount = 0;
  let cleanupWasQuarantined = false;
  const runtime = new AgentRuntime({
    board, agentId: 'stalled-worker', context, capabilities: ['work'], taskTimeoutMs: 70,
    stallTimeoutMs: 1000, watchdogIntervalMs: 10, abortGraceMs: 20,
    cancelActions: reason => { canceled = reason; cancelCount += 1; },
    onTaskEnd: (_task, _reason, state) => { cleanupWasQuarantined = state.quarantined; },
    handlers: { WORK: async () => new Promise(() => {}) }
  });
  const result = await runtime.runOnce();
  assert.equal(result.status, 'QUARANTINED');
  assert.equal(result.reason, 'TASK_TIMEOUT');
  assert.equal(runtime.quarantined, true);
  assert.equal(runtime.busy, false);
  assert.equal(canceled, 'TASK_TIMEOUT');
  assert.equal(cancelCount, 1);
  assert.equal(cleanupWasQuarantined, true);
  assert.equal(board.listTasks({ goalId: goal.id })[0].status, 'CLAIMED');
  assert.equal((await runtime.runOnce()).status, 'QUARANTINED');
  assert.equal(board.listTasks({ goalId: goal.id })[0].id, task.id);
  await runtime.stop();
});

test('scheduler searches beyond the first 128 tasks that are assigned to other workers', t => {
  const { board } = fixture(t);
  const goal = board.createGoal({ ...context, type: 'TEST' });
  for (let i = 0; i < 128; i++) board.addTask({ ...context, goalId: goal.id, type: 'WORK', capability: 'work', payload: { allowedAgents: ['other'] } });
  board.addTask({ ...context, goalId: goal.id, id: 'available', type: 'WORK', capability: 'work', payload: { allowedAgents: ['worker'] } });
  const claimed = board.claimTask({ ...context, agentId: 'worker', capabilities: ['work'], taskTypes: ['WORK'] });
  assert.equal(claimed.id, 'available');
});

test('shared container leases coexist while an exclusive block edit waits for all readers', t => {
  const { memory } = fixture(t);
  const first = new SwarmReservations(memory, 'first');
  const second = new SwarmReservations(memory, 'second');
  const editor = new SwarmReservations(memory, 'editor');
  try {
    const a = first.acquire(context, ['shared:cell:2,64,3']);
    const b = second.acquire(context, ['shared:cell:2,64,3']);
    assert.ok(a && b);
    assert.equal(editor.acquire(context, ['cell:2,64,3']), null);
    first.release(a);
    assert.equal(editor.acquire(context, ['cell:2,64,3']), null);
    second.release(b);
    assert.ok(editor.acquire(context, ['cell:2,64,3']));
  } finally {
    first.close(); second.close(); editor.close();
  }
});

test('pemilik shared lease boleh masuk ulang meski slot bersama sudah penuh', t => {
  const { memory } = fixture(t);
  const first = new SwarmReservations(memory, 'first');
  const second = new SwarmReservations(memory, 'second');
  const third = new SwarmReservations(memory, 'third');
  try {
    assert.ok(first.acquire(context, ['shared:cell:8,64,9']));
    assert.ok(second.acquire(context, ['shared:cell:8,64,9']));
    assert.ok(first.acquire(context, ['shared:cell:8,64,9']));
    assert.equal(third.acquire(context, ['shared:cell:8,64,9']), null);
    assert.equal(third.acquire(context, ['cell:8,64,9']), null);
  } finally { first.close(); second.close(); third.close(); }
});

test('migrasi shared reservation lama aman saat alias dan resource kanonis berbenturan', t => {
  const memory = new SharedWorldMemory(':memory:');
  t.after(() => memory.close());
  memory.db.exec(`CREATE TABLE reservations (
    world TEXT NOT NULL, dimension TEXT NOT NULL, resource TEXT NOT NULL,
    owner TEXT NOT NULL, token TEXT NOT NULL, expiresAt INTEGER NOT NULL,
    PRIMARY KEY(world,dimension,resource,token)
  )`);
  const insert = memory.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?)');
  insert.run(context.world, context.dimension, 'shared:cell:3,64,4', 'owner', 'same-token', 5000);
  insert.run(context.world, context.dimension, 'cell:3,64,4', 'owner', 'same-token', 6000);

  new SwarmReservations(memory, 'migration-check');
  const rows = memory.db.prepare('SELECT resource,expiresAt,mode FROM reservations').all();
  assert.deepEqual(rows.map(row => ({ ...row })), [{ resource: 'cell:3,64,4', expiresAt: 6000, mode: 'exclusive' }]);
});

test('role worker terdaftar di task board bersama tanpa sampling 3D periodik', async t => {
  const memory = new SharedWorldMemory(':memory:');
  const board = new SwarmTaskBoard(memory);
  let adapter;
  t.after(() => { adapter?.sharedWorldObserver?.stop(); memory.close(); });
  const bot = Object.assign(new EventEmitter(), {
    username: 'farmer-lite',
    _client: { options: { host: 'kernel-test', port: 25565 } },
    game: { dimension: 'overworld' },
    entity: { position: { x: 4, y: 64, z: 2 } },
    blockAt: position => ({ name: 'air', position })
  });
  adapter = new MineflayerRoleAdapter(bot, { sharedWorldStore: memory, spatialSampling: false,
    capabilities: ['farm'], coordinateMovement: false });
  assert.ok(adapter.sharedWorldObserver);
  assert.equal(adapter.sharedWorldObserver.spatialSampling, false);
  assert.equal(board.getAgent('farmer-lite', { world: 'kernel-test:25565', dimension: 'overworld' }).status, 'STARTING');
  const goal = board.createGoal({ world: 'kernel-test:25565', dimension: 'overworld', type: 'TEST' });
  board.addTask({ world: 'kernel-test:25565', dimension: 'overworld', goalId: goal.id,
    type: 'HARVEST', capability: 'farm' });
  const runtime = createCooperativeAgent(adapter, {
    capabilities: ['farm'], handlers: { HARVEST: async () => ({ success: true, verified: true, action: 'harvest', count: 1,
      verification: { status: 'VERIFIED', observedAt: Date.now(),
        checks: [{ name: 'inventory', passed: true, operator: 'gt', expected: 0, actual: 1 }] } }) }
  });
  assert.ok(runtime);
  assert.equal((await runtime.runOnce()).status, 'COMPLETED');
});

test('idle tidak dapat meloloskan verifier mutasi yang secara eksplisit menolak hasil', async () => {
  const handlers = createEngineTaskHandlers({}, {
    REPAIR_FARM: { execute: async () => ({ action: 'idle', verified: true }), actions: ['repair'],
      mutatesWorld: true, idleCompletes: true, verify: () => false }
  });
  const result = await handlers.REPAIR_FARM({});
  assert.equal(result.success, false);
  assert.equal(result.verified, false);
});
