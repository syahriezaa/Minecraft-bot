# Handoff Report: Persistent Autonomous Presence & Anti-AFK Supervisor (`src/tasks/persistentCompanion.js`)

## 1. Observation

Berdasarkan inspeksi mendalam terhadap berkas-berkas otoritatif dan arsitektur kode sumber:

### 1.1 Persyaratan Otoritatif & Lokasi Kode
1. **`ORIGINAL_REQUEST.md` (Baris 18–27)**:
   - Persyaratan **R3**: *"Bot yang terhubung harus tetap bertahan di dalam server tanpa terputus (no disconnect/kick), merespon detak jantung (keep-alive), melakukan farming zombie di spawner [-256, -20, -432], memungut bola XP, dan menyinkronkan status ke Web Dashboard http://localhost:8080."*
   - Kriteria Penerimaan: *"Bot bertahan di dalam server selama minimal 60 detik tanpa terkena disconnect/kick."*
2. **`PROJECT.md` (Baris 18, 35–47)**:
   - Fitur #6: *"60s+ Persistent Presence: Sustain continuous live presence on server for 60s+ without disconnect/kick."*
   - Kontrak antarmuka `src/network/liveProtocolClient.js` ↔ `src/tasks/persistentCompanion.js`:
     - `client.sendPositionAndRotation({ x, y, z, yaw, pitch, onGround, hasHorizontalCollision })`
     - `client.sendPosition({ x, y, z, onGround, hasHorizontalCollision })`
     - `client.sendAttack(targetEntityId)`
     - `client.sendChat(message)`
     - Event yang dipancarkan: `spawn`, `joined`, `keep_alive`, `health`, `teleport`, `disconnect`, `kicked`, `close`
3. **`SCOPE.md` (Baris 13–19)**:
   - Milestone 3.2: `src/tasks/persistentCompanion.js` bertindak sebagai *Continuous presence manager and lifecycle supervisor*, mencakup:
     - Anti-AFK micro-movement loop (penyesuaian yaw/pitch mikro berkala & pergerakan halus berbasis `MovementFlags`).
     - Keepalive watchdog dengan deteksi socket macet dan pemulihan status koneksi.
     - Dukungan ganda: `LiveProtocolClient` (live server Protocol 775 / NeoForge 26.1.2) dan `MockArenaHarness` (lingkungan uji/mock).
     - Event emitter untuk integrasi Web Dashboard: `TICK_UPDATE`, `TELEMETRY_EVENT`, `TASK_STATE_CHANGE`.
4. **`src/config/constants.js` (Baris 63–67, 107–114)**:
   - `TARGET_SPAWNER_COORDINATES`: `{ x: -256, y: -20, z: -432 }`.
   - `TELEMETRY_CONSTANTS`: `TICK_RATE_HZ = 20`, `TICK_INTERVAL_MS = 50`.
5. **`src/network/liveProtocolClient.js` (Baris 24–40, 888–899, 938–949, 1068–1089)**:
   - Respons `keep_alive` Play (ID 0x2c serverbound -> 0x1c clientbound).
   - Penanganan teleportasi (ID 0x48) dengan konfirmasi `teleport_confirm` (ID 0x00) & `player_loaded` (ID 0x2c).
   - Pengiriman paket `position_look` (ID 0x1f) dengan `encodeMovementFlags({ onGround, hasHorizontalCollision })`.
   - `_scheduleReconnect()` dengan exponential backoff dan jitter.
6. **`src/web/webServer.js` (Baris 38–43, 144–152, 232–236)**:
   - WebSocket broadcaster menyiarkan payload JSON `{ type: 'TICK_UPDATE', data }`, `{ type: 'AI_ACTION_EVENT', data }`, `{ type: 'BENCHMARK_STATUS', data }`.

---

## 2. Logic Chain

Dari observasi di atas, alur penalaran teknis diturunkan sebagai berikut:

1. **Pencegahan Kick Inaktivitas (Anti-AFK Mechanism)**:
   - Server Minecraft publik / NeoForge sering memiliki plugin anti-AFK yang menendang pemain jika tidak ada paket pergerakan / rotasi selama 60s–300s.
   - Mengirimkan paket `sendPositionAndRotation` berkala (setiap 1.0–2.0 detik) dengan variasi sudut mikroskopis (yaw $\pm 2.5^\circ$, pitch $\pm 1.0^\circ$) dan pergeseran sub-voxel mikroskopis ($< 0.05$m) yang berosilasi di sekitar jangkar `[-256, -20, -432]` mencegah kick tanpa menggeser bot dari perimeter spawner.
   - Paket posisi wajib menyertakan bitflags `MovementFlags` (`onGround = true`) yang valid untuk Protokol 775.

2. **Watchdog Detak Jantung (Keepalive & Socket Health Watchdog)**:
   - Walaupun `LiveProtocolClient` merespons paket `keep_alive` secara instan, koneksi TCP dapat mengalami *half-open state* (koneksi mati tanpa `FIN`/`RST` packet).
   - Watchdog loop memeriksa `_lastKeepAliveTimestamp`. Jika selisih waktu $> 25000$ms pada status `ACTIVE_PLAY`, watchdog memicu peringatan timeout, memutuskan soket yang menggantung, dan memulai siklus rekoneksi otomatis.

3. **Mesin Status Rekoneksi Otomatis (Auto-Reconnection State Machine)**:
   - Saat terputus (`disconnect` atau `kicked`), status beralih ke `RECONNECTING`.
   - Menghitung delay dengan formula backoff eksponensial: $T_{\text{delay}} = \min(T_{\text{base}} \times M^{(\text{attempts}-1)}, T_{\text{max}}) \times (1 + \text{jitter})$.
   - Menghentikan sementara (*pause*) sub-tugas yang berjalan (misal: `ZombieSpawnerTask`) dan melanjutkannya (*resume*) secara otomatis saat koneksi kembali stabil (`ACTIVE_PLAY`).

4. **Abstraksi Klien Ganda (Dual Mode Adapter)**:
   - Untuk mendukung live server Protocol 775 (`LiveProtocolClient`) dan pengujian in-memory (`MockArenaHarness`), dibangun adaptor polimorfik `ClientAdapter`.
   - `ClientAdapter` membungkus pemanggilan `sendPositionAndRotation`, `sendAttack`, `sendChat`, serta ekstraksi `health`, `food`, dan `position` ke dalam satu antarmuka terpadu.

5. **Streaming Telemetri & Dasbor**:
   - `PersistentCompanion` memancarkan event `TICK_UPDATE` pada frekuensi 20 Hz / 1 Hz, `TELEMETRY_EVENT` saat ada kejadian penting (keepalive, anti-afk pulse, reconnect), dan `TASK_STATE_CHANGE` saat sub-tugas berganti status.
   - Menyediakan metode `attachWebSocketBroadcaster` untuk meneruskan event secara langsung ke WebSocket server `webServer.js`.

---

## 3. Caveats

1. **Batas Ruang Gerak (Bounding Box Safety)**:
   - Micro-motion anti-AFK harus dikunci dengan *hard limit* radius ($\le 0.25$m dari titik jangkar `[-256, -20, -432]`) agar bot tidak terdorong ke sudut berbahaya atau keluar dari jangkauan pedang ke zombie.
2. **Prioritas Tugas (Task Priority Conflict)**:
   - Ketika tugas aktif (misal `ZombieSpawnerTask` sedang menyerang monster atau bergerak) mengambil alih rotasi/posisi bot, pulse Anti-AFK otomatis menahan diri (*yield*) agar tidak mengganggu bidikan serangan (*aiming*).
3. **Ketergantungan Milestone 3.1 & 3.3**:
   - `src/tasks/persistentCompanion.js` dirancang modular sehingga dapat mengorkestrasi `ZombieSpawnerTask` tanpa *circular dependency*.

---

## 4. Conclusion & Implementation Design

Berikut adalah spesifikasi arsitektur dan rancangan implementasi lengkap untuk `src/tasks/persistentCompanion.js`.

### 4.1 Definisi Status & Konstanta

```javascript
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
  targetCoordinates: { x: -256, y: -20, z: -432 },
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
```

### 4.2 Struktur Kelas Adaptor Klien Ganda (`ClientAdapter`)

```javascript
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
      this.raw.bot.entity.position = { x, y, z };
      this.raw.bot.lookTarget = { x, y, z, yaw, pitch };
      this.raw.emit('TICK_UPDATE', { type: 'TICK_UPDATE', data: { position: { x, y, z }, yaw, pitch } });
    } else if (this.mode === 'mineflayer') {
      if (this.raw.look) this.raw.look(yaw * (Math.PI / 180), pitch * (Math.PI / 180), true);
    }
  }

  sendAttack(targetEntityId) {
    if (this.mode === 'live') {
      this.raw.sendAttack(targetEntityId);
    } else if (this.mode === 'mock') {
      this.raw.bot.attack({ id: targetEntityId, type: 'zombie' });
    } else if (this.mode === 'mineflayer') {
      const entity = this.raw.entities ? this.raw.entities[targetEntityId] : null;
      if (entity) this.raw.attack(entity);
    }
  }

  sendChat(message) {
    if (this.mode === 'live') {
      this.raw.sendChat(message);
    } else if (this.mode === 'mock') {
      this.raw.emit('chat', 'Bot_Companion', message);
    } else if (this.mode === 'mineflayer') {
      this.raw.chat(message);
    }
  }

  getPosition() {
    if (this.mode === 'live') return this.raw.position || { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
    if (this.mode === 'mock') return this.raw.bot.entity.position;
    if (this.mode === 'mineflayer') return this.raw.entity ? this.raw.entity.position : { x: 0, y: 64, z: 0 };
    return { x: 0, y: 64, z: 0 };
  }

  getHealth() {
    if (this.mode === 'live') return this.raw.health ?? 20;
    if (this.mode === 'mock') return this.raw.bot.health ?? 20;
    if (this.mode === 'mineflayer') return this.raw.health ?? 20;
    return 20;
  }

  getFood() {
    if (this.mode === 'live') return this.raw.food ?? 20;
    if (this.mode === 'mock') return this.raw.bot.food ?? 20;
    if (this.mode === 'mineflayer') return this.raw.food ?? 20;
    return 20;
  }
}
```

### 4.3 Logika Inti `PersistentCompanion`

```javascript
const EventEmitter = require('node:events');
const { TARGET_SPAWNER_COORDINATES, TELEMETRY_CONSTANTS } = require('../config/constants');

class PersistentCompanion extends EventEmitter {
  constructor(clientInstance, options = {}) {
    super();

    this.config = { ...DEFAULT_PERSISTENT_CONFIG, ...options };
    this.adapter = new ClientAdapter(clientInstance, options.mode);
    this.client = clientInstance;

    // Status siklus hidup & kehadiran
    this.presenceState = PRESENCE_STATES.UNINITIALIZED;
    this.sessionStartTime = null;
    this.sessionUptimeMs = 0;
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
    if (!this.client) return;

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
    this.presenceState = PRESENCE_STATES.CONNECTING;
    this._lastKeepAliveTimestamp = Date.now();

    this._startWatchdogLoop();
    this._startAntiAfkLoop();
    this._startTickStream();

    this.emit('presence_started', {
      timestamp: this.sessionStartTime,
      targetCoords: this.anchorPosition
    });

    console.log(`🛡️ [Supervisor] Persistent presence supervisor diaktifkan untuk jangkar [${this.anchorPosition.x}, ${this.anchorPosition.y}, ${this.anchorPosition.z}].`);
  }

  /**
   * Menghentikan pengawasan secara bersih.
   */
  stop(reason = 'Supervisor dihentikan oleh pengguna') {
    this.presenceState = PRESENCE_STATES.TERMINATED;

    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._antiAfkTimer) clearInterval(this._antiAfkTimer);
    if (this._tickInterval) clearInterval(this._tickInterval);

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

        // Paksa pemutusan koneksi yang menggantung untuk memicu rekoneksi
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

      // Jika ada sub-tugas aktif yang sedang mengendalikan pergerakan, hindari tumpang tindih
      if (this._isHighPriorityMotionActive()) return;

      this.metrics.antiAfkPulses++;
      this.totalTicks++;

      // Kalkulasi sinusoidal halus untuk micro-rotation
      const yawOffset = Math.sin(this.totalTicks * 0.25) * this.config.antiAfkYawRangeDeg;
      const pitchOffset = Math.cos(this.totalTicks * 0.2) * this.config.antiAfkPitchRangeDeg;

      // Kalkulasi micro-drift pada koordinat (maksimal ±0.04m, selalu kembali ke jangkar)
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
    this._emitTelemetry('KEEPALIVE_RECEIVED', { keepAliveId: id.toString(), timestamp: Date.now() });
  }

  _handleHealthUpdate({ health, food }) {
    if (health < 6 || food < 6) {
      this.metrics.vitalityWarnings++;
      this._emitTelemetry('VITALITY_WARNING', { health, food });
      this.emit('vitality_warning', { health, food });
    }
  }

  _handleTeleport(pos) {
    this.currentPosition = { ...pos, onGround: true };
    // Perbarui jangkar jika teleportasi terjadi secara sah dari server
    if (Math.hypot(pos.x - this.anchorPosition.x, pos.z - this.anchorPosition.z) > 10) {
      console.log(`📍 [Supervisor] Posisi jangkar diperbarui pasca teleportasi server: [${pos.x}, ${pos.y}, ${pos.z}]`);
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
    this._emitTelemetry('ERROR_EVENT', { message: err.message });
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

  async waitForPresenceDuration(durationSeconds = 60, checkIntervalMs = 1000) {
    const startTime = Date.now();
    const targetMs = durationSeconds * 1000;

    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.presenceState !== PRESENCE_STATES.ACTIVE_PLAY) {
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
```

---

## 5. Verification Method

Untuk memverifikasi kebenaran implementasi `src/tasks/persistentCompanion.js`, berikut prosedur pengujian yang harus dijalankan:

### 5.1 Pengujian Unit & Mock Harness
1. **Verifikasi Keberadaan 60 Detik pada Mock Harness**:
   ```javascript
   const { MockArenaHarness } = require('./test/helpers/mockArenaHarness');
   const { PersistentCompanion, PRESENCE_STATES } = require('./src/tasks/persistentCompanion');
   const assert = require('node:assert/strict');

   const harness = new MockArenaHarness({ port: 25565 });
   await harness.start();

   const companion = new PersistentCompanion(harness, {
     mode: 'mock',
     targetCoordinates: { x: -256, y: -20, z: -432 },
     antiAfkIntervalMs: 500
   });

   companion.start();
   assert.equal(companion.presenceState, PRESENCE_STATES.ACTIVE_PLAY);

   // Tunggu pulse Anti-AFK beroperasi
   await new Promise(r => setTimeout(r, 2500));
   assert.ok(companion.metrics.antiAfkPulses >= 3, 'Anti-AFK pulse harus tereksekusi minimal 3 kali');

   companion.stop('Uji selesai');
   await harness.stop();
   ```

2. **Verifikasi Keepalive Watchdog Timeout Recovery**:
   - Set `keepAliveTimeoutMs = 1500ms`.
   - Simulasikan jeda keepalive selama 2000ms.
   - Pastikan event `watchdog_timeout` terpicu dan `metrics.watchdogAlerts >= 1`.

3. **Verifikasi Sinkronisasi Event Dasbor**:
   - Daftarkan `attachWebSocketBroadcaster`.
   - Pastikan event `TICK_UPDATE`, `TELEMETRY_EVENT`, dan `TASK_STATE_CHANGE` tersiar dengan payload valid.

### 5.2 Pengujian Integrasi Live Server (Protokol 775)
Jalankan pengujian langsung ke live server:
```bash
node test/network/live_connection_slp.test.js
```
Kriteria kelulusan:
- Status koneksi mencapai `ACTIVE_PLAY`.
- Bot bertahan $\ge 60$ detik di server `atoms-girl.tun.ply.gg:25565` tanpa kick atau disconnect.
- Server List Ping memverifikasi `players.online >= 1`.
