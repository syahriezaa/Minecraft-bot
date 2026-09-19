/** Menunggu server sehat lalu menjalankan swarm storage dari checkpoint terakhir. */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { querySLP } = require('../network/slpVerifier');

const root = path.resolve(__dirname, '../..');
const swarmScript = path.join(__dirname, 'runStorageRoomSwarm.js');
const host = process.env.STORAGE_ROOM_SERVER_HOST || process.env.MC_HOST || 'atoms-girl.tun.ply.gg';
const port = Number(process.env.STORAGE_ROOM_SERVER_PORT || process.env.MC_PORT) || 25565;
const probeIntervalMs = Number(process.env.STORAGE_ROOM_PROBE_INTERVAL_MS) || 30000;
const restartDelayMs = Number(process.env.STORAGE_ROOM_RESTART_DELAY_MS) || 10000;
const maxRestarts = Number.isInteger(Number(process.env.STORAGE_ROOM_MAX_RESTARTS)) ? Number(process.env.STORAGE_ROOM_MAX_RESTARTS) : 20;

let stopping = false;
let activeChild = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForServer(log = console.log) {
  for (;;) {
    try {
      const status = await querySLP({ host, port, timeoutMs: 5000, protocolVersion: 775 });
      log(`SLP sehat: ${status.version?.name || 'Minecraft'} protocol=${status.version?.protocol || 775}.`);
      return status;
    } catch (error) {
      log(`Server belum siap (${error.code || error.message}); probe ulang ${probeIntervalMs}ms.`);
      await sleep(probeIntervalMs);
    }
  }
}

function runSwarm() {
  return new Promise(resolve => {
    activeChild = spawn(process.execPath, [swarmScript], {
      cwd: root,
      env: { ...process.env, MC_HOST: host, MC_PORT: String(port), STORAGE_ROOM_EXECUTE: '1' }
    });
    activeChild.stdout.on('data', data => process.stdout.write(`[Supervisor] ${data}`));
    activeChild.stderr.on('data', data => process.stderr.write(`[Supervisor ERROR] ${data}`));
    activeChild.on('exit', (code, signal) => { activeChild = null; resolve({ code, signal }); });
  });
}

async function runSupervisor({ log = console.log } = {}) {
  let restarts = 0;
  while (!stopping) {
    await waitForServer(log);
    if (stopping) break;
    const result = await runSwarm();
    if (stopping || result.code === 0) return result;
    restarts += 1;
    if (restarts > maxRestarts) throw new Error(`Swarm gagal ${maxRestarts} kali; supervisor berhenti untuk mencegah loop tanpa batas.`);
    log(`Swarm berhenti (${result.code ?? 'null'}/${result.signal || 'none'}); checkpoint dipertahankan, restart ${restarts}/${maxRestarts} setelah ${restartDelayMs}ms.`);
    await sleep(restartDelayMs);
  }
  return { code: 0, stopped: true };
}

function stop(signal = 'SIGTERM') { stopping = true; if (activeChild) activeChild.kill(signal); }

if (require.main === module) {
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  runSupervisor().then(result => process.exit(result.code || 0)).catch(error => {
    console.error(`Supervisor berhenti: ${error.message}`);
    process.exit(2);
  });
}

module.exports = { waitForServer, runSupervisor, stop };
