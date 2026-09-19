const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MineflayerRoleAdapter } = require('../../src/ai/mineflayerRoleAdapter');
const { createEngineTaskHandlers } = require('../../src/ai/cooperativeAgent');
const { ChildProcessWatchdog } = require('../../src/ai/childProcessWatchdog');
const { MiningFleetCoordinator } = require('../../src/ai/miningFleetCoordinator');
const { verifyAnimalFeeding } = require('../../src/ai/animalHusbandryEngine');
const { isValidTaskVerification } = require('../../src/ai/swarmTaskBoard');

test('cancelled inventory crafting cannot send a craft command', async () => {
  let crafts = 0;
  const adapter = new MineflayerRoleAdapter({ inventory: {}, recipesFor: () => [{}], craft: async () => crafts++ });
  adapter.cancelActiveActions('LEASE_LOST');
  await assert.rejects(adapter.craftItem('stone_bricks'), /LEASE_LOST/);
  assert.equal(crafts, 0);
});

test('table crafting checks cancellation after navigating and stops when navigation fails', async () => {
  let crafts = 0;
  const adapter = new MineflayerRoleAdapter({ recipesFor: () => [{}], craft: async () => crafts++,
    findBlock: () => ({ position: { x: 1, y: 64, z: 1 } }), blockAt: () => ({ name: 'crafting_table' }) });
  adapter.navigateNear = async () => { adapter.cancelActiveActions('STOPPED'); return true; };
  await assert.rejects(adapter.craftItem('iron_pickaxe'), /STOPPED/);
  adapter.clearActionInterrupt();
  adapter.navigateNear = async () => false;
  assert.equal(await adapter.craftItem('iron_pickaxe'), false);
  assert.equal(crafts, 0);
});

test('craft completing after cancellation cannot report success', async () => {
  const adapter = new MineflayerRoleAdapter({ inventory: {}, recipesFor: () => [{}],
    craft: async () => adapter.cancelActiveActions('STOPPED') });
  await assert.rejects(adapter.craftItem('stone_bricks'), /STOPPED/);
});

test('interaction checks cancellation after looking and after asynchronous fallback', async () => {
  let writes = 0;
  const entity = { id: 1, position: { x: 1, y: 64, z: 1 } };
  const adapter = new MineflayerRoleAdapter({ _client: { write: () => writes++ } });
  adapter.navigateNear = async () => true;
  adapter.lookAt = async () => adapter.cancelActiveActions('LEASE_LOST');
  await assert.rejects(adapter.useOn(entity), /LEASE_LOST/);
  assert.equal(writes, 0);
  const fallback = new MineflayerRoleAdapter({ activateEntity: async () => fallback.cancelActiveActions('STOPPED') });
  fallback.navigateNear = async () => true;
  await assert.rejects(fallback.useOn(entity), /STOPPED/);
});

test('domain progress is verified against its workset, not unrelated inventory changes', async () => {
  let remaining = 3;
  const handlers = createEngineTaskHandlers({}, { HARVEST: {
    remaining: () => remaining,
    execute: async () => ({ action: 'harvest', verified: true })
  } });
  assert.equal((await handlers.HARVEST({ type: 'HARVEST' })).success, false);
  const working = createEngineTaskHandlers({}, { HARVEST: {
    remaining: () => remaining,
    execute: async () => { remaining--; return { action: 'harvest', verified: true }; }
  } });
  assert.equal((await working.HARVEST({ type: 'HARVEST' })).success, true);
});

test('feeding proof counts the appropriate food and ignores unrelated inventory changes', () => {
  const args = { engine: { options: { rules: { cow: { feed: 'wheat' } } } },
    action: 'feed', result: { count: 1 }, before: { inventoryCounts: { wheat: 10, bread: 2 } } };
  assert.equal(isValidTaskVerification(verifyAnimalFeeding({ ...args,
    context: { snapshot: () => ({ inventoryCounts: { wheat: 10, bread: 1 } }) } })), false);
  assert.equal(isValidTaskVerification(verifyAnimalFeeding({ ...args,
    context: { snapshot: () => ({ inventoryCounts: { wheat: 9, bread: 2 } }) } })), true);
});

test('a new worker session accepts low counters and rejects late progress from an old session', () => {
  let now = 0;
  const child = new EventEmitter();
  const signals = [];
  child.kill = signal => signals.push(signal);
  child.exitCode = child.signalCode = null;
  const watchdog = new ChildProcessWatchdog(child, { timeoutMs: 1000, now: () => now });
  try {
    watchdog.beginSession('miner', 0);
    assert.equal(watchdog.beat({ workerSession: 0, progressSequence: 100 }, 'miner'), true);
    now = 600;
    assert.equal(watchdog.beginSession('miner', 1), true);
    assert.equal(watchdog.beat({ workerSession: 0, progressSequence: 200 }, 'miner'), false);
    assert.equal(watchdog.beginSession('miner', 0), false);
    assert.equal(watchdog.beat({ workerSession: 1, progressSequence: 1 }, 'miner'), true);
    now = 1400;
    assert.equal(watchdog.beginSession('miner', 1), false);
    assert.equal(watchdog.beat({ workerSession: 1, progressSequence: 1 }, 'miner'), false);
    watchdog._check();
    assert.deepEqual(signals, []);
    now = 1601;
    watchdog._check();
    assert.deepEqual(signals, ['SIGTERM']);
  } finally { watchdog.close(); }
});

test('mining coordinator routes restart sessions and ignores stale worker status', () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const coordinator = new MiningFleetCoordinator({ spawnProcess: () => child });
  coordinator.start({ count: 1, corners: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }] });
  const emit = event => child.stdout.emit('data', `[ResourceW1] WORK_EVENT ${JSON.stringify(event)}\n`);
  try {
    emit({ phase: 'STARTING', workerSession: 0 });
    emit({ phase: 'EXCAVATE', workerSession: 0, progressSequence: 100 });
    emit({ phase: 'STARTING', workerSession: 1 });
    emit({ phase: 'EXCAVATE', workerSession: 1, progressSequence: 1 });
    assert.equal(coordinator.childWatchdog.progress.counters.get('ResourceW1:progressSequence'), 1);
    emit({ phase: 'BLOCKED', workerSession: 0, progressSequence: 999 });
    assert.equal(coordinator.getStatus().workers.ResourceW1.phase, 'EXCAVATE');
  } finally {
    coordinator.childWatchdog.close();
    child.emit('exit', 0, null);
    if (coordinator.restartTimer) clearTimeout(coordinator.restartTimer);
  }
});
