/**
 * @file recoveryStateMachine.js
 * @description Mesin pemulihan 4-fase yang mengekskalasi strategi penyelamatan bot secara bertahap
 * ketika kondisi macet (stuck) terdeteksi oleh StuckDetector.
 */

const { RECOVERY_PHASES } = require('../config/constants');
const { Vec3 } = require('vec3');

class RecoveryStateMachine {
  constructor() {
    this.currentPhase = RECOVERY_PHASES.NONE;
    this.lastGoodPositions = [];
    this.maxGoodPositions = 10;
    this.recoveryAttempts = 0;
    this.maxAttemptsPerPhase = 3;
  }

  /**
   * Mencatat posisi yang diketahui baik (bot bergerak normal).
   * @param {Object} position - Posisi { x, y, z }
   */
  recordGoodPosition(position) {
    this.lastGoodPositions.push({ ...position, timestamp: Date.now() });
    if (this.lastGoodPositions.length > this.maxGoodPositions) {
      this.lastGoodPositions.shift();
    }
  }

  /**
   * Mengeksekusi upaya pemulihan berdasarkan fase saat ini.
   * @param {Object} bot - Instance Mineflayer bot
   * @returns {Promise<number>} Fase pemulihan berikutnya
   */
  async attemptRecovery(bot) {
    if (!bot || !bot.entity) return RECOVERY_PHASES.NONE;

    this.recoveryAttempts++;

    // Eskalasi fase jika percobaan terlalu banyak di fase saat ini
    if (this.recoveryAttempts > this.maxAttemptsPerPhase) {
      this.currentPhase = Math.min(this.currentPhase + 1, RECOVERY_PHASES.REWIND_WAYPOINT);
      this.recoveryAttempts = 1;
    }

    switch (this.currentPhase) {
      case RECOVERY_PHASES.NONE:
        this.currentPhase = RECOVERY_PHASES.MICRO_JUMP;
        return await this._phase1MicroJump(bot);

      case RECOVERY_PHASES.MICRO_JUMP:
        return await this._phase1MicroJump(bot);

      case RECOVERY_PHASES.STRAFE_DETOUR:
        return await this._phase2StrafeDetour(bot);

      case RECOVERY_PHASES.RE_ROUTE_PATH:
        return await this._phase3ReRoutePath(bot);

      case RECOVERY_PHASES.REWIND_WAYPOINT:
        return await this._phase4RewindWaypoint(bot);

      default:
        return RECOVERY_PHASES.NONE;
    }
  }

  /**
   * Fase 1: Lompatan mikro dengan rotasi yaw sedikit.
   * @private
   */
  async _phase1MicroJump(bot) {
    console.log('[Recovery] Fase 1: Lompatan mikro & rotasi yaw');

    try {
      // Rotasi yaw acak kecil (-30° s.d. +30°)
      const yawOffset = (Math.random() - 0.5) * Math.PI / 3;
      bot.entity.yaw += yawOffset;

      // Lompat
      bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 350));
      bot.setControlState('jump', false);

      // Maju sedikit
      bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 500));
      bot.setControlState('forward', false);
    } catch (e) {
      console.error('[Recovery] Gagal menjalankan fase 1:', e.message);
    }

    this.currentPhase = RECOVERY_PHASES.STRAFE_DETOUR;
    return this.currentPhase;
  }

  /**
   * Fase 2: Bergerak menyamping (strafe) untuk keluar dari celah sempit.
   * @private
   */
  async _phase2StrafeDetour(bot) {
    console.log('[Recovery] Fase 2: Strafe menyamping untuk keluar dari celah');

    try {
      // Strafe kiri
      const direction = Math.random() > 0.5 ? 'left' : 'right';
      bot.setControlState(direction, true);
      bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 800));
      bot.setControlState(direction, false);
      bot.setControlState('forward', false);

      // Lompat setelah strafe
      bot.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 300));
      bot.setControlState('jump', false);
    } catch (e) {
      console.error('[Recovery] Gagal menjalankan fase 2:', e.message);
    }

    this.currentPhase = RECOVERY_PHASES.RE_ROUTE_PATH;
    return this.currentPhase;
  }

  /**
   * Fase 3: Menghitung ulang rute pathfinder secara dinamis.
   * @private
   */
  async _phase3ReRoutePath(bot) {
    console.log('[Recovery] Fase 3: Menghitung ulang rute pathfinder');

    try {
      if (bot.pathfinder) {
        bot.pathfinder.stop();
        await new Promise(r => setTimeout(r, 200));

        // Mundur sedikit sebelum re-route
        bot.setControlState('back', true);
        await new Promise(r => setTimeout(r, 600));
        bot.setControlState('back', false);
      }
    } catch (e) {
      console.error('[Recovery] Gagal menjalankan fase 3:', e.message);
    }

    this.currentPhase = RECOVERY_PHASES.REWIND_WAYPOINT;
    return this.currentPhase;
  }

  /**
   * Fase 4: Kembali ke posisi terakhir yang diketahui baik.
   * @private
   */
  async _phase4RewindWaypoint(bot) {
    console.log('[Recovery] Fase 4: Kembali ke posisi terakhir yang baik');

    try {
      if (this.lastGoodPositions.length > 0) {
        // Ambil posisi baik terlama (paling jauh dari posisi macet saat ini)
        const rewindTarget = this.lastGoodPositions[0];
        const targetVec = new Vec3(rewindTarget.x, rewindTarget.y, rewindTarget.z);

        // Arahkan bot ke posisi rewind
        await bot.lookAt(targetVec);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 1500));
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
      }
    } catch (e) {
      console.error('[Recovery] Gagal menjalankan fase 4:', e.message);
    }

    // Reset ke fase awal setelah mencoba semua fase
    this.currentPhase = RECOVERY_PHASES.NONE;
    this.recoveryAttempts = 0;
    return this.currentPhase;
  }

  /**
   * Mereset seluruh state mesin pemulihan.
   */
  reset() {
    this.currentPhase = RECOVERY_PHASES.NONE;
    this.recoveryAttempts = 0;
    this.lastGoodPositions = [];
  }

  /**
   * Mendapatkan status fase pemulihan saat ini.
   * @returns {Object} Status mesin pemulihan
   */
  getStatus() {
    const phaseNames = {
      [RECOVERY_PHASES.NONE]: 'Normal',
      [RECOVERY_PHASES.MICRO_JUMP]: 'Lompatan Mikro',
      [RECOVERY_PHASES.STRAFE_DETOUR]: 'Strafe Menyamping',
      [RECOVERY_PHASES.RE_ROUTE_PATH]: 'Hitung Ulang Rute',
      [RECOVERY_PHASES.REWIND_WAYPOINT]: 'Kembali ke Waypoint'
    };

    return {
      currentPhase: this.currentPhase,
      phaseName: phaseNames[this.currentPhase] || 'Tidak Diketahui',
      recoveryAttempts: this.recoveryAttempts,
      savedWaypoints: this.lastGoodPositions.length
    };
  }
}

module.exports = { RecoveryStateMachine };
