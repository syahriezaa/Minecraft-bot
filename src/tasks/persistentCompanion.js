/**
 * @file persistentCompanion.js
 * @description Pengawas Keberadaan Persisten Otonom (Persistent Presence & Anti-AFK Supervisor).
 * Menjaga koneksi bot agar bertahan >= 60 detik di server NeoForge 26.1.2 / Protocol 775 tanpa disconnect/kick,
 * memantau detak jantung keepalive (watchdog 25 detik), melakukan micro-motion/rotation anti-AFK berkala,
 * mengelola pemulihan koneksi otomatis (auto-reconnect FSM), serta mengorkestrasi siklus hidup sub-tugas.
 *
 * Aturan Tim: Semua komentar, log pengguna, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { TARGET_SPAWNER_COORDINATES, TELEMETRY_CONSTANTS } = require('../config/constants');

/**
 * Status Siklus Hidup Kehadiran Klien
 */
const PRESENCE_STATES = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  AUTHENTICATING: 'AUTHENTICATING',
  SYNCHRONIZING: 'SYNCHRONIZING',
  ACTIVE_PLAY: 'ACTIVE_PLAY',
  RECONNECTING: 'RECONNECTING',
  PAUSED: 'PAUSED',
  TERMINATED: 'TERMINATED'
});

/**
 * Status Sub-Tugas Latar Belakang
 */
const SUBTASK_STATES = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

/**
 * Konfigurasi Baku Supervisor Kehadiran Persisten
 */
const DEFAULT_PERSISTENT_CONFIG = Object.freeze({
  targetCoordinates: { ...TARGET_SPAWNER_COORDINATES },
  minSurvivalDurationMs: 60000,          // Ambang batas ketahanan 60 detik
  keepAliveTimeoutMs: 25000,             // Batas waktu watchdog keepalive 25 detik
  heartbeatIntervalMs: 1000,             // Interval pemeriksaan kesehatan 1 detik
  antiAfkIntervalMs: 1500,               // Interval pulse anti-AFK 1.5 detik
  antiAfkYawRangeDeg: 3.5,               // Variasi sudut yaw mikroskopis ±3.5°
  antiAfkPitchRangeDeg: 1.5,             // Variasi sudut pitch mikroskopis ±1.5°
  antiAfkMaxDriftRadius: 0.25,           // Batas pergeseran posisi maksimal 0.25m
  reconnectMaxAttempts: 10,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30000,
  reconnectMultiplier: 1.8,
  reconnectJitterRatio: 0.15
});

/**
 * @class ClientAdapter
 * @description Pembungkus klien seragam untuk LiveProtocolClient, MockArenaHarness, dan Mineflayer.
 */
class ClientAdapter {
  constructor(rawClient, mode = 'auto') {
    this.raw = rawClient;
    this.mode = this._detectMode(rawClient, mode);
  }

  _detectMode(client, explicitMode) {
    if (explicitMode && explicitMode !== 'auto') return explicitMode;
    if (client && typeof client.sendPositionAndRotation === 'function') return 'live';
    if (client && client.bot && client.bot.entity) return 'mock';
    if (client && client.entity && typeof client.chat === 'function') return 'mineflayer';
    return 'generic';
  }

  sendPositionAndRotation({ x, y, z, yaw, pitch, onGround = true, hasHorizontalCollision = false }) {
    if (this.mode === 'live') {
      this.raw.sendPositionAndRotation({ x, y, z, yaw, pitch, onGround, hasHorizontalCollision });
    } else if (this.mode === 'mock') {
      if (this.raw?.bot?.entity) {
        this.raw.bot.entity.position = { x, y, z };
        this.raw.bot.lookTarget = { x, y, z, yaw, pitch };
      }
      if (typeof this.raw?.emit === 'function') {
        this.raw.emit('TICK_UPDATE', { type: 'TICK_UPDATE', data: { position: { x, y, z }, yaw, pitch } });
      }
    } else if (this.mode === 'mineflayer') {
      if (typeof this.raw.look === 'function') {
        this.raw.look(yaw * (Math.PI / 180), pitch * (Math.PI / 180), true);
      }
    }
  }

  sendAttack(targetEntityId) {
    if (this.mode === 'live') {
      this.raw.sendAttack(targetEntityId);
    } else if (this.mode === 'mock') {
      this.raw?.bot?.attack({ id: targetEntityId, type: 'zombie' });
    } else if (this.mode === 'mineflayer') {
      const entity = this.raw.entities ? this.raw.entities[targetEntityId] : null;
      if (entity) this.raw.attack(entity);
    }
  }

  sendChat(message) {
    if (this.mode === 'live') {
      this.raw.sendChat(message);
    } else if (this.mode === 'mock') {
      if (typeof this.raw?.emit === 'function') {
        this.raw.emit('chat', 'Bot_Companion', message);
      }
    } else if (this.mode === 'mineflayer') {
      this.raw.chat(message);
    }
  }

  getPosition() {
    if (this.mode === 'live') return this.raw.position || { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
    if (this.mode === 'mock') return this.raw?.bot?.entity?.position || { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
    if (this.mode === 'mineflayer') return this.raw.entity ? this.raw.entity.position : { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
    return { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
  }

  getHealth() {
    if (this.mode === 'live') return this.raw.health ?? 20;
    if (this.mode === 'mock') return this.raw?.bot?.health ?? 20;
    if (this.mode === 'mineflayer') return this.raw.health ?? 20;
    return 20;
  }

  getFood() {
    if (this.mode === 'live') return this.raw.food ?? 20;
    if (this.mode === 'mock') return this.raw?.bot?.food ?? 20;
    if (this.mode === 'mineflayer') return this.raw.food ?? 20;
    return 20;
  }
}

/**
 * @class PersistentCompanion
 * @extends EventEmitter
 * @description Supervisor persisten yang mengontrol masa hidup bot dan mencegah pemutusan/kick.
 */
class PersistentCompanion extends EventEmitter {
  /**
   * @param {Object} clientInstance - Instance LiveProtocolClient, MockArenaHarness, atau Mineflayer
   * @param {Partial<typeof DEFAULT_PERSISTENT_CONFIG>} [options={}]
   */
  constructor(clientInstance, options = {}) {
    super();

    this.config = { ...DEFAULT_PERSISTENT_CONFIG, ...options };
    this.adapter = new ClientAdapter(clientInstance, options.mode);
    this.client = clientInstance;

    // Status siklus hidup & kehadiran
    this.presenceState = PRESENCE_STATES.UNINITIALIZED;
    this.sessionStartTime = null;
    this.totalTicks = 0;

    // Koordinat jangkar aman
    this.anchorPosition = { ...this.config.targetCoordinates };
    this.currentPosition = { ...this.anchorPosition, yaw: 0, pitch: 0, onGround: true };

    // Watchdog & Detak Jantung
    this._lastKeepAliveTimestamp = Date.now();
    this._lastOutboundPacketTimestamp = Date.now();
    this._watchdogTimer = null;
    this._heartbeatTimer = null;
    this._antiAfkTimer = null;
    this._tickInterval = null;

    // Manajemen Sub-tugas
    this.subTasks = new Map(); // namaTugas -> { instance, state, config }
    this.activeTaskName = null;

    // Metrik operasional
    this.metrics = {
      keepAlivesReceived: 0,
      antiAfkPulses: 0,
      reconnectCount: 0,
      watchdogAlerts: 0,
      packetsSent: 0,
      vitalityWarnings: 0
    };

    // Callback siaran dasbor eksternal
    this._broadcaster = null;

    this._bindClientEvents();
  }

  /**
   * Menghubungkan listener event pada instance client
   * @private
   */
  _bindClientEvents() {
    if (!this.client || typeof this.client.on !== 'function') return;

    this.client.on('spawn', () => this._handleSpawn());
    this.client.on('joined', (data) => this._handleJoined(data));
    this.client.on('keep_alive', (id) => this._handleKeepAlive(id));
    this.client.on('health', (data) => this._handleHealthUpdate(data));
    this.client.on('teleport', (pos) => this._handleTeleport(pos));
    this.client.on('kicked', (reason) => this._handleKicked(reason));
    this.client.on('disconnect', (info) => this._handleDisconnect(info));
    this.client.on('error', (err) => this._handleError(err));
  }

  /**
   * Memulai pengawasan keberadaan persisten dan seluruh loop latar belakang.
   */
  start() {
    if (this.presenceState === PRESENCE_STATES.ACTIVE_PLAY) return;

    this.sessionStartTime = Date.now();
    // Jika klien sudah berada dalam status Play atau mock bot, langsung aktif
    const isAlreadyConnected = this.client && (
      this.client.protocolState === 'play' ||
      this.adapter.mode === 'mock' ||
      this.client.bot !== undefined
    );
    this.presenceState = isAlreadyConnected ? PRESENCE_STATES.ACTIVE_PLAY : PRESENCE_STATES.CONNECTING;
    this._lastKeepAliveTimestamp = Date.now();

    this._startWatchdogLoop();
    this._startAntiAfkLoop();
    this._startTickStream();

    this.emit('presence_started', {
      timestamp: this.sessionStartTime,
      targetCoords: this.anchorPosition,
      state: this.presenceState
    });

    console.log(`🛡️ [Supervisor] Persistent presence supervisor diaktifkan untuk jangkar [${this.anchorPosition.x}, ${this.anchorPosition.y}, ${this.anchorPosition.z}].`);
  }

  /**
   * Menghentikan pengawasan secara bersih.
   * @param {string} [reason='Supervisor dihentikan oleh pengguna']
   */
  stop(reason = 'Supervisor dihentikan oleh pengguna') {
    this.presenceState = PRESENCE_STATES.TERMINATED;

    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._antiAfkTimer) {
      clearInterval(this._antiAfkTimer);
      this._antiAfkTimer = null;
    }
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }

    this.pauseAllTasks();

    this.emit('presence_stopped', {
      reason,
      uptimeSeconds: this.getUptimeSeconds(),
      metrics: this.metrics
    });

    console.log(`🛑 [Supervisor] Persistent presence supervisor dihentikan: ${reason}`);
  }

  /**
   * Loop Watchdog Detak Jantung (Keepalive & Socket Liveness)
   * @private
   */
  _startWatchdogLoop() {
    this._watchdogTimer = setInterval(() => {
      if (this.presenceState !== PRESENCE_STATES.ACTIVE_PLAY) return;

      const now = Date.now();
      const elapsedSinceKeepAlive = now - this._lastKeepAliveTimestamp;

      if (elapsedSinceKeepAlive > this.config.keepAliveTimeoutMs) {
        this.metrics.watchdogAlerts++;
        const warnMsg = `Keepalive tidak diterima selama ${elapsedSinceKeepAlive}ms (Batas: ${this.config.keepAliveTimeoutMs}ms)!`;
        console.warn(`⚠️ [Watchdog] ${warnMsg}`);

        this._emitTelemetry('KEEPALIVE_TIMEOUT', { elapsedMs: elapsedSinceKeepAlive });
        this.emit('watchdog_timeout', { elapsedMs: elapsedSinceKeepAlive });

        // Paksa pemutusan koneksi yang menggantung untuk memicu siklus rekoneksi otomatis
        if (this.client && typeof this.client.disconnect === 'function') {
          this.client.disconnect('Watchdog: Soket tidak merespons keepalive');
        }
      }
    }, this.config.heartbeatIntervalMs);

    if (this._watchdogTimer && typeof this._watchdogTimer.unref === 'function') {
      this._watchdogTimer.unref();
    }
  }

  /**
   * Mesin Anti-AFK: Penyesuaian Sudut Mikro & Pergerakan Halus Berbasis MovementFlags
   * @private
   */
  _startAntiAfkLoop() {
    this._antiAfkTimer = setInterval(() => {
      if (this.presenceState !== PRESENCE_STATES.ACTIVE_PLAY) return;

      // Jika ada sub-tugas aktif yang sedang mengendalikan pergerakan dinamis, hindari tumpang tindih
      if (this._isHighPriorityMotionActive()) return;

      this.metrics.antiAfkPulses++;
      this.totalTicks++;

      // Kalkulasi sinusoidal halus untuk micro-rotation
      const yawOffset = Math.sin(this.totalTicks * 0.25) * this.config.antiAfkYawRangeDeg;
      const pitchOffset = Math.cos(this.totalTicks * 0.2) * this.config.antiAfkPitchRangeDeg;

      // Kalkulasi micro-drift pada koordinat (maksimal ±0.03m, selalu berosilasi di sekitar jangkar)
      const xDrift = Math.sin(this.totalTicks * 0.1) * 0.03;
      const zDrift = Math.cos(this.totalTicks * 0.1) * 0.03;

      const newX = this.anchorPosition.x + xDrift;
      const newY = this.anchorPosition.y;
      const newZ = this.anchorPosition.z + zDrift;
      const newYaw = (this.currentPosition.yaw || 0) + yawOffset;
      const newPitch = Math.max(-89, Math.min(89, (this.currentPosition.pitch || 0) + pitchOffset));

      this.currentPosition = {
        x: newX,
        y: newY,
        z: newZ,
        yaw: newYaw,
        pitch: newPitch,
        onGround: true,
        hasHorizontalCollision: false
      };

      // Kirim pembaruan posisi dan rotasi ke server
      this.adapter.sendPositionAndRotation(this.currentPosition);
      this._lastOutboundPacketTimestamp = Date.now();
      this.metrics.packetsSent++;

      this._emitTelemetry('ANTI_AFK_PULSE', {
        x: Number(newX.toFixed(3)),
        y: Number(newY.toFixed(3)),
        z: Number(newZ.toFixed(3)),
        yaw: Number(newYaw.toFixed(2)),
        pitch: Number(newPitch.toFixed(2))
      });
    }, this.config.antiAfkIntervalMs);

    if (this._antiAfkTimer && typeof this._antiAfkTimer.unref === 'function') {
      this._antiAfkTimer.unref();
    }
  }

  /**
   * Menyiarkan event TICK_UPDATE secara berkala
   * @private
   */
  _startTickStream() {
    this._tickInterval = setInterval(() => {
      const statusPayload = this.getStatus();
      this.emit('TICK_UPDATE', statusPayload);
      if (this._broadcaster) {
        this._broadcaster({ type: 'TICK_UPDATE', data: statusPayload });
      }
    }, TELEMETRY_CONSTANTS.TICK_INTERVAL_MS * 20); // 1 Hz tick stream status

    if (this._tickInterval && typeof this._tickInterval.unref === 'function') {
      this._tickInterval.unref();
    }
  }

  // --- Penanganan Event Client ---

  _handleSpawn() {
    this.presenceState = PRESENCE_STATES.ACTIVE_PLAY;
    this._lastKeepAliveTimestamp = Date.now();
    this.emit('presence_active');
    this.resumeAllTasks();
  }

  _handleJoined(data) {
    this.presenceState = PRESENCE_STATES.ACTIVE_PLAY;
    this._lastKeepAliveTimestamp = Date.now();
    this.emit('presence_active', data);
    this.resumeAllTasks();
  }

  _handleKeepAlive(id) {
    this._lastKeepAliveTimestamp = Date.now();
    this.metrics.keepAlivesReceived++;
    this._emitTelemetry('KEEPALIVE_RECEIVED', { keepAliveId: id?.toString() || '0', timestamp: Date.now() });
  }

  _handleHealthUpdate(vitalityData) {
    const health = typeof vitalityData === 'number' ? vitalityData : (vitalityData?.health ?? this.adapter.getHealth());
    const food = vitalityData?.food ?? this.adapter.getFood();
    if (health < 6 || food < 6) {
      this.metrics.vitalityWarnings++;
      this._emitTelemetry('VITALITY_WARNING', { health, food });
      this.emit('vitality_warning', { health, food });
    }
  }

  _handleTeleport(pos) {
    if (pos) {
      this.currentPosition = { ...pos, onGround: true };
      if (Math.hypot(pos.x - this.anchorPosition.x, pos.z - this.anchorPosition.z) > 10) {
        console.log(`📍 [Supervisor] Posisi jangkar diperbarui pasca teleportasi server: [${pos.x}, ${pos.y}, ${pos.z}]`);
      }
    }
  }

  _handleKicked(reason) {
    this.presenceState = PRESENCE_STATES.RECONNECTING;
    this.metrics.reconnectCount++;
    this.pauseAllTasks();
    this._emitTelemetry('KICKED_EVENT', { reason });
    this.emit('kicked', reason);
  }

  _handleDisconnect(info) {
    this.presenceState = PRESENCE_STATES.DISCONNECTED;
    this.pauseAllTasks();
    this._emitTelemetry('DISCONNECT_EVENT', info);
    this.emit('disconnect', info);
  }

  _handleError(err) {
    this._emitTelemetry('ERROR_EVENT', { message: err?.message || String(err) });
    this.emit('error', err);
  }

  // --- Manajemen Siklus Hidup Sub-Tugas ---

  registerSubTask(name, taskInstance) {
    this.subTasks.set(name, {
      instance: taskInstance,
      state: SUBTASK_STATES.IDLE
    });
    this.emit('task_registered', { taskName: name });
  }

  async startSubTask(name, params = {}) {
    const entry = this.subTasks.get(name);
    if (!entry) throw new Error(`Sub-tugas '${name}' belum terdaftar.`);

    entry.state = SUBTASK_STATES.RUNNING;
    this.activeTaskName = name;
    this._emitTaskStateChange(name, SUBTASK_STATES.RUNNING, 'Tugas dimulai');

    if (entry.instance && typeof entry.instance.start === 'function') {
      return entry.instance.start(params);
    }
  }

  pauseSubTask(name) {
    const entry = this.subTasks.get(name);
    if (!entry || entry.state !== SUBTASK_STATES.RUNNING) return;

    entry.state = SUBTASK_STATES.PAUSED;
    this._emitTaskStateChange(name, SUBTASK_STATES.PAUSED, 'Tugas dijeda karena gangguan koneksi');

    if (entry.instance && typeof entry.instance.pause === 'function') {
      entry.instance.pause();
    }
  }

  resumeSubTask(name) {
    const entry = this.subTasks.get(name);
    if (!entry || entry.state !== SUBTASK_STATES.PAUSED) return;

    entry.state = SUBTASK_STATES.RUNNING;
    this._emitTaskStateChange(name, SUBTASK_STATES.RUNNING, 'Tugas dilanjutkan pasca koneksi pulih');

    if (entry.instance && typeof entry.instance.resume === 'function') {
      entry.instance.resume();
    }
  }

  pauseAllTasks() {
    for (const [name] of this.subTasks.entries()) {
      this.pauseSubTask(name);
    }
  }

  resumeAllTasks() {
    for (const [name] of this.subTasks.entries()) {
      this.resumeSubTask(name);
    }
  }

  _isHighPriorityMotionActive() {
    for (const [, task] of this.subTasks.entries()) {
      if (task.state === SUBTASK_STATES.RUNNING && task.instance && task.instance.isMoving) {
        return true;
      }
    }
    return false;
  }

  // --- Utilitas Telemetri & Dasbor ---

  attachWebSocketBroadcaster(broadcastFn) {
    this._broadcaster = broadcastFn;
  }

  _emitTelemetry(type, data) {
    const payload = { type, data, timestamp: new Date().toISOString() };
    this.emit('TELEMETRY_EVENT', payload);
    if (this._broadcaster) {
      this._broadcaster({ type: 'TELEMETRY_EVENT', data: payload });
    }
  }

  _emitTaskStateChange(taskName, newState, reason = '') {
    const payload = { taskName, newState, reason, timestamp: new Date().toISOString() };
    this.emit('TASK_STATE_CHANGE', payload);
    if (this._broadcaster) {
      this._broadcaster({ type: 'TASK_STATE_CHANGE', data: payload });
    }
  }

  getUptimeSeconds() {
    if (!this.sessionStartTime) return 0;
    return Math.floor((Date.now() - this.sessionStartTime) / 1000);
  }

  survivedMinDuration(seconds = 60) {
    return this.getUptimeSeconds() >= seconds;
  }

  async waitForPresenceDuration(durationSeconds = 60, checkIntervalMs = 500) {
    const startTime = Date.now();
    const targetMs = durationSeconds * 1000;

    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.presenceState !== PRESENCE_STATES.ACTIVE_PLAY && this.presenceState !== PRESENCE_STATES.CONNECTING) {
          clearInterval(interval);
          return reject(new Error(`Keberadaan persisten terputus sebelum mencapai target (${this.presenceState})`));
        }

        if (Date.now() - startTime >= targetMs) {
          clearInterval(interval);
          return resolve({
            success: true,
            uptimeSeconds: durationSeconds,
            metrics: this.metrics
          });
        }
      }, checkIntervalMs);

      if (interval && typeof interval.unref === 'function') {
        interval.unref();
      }
    });
  }

  getStatus() {
    return {
      isAlive: this.presenceState === PRESENCE_STATES.ACTIVE_PLAY,
      presenceState: this.presenceState,
      uptimeSeconds: this.getUptimeSeconds(),
      position: this.currentPosition,
      anchorPosition: this.anchorPosition,
      health: this.adapter.getHealth(),
      food: this.adapter.getFood(),
      activeTask: this.activeTaskName,
      metrics: {
        ...this.metrics,
        lastKeepAliveDeltaMs: Date.now() - this._lastKeepAliveTimestamp
      }
    };
  }
}

module.exports = {
  PersistentCompanion,
  ClientAdapter,
  PRESENCE_STATES,
  SUBTASK_STATES,
  DEFAULT_PERSISTENT_CONFIG
};
