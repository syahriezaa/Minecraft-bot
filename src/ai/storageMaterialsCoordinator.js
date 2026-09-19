/** Dashboard-owned lifecycle for the storage materials worker. */

const EventEmitter = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { ChildProcessWatchdog, terminateChildProcess } = require('./childProcessWatchdog');

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(__dirname, 'runStorageRoomMaterials.js');

function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
}

class StorageMaterialsCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      root: ROOT,
      runner: RUNNER,
      spawnProcess: spawn,
      restartDelayMs: 8000,
      maxRestarts: 20,
      workerProgressTimeoutMs: boundedInt(process.env.STORAGE_MATERIALS_PROGRESS_TIMEOUT_MS, 3 * 60 * 1000, 1000, 60 * 60 * 1000),
      orchestrator: null,
      ...options
    };
    this.child = null;
    this.childWatchdog = null;
    this.childWatchdogTimedOut = false;
    this.restartTimer = null;
    this.runConfig = null;
    this.status = this._idleStatus();
  }

  _idleStatus() {
    return {
      active: false,
      phase: 'IDLE',
      pid: null,
      botName: null,
      startedAt: null,
      stoppedAt: null,
      restarts: 0,
      produced: 0,
      deposited: 0,
      cycle: 0,
      recentLogs: [],
      lastMessage: null,
      lastError: null,
      goalId: null,
      config: null
    };
  }

  setOrchestrator(orchestrator) {
    this.options.orchestrator = orchestrator;
    return this;
  }

  _publish(event, data = {}) {
    this.emit('update', { event, at: new Date().toISOString(), ...data });
  }

  _record(level, message) {
    const entry = { at: new Date().toISOString(), level, message };
    this.status.lastMessage = message;
    this.status.recentLogs.push(entry);
    if (this.status.recentLogs.length > 80) this.status.recentLogs.shift();
    this._publish('log', entry);
  }

  _env(config) {
    return {
      ...process.env,
      MC_HOST: config.host,
      MC_PORT: String(config.port),
      MC_REMOTE_HOST: config.host,
      MC_REMOTE_PORT: String(config.port),
      MC_WORLD_ID: config.world,
      MC_REMOTE_VERSION: process.env.MC_REMOTE_VERSION || '26.1',
      MC_BOT_NAME: config.botName,
      STORAGE_ROOM_EXECUTE: '1',
      STORAGE_MATERIALS_MAX_RUN_MS: String(config.maxRunMs),
      STORAGE_MATERIALS_CYCLE_DELAY_MS: String(config.cycleDelayMs),
      STORAGE_MATERIALS_MAX_CYCLES: String(config.maxCycles),
      STORAGE_ROOM_RESTOCK_LOCK: config.restockLockPath,
      STORAGE_MATERIALS_BOOTSTRAP_TERRAIN_WORK: config.bootstrapTerrainWork ? '1' : '0'
    };
  }

  _parseWorkEvent(message) {
    const marker = message.indexOf('WORK_EVENT ');
    if (marker >= 0) {
      try {
        const event = JSON.parse(message.slice(marker + 11));
        if (typeof event.phase === 'string') this.status.phase = event.phase;
        if (Number.isInteger(event.cycle)) this.status.cycle = event.cycle;
        if (Number.isFinite(Number(event.produced))) this.status.produced = Math.max(this.status.produced, Number(event.produced));
        if (Number.isFinite(Number(event.deposited))) this.status.deposited = Math.max(this.status.deposited, Number(event.deposited));
        if (event.reason) this.status.lastError = event.phase === 'BLOCKED' ? String(event.reason) : this.status.lastError;
      } catch {
        // A partial stdout line remains useful as a normal log entry.
      }
    }
    const cycle = message.match(/MATERIALS_CYCLE\s+(\{.*\})$/);
    if (cycle) {
      try {
        const event = JSON.parse(cycle[1]);
        if (Number.isInteger(event.cycle)) this.status.cycle = event.cycle;
        if (Number.isFinite(Number(event.produced))) this.status.produced += Number(event.produced);
        if (Number.isFinite(Number(event.deposited))) this.status.deposited += Number(event.deposited);
      } catch {
        // Keep the raw line when a JSON log is truncated by the child stream.
      }
    }
  }

  _spawnChild() {
    const config = this.runConfig;
    this.childWatchdogTimedOut = false;
    const child = this.options.spawnProcess(process.execPath, [RUNNER], {
      cwd: this.options.root,
      env: this._env(config),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child._codexProcessGroup = process.platform !== 'win32';
    this.child = child;
    this.childWatchdog = new ChildProcessWatchdog(child, {
      timeoutMs: this.options.workerProgressTimeoutMs,
      onStall: ({ silentForMs }) => {
        this.childWatchdogTimedOut = true;
        this.status.phase = 'WATCHDOG_STOPPING';
        this.status.lastError = `Materials worker tidak melaporkan progres selama ${Math.ceil(silentForMs / 60000)} menit; child dihentikan.`;
        this._record('error', this.status.lastError);
      }
    });
    this.status.pid = child.pid || null;
    this.status.phase = this.status.restarts ? 'RESTARTING' : 'STARTING';
    this._publish('worker_started', { pid: this.status.pid, botName: config.botName });

    const consume = (stream, level) => {
      let pending = '';
      stream?.on('data', chunk => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const message of lines.map(line => line.trim()).filter(Boolean)) {
          this._parseWorkEvent(message);
          const marker = message.indexOf('WORK_EVENT ');
          if (marker >= 0) {
            try { this.childWatchdog?.beat(JSON.parse(message.slice(marker + 11))); } catch { /* Ignore incomplete events. */ }
          }
          if (this.status.phase === 'STARTING' || this.status.phase === 'RESTARTING') this.status.phase = 'RUNNING';
          this._record(level, message);
        }
      });
      stream?.on('end', () => {
        if (pending.trim()) {
          this._parseWorkEvent(pending.trim());
          this._record(level, pending.trim());
        }
      });
    };
    consume(child.stdout, 'info');
    consume(child.stderr, 'error');
    child.on('error', error => this._record('error', error.message));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.childWatchdog?.close();
      this.childWatchdog = null;
      this.child = null;
      this.status.pid = null;
      if (this.childWatchdogTimedOut) {
        this.childWatchdogTimedOut = false;
        this.status.active = false;
        this.status.phase = 'NEEDS_ATTENTION';
        this.status.stoppedAt = new Date().toISOString();
        this._publish('stopped', { code, signal, phase: this.status.phase, reason: 'NO_PROGRESS_TIMEOUT' });
        return;
      }
      if (!this.status.active) {
        this.status.phase = 'STOPPED';
        this.status.stoppedAt = new Date().toISOString();
        this._publish('stopped', { code, signal, phase: this.status.phase });
        return;
      }
      if (this.status.restarts < this.options.maxRestarts) {
        this.status.restarts += 1;
        this.status.phase = 'RESTARTING';
        this._record('warning', `Materials worker berhenti code=${code}, dijadwalkan mulai ulang dalam ${this.options.restartDelayMs}ms.`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.status.active) this._spawnChild();
        }, this.options.restartDelayMs);
        this.restartTimer.unref?.();
      } else {
        this.status.active = false;
        this.status.phase = code === 0 ? 'COMPLETE' : 'NEEDS_ATTENTION';
        this.status.lastError = code === 0 ? null : `Materials worker berhenti dengan code=${code}, signal=${signal || 'none'}.`;
        this.status.stoppedAt = new Date().toISOString();
        this._publish('stopped', { code, signal, phase: this.status.phase });
      }
    });
  }

  start(options = {}) {
    if (this.status.active) return { started: false, reason: 'ALREADY_RUNNING', status: this.getStatus() };
    const host = options.host || process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg';
    const port = boundedInt(options.port || process.env.STORAGE_ROOM_SERVER_PORT, 25565, 1, 65535);
    const world = options.world || process.env.MC_WORLD_ID || `${host}:${port}`;
    const botName = String(options.botName || 'StorageMatUI').slice(0, 16);
    const maxRunMs = boundedInt(options.maxRunMs, 300000, 1000, 900000);
    const cycleDelayMs = boundedInt(options.cycleDelayMs, 4000, 250, 60000);
    const maxCycles = boundedInt(options.maxCycles, 60, 1, 1000);
    const restockLockPath = options.restockLockPath || path.join(this.options.root, 'data/storage-room-restock.lock');
    this.runConfig = { host, port, world, botName, maxRunMs, cycleDelayMs, maxCycles, restockLockPath,
      bootstrapTerrainWork: options.bootstrapTerrainWork === true };
    let goalId = null;
    if (this.options.orchestrator) {
      const goal = this.options.orchestrator.submitGoal({
        world,
        dimension: process.env.MC_DIMENSION_ID || 'overworld',
        type: 'PREPARE_MATERIALS',
        priority: 70,
        payload: { botName, capabilities: ['smelt', 'craft', 'haul'] }
      });
      goalId = goal.id;
    }
    this.status = {
      ...this._idleStatus(),
      active: true,
      phase: 'STARTING',
      botName,
      startedAt: new Date().toISOString(),
      goalId,
      config: { host, port, botName, maxRunMs, cycleDelayMs, maxCycles }
    };
    this._spawnChild();
    return { started: true, status: this.getStatus() };
  }

  stop() {
    if (!this.status.active && !this.child && !this.restartTimer) return { stopped: false, reason: 'NOT_RUNNING', status: this.getStatus() };
    this.status.active = false;
    this.status.phase = 'STOPPING';
    this.status.stoppedAt = new Date().toISOString();
    if (this.status.goalId && this.options.orchestrator) this.options.orchestrator.cancelGoal(this.status.goalId, 'OPERATOR_STOP');
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.childWatchdog?.close();
    this.childWatchdog = null;
    terminateChildProcess(this.child);
    if (!this.child) this.status.phase = 'STOPPED';
    this._publish('stopped', { reason: 'operator', phase: this.status.phase });
    return { stopped: true, status: this.getStatus() };
  }

  getStatus() {
    return {
      ...this.status,
      recentLogs: this.status.recentLogs.slice(-20),
      config: this.status.config ? { ...this.status.config } : null
    };
  }
}

const storageMaterialsCoordinator = new StorageMaterialsCoordinator();

module.exports = { StorageMaterialsCoordinator, storageMaterialsCoordinator };
