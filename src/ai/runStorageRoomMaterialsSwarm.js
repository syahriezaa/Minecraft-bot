/** Menjalankan beberapa worker logistik materials dengan identitas dan lock terpisah. */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const workerScript = path.join(__dirname, 'runStorageRoomMaterials.js');
const MAX_WORKERS = 2;

function getWorkerCount(env = process.env) {
  return Math.max(1, Math.min(MAX_WORKERS, Number(env.STORAGE_MATERIALS_WORKERS) || 1));
}

function buildWorkerEnv({ env = process.env, index, rootDir = root } = {}) {
  const name = env[`STORAGE_MATERIALS_BOT_${index + 1}`] ||
    (index === 0 ? env.MC_BOT_NAME || 'StorageMat1' : `StorageMat${index + 1}`);
  return {
    ...env,
    MC_BOT_NAME: name,
    STORAGE_MATERIALS_WORKER_INDEX: String(index),
    STORAGE_ROOM_RESTOCK_LOCK: env.STORAGE_ROOM_RESTOCK_LOCK || path.join(rootDir, 'data/storage-room-restock.lock'),
    STORAGE_MATERIALS_START_DELAY_MS: String(Math.max(0, Number(env.STORAGE_MATERIALS_START_DELAY_MS) || index * 3500))
  };
}

function startStorageRoomMaterialsSwarm({ env = process.env, log = console.log } = {}) {
  const workerCount = getWorkerCount(env);
  const children = [];
  let stopping = false;
  let remaining = workerCount;
  let failureCode = 0;

  const stopAll = (signal = 'SIGTERM') => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill(signal);
  };

  for (let index = 0; index < workerCount; index += 1) {
    const child = spawn(process.execPath, [workerScript], {
      cwd: root,
      env: buildWorkerEnv({ env, index }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    child.stdout.on('data', data => process.stdout.write(`[Materials${index + 1}] ${data}`));
    child.stderr.on('data', data => process.stderr.write(`[Materials${index + 1} ERROR] ${data}`));
    child.on('error', error => {
      failureCode = failureCode || 2;
      log(`[Materials${index + 1}] gagal dibuat: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      if (code && !failureCode) failureCode = code;
      log(`[Materials${index + 1}] worker berhenti code=${code ?? 'null'} signal=${signal || 'none'}`);
      remaining -= 1;
      if (!remaining) process.exit(failureCode || (stopping ? 0 : 0));
    });
  }
  return { workerCount, children, stopAll };
}

if (require.main === module) {
  const swarm = startStorageRoomMaterialsSwarm();
  process.on('SIGINT', () => swarm.stopAll('SIGINT'));
  process.on('SIGTERM', () => swarm.stopAll('SIGTERM'));
}

module.exports = { MAX_WORKERS, getWorkerCount, buildWorkerEnv, startStorageRoomMaterialsSwarm };
