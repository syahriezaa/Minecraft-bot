const EventEmitter = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { ChildProcessWatchdog, terminateChildProcess } = require('./childProcessWatchdog');

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(__dirname, 'runStorageRoomGathererSwarm.js');
const DEFAULT_CORNERS = Object.freeze([
  Object.freeze({ x: -66, z: -406 }),
  Object.freeze({ x: -63, z: -406 }),
  Object.freeze({ x: -63, z: -379 }),
  Object.freeze({ x: -66, z: -379 })
]);

function positiveInt(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function normalizeMiningArea(corners = DEFAULT_CORNERS, { count = 4, floorY = 40, maxY = 80 } = {}) {
  if (!Array.isArray(corners) || corners.length !== 4) throw new Error('Area tambang wajib memiliki tepat empat sudut.');
  const points = corners.map((point, index) => {
    const x = Number(point?.x);
    const z = Number(point?.z);
    if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error(`Sudut ${index + 1} wajib memakai koordinat X dan Z integer.`);
    return { x, z };
  });
  const xs = [...new Set(points.map(point => point.x))].sort((a, b) => a - b);
  const zs = [...new Set(points.map(point => point.z))].sort((a, b) => a - b);
  const pointKeys = new Set(points.map(point => `${point.x},${point.z}`));
  const expected = xs.flatMap(x => zs.map(z => `${x},${z}`));
  if (xs.length !== 2 || zs.length !== 2 || pointKeys.size !== 4 || !expected.every(key => pointKeys.has(key))) {
    throw new Error('Empat sudut harus membentuk persegi panjang sejajar sumbu X/Z tanpa titik duplikat.');
  }
  const lowY = Number(floorY);
  const highY = Number(maxY);
  if (!Number.isInteger(lowY) || !Number.isInteger(highY) || lowY >= highY) throw new Error('Floor Y harus lebih rendah dari Max Y.');
  const workerCount = Number(count);
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 4) throw new Error('Jumlah worker tambang harus antara 1 sampai 4.');
  const zSize = zs[1] - zs[0] + 1;
  if (workerCount > zSize) throw new Error(`Area Z hanya memiliki ${zSize} kolom untuk ${workerCount} worker.`);

  const baseSize = Math.floor(zSize / workerCount);
  const remainder = zSize % workerCount;
  let cursor = zs[0];
  const regions = Array.from({ length: workerCount }, (_, index) => {
    const size = baseSize + (index < remainder ? 1 : 0);
    const minZ = cursor;
    const maxZ = cursor + size - 1;
    cursor = maxZ + 1;
    return [xs[0], xs[1], minZ, maxZ, lowY, highY].join(',');
  });
  return { corners: points, bounds: { minX: xs[0], maxX: xs[1], minZ: zs[0], maxZ: zs[1], floorY: lowY, maxY: highY }, regions };
}

class MiningFleetCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = { root: ROOT, runner: RUNNER, spawnProcess: spawn, orchestrator: null,
      workerProgressTimeoutMs: positiveInt(process.env.MINING_WORKER_PROGRESS_TIMEOUT_MS, 12 * 60 * 1000, 60 * 60 * 1000), ...options };
    this.child = null;
    this.childWatchdog = null;
    this.restartTimer = null;
    this.runConfig = null;
    this.status = this._idleStatus();
  }

  _idleStatus() {
    return { active: false, phase: 'IDLE', pid: null, startedAt: null, stoppedAt: null, restarts: 0, workers: {}, recentLogs: [], lastError: null, config: null, goalId: null };
  }

  setOrchestrator(orchestrator) {
    this.options.orchestrator = orchestrator;
    return this;
  }

  _publish(event, data = {}) {
    const payload = { event, at: new Date().toISOString(), ...data };
    this.emit('update', payload);
  }

  _recordLog(level, worker, message) {
    this.status.recentLogs.push({ at: new Date().toISOString(), level, worker: worker || 'coordinator', message });
    if (this.status.recentLogs.length > 80) this.status.recentLogs.shift();
    this._publish('log', { level, worker: worker || null, message });
  }

  _spawnChild() {
    const config = this.runConfig;
    const child = this.options.spawnProcess(process.execPath, [this.options.runner], {
      cwd: this.options.root,
      env: config.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child._codexProcessGroup = process.platform !== 'win32';
    this.child = child;
    this.childWatchdog = new ChildProcessWatchdog(child, {
      timeoutMs: this.options.workerProgressTimeoutMs,
      onStall: ({ silentForMs }) => {
        this.status.phase = 'WATCHDOG_STOPPING';
        this.status.lastError = `Mining worker tidak melaporkan progres selama ${Math.ceil(silentForMs / 60000)} menit; child dihentikan.`;
        for (const worker of Object.values(this.status.workers)) {
          if (['COMPLETE', 'BLOCKED'].includes(worker.phase)) continue;
          worker.phase = 'NO_PROGRESS_TIMEOUT';
          worker.reason = 'NO_PROGRESS_TIMEOUT';
        }
        this._recordLog('error', null, this.status.lastError);
      }
    });
    this.status.pid = child.pid || null;
    this.status.phase = this.status.restarts > 0 ? 'RESTARTING' : 'MINING';
    this.status.workers = Object.fromEntries(config.names.map((name, index) => ({
      name,
      state: { ...(this.status.workers[name] || {}), name, region: config.area.regions[index], phase: 'STARTING' }
    })).map(({ name, state }) => [name, state]));

    const consume = (stream, level) => {
      let pending = '';
      stream?.on('data', chunk => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const message of lines.map(line => line.trim()).filter(Boolean)) {
          const workerName = message.match(/^\[(ResourceW\d+)\]/)?.[1];
          const marker = message.indexOf('WORK_EVENT ');
          if (workerName && marker >= 0) {
            try {
              const event = JSON.parse(message.slice(marker + 11));
              if (event.phase === 'STARTING') this.childWatchdog?.beginSession(workerName, event.workerSession);
              if (!this.childWatchdog?.acceptsSession(workerName, event.workerSession)) continue;
              if (this.childWatchdog?.beat(event, workerName)) this.status.workers[workerName].lastProgressAt = new Date().toISOString();
              if (typeof event.phase === 'string') this.status.workers[workerName].phase = event.phase;
              if (Number.isFinite(Number(event.inventoryFillRatio))) this.status.workers[workerName].inventoryFillRatio = Number(event.inventoryFillRatio);
              if (Number.isInteger(event.verifiedBlocks)) this.status.workers[workerName].verifiedBlocks = event.verifiedBlocks;
              if (event.reason) this.status.workers[workerName].reason = event.reason;
            } catch { /* Log parsial tidak mengubah status worker. */ }
          }
          this._recordLog(level, workerName, message);
        }
      });
    };
    consume(child.stdout, 'info');
    consume(child.stderr, 'error');
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.childWatchdog?.close();
      this.childWatchdog = null;
      this.child = null;
      this.status.pid = null;
      if (this.status.phase === 'STOPPING' || !this.status.active) {
        this.status.active = false;
        this.status.stoppedAt = new Date().toISOString();
        this.status.phase = 'STOPPED';
        this._publish('stopped', { code, signal, phase: this.status.phase });
        return;
      }
      const verifiedBlocks = Object.values(this.status.workers)
        .reduce((total, worker) => total + (Number(worker.verifiedBlocks) || 0), 0);
      if (code === 0 && verifiedBlocks === 0) {
        this.status.active = false;
        this.status.stoppedAt = new Date().toISOString();
        this.status.phase = 'NEEDS_ATTENTION';
        this.status.lastError = 'Sesi miner berakhir tanpa satu pun blok terverifikasi; periksa perlengkapan dan log worker.';
        this._recordLog('error', null, this.status.lastError);
        this._publish('stopped', { code, signal, phase: this.status.phase });
        return;
      }
      if (code === 0 && config.autoRestart && this.status.restarts < config.maxRestarts) {
        this.status.restarts += 1;
        this.status.phase = 'RESTARTING';
        this._recordLog('warning', null, `Sesi miner selesai normal; melanjutkan dari checkpoint dalam ${config.restartDelayMs}ms (restart ${this.status.restarts}/${config.maxRestarts}).`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.status.active) this._spawnChild();
        }, config.restartDelayMs);
        this.restartTimer.unref?.();
        return;
      }
      this.status.active = false;
      this.status.stoppedAt = new Date().toISOString();
      if (code === 0) this.status.phase = 'COMPLETE';
      else {
        this.status.phase = 'NEEDS_ATTENTION';
        this.status.lastError = `Mining fleet berhenti dengan code=${code}, signal=${signal || 'none'}.`;
      }
      this._publish('stopped', { code, signal, phase: this.status.phase });
    });
  }

  start(options = {}) {
    if (this.status.active) return { started: false, reason: 'ALREADY_RUNNING', status: this.getStatus() };
    const count = options.count === undefined ? 4 : Number(options.count);
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('Jumlah worker tambang harus antara 1 sampai 4.');
    const area = normalizeMiningArea(options.corners, { count, floorY: options.floorY ?? 40, maxY: options.maxY ?? 80 });
    const requestedMode = String(options.mode || 'strip_surface_to_floor');
    const mode = ['depth_first', 'surface_to_floor', 'strip_surface_to_floor', 'surface_flat_then_stair'].includes(requestedMode)
      ? requestedMode : 'strip_surface_to_floor';
    const host = options.host || process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg';
    const port = Number(options.port) || Number(process.env.STORAGE_ROOM_SERVER_PORT) || 25565;
    const world = options.world || process.env.MC_WORLD_ID || `${host}:${port}`;
    const names = Array.from({ length: count }, (_, index) => `ResourceW${index + 1}`);
    const areaKey = [area.bounds.minX, area.bounds.maxX, area.bounds.minZ, area.bounds.maxZ, area.bounds.floorY, area.bounds.maxY].join('_');
    let goalId = null;
    if (this.options.orchestrator) {
      const goal = this.options.orchestrator.submitGoal({
        world,
        dimension: process.env.MC_DIMENSION_ID || 'overworld',
        type: 'MINING_FLEET',
        priority: 80,
        payload: { count, regions: area.regions, workerNames: names, corners: area.corners, bounds: area.bounds }
      });
      goalId = goal.id;
    }
    const env = {
      ...process.env,
      MC_HOST: host,
      MC_PORT: String(port),
      MC_REMOTE_HOST: host,
      MC_REMOTE_PORT: String(port),
      MC_WORLD_ID: world,
      MC_REMOTE_VERSION: process.env.MC_REMOTE_VERSION || '26.1',
      STORAGE_ROOM_EXECUTE: '1',
      STORAGE_GATHERER_COUNT: String(count),
      STORAGE_GATHERER_REGIONS: area.regions.join(';'),
      STORAGE_GATHERER_START_STAGGER_MS: String(positiveInt(options.staggerMs, 12000, 120000)),
      STORAGE_QUARRY_MIN_CARRY_RATIO: String(Math.min(1, Math.max(0.1, Number(options.minInventoryFillRatio) || 0.75))),
      STORAGE_QUARRY_MAX_RUN_MS: String(positiveInt(options.maxRunMs, 900000, 3600000)),
      STORAGE_QUARRY_SHARED_WORLD: '1',
      STORAGE_QUARRY_MODE: mode,
      STORAGE_QUARRY_MAX_SAFE_DROP: String(Math.max(1, Math.min(4, Number(options.maxSafeDrop) || 3))),
      STORAGE_QUARRY_BOOTSTRAP_TP: '1',
      STORAGE_QUARRY_BOOTSTRAP_TERRAIN_WORK: options.bootstrapTerrainWork === false ? '0' : '1',
      ...Object.fromEntries(names.flatMap((name, index) => [
        [`STORAGE_GATHERER_BOT_${index + 1}`, name],
        [`STORAGE_GATHERER_CHECKPOINT_${index + 1}`, `data/mining-fleet-${areaKey}-worker-${index + 1}.json`]
      ]))
    };
    const autoRestart = options.autoRestart !== false;
    const restartDelayMs = positiveInt(options.restartDelayMs, 10000, 120000);
    const maxRestarts = positiveInt(options.maxRestarts, 20, 1000);
    this.runConfig = { host, port, world, count, mode, area, names, env, autoRestart, restartDelayMs, maxRestarts };
    this.status = {
      active: true,
      phase: 'MINING',
      pid: null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      restarts: 0,
      workers: Object.fromEntries(names.map((name, index) => [name, { name, region: area.regions[index], phase: 'STARTING' }])),
      recentLogs: [],
      lastError: null,
      config: { host, port, world, count, mode, maxSafeDrop: Number(env.STORAGE_QUARRY_MAX_SAFE_DROP), corners: area.corners, bounds: area.bounds, regions: area.regions },
      goalId
    };
    this._spawnChild();
    this._publish('started', { pid: this.status.pid, count, bounds: area.bounds });
    return { started: true, status: this.getStatus() };
  }

  stop() {
    if (!this.status.active && !this.child && !this.restartTimer) return { stopped: false, reason: 'NOT_RUNNING', status: this.getStatus() };
    if (this.status.goalId && this.options.orchestrator) this.options.orchestrator.cancelGoal(this.status.goalId, 'OPERATOR_STOP');
    this.status.phase = 'STOPPING';
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.childWatchdog?.close();
    this.childWatchdog = null;
    terminateChildProcess(this.child);
    if (!this.child) {
      this.status.active = false;
      this.status.phase = 'STOPPED';
    }
    return { stopped: true, status: this.getStatus() };
  }

  getStatus() {
    return { ...this.status, workers: Object.fromEntries(Object.entries(this.status.workers).map(([name, state]) => [name, { ...state }])), recentLogs: this.status.recentLogs.slice(-20) };
  }
}

const miningFleetCoordinator = new MiningFleetCoordinator();

module.exports = { DEFAULT_CORNERS, MiningFleetCoordinator, miningFleetCoordinator, normalizeMiningArea };
