/** Menjalankan empat resource gatherer pada kuadran quarry yang tidak tumpang tindih. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const REGIONS = [
  [-66, -63, -406, -400, 40, 80],
  [-66, -63, -399, -393, 40, 80],
  [-66, -63, -392, -386, 40, 80],
  [-66, -63, -385, -379, 40, 80]
].map(region => region.join(','));

function parseRegions(raw = process.env.STORAGE_GATHERER_REGIONS) {
  if (!raw || !raw.trim()) return REGIONS.slice();
  const regions = raw.split(';').map(value => value.trim()).filter(Boolean);
  if (regions.length === 0 || regions.length > 4) throw new RangeError('Region gatherer harus berjumlah 1..4.');
  for (const region of regions) {
    const values = region.split(',').map(Number);
    if (values.length !== 6 || !values.every(Number.isInteger)) throw new Error('Setiap region gatherer harus berbentuk minX,maxX,minZ,maxZ,floorY,maxY.');
    if (values[0] > values[1] || values[2] > values[3] || values[4] > values[5]) throw new Error('Batas region gatherer tidak berurutan.');
  }
  return regions;
}

function startStorageRoomGathererSwarm({
  count = Number(process.env.STORAGE_GATHERER_COUNT) || 4,
  batch = Number(process.env.STORAGE_QUARRY_BATCH) || 256,
  maxRunMs = Number(process.env.STORAGE_QUARRY_MAX_RUN_MS) || 420000,
  maxRestarts = Number(process.env.STORAGE_GATHERER_MAX_RESTARTS) || 20,
  restartDelayMs = Number(process.env.STORAGE_GATHERER_RESTART_DELAY_MS) || 5000,
  runner = path.join(__dirname, 'runStorageRoomQuarry.js'),
  spawnProcess = spawn,
  regions = parseRegions(),
  log = message => console.log(message)
} = {}) {
  if (!Number.isInteger(count) || count < 1 || count > regions.length) throw new Error(`Jumlah gatherer harus 1..${regions.length}.`);
  const children = Array(count).fill(null);
  const workerStates = Array.from({ length: count }, () => ({ phase: 'STARTING', restarts: 0, terminal: false }));
  const restartTimers = new Set();
  let stopped = false;
  let completed = 0;
  let failed = false;
  let stopTimer;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(stopTimer);
    for (const timer of restartTimers) clearTimeout(timer);
    restartTimers.clear();
    for (const child of children) child?.kill('SIGTERM');
  };
  // Setiap quarry child punya timer sendiri dan dapat menulis PAUSED + checkpoint.
  // Parent tidak boleh membunuh semua region tepat pada detik yang sama, karena itu
  // menghapus kesempatan child untuk menyelesaikan batch dan mengirim status resumable.
  // Grace satu menit tetap menjadi pagar terakhir bila child benar-benar menggantung.
  stopTimer = setTimeout(stop, Math.max(1000, Number(maxRunMs) || 420000) + 60000);
  stopTimer.unref?.();

  const startWorker = index => {
    if (stopped || workerStates[index].terminal) return;
    const staggerMs = Math.max(0, Number(process.env.STORAGE_GATHERER_START_STAGGER_MS) || 0);
    const env = {
      ...process.env,
      MC_BOT_NAME: process.env[`STORAGE_GATHERER_BOT_${index + 1}`] || `ResourceW${index + 1}`,
      STORAGE_ROOM_EXECUTE: process.env.STORAGE_ROOM_EXECUTE || '1',
      STORAGE_QUARRY_BOUNDS: regions[index],
      STORAGE_QUARRY_STATE_DRIVEN: '1',
      // Deprecated: forwarded only so older deployments can still parse their env.
      // The production quarry runner ignores it in state-driven mode.
      STORAGE_QUARRY_BATCH: String(batch),
      STORAGE_QUARRY_MAX_RUN_MS: String(maxRunMs),
      STORAGE_QUARRY_CHECKPOINT: process.env[`STORAGE_GATHERER_CHECKPOINT_${index + 1}`] || `data/storage-room-quarry-w${index + 1}.json`,
      // Stagger hanya mengatur login awal agar empat bot tidak menyerbu server
      // bersamaan. Saat worker retry karena pathfinder/chunk sementara gagal,
      // jangan kenakan delay awal lagi; kalau tidak worker terakhir dapat
      // menunggu puluhan detik pada setiap siklus dan terlihat mati.
      STORAGE_QUARRY_START_DELAY_MS: String(workerStates[index].restarts === 0 ? index * staggerMs : 0)
    };
    const child = spawnProcess(process.execPath, [runner], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children[index] = child;
    workerStates[index].phase = 'STARTING';
    log(`[ResourceW${index + 1}] WORK_EVENT ${JSON.stringify({ phase: 'STARTING', workerIndex: index, restart: workerStates[index].restarts })}`);
    const consume = (stream, level) => {
      let pending = '';
      stream.on('data', data => {
      pending += String(data);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines.map(item => item.trim()).filter(Boolean)) {
        const marker = line.indexOf('WORK_EVENT ');
        if (marker >= 0) {
          try {
            const event = JSON.parse(line.slice(marker + 11));
            if (typeof event.phase === 'string') workerStates[index].phase = event.phase;
            if (event.reason) workerStates[index].reason = event.reason;
          } catch { /* Baris log biasa tidak mengubah state worker. */ }
        }
        log(`[ResourceW${index + 1}]${level === 'error' ? ' ERROR' : ''} ${line}`);
      }
      });
    };
    consume(child.stdout, 'info');
    consume(child.stderr, 'error');
    child.on('exit', (code, signal) => {
      log(`[ResourceW${index + 1}] selesai code=${code} signal=${signal || 'none'}`);
      if (stopped) return;
      if (workerStates[index].phase === 'COMPLETE') {
        workerStates[index].terminal = true;
        completed += 1;
        if (completed === count && require.main === module) {
          clearTimeout(stopTimer);
          process.exitCode = failed ? 2 : 0;
        }
        return;
      }
      if (workerStates[index].phase === 'BLOCKED') {
        failed = true;
        workerStates[index].terminal = true;
        completed += 1;
        log(`[ResourceW${index + 1}] WORK_EVENT ${JSON.stringify({ phase: 'BLOCKED', reason: workerStates[index].reason || 'WORKER_BLOCKED_TERMINAL' })}`);
        if (completed === count && require.main === module) {
          clearTimeout(stopTimer);
          process.exitCode = 2;
        }
        return;
      }
      if (workerStates[index].restarts >= Math.max(0, Number(maxRestarts) || 0)) {
        failed = true;
        workerStates[index].terminal = true;
        completed += 1;
        log(`[ResourceW${index + 1}] WORK_EVENT ${JSON.stringify({ phase: 'BLOCKED', reason: 'RESTART_LIMIT' })}`);
        if (completed === count && require.main === module) {
          clearTimeout(stopTimer);
          process.exitCode = 2;
        }
        return;
      }
      workerStates[index].restarts += 1;
      const timer = setTimeout(() => {
        restartTimers.delete(timer);
        startWorker(index);
      }, Math.max(250, Number(restartDelayMs) || 5000));
      restartTimers.add(timer);
      log(`[ResourceW${index + 1}] WORK_EVENT ${JSON.stringify({ phase: 'RESTARTING', restart: workerStates[index].restarts })}`);
    });
  };
  for (let index = 0; index < count; index += 1) startWorker(index);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { children, regions: regions.slice(0, count) };
}

module.exports = { REGIONS, parseRegions, startStorageRoomGathererSwarm };

if (require.main === module) startStorageRoomGathererSwarm();
