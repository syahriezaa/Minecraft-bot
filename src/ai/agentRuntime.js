const EventEmitter = require('node:events');

const WORLD_MUTATION_TASKS = new Set([
  'MINE_CELL', 'ENSURE_ACCESS', 'BUILD', 'LANDSCAPE', 'REPAIR_FARM',
  'HARVEST', 'PLANT', 'SORT_ITEMS', 'SMELT', 'CRAFT'
]);

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
    this.pollIntervalMs = Math.max(250, Number(options.pollIntervalMs) || 1000);
    this.leaseTtlMs = Math.max(5000, Number(options.leaseTtlMs) || 30000);
    this.metadata = options.metadata || {};
    this.running = false;
    this.timer = null;
    this.busy = false;
    this.currentTask = null;
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

  async runOnce() {
    if (this.busy) return { status: 'BUSY', taskId: this.currentTask?.id || null };
    this.busy = true;
    let renewTimer = null;
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
      const decision = this.policy.evaluate(task, this.snapshot(task));
      if (!decision.allowed) {
        this.board.deferTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken,
          reason: decision.reason, retryDelayMs: this.pollIntervalMs * 5 });
        this._heartbeat('DEFERRED', { reason: decision.reason });
        this.emit('deferred', { task, reason: decision.reason });
        return { status: 'DEFERRED', taskId: task.id, reason: decision.reason };
      }
      const handler = this.handlers[task.type];
      if (typeof handler !== 'function') {
        this.board.failTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken,
          error: `NO_HANDLER:${task.type}`, retryable: false });
        return { status: 'FAILED', taskId: task.id, reason: `NO_HANDLER:${task.type}` };
      }
      this._heartbeat('WORKING', { taskId: task.id, taskType: task.type });
      this.emit('taskStart', task);
      renewTimer = setInterval(() => {
        const renewed = this.board.renewTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken, ttlMs: this.leaseTtlMs });
        if (!renewed) this.emit('leaseLost', task);
      }, Math.max(1000, Math.floor(this.leaseTtlMs / 3)));
      renewTimer.unref?.();
      const result = await handler(task, { runtime: this, snapshot: () => this.snapshot(task) });
      const mutatesWorld = task.payload?.mutatesWorld === true || WORLD_MUTATION_TASKS.has(task.type);
      if (result?.success === false || (mutatesWorld && result?.verified !== true)) {
        const reason = result?.reason || (mutatesWorld ? 'RESULT_NOT_VERIFIED' : 'TASK_FAILED');
        this.board.failTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken, error: reason, retryable: result?.retryable !== false });
        this.emit('taskFailed', { task, result, reason });
        return { status: 'FAILED', taskId: task.id, reason };
      }
      if (!this.board.completeTask({ taskId: task.id, agentId: this.agentId, leaseToken: task.leaseToken, result: result || {} })) {
        return { status: 'LEASE_LOST', taskId: task.id };
      }
      this.emit('taskComplete', { task, result });
      this._heartbeat('IDLE', { lastTaskId: task.id, lastTaskType: task.type });
      return { status: 'COMPLETED', taskId: task.id, result };
    } catch (error) {
      if (this.currentTask) {
        this.board.failTask({ taskId: this.currentTask.id, agentId: this.agentId,
          leaseToken: this.currentTask.leaseToken, error: error.message, retryable: true });
      }
      if (this.listenerCount('error') > 0) this.emit('error', error);
      return { status: 'FAILED', taskId: this.currentTask?.id || null, reason: error.message };
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      this.currentTask = null;
      this.busy = false;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.runOnce();
      if (this.running) this.timer = setTimeout(loop, this.pollIntervalMs);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this._heartbeat('STOPPED');
  }
}

module.exports = { AgentRuntime, UniversalSafetyPolicy, WORLD_MUTATION_TASKS };
