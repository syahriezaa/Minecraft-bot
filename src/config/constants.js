/**
 * @file constants.js
 * @description Konstanta sistem untuk benchmark, tingkat kesulitan navigasi, deteksi macet, fase pemulihan, dan jeda serangan senjata.
 */

// Tingkat Pengujian Tolak Ukur Kurikulum Navigasi
const BENCHMARK_LEVELS = Object.freeze({
  LEVEL_1: 'level1',
  LEVEL_2: 'level2',
  LEVEL_3: 'level3',
  LEVEL_4: 'level4'
});

// Status Eksekusi Benchmark Run
const BENCHMARK_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  ABORTED: 'ABORTED'
});

// Konfigurasi Spesifikasi Setiap Tingkat Benchmark
const BENCHMARK_CONFIGS = Object.freeze({
  [BENCHMARK_LEVELS.LEVEL_1]: {
    id: 'level1',
    name: 'Flat Ground Sprint',
    nameId: 'Medan Datar (30m)',
    distanceMeters: 30,
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 30, y: 64, z: 0 },
    timeoutMs: 30000,
    requiredConsecutiveSuccesses: 5
  },
  [BENCHMARK_LEVELS.LEVEL_2]: {
    id: 'level2',
    name: 'Obstacles & Elevation',
    nameId: 'Rintangan & Elevasi (50m)',
    distanceMeters: 50,
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 50, y: 68, z: 0 },
    timeoutMs: 60000
  },
  [BENCHMARK_LEVELS.LEVEL_3]: {
    id: 'level3',
    name: 'Stairs, Ladders & Bridges',
    nameId: 'Tangga, Ladder & Jembatan Sempit',
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: 40, y: 80, z: 20 },
    timeoutMs: 90000
  },
  [BENCHMARK_LEVELS.LEVEL_4]: {
    id: 'level4',
    name: 'Underground Spawner Farm',
    nameId: 'Rute Bawah Tanah Farm Spawner',
    startCoord: { x: 0, y: 64, z: 0 },
    targetCoord: { x: -256, y: -20, z: -432 },
    timeoutMs: 180000
  }
});

// Target Koordinat Spawner Farm Bawah Tanah
const TARGET_SPAWNER_COORDINATES = Object.freeze({
  x: -256,
  y: -20,
  z: -432
});

// Ambang Batas Deteksi Macet (Stuck Detector)
const STUCK_DETECTION = Object.freeze({
  MIN_VELOCITY_XZ: 0.05,
  MIN_DISTANCE_DELTA: 0.1,
  WINDOW_TICKS: 20, // 1 detik pada 20 Hz
  MAX_STUCK_DURATION_MS: 3000
});

// 4-Fase Eskalasi Pemulihan Dinamis (Dynamic Recovery Phases)
const RECOVERY_PHASES = Object.freeze({
  NONE: 0,           // Pergerakan normal tanpa pemulihan
  MICRO_JUMP: 1,     // Fase 1: Lompatan mikro / penyesuaian sudut langkah
  STRAFE_DETOUR: 2,  // Fase 2: Bergerak menyamping (strafe kiri/kanan) untuk keluar dari celah
  RE_ROUTE_PATH: 3,  // Fase 3: Hitung ulang jalur pathfinder secara dinamis
  REWIND_WAYPOINT: 4 // Fase 4: Mundur ke waypoint sebelumnya pada graf makro
});

// Jeda Serangan Senjata / Weapon Cooldown Pacing (Milidetik)
// Berdasarkan mekanika serangan Minecraft 1.9+ (misal pedang 1.6 attack speed = 625ms)
const WEAPON_COOLDOWNS_MS = Object.freeze({
  sword: 625,
  axe: 1250,
  trident: 909,
  pickaxe: 833,
  shovel: 1000,
  hoe: 500,
  hand: 250,
  default: 625
});

// Tugas-Tugas AI Brain (DeepSeek AI Brain Tasks)
const AI_TASKS = Object.freeze({
  ZOMBIE_FARM: 'ZOMBIE_FARM',
  CHEST_SORT: 'CHEST_SORT',
  TRASH_INCINERATE: 'TRASH_INCINERATE',
  NAVIGATE: 'NAVIGATE'
});

// Konstanta Telemetri & Tick Loop
const TELEMETRY_CONSTANTS = Object.freeze({
  TICK_RATE_HZ: 20,
  TICK_INTERVAL_MS: 50,
  DEFAULT_FLUSH_INTERVAL_MS: 250,
  DEFAULT_BATCH_THRESHOLD: 50,
  DEFAULT_MAX_BUFFER_SIZE: 5000
});

module.exports = {
  BENCHMARK_LEVELS,
  BENCHMARK_STATUS,
  BENCHMARK_CONFIGS,
  TARGET_SPAWNER_COORDINATES,
  STUCK_DETECTION,
  RECOVERY_PHASES,
  WEAPON_COOLDOWNS_MS,
  AI_TASKS,
  TELEMETRY_CONSTANTS
};
