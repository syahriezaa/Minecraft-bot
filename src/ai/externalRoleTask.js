const { worldContext } = require('./sharedWorldObserver');
const { requiresTaskVerification, isValidTaskVerification } = require('./swarmTaskBoard');
const { WorkProgress } = require('./workProgress');

function claimExternalRoleTask(adapter, { taskTypes, capabilities, leaseTtlMs = 60000,
  stallTimeoutMs = 8 * 60 * 1000, log = () => {} } = {}) {
  const observer = adapter?.sharedWorldObserver;
  const context = worldContext(adapter?.bot);
  if (!observer?.taskBoard || !context) return null;
  const agentId = adapter.bot?.username || 'worker';
  const task = observer.taskBoard.claimTask({ ...context, agentId,
    capabilities: capabilities || adapter.options?.capabilities || [], taskTypes,
    position: adapter.getPosition?.(), ttlMs: leaseTtlMs });
  if (!task) return null;
  adapter.clearActionInterrupt?.();
  let closed = false;
  let leaseLost = false;
  let lastRenewalErrorAt = 0;
  let lastProgressAt = Date.now();
  let lastProgressEventAt = 0;
  const progress = new WorkProgress();
  progress.observe({ action: 'NAVIGATED', position: adapter.getPosition?.() });
  let waitingUntil = 0;
  let waitGranted = false;
  const cancelLease = reason => {
    if (leaseLost || closed) return;
    leaseLost = true;
    try { adapter.cancelActiveActions?.(reason); } catch {}
    try { adapter.bot?.quit?.(`Task dihentikan: ${reason}`); } catch {}
    clearInterval(timer);
    try { adapter.setTaskProgressReporter?.(null); } catch {}
    log(`Task ${task.id} dihentikan (${reason}); lease dibiarkan kedaluwarsa sebelum boleh diklaim ulang.`);
  };
  const timer = setInterval(() => {
    const now = Date.now();
    const position = adapter.getPosition?.();
    if (progress.observe({ action: 'NAVIGATED', position })) {
      lastProgressAt = now;
    }
    if (now > waitingUntil && now - lastProgressAt > stallTimeoutMs) {
      cancelLease('NO_PROGRESS_TIMEOUT');
      return;
    }
    try {
      if (observer.taskBoard.renewTask({ taskId: task.id, agentId, leaseToken: task.leaseToken, ttlMs: leaseTtlMs })) return;
      cancelLease('LEASE_LOST');
    } catch (error) {
      cancelLease(`LEASE_RENEWAL_ERROR:${error.message}`);
    }
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));
  timer.unref?.();
  const close = () => {
    clearInterval(timer);
    adapter.setTaskProgressReporter?.(null);
    closed = true;
  };
  const reportProgress = (details = {}) => {
    if (closed || leaseLost) return false;
    const now = Date.now();
    const advanced = progress.observe(details);
    if (advanced) {
      lastProgressAt = now;
      waitingUntil = 0;
      waitGranted = false;
      if (details?.action !== 'NAVIGATED') {
        try { observer.taskBoard.noteTaskProgress?.({ taskId: task.id, agentId, leaseToken: task.leaseToken }); }
        catch (error) { cancelLease(`PROGRESS_WRITE_ERROR:${error.message}`); return false; }
      }
    }
    if (!waitGranted && details?.phase === 'WAITING' && Number.isFinite(details.expectedUntil)) {
      waitingUntil = Math.min(details.expectedUntil, lastProgressAt + Math.min(stallTimeoutMs, 120000));
      waitGranted = true;
    }
    if (now - lastProgressEventAt < 1000) return advanced;
    lastProgressEventAt = now;
    try {
      observer.taskBoard.recordEvent({ taskId: task.id, goalId: task.goalId, agentId,
        kind: 'TASK_PROGRESS', data: details });
      observer.taskBoard.heartbeatAgent(agentId, { ...context, status: 'WORKING',
        position: adapter.getPosition?.() || null, snapshot: { taskId: task.id, progress: details } });
      return advanced;
    } catch (error) {
      const now = Date.now();
      if (now - lastRenewalErrorAt > 30000) {
        log(`Progress task ${task.id} belum tersimpan: ${error.message}`);
        lastRenewalErrorAt = now;
      }
      return false;
    }
  };
  adapter.setTaskProgressReporter?.(reportProgress);
  log(`Task global ${task.type} diklaim: ${task.id}.`);
  return {
    task,
    get leaseLost() { return leaseLost; },
    complete(result = {}) {
      if (closed || leaseLost) return false;
      try {
        if (requiresTaskVerification(task) && !isValidTaskVerification(result?.verification, observer.taskBoard.now())) {
          observer.taskBoard.deferTask({ taskId: task.id, agentId, leaseToken: task.leaseToken,
            reason: 'RESULT_NOT_VERIFIED', retryDelayMs: 5000 });
          close();
          log(`Task ${task.id} ditunda: worker belum memberikan bukti verifikasi hasil.`);
          return false;
        }
        const ok = observer.taskBoard.completeTask({ taskId: task.id, agentId, leaseToken: task.leaseToken, result });
        close();
        return ok;
      } catch (error) {
        close();
        log(`Penyelesaian task ${task.id} gagal disimpan (${error.message}); lease dibiarkan kedaluwarsa.`);
        return false;
      }
    },
    reportProgress,
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
