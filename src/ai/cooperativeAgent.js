const { AgentRuntime } = require('./agentRuntime');
const { worldContext } = require('./sharedWorldObserver');
const { requiresTaskVerification, isValidTaskVerification } = require('./swarmTaskBoard');

function createEngineTaskHandlers(engine, mapping = {}) {
  const handlers = {};
  for (const [taskType, rule] of Object.entries(mapping)) {
    handlers[taskType] = async (task, context = {}) => {
      const execute = typeof rule.execute === 'function' ? rule.execute : () => engine.tick(context);
      const before = context.snapshot?.() || {};
      const remainingBefore = typeof rule.remaining === 'function' ? await rule.remaining() : null;
      const result = await execute(task, context);
      const action = result?.action || 'idle';
      if (result?.success === false || result?.verified === false) {
        return { success: false, verified: false, retryable: result.retryable !== false,
          reason: result.reason || `ACTION_NOT_VERIFIED:${action}`, action, result };
      }
      if (['retreat', 'eat'].includes(action)) {
        return { success: false, retryable: true, reason: `SURVIVAL_${action.toUpperCase()}`, action };
      }
      const accepted = !Array.isArray(rule.actions) || rule.actions.includes(action) ||
        (rule.idleCompletes !== false && action === 'idle');
      if (!accepted) return { success: false, retryable: true, reason: `TASK_NOT_READY:${action}`, action };
      const mutatesWorld = rule.mutatesWorld === true || requiresTaskVerification(task);
      let verified = !mutatesWorld || result?.verified === true || isValidTaskVerification(result?.verification);
      let verification = result?.verification || null;
      if (mutatesWorld && typeof rule.verify === 'function') {
        const check = await rule.verify({ task, context, result, action, engine, before });
        if (check && typeof check === 'object') {
          verification = check;
          verified = check.status === 'VERIFIED';
        } else verified = Boolean(check);
      }
      if (mutatesWorld && verified && !verification) {
        const after = context.snapshot?.() || {};
        const checks = [];
        const expectedBlock = task.payload?.expectedBlock;
        if (task.type === 'BUILD' && task.payload?.target && typeof expectedBlock === 'string' &&
            after.targetKnown === true && after.targetState === expectedBlock) {
          checks.push({ name: 'requested_block', passed: true, expected: expectedBlock, actual: after.targetState });
        }
        if (typeof rule.remaining === 'function') {
          const remaining = await rule.remaining();
          if (Number.isInteger(remaining) && remaining >= 0 && Number.isInteger(remainingBefore) &&
              remainingBefore >= 0 && (remaining === 0 || remaining < remainingBefore)) {
            checks.push(remaining === 0
              ? { name: 'remaining_work', passed: true, expected: 0, actual: remaining }
              : { name: 'remaining_work_reduced', passed: true, operator: 'gt', expected: remaining, actual: remainingBefore });
          }
        }
        if (checks.length) verification = { status: 'VERIFIED',
          observedAt: context.runtime?.board?.now?.() ?? Date.now(), checks };
      }
      if (mutatesWorld && (!verified || !isValidTaskVerification(verification, context.runtime?.board?.now?.() ?? Date.now()))) {
        return { success: false, verified: false, retryable: result?.retryable !== false,
          reason: result?.reason || `RESULT_NOT_VERIFIED:${action}`, action, result };
      }
      return { success: true, verified, verification, action, result };
    };
  }
  return handlers;
}

function createCooperativeAgent(adapter, { handlers, capabilities, metadata = {}, pollIntervalMs, leaseTtlMs,
  taskTimeoutMs, stallTimeoutMs, watchdogIntervalMs, abortGraceMs } = {}) {
  const observer = adapter?.sharedWorldObserver;
  const context = worldContext(adapter?.bot);
  if (!observer?.taskBoard || !context || !handlers || Object.keys(handlers).length === 0) return null;
  const runtime = new AgentRuntime({
    board: observer.taskBoard,
    agentId: adapter.bot?.username || 'worker',
    context,
    capabilities: capabilities || adapter.options?.capabilities || [],
    handlers,
    metadata,
    pollIntervalMs,
    leaseTtlMs,
    taskTimeoutMs,
    stallTimeoutMs,
    watchdogIntervalMs,
    abortGraceMs,
    cancelActions: reason => adapter.cancelActiveActions?.(reason),
    onTaskStart: (_task, runtimeContext) => {
      adapter.clearActionInterrupt?.();
      adapter.setTaskProgressReporter?.(runtimeContext?.reportProgress);
    },
    onTaskEnd: (_task, _reason, { quarantined } = {}) => {
      adapter.setTaskProgressReporter?.(null);
      if (!quarantined) adapter.clearActionInterrupt?.();
    },
    onQuarantine: (_task, reason) => {
      adapter.cancelActiveActions?.(reason);
      return adapter.bot?.quit?.(`Worker dikarantina: ${reason}`);
    },
    snapshot: task => {
      const position = adapter.getPosition?.();
      const target = task?.payload?.target || task?.payload?.position || null;
      const known = target && observer.memory?.getBlock
        ? observer.memory.getBlock(context.world, context.dimension, target)
        : null;
      const targetFresh = Boolean(known && Date.now() - Number(known.observedAt) <= 15000);
      let structureProtected = false;
      if (target && observer.structures?.db) {
        structureProtected = Boolean(observer.structures.db.prepare(`SELECT 1 FROM structure_voxels
          WHERE world=? AND dimension=? AND x=? AND y=? AND z=? LIMIT 1`)
          .get(context.world, context.dimension, target.x, target.y, target.z));
      }
      return {
        position,
        health: adapter.getHealth?.(),
        food: adapter.getFood?.(),
        inventorySignature: (adapter.getInventoryItems?.() || []).map(item => `${item.name}:${item.count}`).sort().join('|'),
        inventoryCounts: (adapter.getInventoryItems?.() || []).reduce((counts, item) => {
          counts[item.name] = (counts[item.name] || 0) + item.count;
          return counts;
        }, {}),
        targetState: known?.name || null,
        targetKnown: target ? targetFresh : true,
        structureProtected
      };
    }
  });
  runtime.recover = () => runtime.runAutonomous(() => adapter.eatBestFood?.(),
    { name: 'SURVIVAL_RECOVERY', survival: true, timeoutMs: 30000 });
  return runtime;
}

async function runCooperativeCycle(runtime, autonomousTick) {
  if (runtime) {
    const claimed = await runtime.runOnce();
    if (['LOW_HEALTH', 'LOW_FOOD'].includes(claimed.reason) && runtime.recover) {
      return { action: 'recovery', result: await runtime.recover() };
    }
    if (claimed.status !== 'IDLE') return { action: 'cooperative_task', cooperative: claimed };
    if (typeof runtime.runAutonomous !== 'function') return autonomousTick();
    const guarded = await runtime.runAutonomous(context => autonomousTick(context));
    if (['SAFETY:LOW_HEALTH', 'SAFETY:LOW_FOOD'].includes(guarded?.reason) && runtime.recover) {
      return { action: 'recovery', result: await runtime.recover() };
    }
    if (guarded?.status && ['QUARANTINED', 'PREEMPTED', 'FAILED', 'STOPPED', 'BUSY'].includes(guarded.status)) {
      return { action: 'cooperative_autonomous', cooperative: guarded };
    }
    return guarded;
  }
  return autonomousTick();
}

module.exports = { createEngineTaskHandlers, createCooperativeAgent, runCooperativeCycle };
