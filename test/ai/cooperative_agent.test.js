const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEngineTaskHandlers, runCooperativeCycle } = require('../../src/ai/cooperativeAgent');

test('engine handler hanya menerima mutasi dengan bukti eksplisit dan menunda aksi domain lain', async () => {
  let result = { action: 'harvest', verified: true };
  let reads = 0;
  const handlers = createEngineTaskHandlers({ tick: async () => result }, {
    HARVEST: { actions: ['harvest'], mutatesWorld: true, idleCompletes: true, remaining: () => reads++ ? 0 : 1 }
  });
  const verified = await handlers.HARVEST({});
  assert.equal(verified.success, true);
  assert.equal(verified.verified, true);
  assert.equal(verified.verification.status, 'VERIFIED');
  assert.equal(verified.verification.checks[0].passed, true);
  result = { action: 'harvest' };
  assert.equal((await handlers.HARVEST({})).reason, 'RESULT_NOT_VERIFIED:harvest');
  result = { action: 'plant' };
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
