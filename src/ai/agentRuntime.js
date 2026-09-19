const EventEmitter = require('node:events');
const { requiresTaskVerification, isValidTaskVerification } = require('./swarmTaskBoard');
const { WorkProgress } = require('./workProgress');

const WORLD_MUTATION_TASKS = new Set([
  'MINE_CELL', 'ENSURE_ACCESS', 'BUILD', 'LANDSCAPE', 'REPAIR_FARM',
  'BUILD_STORAGE', 'LANDSCAPE_SITE', 'MINING_SUPPLY', 'PREPARE_MATERIALS',
  'HARVEST', 'PLANT', 'SORT_ITEMS', 'SMELT', 'CRAFT'
]);

function abortError(reason) {
  const error = new Error(String(reason || 'Aksi dibatalkan.'));
  error.name = 'AbortError';
  return error;
}

function boundedMs(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(10, Math.min(maximum, number)) : fallback;
}

class UniversalSafetyPolicy {
  constructor(options = {}) {
    this.options = { minimumHealth: 8, minimumFood: 6, ...options };
  }

  evaluate(task, snapshot = {}) {
    const mutatesWorld = task?.payload?.mutatesWorld === true || WORLD_MUTATION_TASKS.has(task?.type);
    if (Number.isFinite(snapshot.health) && snapshot.health < this.options.minimumHealth) return { allowed: false, reason: 'LOW_HEALTH' };
    if (Number.isFinite(snapshot.food) && snapshot.food < this.options.minimumFood) return { allowed: false, reason: 'LOW_FOOD' };
    if (mutatesWorld && snapshot.targetKnown === false) return { allowed: false, reason: 'UNKNOWN_WORLD' };
    if (mutatesWorld && snapshot.structureProtected === true) return { allowed: false, reason: 'PROTECTED_STRUCTURE' };
    if (snapshot.routeHomeAvailable === false) return { allowed: false, reason: 'NO_SAFE_RETURN_ROUTE' };
    return { allowed: true };
  }
}

class AgentRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.board) throw new TypeError('AgentRuntime membutuhkan task board.');
    if (!options.agentId || !options.context?.world || !options.context?.dimension) throw new Error('AgentRuntime membutuhkan identitas dan konteks dunia.');
    this.board = options.board;
    this.agentId = options.agentId;
    this.context = options.context;
    this.capabilities = [...new Set(options.capabilities || [])];
    this.handlers = options.handlers || {};
    this.snapshot = options.snapshot || (() => ({}));
    this.policy = options.policy || new UniversalSafetyPolicy();
    this.cancelActions = options.cancelActions || (() => {});
    this.onTaskStart = options.onTaskStart || (() => {});
    this.onTaskEnd = options.onTaskEnd || (() => {});
    this.pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || 1000);
    this.safetyCheckIntervalMs = Math.max(100, Number(options.safetyCheckIntervalMs) || 250);
    this.taskTimeoutMs = boundedMs(options.taskTimeoutMs, 10 * 60 * 1000, 30 * 60 * 1000);
    this.stallTimeoutMs = boundedMs(options.stallTimeoutMs, 90 * 1000, 10 * 60 * 1000);
    this.watchdogIntervalMs = boundedMs(options.watchdogIntervalMs, 250, 5000);
    this.abortGraceMs = boundedMs(options.abortGraceMs, 500, 5000);
    this.leaseTtlMs = Math.max(5000, Number(options.leaseTtlMs) || 30000);
    this.metadata = options.metadata || {};
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.busy = false;
    this.activeRun = null;
    this.abortController = null;
    this.currentTask = null;
    this.interruptReason = null;
    this.quarantined = false;
    this.onQuarantine = options.onQuarantine || (() => {});
    this.board.registerAgent({ id: this.agentId, ...this.context, capabilities: this.capabilities, metadata: this.metadata });
  }

  _heartbeat(status, extra = {}) {
    const snapshot = { ...this.snapshot(), ...extra };
    return this.board.heartbeatAgent(this.agentId, {
      ...this.context,
      status,
      position: snapshot.position || null,
      snapshot
    });
  }

  _safeHeartbeat(status, extra = {}) {
    try { return this._heartbeat(status, extra); }
    catch (error) {
      this.emit('heartbeatError', { status, error });
      return false;
    }
  }

  _interrupt(reason) {
    if (!this.abortController || this.abortController.signal.aborted) return false;
    this.interruptReason = reason;
    this.abortController.abort(reason);
    try { this.cancelActions(reason); }
    catch (error) { this.emit('interruptError', { reason, error }); }
    this.emit('preempted', { task: this.currentTask, reason });
    return true;
  }

  _quarantine(reason) {
    if (this.quarantined) return false;
    this.quarantined = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const interrupted = this._interrupt(reason);
    if (!interrupted) {
      try { this.cancelActions(reason); }
      catch (error) { this.emit('interruptError', { reason, error }); }
    }
    this._safeHeartbeat('QUARANTINED', { taskId: this.currentTask?.id || null, reason });
    try {
      this.board.recordEvent({ taskId: this.currentTask?.id || null, goalId: this.currentTask?.goalId || null,
        agentId: this.agentId, kind: 'AGENT_QUARANTINED', data: { reason } });
    } catch (error) { this.emit('eventError', { kind: 'AGENT_QUARANTINED', error }); }
    try {
      const result = this.onQuarantine(this.currentTask, reason);
      result?.catch?.(error => this.emit('quarantineError', { task: this.currentTask, error }));
    } catch (error) { this.emit('quarantineError', { task: this.currentTask, error }); }
    this.emit('quarantined', { task: this.currentTask, reason });
    return true;
  }

  runOnce() {
    if (this.stopped) return Promise.resolve({ status: 'STOPPED' });
    if (this.quarantined) return Promise.resolve({ status: 'QUARANTINED', taskId: this.currentTask?.id || null });
    if (this.busy) return Promise.resolve({ status: 'BUSY', taskId: this.currentTask?.id || null });
    this.busy = true;
    const execution = this._runOnce();
    this.activeRun = execution.finally(() => {
      try {
        if (this.abortController) {
          try { this.onTaskEnd(this.currentTask, this.interruptReason, { quarantined: this.quarantined }); }
          catch (error) { this.emit('taskCleanupError', { task: this.currentTask, error }); }
        }
        this.currentTask = null;
        this.abortController = null;
        this.busy = false;
        this._safeHeartbeat(this.quarantined ? 'QUARANTINED' : this.stopped ? 'STOPPED' : 'IDLE');
      } finally {
        this.activeRun = null;
      }
    });
    return this.activeRun;
  }

  runAutonomous(work, { name = 'AUTONOMOUS_TICK', survival = false, timeoutMs = this.taskTimeoutMs,
    stallTimeoutMs = this.stallTimeoutMs } = {}) {
    if (typeof work !== 'function') return Promise.reject(new TypeError('runAutonomous membutuhkan fungsi kerja.'));
    if (this.stopped) return Promise.resolve({ status: 'STOPPED' });
    if (this.quarantined) return Promise.resolve({ status: 'QUARANTINED' });
    if (this.busy) return Promise.resolve({ status: 'BUSY' });
    this.busy = true;
    const execution = this._runAutonomous(work, { name, survival, timeoutMs, stallTimeoutMs });
    this.activeRun = execution.finally(() => {
      try {
        if (this.abortController) {
          try { this.onTaskEnd(this.currentTask, this.interruptReason, { quarantined: this.quarantined }); }
          catch (error) { this.emit('taskCleanupError', { task: this.currentTask, error }); }
        }
        this.currentTask = null;
        this.abortController = null;
        this.busy = false;
        this._safeHeartbeat(this.quarantined ? 'QUARANTINED' : this.stopped ? 'STOPPED' : 'IDLE');
      } finally { this.activeRun = null; }
    });
    return this.activeRun;
  }

  async _runAutonomous(work, { name, survival, timeoutMs, stallTimeoutMs }) {
    const task = { id: null, type: name,
      payload: { mutatesWorld: true, executionMode: 'AUTONOMOUS' } };
    const controller = new AbortController();
    this.currentTask = task;
    this.abortController = controller;
    this.interruptReason = null;
    let watchdogTimer;
    let lastProgressAt = Date.now();
    let abortObservedAt = null;
    const initialSnapshot = this.snapshot(task) || {};
    let lastPosition = initialSnapshot.position ? { ...initialSnapshot.position } : null;
    let lastInventorySignature = initialSnapshot.inventorySignature ?? null;
    let lastTargetState = initialSnapshot.targetState ?? null;
    const progress = new WorkProgress();
    let rejectWatchdog;
    const reportProgress = details => {
      if (!progress.observe(details)) return false;
      lastProgressAt = Date.now();
      this._safeHeartbeat('WORKING', { workMode: 'AUTONOMOUS', workName: name, progress: details || null });
      this.emit('autonomousProgress', { name, details });
      return true;
    };
    const evaluateSafety = snapshot => {
      // Recovery must remain possible while hungry or hurt; spatial checks still apply.
      const state = survival ? { ...snapshot, health: undefined, food: undefined } : snapshot;
      return this.policy.evaluate(task, state);
    };
    const checkpoint = () => {
      if (controller.signal.aborted) throw abortError(controller.signal.reason);
      const decision = evaluateSafety(this.snapshot(task) || {});
      if (!decision.allowed) {
        this._interrupt(`SAFETY:${decision.reason}`);
        throw abortError(`SAFETY:${decision.reason}`);
      }
      return true;
    };
    const watchdogFailure = reason => {
      this._quarantine(reason);
      rejectWatchdog(abortError(reason));
    };
    try {
      checkpoint();
      this._safeHeartbeat('WORKING', { workMode: 'AUTONOMOUS', workName: name });
      this.onTaskStart(task, { reportProgress });
      const workPromise = Promise.resolve().then(() => work({ signal: controller.signal, checkpoint,
        reportProgress, snapshot: () => this.snapshot(task) }));
      const watchdogPromise = new Promise((_, reject) => { rejectWatchdog = reject; });
      const startedAt = Date.now();
      watchdogTimer = setInterval(() => {
        const now = Date.now();
        if (controller.signal.aborted) {
          abortObservedAt ??= now;
          if (now - abortObservedAt >= this.abortGraceMs) watchdogFailure(`ABORT_IGNORED:${controller.signal.reason || 'INTERRUPTED'}`);
          return;
        }
        if (now - startedAt >= boundedMs(timeoutMs, this.taskTimeoutMs, 30 * 60 * 1000)) return watchdogFailure('AUTONOMOUS_TIMEOUT');
        try {
          const snapshot = this.snapshot(task) || {};
          const decision = evaluateSafety(snapshot);
          if (!decision.allowed) {
            this._interrupt(`SAFETY:${decision.reason}`);
            return;
          }
          const position = snapshot.position;
          if (position && lastPosition && Math.hypot(position.x - lastPosition.x, position.y - lastPosition.y,
            position.z - lastPosition.z) >= 1) {
            lastPosition = { ...position };
            lastProgressAt = now;
          } else if (position && !lastPosition) lastPosition = { ...position };
          if (snapshot.inventorySignature != null && snapshot.inventorySignature !== lastInventorySignature) {
            lastInventorySignature = snapshot.inventorySignature;
            lastProgressAt = now;
          }
          if (snapshot.targetState != null && snapshot.targetState !== lastTargetState) {
            lastTargetState = snapshot.targetState;
            lastProgressAt = now;
          }
        } catch (error) { return watchdogFailure(`WATCHDOG_ERROR:${error.message}`); }
        if (now - lastProgressAt >= boundedMs(stallTimeoutMs, this.stallTimeoutMs, 10 * 60 * 1000)) watchdogFailure('AUTONOMOUS_NO_PROGRESS');
      }, this.watchdogIntervalMs);
      watchdogTimer.unref?.();
      const result = await Promise.race([workPromise, watchdogPromise]);
      checkpoint();
      return result;
    } catch (error) {
      const reason = controller.signal.aborted ? String(controller.signal.reason || error.message) : error.message;
      if (!this.quarantined && controller.signal.aborted) return { status: 'PREEMPTED', reason };
      if (!this.quarantined && error?.name !== 'AbortError') this.emit('autonomousError', { name, error });
      return { status: this.quarantined ? 'QUARANTINED' : 'FAILED', reason };
    } finally {
      if (watchdogTimer) clearInterval(watchdogTimer);
    }
  }

  async _runOnce() {
    let renewTimer = null;
    let safetyTimer = null;
    try {
      this._heartbeat('IDLE');
      const claimSnapshot = this.snapshot(null);
      const task = this.board.claimTask({
        ...this.context,
        agentId: this.agentId,
        capabilities: this.capabilities,
        taskTypes: Object.keys(this.handlers),
        position: claimSnapshot.position || null,
        ttlMs: this.leaseTtlMs
      });
      if (!task) return { status: 'IDLE' };
      this.currentTask = task;
      const initialDecision = this.policy.evaluate(task, this.snapshot(task));
      if (!initialDecision.allowed) {
        this.board.deferTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken,
          reason: initialDecision.reason, retryDelayMs: this.pollIntervalMs * 5 });
        this._heartbeat('DEFERRED', { reason: initialDecision.reason });
        this.emit('deferred', { task, reason: initialDecision.reason });
        return { status: 'DEFERRED', taskId: task.id, reason: initialDecision.reason };
      }
      const handler = this.handlers[task.type];
      if (typeof handler !== 'function') {
        this.board.failTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken,
          error: `NO_HANDLER:${task.type}`, retryable: false });
        return { status: 'FAILED', taskId: task.id, reason: `NO_HANDLER:${task.type}` };
      }

      const controller = new AbortController();
      this.abortController = controller;
      this.interruptReason = null;
      const checkpoint = () => {
        if (controller.signal.aborted) throw abortError(controller.signal.reason);
        const decision = this.policy.evaluate(task, this.snapshot(task));
        if (!decision.allowed) {
          this._interrupt(`SAFETY:${decision.reason}`);
          throw abortError(`SAFETY:${decision.reason}`);
        }
        return true;
      };
      this._heartbeat('WORKING', { taskId: task.id, taskType: task.type });
      this.emit('taskStart', task);
      const startedAt = Date.now();
      let lastProgressAt = startedAt;
      let lastProgressEventAt = 0;
      const initialSnapshot = this.snapshot(task) || {};
      let lastPosition = initialSnapshot.position ? { ...initialSnapshot.position } : null;
      let lastInventorySignature = initialSnapshot.inventorySignature ?? null;
      let lastTargetState = initialSnapshot.targetState ?? null;
      const progress = new WorkProgress();
      let abortObservedAt = null;
      let rejectWatchdog;
      const reportProgress = details => {
        if (!progress.observe(details)) return false;
        const now = Date.now();
        lastProgressAt = now;
        if (details?.action !== 'NAVIGATED') this.board.noteTaskProgress?.({ taskId: task.id,
          agentId: this.agentId, leaseToken: task.leaseToken });
        this._safeHeartbeat('WORKING', { taskId: task.id, progress: details || null });
        if (now - lastProgressEventAt >= 5000) {
          lastProgressEventAt = now;
          try { this.board.recordEvent({ taskId: task.id, goalId: task.goalId, agentId: this.agentId,
            kind: 'TASK_PROGRESS', data: details || {} }); }
          catch (error) { this.emit('eventError', { kind: 'TASK_PROGRESS', error }); }
        }
        this.emit('taskProgress', { task, details });
        return true;
      };
      this.onTaskStart(task, { reportProgress });
      const watchdogFailure = reason => {
        this._quarantine(reason);
        rejectWatchdog(abortError(reason));
      };
      const handlerPromise = Promise.resolve().then(() => handler(task, {
        runtime: this,
        signal: controller.signal,
        checkpoint,
        reportProgress,
        snapshot: () => this.snapshot(task)
      }));
      const watchdogPromise = new Promise((_, reject) => { rejectWatchdog = reject; });
      renewTimer = setInterval(() => {
        try {
          const renewed = this.board.renewTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken, ttlMs: this.leaseTtlMs });
          if (!renewed) this._interrupt('LEASE_LOST');
        } catch (error) { watchdogFailure(`LEASE_RENEWAL_ERROR:${error.message}`); }
      }, Math.max(1000, Math.floor(this.leaseTtlMs / 3)));
      safetyTimer = setInterval(() => {
        if (this.quarantined) return;
        const now = Date.now();
          if (controller.signal.aborted) {
          abortObservedAt ??= now;
          if (now - abortObservedAt >= this.abortGraceMs) watchdogFailure(`ABORT_IGNORED:${controller.signal.reason || 'INTERRUPTED'}`);
          return;
        }
        if (now - startedAt >= this.taskTimeoutMs) return watchdogFailure('TASK_TIMEOUT');
        try {
          const snapshot = this.snapshot(task);
          const position = snapshot?.position;
          if (position && lastPosition && Math.hypot(position.x - lastPosition.x, position.y - lastPosition.y,
            position.z - lastPosition.z) >= 1) {
            lastPosition = { ...position };
            lastProgressAt = now;
          } else if (position && !lastPosition) lastPosition = { ...position };
          if (snapshot?.inventorySignature != null && snapshot.inventorySignature !== lastInventorySignature) {
            lastInventorySignature = snapshot.inventorySignature;
            lastProgressAt = now;
          }
          if (snapshot?.targetState != null && snapshot.targetState !== lastTargetState) {
            lastTargetState = snapshot.targetState;
            lastProgressAt = now;
          }
          const decision = this.policy.evaluate(task, snapshot);
          if (!decision.allowed) {
            this._interrupt(`SAFETY:${decision.reason}`);
            return;
          }
        } catch (error) { return watchdogFailure(`WATCHDOG_ERROR:${error.message}`); }
        if (now - lastProgressAt >= this.stallTimeoutMs) watchdogFailure('NO_PROGRESS_TIMEOUT');
      }, Math.min(this.safetyCheckIntervalMs, this.watchdogIntervalMs));
      renewTimer.unref?.();
      safetyTimer.unref?.();

      let result;
      try { result = await Promise.race([handlerPromise, watchdogPromise]); }
      finally {
        if (renewTimer) clearInterval(renewTimer);
        if (safetyTimer) clearInterval(safetyTimer);
        renewTimer = null;
        safetyTimer = null;
      }
      checkpoint();
      const mutatesWorld = requiresTaskVerification(task) || WORLD_MUTATION_TASKS.has(task.type);
      if (result?.success === false || (mutatesWorld && (result?.verified === false ||
          !isValidTaskVerification(result?.verification, this.board.now?.() ?? Date.now())))) {
        const reason = result?.reason || (mutatesWorld ? 'RESULT_NOT_VERIFIED' : 'TASK_FAILED');
        this.board.failTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken, error: reason, retryable: result?.retryable !== false });
        this.emit('taskFailed', { task, result, reason });
        return { status: 'FAILED', taskId: task.id, reason };
      }
      if (!this.board.completeTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken, result: result || {} })) {
        this._interrupt('LEASE_LOST');
        return { status: 'LEASE_LOST', taskId: task.id };
      }
      this.emit('taskComplete', { task, result });
      return { status: 'COMPLETED', taskId: task.id, result };
    } catch (error) {
      const reason = this.abortController?.signal.aborted
        ? String(this.abortController.signal.reason || error.message)
        : error.message;
      if (this.currentTask && !this.quarantined) {
        this.board.failTask({ taskId: this.currentTask.id, agentId: this.agentId,
          leaseToken: this.currentTask.leaseToken, error: reason, retryable: true });
      }
      if (error?.name !== 'AbortError' && this.listenerCount('error') > 0) this.emit('error', error);
      return { status: this.quarantined ? 'QUARANTINED' : this.abortController?.signal.aborted ? 'PREEMPTED' : 'FAILED', taskId: this.currentTask?.id || null, reason };
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      if (safetyTimer) clearInterval(safetyTimer);
    }
  }

  start() {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.runOnce(); }
      catch (error) { this.emit('runtimeError', error); }
      finally {
        if (this.running && !this.quarantined) this.timer = setTimeout(loop, this.pollIntervalMs);
      }
    };
    loop();
  }

  stop() {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this._interrupt('STOPPED');
    this._safeHeartbeat(this.quarantined ? 'QUARANTINED' : this.busy ? 'STOPPING' : 'STOPPED');
    return this.activeRun || Promise.resolve();
  }
}

module.exports = { AgentRuntime, UniversalSafetyPolicy, WORLD_MUTATION_TASKS };
