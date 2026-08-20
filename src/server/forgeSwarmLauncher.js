/**
 * @file forgeSwarmLauncher.js
 * @description Pengelola Swarm Akun Headless yang dapat bergabung langsung ke server Modded Forge (atoms-girl.tun.ply.gg:25565).
 * Meluncurkan worker Java di background dengan akun berbeda (Bot_Slayer, Bot_Sorter, Bot_Miner, dll)
 * dan mengendalikannya secara terpusat dari Web Dashboard.
 */

const subprocess = require('node:child_process');
const shlex = require('node:process');
const uuid = require('node:crypto');
const fs = require('node:fs');

class ForgeSwarmManager {
  constructor() {
    this.activeWorkers = new Map();
  }

  /**
   * Meluncurkan swarm worker ke live server.
   * @param {Array<string>} botNames - Daftar nama bot yang akan login ke live server
   * @param {string} [serverHost='atoms-girl.tun.ply.gg:25565'] - Alamat server target
   */
  launchSwarm(botNames = ['Bot_Slayer_1', 'Bot_Sorter_2'], serverHost = 'atoms-girl.tun.ply.gg:25565') {
    const cmdPath = '/Users/syahriezas/Desktop/minecraft_real_cmd.txt';
    if (!fs.existsSync(cmdPath)) {
      throw new Error('Template launch Minecraft tidak ditemukan.');
    }

    const cmdStr = fs.readFileSync(cmdPath, 'utf8').trim();
    const results = [];

    for (const name of botNames) {
      // Hentikan worker lama jika ada
      if (this.activeWorkers.has(name)) {
        try {
          process.kill(this.activeWorkers.get(name).pid);
        } catch (e) {}
      }

      const botUuid = uuid.randomUUID().replace(/-/g, '');
      
      // Jalankan worker python launcher di background
      const pyScript = `
import subprocess, shlex, os

cmd_str = open('${cmdPath}').read().strip()
tokens = shlex.split(cmd_str)

for i in range(len(tokens)):
    if tokens[i] == '--username' and i + 1 < len(tokens):
        tokens[i+1] = '${name}'
    elif tokens[i] == '--uuid' and i + 1 < len(tokens):
        tokens[i+1] = '${botUuid}'

if '--quickPlayMultiplayer' not in tokens:
    tokens.extend(['--quickPlayMultiplayer', '${serverHost}'])
else:
    idx = tokens.index('--quickPlayMultiplayer')
    tokens[idx+1] = '${serverHost}'

proc = subprocess.Popen(
    tokens,
    cwd='/Users/syahriezas/Library/Application Support/minecraft',
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True
)
print(proc.pid)
`;

      try {
        const pidOut = subprocess.execSync(`python3 -c "${pyScript.replace(/\n/g, ' ')}"`, { encoding: 'utf8' }).trim();
        const pid = parseInt(pidOut, 10);
        
        const workerInfo = {
          name,
          uuid: botUuid,
          pid,
          server: serverHost,
          status: 'CONNECTED_FORGE',
          startedAt: new Date().toISOString()
        };

        this.activeWorkers.set(name, workerInfo);
        results.push(workerInfo);
        console.log(`[Forge Swarm] 🤖 Bot '${name}' (PID: ${pid}) berhasil diluncurkan ke ${serverHost}`);
      } catch (e) {
        console.error(`[Forge Swarm] Gagal meluncurkan bot '${name}':`, e.message);
      }
    }

    return results;
  }

  /**
   * Menghentikan semua bot swarm yang sedang aktif di live server.
   */
  stopAllSwarm() {
    for (const [name, info] of this.activeWorkers.entries()) {
      try {
        process.kill(info.pid);
        console.log(`[Forge Swarm] ⏹️ Bot '${name}' (PID: ${info.pid}) dihentikan.`);
      } catch (e) {}
    }
    this.activeWorkers.clear();
    return true;
  }

  getActiveSwarm() {
    return Array.from(this.activeWorkers.values());
  }
}

const forgeSwarmManager = new ForgeSwarmManager();
module.exports = { forgeSwarmManager, ForgeSwarmManager };
