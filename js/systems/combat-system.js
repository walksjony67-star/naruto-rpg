import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { getElementMultiplier } from '../utils/format.js';
import { GAME_DATA, getMasteryTier } from '../data/game-data.js';

class CombatSystem {
  constructor() {
    this._combatLog = [];
  }

  processInstruction(combatData) {
    if (!combatData || typeof combatData !== 'object') {
      console.warn('[CombatSystem] Invalid combat instruction:', typeof combatData);
      return;
    }

    switch (combatData.state) {
      case 'start':
        this._startCombat(combatData);
        break;
      case 'round_start':
      case 'player_turn':
        this._playerTurn(combatData);
        break;
      case 'enemy_turn':
        this._enemyTurn(combatData);
        break;
      case 'victory':
      case 'defeat':
      case 'retreat':
        this._endCombat(combatData);
        break;
    }
  }

  _startCombat(data) {
    stateManager.batchUpdate([
      {
        path: 'combat', op: 'set', value: {
          state: 'initiating',
          turn: 0,
          is_active: true,
          enemy_name: data.enemy_name || '不明敌人',
          enemy_rank: data.enemy_rank || '中忍',
          enemy_chakra: data.enemy_chakra || 80,
          enemy_chakra_max: data.enemy_chakra_max || data.enemy_chakra || 80,
          enemy_stamina: data.enemy_stamina || data.enemy_hp || 160,
          enemy_stamina_max: data.enemy_stamina_max || data.enemy_hp_max || data.enemy_stamina || data.enemy_hp || 160,
          enemy_spirit: data.enemy_spirit || 50,
          enemy_speed: data.enemy_speed || 30,
          enemy_defense: data.enemy_defense || 20,
          enemy_element: data.enemy_element || '无',
          enemy_style: data.enemy_style || '均衡型',
          enemy_status: data.enemy_status || [],
          environment: data.environment || {},
          log: [],
          player_buffs: [],
          player_debuffs: [],
          enemy_buffs: [],
          enemy_debuffs: [],
          result: null
        }
      }
    ]);
    eventBus.emit('combat:started', data);
  }

  _playerTurn(data) {
    const combat = stateManager.get('combat');
    if (!combat || typeof combat !== 'object') {
      console.warn('[CombatSystem] _playerTurn called but no combat state exists');
      return;
    }
    const turn = (combat?.turn || 0) + 1;

    stateManager.batchUpdate([
      { path: 'combat.state', op: 'set', value: 'player_turn' },
      { path: 'combat.turn', op: 'set', value: turn }
    ]);

    if (data.enemy_chakra !== undefined) {
      stateManager.update([{ path: 'combat.enemy_chakra', op: 'set', value: data.enemy_chakra }]);
    }
    if (data.enemy_stamina !== undefined || data.enemy_hp !== undefined) {
      stateManager.update([{ path: 'combat.enemy_stamina', op: 'set', value: data.enemy_stamina ?? data.enemy_hp }]);
    }

    if (data.log) {
      const entry = {
        turn,
        actor: 'player',
        action_type: data.action_type || 'attack',
        action_name: data.action_name || '攻击',
        result: data.result || '',
        damage: data.damage_to_enemy || 0
      };
      stateManager.update([{ path: 'combat.log', op: 'push', value: entry }]);
    }

    if (data.state === 'enemy_turn') {
      stateManager.update([{ path: 'combat.state', op: 'set', value: 'enemy_turn' }]);
    }
  }

  _enemyTurn(data) {
    stateManager.update([{ path: 'combat.state', op: 'set', value: 'enemy_turn' }]);

    if (data.damage_to_player) {
      stateManager.update([
        { path: 'attributes.stamina_current', op: 'sub', value: data.damage_to_player }
      ]);
    }

    if (data.log) {
      const combat = stateManager.get('combat');
      const entry = {
        turn: combat?.turn || 0,
        actor: 'enemy',
        action_type: data.action_type || 'attack',
        action_name: data.action_name || '攻击',
        result: data.result || '',
        damage: data.damage_to_player || 0
      };
      stateManager.update([{ path: 'combat.log', op: 'push', value: entry }]);
    }

    if (data.state === 'player_turn') {
      stateManager.update([{ path: 'combat.state', op: 'set', value: 'player_turn' }]);
    }
  }

  _endCombat(data) {
    const result = data.state;
    const combat = stateManager.get('combat');

    stateManager.batchUpdate([
      { path: 'combat.state', op: 'set', value: 'peace' },
      { path: 'combat.is_active', op: 'set', value: false },
      { path: 'combat.result', op: 'set', value: result }
    ]);

    if (result === 'victory' && data.exp_reward) {
      stateManager.update([
        { path: 'progression.exp', op: 'add', value: data.exp_reward }
      ]);
    }

    eventBus.emit('combat:ended', { result, data, combat });
  }

  calculateDamage(attacker, defender, attack) {
    const attackType = attack.type || 'ninjutsu';
    const mastery = attack.mastery || 0;
    let basePower = attack.power || this._basePowerFromRank(attack.rank || 'D');

    if (attacker) {
      if (attackType === 'taijutsu') {
        basePower += (attacker.speed || 0) * 0.25 + (attacker.stamina || 0) * 0.08 + (attacker.willpower || 0) * 0.08;
      } else if (attackType === 'genjutsu') {
        basePower += (attacker.spirit || 0) * 0.25 + (attacker.chakra || 0) * 0.05;
      } else {
        basePower += (attacker.chakra || 0) * 0.12 + (attacker.spirit || 0) * 0.08;
      }
    }

    const tier = getMasteryTier(mastery);
    basePower *= tier.power_multiplier;

    if (attack.element && defender.element) {
      const mult = getElementMultiplier(attack.element, defender.element);
      basePower *= mult;
    }

    const randomFactor = 0.85 + Math.random() * 0.3;
    basePower *= randomFactor;

    const defense = defender?.defense ?? defender?.enemy_defense ?? this._estimateDefense(defender);
    basePower = Math.max(1, basePower - defense * 0.45);

    return Math.round(basePower);
  }

  _basePowerFromRank(rank) {
    const table = { E: 8, D: 16, C: 34, B: 62, A: 105, S: 180 };
    return table[String(rank || 'D').toUpperCase()] || table.D;
  }

  _estimateDefense(defender = {}) {
    return Math.round((defender.stamina || defender.enemy_stamina_max || 100) * 0.08 + (defender.willpower || defender.enemy_spirit || 30) * 0.12);
  }

  getCombatState() {
    return stateManager.get('combat');
  }

  isInCombat() {
    const combat = stateManager.get('combat');
    return combat?.is_active === true;
  }

  getCombatLog() {
    const combat = stateManager.get('combat');
    return combat?.log || [];
  }
}

export const combatSystem = new CombatSystem();
export default combatSystem;
