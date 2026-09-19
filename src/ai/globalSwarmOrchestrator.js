const EventEmitter = require('node:events');
const { randomUUID } = require('node:crypto');
const { SharedWorldMemory } = require('./sharedWorldMemory');
const { SwarmTaskBoard } = require('./swarmTaskBoard');
const { createDefaultPlannerRegistry } = require('./domainGoalPlanners');

class GlobalSwarmOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ownsMemory = !options.memory;
    this.memory = options.memory || new SharedWorldMemory(options.memoryFile);
    this.board = options.board || new SwarmTaskBoard(this.memory);
    this.planners = options.planners || createDefaultPlannerRegistry();
  }

  submitGoal({ world, dimension, type, payload = {}, priority = 0 }) {
    const draft = { id: randomUUID(), world, dimension, type, payload, priority };
    const tasks = this.planners.plan(draft);
    let goal;
    this.memory.db.exec('BEGIN IMMEDIATE');
    try {
      goal = this.board.createGoal(draft);
      for (const task of tasks) {
        this.board.addTask({ ...task, world, dimension, priority: Number(task.priority ?? priority) });
      }
      this.memory.db.exec('COMMIT');
    } catch (error) {
      this.memory.db.exec('ROLLBACK');
      throw error;
    }
    const result = { ...goal, tasks: this.board.listTasks({ goalId: goal.id }) };
    this.emit('goalSubmitted', result);
    return result;
  }

  getGoal(goalId) {
    const goal = this.board.getGoal(goalId);
    return goal ? { ...goal, tasks: this.board.listTasks({ goalId }), events: this.board.listEvents({ goalId }) } : null;
  }

  getStatus({ world, dimension } = {}) {
    const agents = world && dimension ? this.board.listAgents({ world, dimension }) : [];
    const tasks = this.board.listTasks({ world, dimension });
    return {
      world: world || null,
      dimension: dimension || null,
      agents,
      tasks,
      taskCounts: tasks.reduce((counts, task) => {
        counts[task.status] = (counts[task.status] || 0) + 1;
        return counts;
      }, {})
    };
  }

  cancelGoal(goalId, reason) {
    return this.board.cancelGoal(goalId, reason);
  }

  close() {
    if (this.ownsMemory) this.memory.close();
  }
}

module.exports = { GlobalSwarmOrchestrator };
