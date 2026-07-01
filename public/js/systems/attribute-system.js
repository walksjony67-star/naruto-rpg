import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { GAME_DATA } from '../data/game-data.js';

const ATTR_MAP = {
  chakra: '属性·查克拉',
  chakra_current: '属性·当前查克拉',
  spirit: '属性·精神力',
  spirit_current: '属性·当前精神力',
  willpower: '属性·意志力',
  willpower_current: '属性·当前意志力',
  stamina: '属性·体力',
  stamina_current: '属性·当前体力',
  speed: '属性·速度',
  luck: '属性·幸运'
};

class AttributeSystem {
  getAttribute(name) {
    const key = ATTR_MAP[name];
    return key ? stateManager.get(key) : undefined;
  }

  getAttributes() {
    const attrs = {};
    for (const [name, key] of Object.entries(ATTR_MAP)) {
      attrs[name] = stateManager.get(key) || 0;
    }
    return attrs;
  }

  getDerivedStats(attributes = this.getAttributes(), skills = this._getSkillsObject()) {
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

  _getSkillsObject() {
    const state = stateManager.get();
    const result = { jutsu: {}, taijutsu: {}, genjutsu: {}, support: {}, kekkei_genkai: {}, talents: {} };
    const catMap = { '忍术': 'jutsu', '体术': 'taijutsu', '幻术': 'genjutsu', '支援': 'support' };
    for (const key of Object.keys(state)) {
      if (!key.startsWith('技能·')) continue;
      const parts = key.split('·');
      if (parts.length < 4) continue;
      const catChinese = parts[1];
      const catProp = catMap[catChinese];
      if (catProp) {
        const skillName = parts[2];
        const subKey = parts.slice(3).join('·');
        if (!result[catProp][skillName]) result[catProp][skillName] = {};
        result[catProp][skillName][subKey] = state[key];
      } else if (catChinese === '血继限界') {
        const kgName = parts[2];
        const subKey = parts.slice(3).join('·');
        if (!result.kekkei_genkai[kgName]) result.kekkei_genkai[kgName] = {};
        result.kekkei_genkai[kgName][subKey] = state[key];
      } else if (catChinese === '天赋') {
        const talentName = parts[2];
        const subKey = parts.slice(3).join('·');
        if (!result.talents[talentName]) result.talents[talentName] = {};
        result.talents[talentName][subKey] = state[key];
      }
    }
    return result;
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
    const current = stateManager.get('属性·当前查克拉');
    const newVal = Math.max(0, current - amount);
    stateManager.update([{ key: '属性·当前查克拉', op: '=', value: newVal }]);
    if (newVal <= 0) {
      eventBus.emit('attribute:depleted', { attribute: 'chakra' });
    }
    return newVal;
  }

  consumeStamina(amount) {
    const current = stateManager.get('属性·当前体力');
    const newVal = Math.max(0, current - amount);
    stateManager.update([{ key: '属性·当前体力', op: '=', value: newVal }]);
    return newVal;
  }

  restoreChakra(amount) {
    const max = stateManager.get('属性·查克拉');
    const current = stateManager.get('属性·当前查克拉');
    const newVal = Math.min(max, current + amount);
    stateManager.update([{ key: '属性·当前查克拉', op: '=', value: newVal }]);
    return newVal;
  }

  clampResources() {
    const a = this.getAttributes();
    const updates = [];
    const pairs = [
      ['chakra', 'chakra_current'],
      ['spirit', 'spirit_current'],
      ['willpower', 'willpower_current'],
      ['stamina', 'stamina_current']
    ];
    for (const [maxK, curK] of pairs) {
      if (a[curK] > a[maxK]) updates.push({ key: ATTR_MAP[curK], op: '=', value: a[maxK] });
      if (a[curK] < 0) updates.push({ key: ATTR_MAP[curK], op: '=', value: 0 });
    }
    if (updates.length) stateManager.update(updates);
  }

  restoreStamina(amount) {
    const max = stateManager.get('属性·体力');
    const current = stateManager.get('属性·当前体力');
    const newVal = Math.min(max, current + amount);
    stateManager.update([{ key: '属性·当前体力', op: '=', value: newVal }]);
    return newVal;
  }

  addExperience(amount) {
    stateManager.update([{ key: '进度·经验', op: '+', value: amount }]);
    const exp = stateManager.get('进度·经验') || 0;
    const needed = stateManager.get('进度·下一级经验') || 100;
    if (exp >= needed) {
      eventBus.emit('attribute:level-up', { exp, needed });
    }
  }

  getSuggestedExpReward(type = 'training', rank = 'D') {
    const key = type === 'mission' ? String(rank || 'D').toLowerCase() : type;
    const range = GAME_DATA.balance.expReward[key] || GAME_DATA.balance.expReward.training;
    return Math.round((range[0] + range[1]) / 2);
  }

  getRankBenchmark(rank) {
    return GAME_DATA.getRankBenchmark(rank || this.getOfficialRank());
  }

  getExpProgress() {
    const exp = stateManager.get('进度·经验') || 0;
    const needed = stateManager.get('进度·下一级经验') || 100;
    return {
      current: exp,
      needed,
      pct: needed > 0 ? Math.round((exp / needed) * 100) : 0
    };
  }

  getOfficialRank() {
    return stateManager.get('玩家·正式忍阶') || stateManager.get('玩家·忍阶') || '忍校学生';
  }

  getPowerLevel() {
    return stateManager.get('玩家·战力等级') || 'E级';
  }

  evaluatePowerLevel() {
    const attrs = this.getAttributes();
    const chakra = attrs.chakra || 0;
    const spirit = attrs.spirit || 0;
    const willpower = attrs.willpower || 0;
    const vitality = attrs.stamina || 0;
    const speed = attrs.speed || 0;
    const luck = attrs.luck || 0;

    const nin = stateManager.get('进度·忍术熟练度') || 0;
    const tai = stateManager.get('进度·体术熟练度') || 0;
    const gen = stateManager.get('进度·幻术熟练度') || 0;
    const def = stateManager.get('进度·防御熟练度') || 0;

    const coreScore = (chakra * 0.08) + (spirit * 0.08) + (willpower * 0.08) + (vitality * 0.08) + (speed * 0.06) + (luck * 0.02);
    const masteryScore = (nin * 0.15) + (tai * 0.15) + (gen * 0.15) + (def * 0.15);

    const totalScore = coreScore + masteryScore;
    const maxMastery = Math.max(nin, tai, gen);

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
    for (let i = 0; i < benchmarks.length; i++) {
      const b = benchmarks[i];
      if (totalScore >= b.score) {
        if (maxMastery >= b.mastery) {
          newLevel = b.level;
          break;
        } else {
          const prevIndex = i + 1;
          const prevLevel = benchmarks[prevIndex] ? benchmarks[prevIndex].level : 'E级';
          newLevel = prevLevel.replace('级', '级精英');
          break;
        }
      }
    }

    const currentLevel = this.getPowerLevel();
    if (newLevel !== currentLevel && newLevel !== currentLevel.replace('级精英', '级')) {
      stateManager.update([{ key: '玩家·战力等级', op: '=', value: newLevel }]);
      eventBus.emit('attribute:power-level-up', { level: newLevel });
    }
    return newLevel;
  }

  updateRank(rank) {
    stateManager.update([{ key: '玩家·正式忍阶', op: '=', value: rank }]);
    eventBus.emit('attribute:rank-up', { rank });
  }
}

export const attributeSystem = new AttributeSystem();
eventBus.on('pipeline:vars-updated', () => attributeSystem.evaluatePowerLevel());
export default attributeSystem;
