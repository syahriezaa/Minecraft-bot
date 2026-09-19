/**
 * @file survivalRoleCoordinator.js
 * @description Coordinator role survival untuk farming, peternakan, dan mob farm.
 *
 * Aturan Tim: Semua komentar, log, dan pesan error ditulis dalam Bahasa Indonesia.
 */

const EventEmitter = require('node:events');
const { MineflayerRoleAdapter } = require('./mineflayerRoleAdapter');
const { FarmerEngine } = require('./farmerEngine');
const { AnimalHusbandryEngine, verifyAnimalFeeding } = require('./animalHusbandryEngine');
const { MobFarmEngine } = require('./mobFarmEngine');
const { createEngineTaskHandlers, createCooperativeAgent } = require('./cooperativeAgent');

const ROLE_STATES = Object.freeze({
  IDLE: 'IDLE',
  FARMING: 'FARMING',
  HUSBANDRY: 'HUSBANDRY',
  MOB_FARMING: 'MOB_FARMING',
  RECOVERING: 'RECOVERING',
  STOPPED: 'STOPPED'
});

class SurvivalRoleCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    const adapter = options.adapter || new MineflayerRoleAdapter(options.bot, options.adapterOptions);
    this.adapter = adapter;
    this.options = {
      tickIntervalMs: 750,
      emergencyHealth: 7,
      emergencyFood: 10,
      enableFarmer: true,
      enableAnimals: true,
      enableMobFarm: true,
      ...options
    };
    this.farmer = options.farmer || new FarmerEngine({ adapter, ...(options.farmerOptions || {}) });
    this.animals = options.animals || new AnimalHusbandryEngine({ adapter, ...(options.animalOptions || {}) });
    this.mobFarm = options.mobFarm || new MobFarmEngine({ adapter, ...(options.mobFarmOptions || {}) });
    this.cooperativeRuntime = options.cooperativeRuntime === false ? null : createCooperativeAgent(adapter, {
      capabilities: ['farm', 'animal_care', 'combat', 'haul', 'survey'],
      metadata: { role: 'survival_coordinator' },
      handlers: {
        ...createEngineTaskHandlers(this.farmer, {
          SURVEY_FARM: { execute: async () => ({ action: 'survey', mature: this.farmer.findMatureCrops().length,
            plantingSpots: this.farmer.findPlantingSpots().length, repairs: this.farmer.findRepairCandidates().length }) },
          REPAIR_FARM: { execute: async () => {
            const result = await this.farmer.attemptRepair();
            if (result) return { ...result, verified: result.count > 0 };
            const noWork = this.farmer.options.repairEnabled && this.farmer.findRepairCandidates().length === 0;
            return { action: 'idle', verified: noWork, reason: noWork ? undefined : 'REPAIR_NO_PROGRESS' };
          }, actions: ['repair'], mutatesWorld: true, idleCompletes: true, remaining: () => this.farmer.findRepairCandidates().length },
          HARVEST: { actions: ['harvest'], mutatesWorld: true, idleCompletes: true, remaining: () => this.farmer.findMatureCrops().length,
            verify: ({ result }) => Number(result?.count) > 0 },
          PLANT: { actions: ['plant'], mutatesWorld: true, idleCompletes: true, remaining: () => this.farmer.findPlantingSpots().length,
            verify: ({ result }) => Number(result?.count) > 0 },
          DEPOSIT_CROPS: { execute: async () => await this.farmer.runAutoMatchDeposit() || { action: 'idle' }, actions: ['deposit'], idleCompletes: true }
        }),
        ...createEngineTaskHandlers(this.animals, {
          INSPECT_ANIMALS: { execute: async () => ({ action: 'inspect', animals: this.animals.getAnimals().length }) },
          FEED_ANIMALS: { actions: ['feed'], mutatesWorld: true, idleCompletes: true, remaining: () => this.animals.selectFeedTargets().length,
            verify: verifyAnimalFeeding },
          BALANCE_HERD: { actions: ['cull'], mutatesWorld: true, idleCompletes: true, remaining: () => this.animals.selectCullTargets().length,
            verify: ({ result }) => Number(result?.count) > 0 }
        }),
        ...createEngineTaskHandlers(this.mobFarm, {
          SURVEY_THREATS: { execute: async () => ({ action: 'survey', threats: this.mobFarm.getThreats().length }) },
          PATROL_AREA: { actions: ['patrol', 'standby'], idleCompletes: true },
          ENGAGE_THREATS: { actions: ['attack', 'approach', 'cooldown'], idleCompletes: true }
        })
      }
    });
    this.state = ROLE_STATES.IDLE;
    this._timer = null;
    this._tickInProgress = false;
    this.metrics = {
      ticks: 0,
      actions: []
    };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(err => this.emit('error', err));
    }, this.options.tickIntervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    this.emit('started');
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.state = ROLE_STATES.STOPPED;
    this.cooperativeRuntime?.stop();
    this.emit('stopped');
  }

  async tick() {
    if (this._tickInProgress) return { role: 'coordinator', action: 'busy' };
    this._tickInProgress = true;
    try { return await this._runTick(); }
    finally { this._tickInProgress = false; }
  }

  async _runTick() {
    this.metrics.ticks++;

    if (this.adapter.getHealth() <= this.options.emergencyHealth || this.adapter.getFood() <= this.options.emergencyFood) {
      this.state = ROLE_STATES.RECOVERING;
      const recovery = this.cooperativeRuntime
        ? await this.cooperativeRuntime.runAutonomous(() => this.adapter.eatBestFood(), { name: 'SURVIVAL_RECOVERY', survival: true, stallTimeoutMs: 30000 })
        : await this.adapter.eatBestFood();
      const ate = recovery?.status ? false : recovery;
      const result = { role: 'recovery', action: ate ? 'eat' : 'wait' };
      this.recordAction(result);
      return result;
    }

    if (this.options.enableMobFarm && this.mobFarm.getThreats().length > 0) {
      this.state = ROLE_STATES.MOB_FARMING;
      const mobResult = this.cooperativeRuntime
        ? await this.cooperativeRuntime.runAutonomous(() => this.mobFarm.tick(), { name: 'REACTIVE_COMBAT', survival: true, stallTimeoutMs: 45000 })
        : await this.mobFarm.tick();
      const result = mobResult?.status ? { role: 'mob_farm', action: mobResult.status.toLowerCase(), reason: mobResult.reason }
        : { role: 'mob_farm', ...mobResult };
      this.recordAction(result);
      return result;
    }

    const cooperative = await this.cooperativeRuntime?.runOnce();
    if (cooperative && cooperative.status !== 'IDLE') {
      const result = { role: 'swarm', action: 'cooperative_task', task: cooperative };
      this.recordAction(result);
      return result;
    }

    if (this.options.enableFarmer) {
      const result = this.cooperativeRuntime
        ? await this.cooperativeRuntime.runAutonomous(() => this.farmer.tick(), { name: 'FARMER_TICK' })
        : await this.farmer.tick();
      if (result?.status) {
        const action = { role: 'farmer', action: result.status.toLowerCase(), reason: result.reason };
        this.recordAction(action);
        return action;
      }
      if (result.action !== 'idle') {
        this.state = ROLE_STATES.FARMING;
        const action = { role: 'farmer', ...result };
        this.recordAction(action);
        return action;
      }
    }

    if (this.options.enableAnimals) {
      const result = this.cooperativeRuntime
        ? await this.cooperativeRuntime.runAutonomous(() => this.animals.tick(), { name: 'ANIMAL_CARE_TICK' })
        : await this.animals.tick();
      if (result?.status) {
        const action = { role: 'animals', action: result.status.toLowerCase(), reason: result.reason };
        this.recordAction(action);
        return action;
      }
      if (result.action !== 'idle') {
        this.state = ROLE_STATES.HUSBANDRY;
        const action = { role: 'animals', ...result };
        this.recordAction(action);
        return action;
      }
    }

    this.state = ROLE_STATES.IDLE;
    const idle = { role: 'coordinator', action: 'idle' };
    this.recordAction(idle);
    return idle;
  }

  recordAction(action) {
    this.metrics.actions.push({ ...action, timestamp: Date.now() });
    if (this.metrics.actions.length > 100) this.metrics.actions.shift();
    this.emit('action', action);
  }
}

module.exports = {
  SurvivalRoleCoordinator,
  ROLE_STATES
};
