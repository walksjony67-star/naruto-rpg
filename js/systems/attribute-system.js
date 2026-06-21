import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { GAME_DATA } from '../data/game-data.js';

class AttributeSystem {
  getAttribute(name) {
    return stateManager.get(`attributes.${name}`);
  }

  getAttributes() {
    return stateManager.get('attributes');
  }

  getDerivedStats(attributes = this.getAttributes(), skills = stateManager.get('skills') || {}) {
    const best = (group) => Math.max(0, ...Object.values(group || {}).map(item => Number(item?.mastery) || 0));
    const bestJutsu = best(skills.jutsu);
    const bestTaijutsu = best(skills.taijutsu);
    const bestGenjutsu = best(skills.genjutsu);
    return {
      ninjutsu_power: Math.round((attributes.chakra || 0) * 0.45 + (attributes.spirit || 0) * 0.25 + bestJutsu * 0.7),
      taijutsu_power: Math.round((attributes.stamina || 0) * 0.25 + (attributes.speed || 0) * 0.9 + (attributes.willpower || 0) * 0.2 + bestTaijutsu * 0.9),
      genjutsu_power: Math.round((attributes.spirit || 0) * 0.75 + (attributes.chakra || 0) * 0.2 + bestGenjutsu * 0.9),
      defense: Math.round((attributes.stamina || 0) * 0.18 + (attributes.willpower || 0) * 0.25),
      evasion: Math.round((attributes.speed || 0) * 0.6 + (attributes.luck || 0) * 0.8),
      chakra_control: Math.round((attributes.spirit || 0) * 0.5 + (attributes.chakra || 0) * 0.15 + bestJutsu * 0.35),
      initiative: Math.round((attributes.speed || 0) * 0.8 + (attributes.spirit || 0) * 0.15 + (attributes.luck || 0) * 0.5)
    };
  }

  getChakraPct() {
    const a = this.getAttributes();
    return a.chakra > 0 ? Math.round((a.chakra_current / a.chakra) * 100) : 0;
  }

  getSpiritPct() {
    const a = this.getAttributes();
    return a.spirit > 0 ? Math.round((a.spirit_current / a.spirit) * 100) : 0;
  }

  getWillpowerPct() {
    const a = this.getAttributes();
    return a.willpower > 0 ? Math.round((a.willpower_current / a.willpower) * 100) : 0;
  }

  getStaminaPct() {
    const a = this.getAttributes();
    return a.stamina > 0 ? Math.round((a.stamina_current / a.stamina) * 100) : 0;
  }

  consumeChakra(amount) {
    const current = stateManager.get('attributes.chakra_current');
    const newVal = Math.max(0, current - amount);
    stateManager.update([{ path: 'attributes.chakra_current', op: 'set', value: newVal }]);
    if (newVal <= 0) {
      eventBus.emit('attribute:depleted', { attribute: 'chakra' });
    }
    return newVal;
  }

  consumeStamina(amount) {
    const current = stateManager.get('attributes.stamina_current');
    const newVal = Math.max(0, current - amount);
    stateManager.update([{ path: 'attributes.stamina_current', op: 'set', value: newVal }]);
    return newVal;
  }

  restoreChakra(amount) {
    const max = stateManager.get('attributes.chakra');
    const current = stateManager.get('attributes.chakra_current');
    const newVal = Math.min(max, current + amount);
    stateManager.update([{ path: 'attributes.chakra_current', op: 'set', value: newVal }]);
    return newVal;
  }

  clampResources() {
    const a = this.getAttributes();
    const updates = [];
    for (const key of ['chakra', 'spirit', 'willpower', 'stamina']) {
      const currentKey = `${key}_current`;
      if (a[currentKey] > a[key]) updates.push({ path: `attributes.${currentKey}`, op: 'set', value: a[key] });
      if (a[currentKey] < 0) updates.push({ path: `attributes.${currentKey}`, op: 'set', value: 0 });
    }
    if (updates.length) stateManager.update(updates);
  }

  restoreStamina(amount) {
    const max = stateManager.get('attributes.stamina');
    const current = stateManager.get('attributes.stamina_current');
    const newVal = Math.min(max, current + amount);
    stateManager.update([{ path: 'attributes.stamina_current', op: 'set', value: newVal }]);
    return newVal;
  }

  addExperience(amount) {
    stateManager.update([{ path: 'progression.exp', op: 'add', value: amount }]);
    const state = stateManager.get('progression');
    if (state.exp >= state.exp_to_next) {
      eventBus.emit('attribute:level-up', { exp: state.exp, needed: state.exp_to_next });
    }
  }

  getSuggestedExpReward(type = 'training', rank = 'D') {
    const key = type === 'mission' ? String(rank || 'D').toLowerCase() : type;
    const range = GAME_DATA.balance.expReward[key] || GAME_DATA.balance.expReward.training;
    return Math.round((range[0] + range[1]) / 2);
  }

  getRankBenchmark(rank) {
    return GAME_DATA.getRankBenchmark(rank || this.getRank());
  }

  getExpProgress() {
    const state = stateManager.get('progression');
    return {
      current: state.exp,
      needed: state.exp_to_next,
      pct: state.exp_to_next > 0 ? Math.round((state.exp / state.exp_to_next) * 100) : 0
    };
  }

  getOfficialRank() {
    return stateManager.get('player.official_rank') || stateManager.get('player.rank') || '忍校学生';
  }

  getPowerLevel() {
    return stateManager.get('player.power_level') || 'E级';
  }

  evaluatePowerLevel() {
    const attrs = stateManager.get('attributes') || {};
    const prog = stateManager.get('progression') || {};
    
    // Core Potential (40% weight total)
    const chakra = attrs.chakra || 0;
    const spirit = attrs.spirit || attrs.spirit_current || 0;
    const willpower = attrs.willpower || attrs.willpower_current || 0;
    const vitality = attrs.stamina || 0;
    const speed = attrs.speed || 0;
    const luck = attrs.luck || 0;
    
    // Combat Mastery (60% weight total)
    const nin = prog.jutsu_mastery || 0;
    const tai = prog.taijutsu_mastery || 0;
    const gen = prog.genjutsu_mastery || 0;
    const def = prog.defense_mastery || 0;

    // Weights: Core (Chakra 8%, Spirit 8%, Will 8%, Vitality 8%, Speed 6%, Luck 2%)
    const coreScore = (chakra*0.08) + (spirit*0.08) + (willpower*0.08) + (vitality*0.08) + (speed*0.06) + (luck*0.02);
    // Mastery: Sum of highest 3 * 0.15, plus lowest * 0.05 (simplified: average * 0.6)
    // Actually, user wants a straightforward weighted score:
    const masteryScore = (nin*0.15) + (tai*0.15) + (gen*0.15) + (def*0.15); 
    
    const totalScore = coreScore + masteryScore;
    const maxMastery = Math.max(nin, tai, gen); // At least one main mastery must meet the standard

    // Thresholds
    const benchmarks = [
      { level: '超S级', score: 350, mastery: 95 },
      { level: 'S级', score: 250, mastery: 85 },
      { level: 'A级', score: 180, mastery: 75 },
      { level: 'B级', score: 120, mastery: 60 },
      { level: 'C级', score: 70, mastery: 40 },
      { level: 'D级', score: 30, mastery: 20 },
      { level: 'E级', score: 0, mastery: 0 }
    ];

    let newLevel = 'E级';
    for (const b of benchmarks) {
      if (totalScore >= b.score) {
        if (maxMastery >= b.mastery) {
          newLevel = b.level;
          break;
        } else {
          // Score met but mastery lacking -> "Elite" of the previous tier
          // E.g., Score is A-rank, but mastery is only B-rank -> B级精英
          const prevIndex = benchmarks.indexOf(b) + 1;
          const prevLevel = benchmarks[prevIndex] ? benchmarks[prevIndex].level : 'E级';
          newLevel = prevLevel.replace('级', '级精英');
          break;
        }
      }
    }

    const currentLevel = this.getPowerLevel();
    if (newLevel !== currentLevel && newLevel !== currentLevel.replace('级精英', '级')) {
      stateManager.update([{ path: 'player.power_level', op: 'set', value: newLevel }]);
      // Also sync to player.rank for backward compatibility with HUD until fully replaced
      stateManager.update([{ path: 'player.rank', op: 'set', value: newLevel }]); 
      eventBus.emit('attribute:power-level-up', { level: newLevel });
    }
    return newLevel;
  }

  updateRank(rank) {
    stateManager.update([{ path: 'player.official_rank', op: 'set', value: rank }]);
    eventBus.emit('attribute:rank-up', { rank });
  }
}

export const attributeSystem = new AttributeSystem();
// Bind evaluation to variable updates
eventBus.on('pipeline:vars-updated', () => attributeSystem.evaluatePowerLevel());
export default attributeSystem;
