const { AgentRuntime } = require('./agentRuntime');
const { worldContext } = require('./sharedWorldObserver');

function createEngineTaskHandlers(engine, mapping = {}) {
  const handlers = {};
  for (const [taskType, rule] of Object.entries(mapping)) {
    handlers[taskType] = async task => {
      const execute = typeof rule.execute === 'function' ? rule.execute : () => engine.tick();
      const result = await execute(task);
      const action = result?.action || 'idle';
      if (['retreat', 'eat'].includes(action)) {
        return { success: false, retryable: true, reason: `SURVIVAL_${action.toUpperCase()}`, action };
      }
      const accepted = !Array.isArray(rule.actions) || rule.actions.includes(action) ||
        (rule.idleCompletes !== false && action === 'idle');
      if (!accepted) return { success: false, retryable: true, reason: `TASK_NOT_READY:${action}`, action };
      return { success: true, verified: rule.mutatesWorld !== true || action !== 'idle' || rule.idleCompletes === true, action, result };
    };
  }
  return handlers;
}

function createCooperativeAgent(adapter, { handlers, capabilities, metadata = {}, pollIntervalMs, leaseTtlMs } = {}) {
  const observer = adapter?.sharedWorldObserver;
  const context = worldContext(adapter?.bot);
  if (!observer?.taskBoard || !context || !handlers || Object.keys(handlers).length === 0) return null;
  return new AgentRuntime({
    board: observer.taskBoard,
    agentId: adapter.bot?.username || 'worker',
    context,
    capabilities: capabilities || adapter.options?.capabilities || [],
    handlers,
    metadata,
    pollIntervalMs,
    leaseTtlMs,
    snapshot: task => {
      const position = adapter.getPosition?.();
      const target = task?.payload?.target || task?.payload?.position || null;
      const known = target && observer.memory?.getBlock
        ? observer.memory.getBlock({ ...context, ...target })
        : null;
      return {
        position,
        health: adapter.getHealth?.(),
        food: adapter.getFood?.(),
        targetKnown: target ? Boolean(known) : true,
        structureProtected: false,
        routeHomeAvailable: true
      };
    }
  });
}

async function runCooperativeCycle(runtime, autonomousTick) {
  if (runtime) {
    const claimed = await runtime.runOnce();
    if (claimed.status !== 'IDLE') return { action: 'cooperative_task', cooperative: claimed };
  }
  return autonomousTick();
}

module.exports = { createEngineTaskHandlers, createCooperativeAgent, runCooperativeCycle };
