const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineTaskHandlers, runCooperativeCycle } = require('../../src/ai/cooperativeAgent');

test('engine handler memverifikasi aksi yang sesuai dan menunda aksi domain lain', async () => {
  let action = 'harvest';
  const handlers = createEngineTaskHandlers({ tick: async () => ({ action }) }, {
    HARVEST: { actions: ['harvest'], mutatesWorld: true, idleCompletes: true }
  });
  assert.deepEqual(await handlers.HARVEST({}), {
    success: true, verified: true, action: 'harvest', result: { action: 'harvest' }
  });
  action = 'plant';
  assert.equal((await handlers.HARVEST({})).retryable, true);
});

test('cooperative cycle memprioritaskan task global lalu jatuh ke autonomy saat idle', async () => {
  let autonomous = 0;
  const busy = { runOnce: async () => ({ status: 'COMPLETED', taskId: 't1' }) };
  const idle = { runOnce: async () => ({ status: 'IDLE' }) };
  assert.equal((await runCooperativeCycle(busy, async () => { autonomous += 1; })).action, 'cooperative_task');
  assert.deepEqual(await runCooperativeCycle(idle, async () => { autonomous += 1; return { action: 'farm' }; }), { action: 'farm' });
  assert.equal(autonomous, 1);
});
