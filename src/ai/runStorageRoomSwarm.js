/** Menjalankan beberapa builder storage room dengan pembagian wing dan checkpoint terpisah. */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const MAX_WORKERS = 8;

function getWorkerCount(env = process.env) {
  return Math.max(1, Math.min(MAX_WORKERS, Number(env.STORAGE_ROOM_SWARM_WORKERS) || 2));
}

function getWorkerIndices(env = process.env, count = getWorkerCount(env)) {
  const raw = env.STORAGE_ROOM_SWARM_WORKER_INDICES;
  if (raw === undefined || raw.trim() === '') return Array.from({ length: count }, (_, index) => index);
  const indices = [...new Set(raw.split(',').map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value >= 0 && value < count))].sort((a, b) => a - b);
  if (indices.length === 0) throw new RangeError(`STORAGE_ROOM_SWARM_WORKER_INDICES tidak memiliki index valid untuk ${count} worker.`);
  return indices;
}

function buildWorkerEnv({ env = process.env, index, count, rootDir = root } = {}) {
  const explicitDelay = env.STORAGE_ROOM_START_DELAY_MS;
  // Semua worker boleh mulai pada batch awal. Stagger kecil tetap mencegah empat login/klik chest
  // terjadi pada tick yang sama, tetapi tidak membuang satu menit sebelum pekerjaan dimulai.
  const baseDelay = Number(explicitDelay) >= 0 ? Number(explicitDelay) : 0;
  const stagger = Math.max(0, Number(env.STORAGE_ROOM_WORKER_START_STAGGER_MS) || 8000);
  const checkpoint = env[`STORAGE_ROOM_CHECKPOINT_WORKER_${index + 1}`] ||
    (count === 2 && index === 0 ? 'data/storage-room-checkpoint-live.json' :
      count === 2 && index === 1 ? 'data/storage-room-checkpoint-wing-2-live.json' :
        `data/storage-room-checkpoint-worker-${index + 1}-of-${count}.json`);
  return {
    ...env,
    STORAGE_ROOM_EXECUTE: env.STORAGE_ROOM_EXECUTE || '1',
    STORAGE_ROOM_CONTINUOUS: env.STORAGE_ROOM_CONTINUOUS || '1',
    STORAGE_ROOM_ALLOW_TERRAIN_WORK: '1',
    STORAGE_ROOM_SKIP_BASE: env.STORAGE_ROOM_SKIP_BASE || '1',
    STORAGE_ROOM_WALK_TO_WORKSITE: env.STORAGE_ROOM_WALK_TO_WORKSITE || '1',
    STORAGE_ROOM_BOOTSTRAP_TP: env.STORAGE_ROOM_BOOTSTRAP_TP || '0',
    STORAGE_ROOM_RESTOCK_LOCK: env.STORAGE_ROOM_RESTOCK_LOCK || path.join(rootDir, 'data/storage-room-restock.lock'),
    STORAGE_ROOM_MAX_PAUSED_RETRIES: env.STORAGE_ROOM_MAX_PAUSED_RETRIES || '30',
    STORAGE_ROOM_PAUSE_DELAY_MS: env.STORAGE_ROOM_PAUSE_DELAY_MS || '3000',
    STORAGE_ROOM_START_DELAY_MS: String(baseDelay + (explicitDelay === undefined ? index * stagger : 0)),
    STORAGE_ROOM_BATCH: env.STORAGE_ROOM_BATCH || '32',
    STORAGE_ROOM_WORKER_INDEX: String(index),
    STORAGE_ROOM_WORKER_COUNT: String(count),
    // Dipertahankan untuk kompatibilitas konfigurasi lama.
    STORAGE_ROOM_WING: String(index),
    MC_BOT_NAME: env[`STORAGE_ROOM_BOT_${index + 1}`] || `StorageW${index + 1}`,
    STORAGE_ROOM_CHECKPOINT: checkpoint,
    STORAGE_ROOM_INSTANCE_LOCK: env[`STORAGE_ROOM_INSTANCE_LOCK_${index + 1}`] || path.join(rootDir, `data/storage-room-instance-${index + 1}.lock`)
  };
}

function startStorageRoomSwarm({ env = process.env, log = console.log } = {}) {
  const workerCount = getWorkerCount(env);
  const workerIndices = getWorkerIndices(env, workerCount);
  const children = [];
  let stopping = false;

  const stopAll = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill(signal);
  };

  for (const index of workerIndices) {
    const child = spawn(process.execPath, [path.join(__dirname, 'runStorageRoomBuilder.js')], {
      cwd: root,
      env: buildWorkerEnv({ env, index, count: workerCount })
    });
    children.push(child);
    child.stdout.on('data', data => process.stdout.write(`[StorageW${index + 1}] ${data}`));
    child.stderr.on('data', data => process.stderr.write(`[StorageW${index + 1} ERROR] ${data}`));
    child.on('exit', (code, signal) => {
      log(`[StorageW${index + 1}] worker berhenti code=${code ?? 'null'} signal=${signal || 'none'}`);
      if (!stopping && code !== 0) {
        console.error(`[StorageW${index + 1}] berhenti dengan error; worker lain tetap berjalan dari checkpoint masing-masing.`);
        process.exitCode = code || 2;
      }
      if (children.every(item => item.exitCode !== null || item.signalCode !== null)) process.exit(process.exitCode || 0);
    });
  }
  return { workerCount, workerIndices, children, stopAll };
}

if (require.main === module) {
  const swarm = startStorageRoomSwarm();
  process.on('SIGINT', () => swarm.stopAll('SIGINT'));
  process.on('SIGTERM', () => swarm.stopAll('SIGTERM'));
}

module.exports = { MAX_WORKERS, getWorkerCount, getWorkerIndices, buildWorkerEnv, startStorageRoomSwarm };
