const { worldContext } = require('./sharedWorldObserver');

function claimExternalRoleTask(adapter, { taskTypes, capabilities, leaseTtlMs = 60000, log = () => {} } = {}) {
  const observer = adapter?.sharedWorldObserver;
  const context = worldContext(adapter?.bot);
  if (!observer?.taskBoard || !context) return null;
  const agentId = adapter.bot?.username || 'worker';
  const task = observer.taskBoard.claimTask({ ...context, agentId,
    capabilities: capabilities || adapter.options?.capabilities || [], taskTypes,
    position: adapter.getPosition?.(), ttlMs: leaseTtlMs });
  if (!task) return null;
  let closed = false;
  let leaseLost = false;
  const timer = setInterval(() => {
    if (!observer.taskBoard.renewTask({ taskId: task.id, agentId, leaseToken: task.leaseToken, ttlMs: leaseTtlMs })) {
      leaseLost = true;
      log(`Lease task ${task.id} hilang; hasil worker tidak akan diklaim sebagai selesai.`);
    }
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
  timer.unref?.();
  const close = () => { clearInterval(timer); closed = true; };
  log(`Task global ${task.type} diklaim: ${task.id}.`);
  return {
    task,
    get leaseLost() { return leaseLost; },
    complete(result = {}) {
      if (closed || leaseLost) return false;
      const ok = observer.taskBoard.completeTask({ taskId: task.id, agentId, leaseToken: task.leaseToken,
        result: { verified: true, ...result } });
      close(); return ok;
    },
    defer(reason, retryDelayMs = 5000) {
      if (closed || leaseLost) return false;
      const ok = observer.taskBoard.deferTask({ taskId: task.id, agentId, leaseToken: task.leaseToken, reason, retryDelayMs });
      close(); return ok;
    },
    fail(reason) {
      if (closed || leaseLost) return false;
      const ok = observer.taskBoard.failTask({ taskId: task.id, agentId, leaseToken: task.leaseToken, error: reason, retryable: false });
      close(); return ok;
    }
  };
}

module.exports = { claimExternalRoleTask };
