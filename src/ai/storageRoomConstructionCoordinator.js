/** Orkestrator pembangunan storage room yang dikendalikan dashboard dan bisa dipulihkan. */

const EventEmitter = require('node:events');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { querySLP } = require('../network/liveProtocolClient');

const ROOT = path.resolve(__dirname, '../..');
const DEFAULT_ORIGIN = '-110,70,-400';
const BUILD_PHASES = Object.freeze(['floor', 'walls', 'entry', 'lighting', 'roof']);

const ROLE_SCRIPTS = Object.freeze({
  builder: path.join(__dirname, 'runStorageRoomSwarm.js'),
  chestInstaller: path.join(__dirname, 'runStorageRoomSwarm.js'),
  landscaper: path.join(__dirname, 'runStorageRoomLandscaper.js')
});

function positiveInt(value, fallback, maximum = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function nonNegativeInt(value, fallback, maximum = 60000) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function normalizeOrigin(value) {
  if (value && typeof value === 'object') {
    const points = [value.x, value.y, value.z].map(Number);
    if (points.every(Number.isInteger)) return points.join(',');
  }
  const origin = String(value ?? DEFAULT_ORIGIN).trim();
  if (/^-?\d+,-?\d+,-?\d+$/.test(origin)) return origin;
  throw new Error('Origin storage room harus berbentuk x,y,z integer.');
}

class StorageRoomConstructionCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      root: ROOT,
      host: process.env.STORAGE_ROOM_SERVER_HOST || 'atoms-girl.tun.ply.gg',
      port: Number(process.env.STORAGE_ROOM_SERVER_PORT) || 25565,
      version: process.env.MC_REMOTE_VERSION || '26.1',
      origin: process.env.STORAGE_ROOM_ORIGIN || DEFAULT_ORIGIN,
      spawnProcess: spawn,
      restartDelayMs: 10000,
      materialRetryDelayMs: 15000,
      maxRestarts: 20,
      ...options
    };
    this.children = new Map();
    this.startTimers = new Set();
    this.pendingRoles = new Set();
    this.roleRestarts = new Map();
    this.waitingForServer = null;
    this.blockedRoles = new Set();
    this.runConfig = null;
    this.orchestrator = options.orchestrator || null;
    this.status = {
      active: false,
      phase: 'IDLE',
      runId: null,
      startedAt: null,
      stoppedAt: null,
      restarts: 0,
      children: {},
      recentLogs: [],
      lastError: null
    };
  }

  setOrchestrator(orchestrator) {
    this.orchestrator = orchestrator;
    return this;
  }

  _publish(event, data = {}) {
    const payload = { event, at: new Date().toISOString(), ...data };
    this.emit('update', payload);
    if (event === 'log') {
      this.status.recentLogs.push(payload);
      if (this.status.recentLogs.length > 100) this.status.recentLogs.shift();
    }
  }

  _childEnv(role, config) {
    const common = {
      ...process.env,
      // Runner Mineflayer lama memakai MC_HOST/MC_PORT, sedangkan konektor remote memakai
      // MC_REMOTE_*; coordinator harus mengisi keduanya agar .env lokal tidak mengambil alamat
      // default 127.0.0.1 tanpa terlihat.
      MC_HOST: config.host,
      MC_PORT: String(config.port),
      MC_REMOTE_HOST: config.host,
      MC_REMOTE_PORT: String(config.port),
      MC_WORLD_ID: config.world,
      MC_REMOTE_VERSION: this.options.version,
      STORAGE_ROOM_EXECUTE: '1',
      STORAGE_ROOM_ORIGIN: config.origin,
      // Builder hanya memakai sumber resmi dari memori bersama. Produksi material dimiliki
      // fleet mandiri dan tidak menjadi bagian lifecycle pembangunan.
      // Assignment bersama tetap menjadi jalur utama, tetapi builder boleh mencari
      // sumber live terbatas ketika materials baru saja memindahkan batch ke overflow.
      STORAGE_ROOM_MATERIAL_FALLBACK_SEARCH: process.env.STORAGE_ROOM_MATERIAL_FALLBACK_SEARCH || '1',
      STORAGE_ROOM_MATERIAL_SEARCH_COUNT: '16',
      STORAGE_ROOM_LOGISTICS_MAX_CONCURRENCY: process.env.STORAGE_ROOM_LOGISTICS_MAX_CONCURRENCY || '8',
      STORAGE_ROOM_RESTOCK_LOCK: path.join(this.options.root, 'data/storage-room-restock.lock')
    };
    if (role === 'landscaper') return {
      ...common,
      MC_BOT_NAME: config.landscaperBotName || 'StorageLand2',
      STORAGE_LANDSCAPE_SUPPORT_ONLY: '1',
      // Runner landscaper membatasi satu sesi maksimal 480000ms; sesi
      // coordinator yang lebih panjang tetap dijalankan bertahap tanpa
      // membuat role langsung gagal validasi saat spawn.
      STORAGE_LANDSCAPE_MAX_RUN_MS: String(Math.min(config.workerRunMs, 480000)),
      STORAGE_LANDSCAPE_SKIP_BASE: '0',
      STORAGE_LANDSCAPE_CHECKPOINT: 'data/storage-room-landscape.json',
      STORAGE_LANDSCAPE_SUPPORT_AUDIT: 'data/storage-room-support-audit.json'
    };
    if (role === 'chestInstaller') return {
      ...common,
      STORAGE_ROOM_LOCK_PRIORITY: '9',
      STORAGE_ROOM_COORDINATE_MOVEMENT: '0',
      STORAGE_ROOM_CONTINUOUS: '1',
      STORAGE_ROOM_ALLOW_TERRAIN_WORK: '0',
      STORAGE_ROOM_SKIP_BASE: '1',
      STORAGE_ROOM_WALK_TO_WORKSITE: '1',
      STORAGE_ROOM_BOOTSTRAP_TP: '0',
      STORAGE_ROOM_PHASES: 'storage',
      STORAGE_ROOM_ALLOW_MATERIAL_PROCESSING: '1',
      STORAGE_ROOM_SWARM_WORKERS: '1',
      STORAGE_ROOM_BATCH: String(config.chestInstallerBatch),
      STORAGE_ROOM_MAX_RUN_MS: String(config.workerRunMs),
      STORAGE_ROOM_BOT_1: config.chestInstallerBotName,
      STORAGE_ROOM_INSTANCE_LOCK_1: path.join(this.options.root, 'data/storage-room-chest-installer.lock'),
      STORAGE_ROOM_CHECKPOINT_WORKER_1: 'data/storage-room-chest-installer.json'
      ,STORAGE_ROOM_REPAIR_EMPTY_CHESTS: '1'
    };
    return {
      ...common,
      STORAGE_ROOM_LOCK_PRIORITY: '10',
      STORAGE_ROOM_COORDINATE_MOVEMENT: '0',
      STORAGE_ROOM_CONTINUOUS: '1',
      STORAGE_ROOM_SWARM_WORKERS: String(config.builderWorkerCount),
      STORAGE_ROOM_WORKER_START_STAGGER_MS: String(config.builderStaggerMs),
      STORAGE_ROOM_BATCH: String(config.builderBatch),
      STORAGE_ROOM_MAX_RUN_MS: String(config.workerRunMs),
      STORAGE_ROOM_ALLOW_TERRAIN_WORK: '1',
      STORAGE_ROOM_PHASES: config.builderPhases.join(','),
      STORAGE_ROOM_ALLOW_MATERIAL_PROCESSING: '0',
      STORAGE_ROOM_SKIP_BASE: '1',
      STORAGE_ROOM_WALK_TO_WORKSITE: '1',
      STORAGE_ROOM_BOOTSTRAP_TP: '0',
      ...Object.fromEntries(Array.from({ length: config.builderWorkerCount }, (_, index) => [
        [`STORAGE_ROOM_BOT_${index + 1}`, config.builderBotNames[index] || `BuildBot${index + 1}`],
        [`STORAGE_ROOM_INSTANCE_LOCK_${index + 1}`, path.join(this.options.root, `data/storage-room-construction-builder-${index + 1}.lock`)],
        [`STORAGE_ROOM_CHECKPOINT_WORKER_${index + 1}`, `data/storage-room-construction-builder-${index + 1}.json`]
      ]).flat())
    };
  }

  _startChild(role, config) {
    this.pendingRoles.delete(role);
    const script = ROLE_SCRIPTS[role];
    const child = this.options.spawnProcess(process.execPath, [script], {
      cwd: this.options.root,
      env: this._childEnv(role, config),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const state = { role, pid: child.pid || null, status: 'STARTING', startedAt: new Date().toISOString(), restarts: 0, subworkers: {}, lastLogs: [] };
    this.children.set(role, { child, state });
    this.status.children[role] = state;
    this._publish('worker_started', { role, pid: state.pid });

    const consume = (stream, level) => {
      let pending = '';
      stream?.on('data', chunk => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines.map(item=>item.trim()).filter(Boolean)) {
        if (state.status === 'STARTING') state.status = 'ALIVE';
        const marker = line.indexOf('WORK_EVENT ');
        if (marker >= 0) {
          try {
            const event = JSON.parse(line.slice(marker + 11));
            const prefix = line.slice(0, marker).match(/^\[([^\]]+)\]\s*$/);
            const workerName = prefix?.[1];
            const target = workerName
              ? (state.subworkers[workerName] ||= { name: workerName, status: 'ALIVE' })
              : state;
            if (typeof event.phase === 'string') target.status = event.phase;
            if (Number.isInteger(event.verifiedBlocks) && event.verifiedBlocks >= 0) {
              target.verifiedBlocks = Math.max(target.verifiedBlocks || 0, event.verifiedBlocks);
              state.verifiedBlocks = Math.max(state.verifiedBlocks || 0, event.verifiedBlocks);
            }
            if (typeof event.buildPhase === 'string') target.buildPhase = event.buildPhase;
            if (Number.isInteger(event.remainingBlocks) && event.remainingBlocks >= 0) target.remainingBlocks = event.remainingBlocks;
            if (Number.isInteger(event.delivered) && event.delivered >= 0) {
              target.delivered = Math.max(target.delivered || 0, event.delivered);
              state.delivered = Math.max(state.delivered || 0, event.delivered);
            }
            if (Number.isFinite(Number(event.inventoryFillRatio))) {
              target.inventoryFillRatio = Math.max(Number(target.inventoryFillRatio) || 0, Number(event.inventoryFillRatio));
              state.inventoryFillRatio = Math.max(Number(state.inventoryFillRatio) || 0, Number(event.inventoryFillRatio));
            }
            if (event.reason) target.reason = event.reason;
            if (workerName) {
              const workers = Object.values(state.subworkers);
              const active = workers.find(item => !['BLOCKED', 'COMPLETE'].includes(item.status));
              if (active) {
                state.status = active.status || 'RUNNING';
                delete state.reason;
              } else if (workers.length && workers.every(item => item.status === 'COMPLETE')) {
                state.status = 'COMPLETE';
                delete state.reason;
              } else if (workers.length && workers.every(item => item.status === 'BLOCKED')) {
                state.status = 'BLOCKED';
                state.reason = workers.find(item => item.reason)?.reason;
              } else if (workers.length) {
                state.status = 'PARTIAL';
                delete state.reason;
              }
            } else {
              if (typeof event.phase === 'string') state.status = event.phase;
              if (event.reason) state.reason = event.reason;
            }
            // Begitu role berhasil melewati spawn dan mengirim event kerja, kegagalan
            // koneksi sebelumnya tidak lagi dihitung sebagai retry beruntun.
            if (event.phase && event.phase !== 'STARTING') this.roleRestarts.delete(role);
            if (role === 'builder' || role === 'landscaper') this._maybeStartChestInstaller(config);
          } catch { /* Baris tidak lengkap bukan bukti progres. */ }
        }
        state.lastLog = line;
        state.lastLogs.push({ level, message: line, at: new Date().toISOString() });
        if (state.lastLogs.length > 12) state.lastLogs.shift();
        this._publish('log', { role, level, message: line });
      }
    }); };
    consume(child.stdout, 'info');
    consume(child.stderr, 'error');
    child.on('exit', (code, signal) => this._handleExit(role, code, signal, config));
    return state;
  }

  _maybeStartChestInstaller(config) {
    if (config.chestInstallerWorkerCount < 1) return false;
    const waiting = this.status.children.chestInstaller;
    if (!this.status.active || waiting?.status !== 'WAITING_FOR_FLOOR' || !this.pendingRoles.has('chestInstaller')) return false;
    const landscapedReady = this.status.children.landscaper?.status === 'COMPLETE';
    if (config.chestInstallerStartWhenLandscaped && landscapedReady) {
      this.pendingRoles.delete('chestInstaller');
      this._publish('landscape_ready', { role: 'chestInstaller' });
      this._startChild('chestInstaller', config);
      return true;
    }
    const builders = Object.values(this.status.children.builder?.subworkers || {});
    if (builders.length < config.builderWorkerCount) return false;
    const floorReady = builders.every(worker => worker.status === 'COMPLETE' ||
      (worker.buildPhase && !['foundation', 'floor'].includes(worker.buildPhase)));
    if (!floorReady) return false;
    this.pendingRoles.delete('chestInstaller');
    this._publish('floor_ready', { role: 'chestInstaller', builderWorkers: builders.length });
    this._startChild('chestInstaller', config);
    return true;
  }

  _scheduleChild(role, config, delayMs) {
    const queuedState = {
      role,
      pid: null,
      status: 'QUEUED',
      scheduledAt: new Date(Date.now() + delayMs).toISOString(),
      subworkers: {}
    };
    this.pendingRoles.add(role);
    this.status.children[role] = queuedState;
    if (delayMs <= 0) {
      this._startChild(role, config);
      return;
    }
    this._publish('worker_queued', { role, delayMs });
    const timer = setTimeout(() => {
      this.startTimers.delete(timer);
      if (this.status.active && this.generation === config.generation) this._startChild(role, config);
      else {
        this.pendingRoles.delete(role);
        if (this.status.children[role]?.status === 'QUEUED') this.status.children[role].status = 'STOPPED';
      }
    }, delayMs);
    timer.unref?.();
    this.startTimers.add(timer);
  }

  _clearStartupSchedule() {
    for (const timer of this.startTimers) clearTimeout(timer);
    this.startTimers.clear();
    for (const role of this.pendingRoles) {
      if (this.status.children[role]?.status === 'QUEUED') this.status.children[role].status = 'STOPPED';
    }
    this.pendingRoles.clear();
  }

  _handleExit(role, code, signal, config) {
    const entry = this.children.get(role);
    if (!entry) return;
    const completed = entry.state.status === 'COMPLETE';
    const resumable = entry.state.status === 'PAUSED' || entry.state.reason === 'TIME_LIMIT';
    entry.state.status = this.status.active ? 'RESTARTING' : 'STOPPED';
    entry.state.exit = { code, signal, at: new Date().toISOString() };
    this._publish('worker_exit', {
      role,
      code,
      signal,
      status: entry.state.status,
      reason: entry.state.reason || null,
      lastLog: entry.state.lastLog || null,
      lastLogs: entry.state.lastLogs || []
    });
    this.children.delete(role);
    if (!this.status.active) {
      if (!this.children.size && this.status.phase === 'STOPPING') this.status.phase = 'STOPPED';
      return;
    }
    const productive = (entry.state.verifiedBlocks || 0) > 0 || (entry.state.delivered || 0) > 0;
    const connectionLog = (entry.state.lastLogs || []).map(item => item.message).join('\n');
    const transientConnectionFailure = !productive && /event spawn|spawn timeout|ECONN(?:RESET|REFUSED|TIMEDOUT)|ETIMEDOUT|Koneksi .*berakhir|connect .*timeout/i.test(connectionLog);
    if (transientConnectionFailure) {
      const roleRestarts = (this.roleRestarts.get(role) || 0) + 1;
      if (roleRestarts <= this.options.maxRestarts) {
        this.roleRestarts.set(role, roleRestarts);
        this.status.restarts += 1;
        const delay = Math.min(60000, Math.max(250, this.options.restartDelayMs) * (2 ** Math.min(roleRestarts - 1, 5)));
        this.status.phase = 'PARTIAL_ATTENTION';
        this.status.lastError = `${role}: koneksi belum stabil; retry ${roleRestarts}/${this.options.maxRestarts}.`;
        this._publish('worker_restart_scheduled', {
          role,
          delayMs: delay,
          attempt: roleRestarts,
          reason: { code, signal, kind: 'TRANSIENT_CONNECTION', lastLog: entry.state.lastLog || null }
        });
        const generation = this.generation;
        setTimeout(() => {
          if (this.status.active && this.generation === generation) this._startChild(role, config);
        }, delay).unref?.();
        return;
      }
      entry.state.reason = 'STARTUP_RETRY_EXHAUSTED';
    }
    const materialBlocked = ['builder', 'chestInstaller'].includes(role) && /MATERIAL_(?:UNAVAILABLE|SOURCE_UNCHANGED)|MATERIAL_SOURCE_UNCHANGED/i.test(
      `${entry.state.reason || ''}\n${connectionLog}`
    );
    if (materialBlocked && this.status.active) {
      const generation = this.generation;
      const delay = Math.max(250, Number(this.options.materialRetryDelayMs) || 15000);
      entry.state.status = 'WAITING_MATERIAL';
      entry.state.pid = null;
      this.status.children[role] = { ...entry.state, subworkers: {} };
      this.status.phase = 'PARTIAL_ATTENTION';
      this.status.lastError = `${role}: menunggu material, retry checkpoint dalam ${delay}ms.`;
      this.pendingRoles.add(role);
      this._publish('worker_waiting_material', {
        role,
        delayMs: delay,
        reason: entry.state.reason || 'MATERIAL_UNAVAILABLE'
      });
      setTimeout(() => {
        if (!this.status.active || this.generation !== generation || this.children.has(role)) return;
        this._startChild(role, config);
      }, delay).unref?.();
      return;
    }
    if (code === 0 && completed) {
      entry.state.status = 'COMPLETE';
      if (!this.children.size && !this.pendingRoles.size) {
        this.status.active = false;
        this.status.phase = this.blockedRoles.size ? 'NEEDS_ATTENTION' : 'COMPLETE';
        this.status.stoppedAt = new Date().toISOString();
        if (this.blockedRoles.size && !this.status.lastError) this.status.lastError = `Role(s) geblokir: ${[...this.blockedRoles].join(', ')}`;
      }
      return;
    }
    // Batas sesi normal adalah checkpoint pause, bukan kegagalan role.
    if (!resumable && !productive) {
      entry.state.status = 'BLOCKED';
      this.blockedRoles.add(role);
      if (this.children.size > 0 || this.pendingRoles.size > 0) {
        this.status.phase = 'PARTIAL_ATTENTION';
        this.status.lastError = `${role}: ${entry.state.reason || 'role berhenti tanpa progres terverifikasi.'}`;
        return;
      }
      this.status.active = false;
      this.status.phase = 'NEEDS_ATTENTION';
      this.status.stoppedAt = new Date().toISOString();
      this.status.lastError = `${role}: ${entry.state.reason || 'Tidak ada progres terverifikasi; sesi tidak diulang otomatis.'}`;
      for (const {child} of this.children.values()) child.kill('SIGTERM');
      return;
    }
    if (code !== 0 || resumable) this.status.restarts += 1;
    if (this.status.restarts > this.options.maxRestarts) {
      this._clearStartupSchedule();
      this.status.active = false;
      this.status.phase = 'NEEDS_ATTENTION';
      this.status.stoppedAt = new Date().toISOString();
      this.status.lastError = `Worker ${role} terlalu sering berhenti.`;
      this._publish('attention_required', { role, message: this.status.lastError });
      for (const { child } of this.children.values()) child.kill('SIGTERM');
      return;
    }
    const delay = this.options.restartDelayMs;
    const generation = this.generation;
    this._publish('worker_restart_scheduled', { role, delayMs: delay, reason: { code, signal } });
    setTimeout(() => {
      if (this.status.active && this.generation === generation) this._startChild(role, config);
    }, delay).unref?.();
  }

  start(options = {}) {
    if (this.status.active) return { started: false, reason: 'ALREADY_RUNNING', status: this.getStatus() };
    const requestedPhases = options.builderPhases === undefined
      ? BUILD_PHASES
      : (Array.isArray(options.builderPhases) ? options.builderPhases : String(options.builderPhases).split(','))
        .map(phase => String(phase).trim()).filter(Boolean);
    if (!requestedPhases.length || requestedPhases.some(phase => !BUILD_PHASES.includes(phase))) {
      throw new Error(`Fase builder tidak valid. Pilihan: ${BUILD_PHASES.join(', ')}`);
    }
    const config = {
      host: options.host || this.options.host,
      port: Number(options.port) || this.options.port,
      world: options.world || process.env.MC_WORLD_ID || `${options.host || this.options.host}:${Number(options.port) || this.options.port}`,
      origin: normalizeOrigin(options.origin ?? this.options.origin),
      builderWorkerCount: positiveInt(options.builderWorkerCount, 2, 8),
      landscaperWorkerCount: nonNegativeInt(options.landscaperWorkerCount, 1, 1),
      chestInstallerWorkerCount: nonNegativeInt(options.chestInstallerWorkerCount, 1, 1),
      builderPhases: requestedPhases,
      chestInstallerBatch: positiveInt(options.chestInstallerBatch, 16, 64),
      // Dua builder berbagi satu jalur produksi stone_bricks. Batch 32 membuat
      // suplai parsial (mis. 22 + 18) tidak pernah bisa dipakai oleh keduanya;
      // batch 16 menjaga keduanya tetap produktif tanpa mengubah checkpoint.
      builderBatch: positiveInt(options.builderBatch, 16, 128),
      workerRunMs: positiveInt(options.workerRunMs, 900000, 900000),
      builderStaggerMs: positiveInt(options.builderStaggerMs, 10000, 120000),
      roleStartStaggerMs: nonNegativeInt(options.roleStartStaggerMs, this.options.roleStartStaggerMs || 0, 60000),
      serverPreflight: options.serverPreflight || null,
      chestInstallerStartWhenLandscaped: options.chestInstallerStartWhenLandscaped === true,
      builderBotNames: Array.isArray(options.builderBotNames) ? options.builderBotNames : [],
      landscaperBotName: options.landscaperBotName || 'StorageLand2',
      chestInstallerBotName: options.chestInstallerBotName || 'ChestInstaller'
    };
    if (this.orchestrator) {
      const builderBotNames = Array.from({ length: config.builderWorkerCount }, (_, index) => config.builderBotNames[index] || `BuildBot${index + 1}`);
      const goal = this.orchestrator.submitGoal({
        world: config.world,
        dimension: process.env.MC_DIMENSION_ID || 'overworld',
        type: 'STORAGE_ROOM_CONSTRUCTION',
        priority: 100,
        payload: { ...config, builderBotNames,
          landscaperBotNames: [config.landscaperBotName] }
      });
      config.goalId = goal.id;
    }
    this.runConfig = config;
    this.blockedRoles.clear();
    this.generation = (this.generation || 0) + 1;
    this.status = {
      active: true,
      phase: 'BUILDING_AND_LANDSCAPING',
      runId: `storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      restarts: 0,
      children: {},
      recentLogs: [],
      lastError: null,
      goalId: config.goalId || null,
      config: { ...config, builderBotNames: undefined }
    };
    // Landscaper masuk lebih dulu; builder menyusul agar login Mineflayer tidak terjadi
    // pada tick yang sama. Keduanya tetap berada dalam satu lifecycle pembangunan.
    config.generation = this.generation;
    if (config.landscaperWorkerCount > 0) this._scheduleChild('landscaper', config, 0);
    this._scheduleChild('builder', config, config.roleStartStaggerMs);
    if (config.chestInstallerWorkerCount > 0) {
      this.pendingRoles.add('chestInstaller');
      this.status.children.chestInstaller = { role: 'chestInstaller', pid: null, status: 'WAITING_FOR_FLOOR', subworkers: {} };
    }
    const roles = ['builder'];
    if (config.landscaperWorkerCount > 0) roles.push('landscaper');
    if (config.chestInstallerWorkerCount > 0) roles.push('chestInstaller');
    this._publish('started', { phase: this.status.phase, roles });
    return { started: true, status: this.getStatus() };
  }

  startWhenReady(options = {}, { probe = null, intervalMs = 30000, initialDelayMs = 0 } = {}) {
    if (this.status.active || this.waitingForServer) {
      return { started: false, reason: 'ALREADY_RUNNING', status: this.getStatus() };
    }
    const host = options.host || this.options.host;
    const port = Number(options.port) || this.options.port;
    const retryIntervalMs = Math.min(120000, Math.max(1, Number(intervalMs) || 30000));
    const probeServer = probe || (() => querySLP({ host, port, timeoutMs: 8000, protocolVersion: 775 }));
    const pending = { options: { ...options, host, port }, probe: probeServer, retryIntervalMs, timer: null };
    this.waitingForServer = pending;
    this.status = {
      active: true,
      phase: 'WAITING_FOR_SERVER',
      runId: `storage-wait-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      restarts: 0,
      children: {},
      recentLogs: [],
      lastError: null,
      config: {
        host,
        port,
        builderWorkerCount: options.builderWorkerCount || 2,
        landscaperWorkerCount: options.landscaperWorkerCount || 1,
        retryIntervalMs
      }
    };
    this._publish('waiting_for_server', { host, port, retryIntervalMs });
    const probeOnce = async () => {
      if (this.waitingForServer !== pending || !this.status.active) return;
      try {
        const serverStatus = await pending.probe({ host, port });
        if (Number(serverStatus?.version?.protocol) !== 775) {
          throw new Error(`protokol server ${serverStatus?.version?.protocol ?? 'tidak diketahui'} bukan 775`);
        }
        if (this.waitingForServer !== pending || !this.status.active) return;
        this.waitingForServer = null;
        this.status.active = false;
        const result = this.start({
          ...pending.options,
          serverPreflight: {
            protocol: serverStatus.version.protocol,
            latencyMs: serverStatus.latencyMs,
            playersOnline: serverStatus.players?.online ?? null,
            playersMax: serverStatus.players?.max ?? null
          }
        });
        this._publish('server_ready', { host, port, latencyMs: serverStatus.latencyMs, runId: result.status.runId });
      } catch (error) {
        if (this.waitingForServer !== pending || !this.status.active) return;
        this.status.lastError = `Server belum siap: ${error.message}`;
        this._publish('log', { role: 'coordinator', level: 'warn', message: `${this.status.lastError}; probe ulang ${retryIntervalMs}ms.` });
        pending.timer = setTimeout(probeOnce, retryIntervalMs);
        pending.timer.unref?.();
      }
    };
    pending.timer = setTimeout(probeOnce, Math.max(0, Number(initialDelayMs) || 0));
    pending.timer.unref?.();
    return { started: true, waiting: true, status: this.getStatus() };
  }

  stop() {
    if (!this.status.active && this.children.size === 0) return { stopped: false, reason: 'NOT_RUNNING', status: this.getStatus() };
    if (this.status.goalId && this.orchestrator) this.orchestrator.cancelGoal(this.status.goalId, 'OPERATOR_STOP');
    this.status.active = false;
    this.status.phase = 'STOPPING';
    this.status.stoppedAt = new Date().toISOString();
    if (this.waitingForServer?.timer) clearTimeout(this.waitingForServer.timer);
    this.waitingForServer = null;
    this._clearStartupSchedule();
    for (const { child } of this.children.values()) child.kill('SIGTERM');
    if (!this.children.size) this.status.phase = 'STOPPED';
    this._publish('stopped', { reason: 'operator' });
    return { stopped: true, status: this.getStatus() };
  }

  getStatus() {
    return {
      ...this.status,
      children: Object.fromEntries(Object.entries(this.status.children).map(([role, state]) => [role, { ...state }])),
      recentLogs: this.status.recentLogs.slice(-20)
    };
  }
}

const storageRoomConstructionCoordinator = new StorageRoomConstructionCoordinator();

module.exports = {
  ROLE_SCRIPTS,
  StorageRoomConstructionCoordinator,
  storageRoomConstructionCoordinator
};
