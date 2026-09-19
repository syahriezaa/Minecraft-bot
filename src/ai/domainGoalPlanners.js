function task(goal, key, type, capability, dependencies = [], payload = {}) {
  return {
    id: `${goal.id}:${key}`,
    goalId: goal.id,
    type,
    capability,
    dependencies: dependencies.map(value => `${goal.id}:${value}`),
    payload: { ...(goal.payload || {}), ...payload }
  };
}

class GoalPlannerRegistry {
  constructor() { this.planners = new Map(); }
  register(type, planner) {
    if (!type || typeof planner !== 'function') throw new TypeError('Planner goal tidak valid.');
    this.planners.set(type, planner);
    return this;
  }
  plan(goal) {
    const planner = this.planners.get(goal?.type);
    if (!planner) throw new Error(`Planner goal ${goal?.type || 'unknown'} belum tersedia.`);
    return planner(goal);
  }
}

function createDefaultPlannerRegistry() {
  return new GoalPlannerRegistry()
    .register('STORAGE_ROOM_CONSTRUCTION', goal => {
      const payload = goal.payload || {};
      const workers = (role, count, capability, type, names = []) => Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) =>
        task(goal, `${role}-${index + 1}`, type, capability, [], {
          role, workerIndex: index + 1, allowedAgents: [names[index] || `${role}-${index + 1}`]
        }));
      return [
        ...workers('landscaper', payload.landscaperWorkerCount ?? 1, 'landscape', 'LANDSCAPE_SITE', payload.landscaperBotNames),
        ...workers('builder', payload.builderWorkerCount ?? 2, 'build', 'BUILD_STORAGE', payload.builderBotNames)
      ];
    })
    .register('MINING_FLEET', goal => {
      const payload = goal.payload || {};
      const count = Math.max(1, Math.min(4, Number(payload.count) || 1));
      return Array.from({ length: count }, (_, index) => task(goal, `miner-${index + 1}`, 'MINING_SUPPLY', 'mine', [], {
        role: 'miner',
        workerIndex: index + 1,
        region: payload.regions?.[index] || null,
        allowedAgents: [payload.workerNames?.[index] || `ResourceW${index + 1}`]
      }));
    })
    .register('PREPARE_MATERIALS', goal => {
      const payload = goal.payload || {};
      return [task(goal, 'materials', 'PREPARE_MATERIALS', 'craft', [], {
        role: 'materials',
        allowedAgents: payload.botName ? [payload.botName] : undefined,
        capabilities: ['smelt', 'craft', 'haul']
      })];
    })
    .register('MINE_RESOURCES', goal => [
      task(goal, 'survey', 'SURVEY_FRONTIER', 'survey'),
      task(goal, 'access', 'ENSURE_ACCESS', 'access', ['survey'], { mutatesWorld: true }),
      task(goal, 'mine', 'MINE_CELL', 'mine', ['access'], { mutatesWorld: true, returnPolicy: 'STATE_DRIVEN' }),
      task(goal, 'haul', 'HAUL_RESOURCES', 'haul', ['mine'])
    ])
    .register('BUILD_STRUCTURE', goal => [
      task(goal, 'survey', 'SURVEY_SITE', 'survey'),
      task(goal, 'landscape', 'LANDSCAPE', 'landscape', ['survey'], { mutatesWorld: true }),
      task(goal, 'gather', 'GATHER_MATERIALS', 'mine', ['survey']),
      task(goal, 'smelt', 'SMELT', 'smelt', ['gather'], { mutatesWorld: true }),
      task(goal, 'craft', 'CRAFT', 'craft', ['smelt'], { mutatesWorld: true }),
      task(goal, 'build', 'BUILD', 'build', ['landscape', 'craft'], { mutatesWorld: true }),
      task(goal, 'audit', 'AUDIT_STRUCTURE', 'audit', ['build'])
    ])
    .register('MAINTAIN_FARM', goal => [
      task(goal, 'survey', 'SURVEY_FARM', 'survey'),
      task(goal, 'repair', 'REPAIR_FARM', 'farm', ['survey'], { mutatesWorld: true }),
      task(goal, 'harvest', 'HARVEST', 'farm', ['repair'], { mutatesWorld: true }),
      task(goal, 'plant', 'PLANT', 'farm', ['harvest'], { mutatesWorld: true }),
      task(goal, 'deposit', 'DEPOSIT_CROPS', 'haul', ['plant'])
    ])
    .register('SORT_STORAGE', goal => [
      task(goal, 'audit', 'AUDIT_STORAGE', 'storage'),
      task(goal, 'sort', 'SORT_ITEMS', 'storage', ['audit'], { mutatesWorld: true }),
      task(goal, 'verify', 'VERIFY_STORAGE', 'audit', ['sort'])
    ])
    .register('EXPLORE_AREA', goal => [
      task(goal, 'survey', 'SURVEY_AREA', 'survey'),
      task(goal, 'classify', 'CLASSIFY_STRUCTURES', 'classify', ['survey']),
      task(goal, 'publish', 'PUBLISH_LANDMARKS', 'survey', ['classify'])
    ])
    .register('DEFEND_AREA', goal => [
      task(goal, 'survey', 'SURVEY_THREATS', 'survey'),
      task(goal, 'patrol', 'PATROL_AREA', 'patrol', ['survey']),
      task(goal, 'engage', 'ENGAGE_THREATS', 'combat', ['patrol'])
    ])
    .register('CARE_ANIMALS', goal => [
      task(goal, 'inspect', 'INSPECT_ANIMALS', 'animal_care'),
      task(goal, 'feed', 'FEED_ANIMALS', 'animal_care', ['inspect']),
      task(goal, 'balance', 'BALANCE_HERD', 'animal_care', ['feed']),
      task(goal, 'deposit', 'DEPOSIT_ANIMAL_PRODUCTS', 'haul', ['balance'])
    ]);
}

module.exports = { GoalPlannerRegistry, createDefaultPlannerRegistry };
