import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';

const SLOT_CATEGORY = { weapon: 'weapons', armor: 'armor', accessory1: 'tools', accessory2: 'tools' };

const QUALITY_BONUS = {
  '破烂': { power: 0, defense: 0, attr: 0 },
  '普通': { power: 3, defense: 1, attr: 0 },
  '精良': { power: 8, defense: 3, attr: 1 },
  '优秀': { power: 15, defense: 6, attr: 2 },
  '史诗': { power: 25, defense: 10, attr: 4 },
  '传说': { power: 40, defense: 18, attr: 7 }
};

class EquipmentSystem {
  getEquipped(slot) {
    const equipped = stateManager.get('equipment.equipped') || {};
    return slot ? (equipped[slot] || null) : equipped;
  }

  equip(slot, name, category) {
    const equipped = { ...(stateManager.get('equipment.equipped') || {}) };
    const item = stateManager.get(`equipment.${category}.${name}`);
    if (!item) return false;

    const prev = equipped[slot];
    if (prev) this.unequip(slot);

    const updates = [
      { path: `equipment.equipped.${slot}`, op: 'set', value: { name, category } }
    ];

    if (category === 'consumables') {
      this.removeItem('consumables', name, 1);
    }

    stateManager.update(updates);
    this._applyEquipBonus(name, category, 'add');
    eventBus.emit('equipment:equipped', { slot, name, category });
    return true;
  }

  unequip(slot) {
    const equipped = stateManager.get('equipment.equipped') || {};
    const entry = equipped[slot];
    if (!entry) return false;

    this._applyEquipBonus(entry.name, entry.category, 'remove');
    stateManager.update([
      { path: `equipment.equipped.${slot}`, op: 'set', value: null }
    ]);
    eventBus.emit('equipment:unequipped', { slot, name: entry.name });
    return true;
  }

  useItem(name) {
    const item = stateManager.get(`equipment.consumables.${name}`);
    if (!item || !item.quantity || item.quantity <= 0) return false;

    const effect = this._consumableEffect(name, item);

    const updates = [];
    if (effect.chakra) updates.push({ path: 'attributes.chakra_current', op: 'add', value: effect.chakra });
    if (effect.stamina) updates.push({ path: 'attributes.stamina_current', op: 'add', value: effect.stamina });
    if (effect.spirit) updates.push({ path: 'attributes.spirit_current', op: 'add', value: effect.spirit });
    if (effect.willpower) updates.push({ path: 'attributes.willpower_current', op: 'add', value: effect.willpower });
    if (effect.heal) {
      updates.push({ path: 'attributes.stamina_current', op: 'add', value: effect.heal });
      updates.push({ path: 'attributes.chakra_current', op: 'add', value: Math.floor(effect.heal * 0.5) });
    }

    this.removeItem('consumables', name, 1);
    if (updates.length) stateManager.update(updates);
    eventBus.emit('equipment:used', { name, effect });
    return true;
  }

  _applyEquipBonus(name, category, mode) {
    const item = stateManager.get(`equipment.${category}.${name}`);
    if (!item) return;
    const quality = item.quality || '普通';
    const bonus = QUALITY_BONUS[quality] || QUALITY_BONUS['普通'];
    const sign = mode === 'add' ? 1 : -1;
    const updates = [];

    if (item.stats && typeof item.stats === 'object') {
      for (const [k, v] of Object.entries(item.stats)) {
        if (typeof v === 'number') {
          updates.push({ path: `attributes.${k}`, op: 'add', value: sign * v });
          if (['chakra', 'stamina', 'spirit', 'willpower'].includes(k)) {
            updates.push({ path: `attributes.${k}_current`, op: 'add', value: sign * v });
          }
        }
      }
    } else {
      if (category === 'weapons') {
        updates.push({ path: 'attributes.speed', op: 'add', value: sign * Math.floor(bonus.power * 0.3) });
      }
      if (category === 'armor') {
        updates.push({ path: 'attributes.stamina', op: 'add', value: sign * bonus.defense });
        updates.push({ path: 'attributes.stamina_current', op: 'add', value: sign * bonus.defense });
      }
      if (bonus.attr > 0 && (category === 'tools')) {
        updates.push({ path: 'attributes.luck', op: 'add', value: sign * bonus.attr });
      }
    }

    if (updates.length) stateManager.update(updates);
  }

  _consumableEffect(name, item) {
    const q = item.quality || '普通';
    const tier = { '破烂': 0.5, '普通': 1, '精良': 1.5, '优秀': 2.5 }[q] || 1;
    const base = 20;

    if (/兵粮丸/.test(name)) return { stamina: Math.round(base * tier * 1.5), chakra: Math.round(base * tier * 0.6) };
    if (/军粮丸/.test(name)) return { chakra: Math.round(base * tier * 2), stamina: Math.round(base * tier * 0.3) };
    if (/止血|绷带|药膏|回复|治疗/.test(name)) return { heal: Math.round(25 * tier) };
    if (/解毒|解/.test(name)) return { willpower: Math.round(15 * tier) };
    if (/醒神|精神|专注/.test(name)) return { spirit: Math.round(20 * tier) };
    return { heal: Math.round(15 * tier) };
  }

  getEquipBonusSummary() {
    const equipped = stateManager.get('equipment.equipped') || {};
    const bonuses = {};
    for (const [slot, entry] of Object.entries(equipped)) {
      if (!entry) continue;
      const item = stateManager.get(`equipment.${entry.category}.${entry.name}`);
      if (!item) continue;
      const quality = item.quality || '普通';
      const bonus = QUALITY_BONUS[quality] || QUALITY_BONUS['普通'];
      if (entry.category === 'weapons') bonuses.attack = (bonuses.attack || 0) + bonus.power;
      if (entry.category === 'armor') bonuses.defense = (bonuses.defense || 0) + bonus.defense;
      if (entry.category === 'tools') bonuses.luck = (bonuses.luck || 0) + bonus.attr;
    }
    return bonuses;
  }

  getAllEquipment() {
    return stateManager.get('equipment');
  }

  getTools() {
    return stateManager.get('equipment.tools') || {};
  }

  getConsumables() {
    return stateManager.get('equipment.consumables') || {};
  }

  getWeapons() {
    return stateManager.get('equipment.weapons') || {};
  }

  getArmor() {
    return stateManager.get('equipment.armor') || {};
  }

  getRyo() {
    const ryo = stateManager.get('equipment.ryo');
    if (ryo != null) return Number(ryo) || 0;
    return Number(stateManager.get('equipment.currency.ryo')) || 0;
  }

  addRyo(amount) {
    stateManager.update([
      { path: 'equipment.ryo', op: 'add', value: amount }
    ]);
    return this.getRyo();
  }

  spendRyo(amount) {
    const current = this.getRyo();
    if (!Number.isFinite(amount) || amount <= 0) {
      console.warn('[EquipmentSystem] spendRyo called with invalid amount:', amount);
      return false;
    }
    if (current < amount) {
      console.warn('[EquipmentSystem] spendRyo insufficient funds:', { current, amount });
      return false;
    }
    stateManager.update([
      { path: 'equipment.ryo', op: 'sub', value: amount }
    ]);
    return true;
  }

  addItem(category, name, quantity = 1, quality = '普通') {
    const path = `equipment.${category}.${name}`;
    const existing = stateManager.get(path);
    if (existing) {
      stateManager.update([
        { path: `${path}.quantity`, op: 'add', value: quantity }
      ]);
    } else {
      stateManager.update([
        { path, op: 'set', value: { quantity, quality } }
      ]);
    }
  }

  removeItem(category, name, quantity = 1) {
    const path = `equipment.${category}.${name}`;
    const existing = stateManager.get(path);
    if (!existing) return false;
    const currentQty = Number(existing.quantity) || 0;
    const newQty = currentQty - quantity;
    if (newQty <= 0) {
      stateManager.update([{ path: `equipment.${category}`, op: 'remove', value: name }]);
    } else {
      stateManager.update([
        { path: `${path}.quantity`, op: 'set', value: newQty }
      ]);
    }
    return true;
  }

  useConsumable(name) {
    return this.useItem(name);
  }

  getToolList() {
    const tools = this.getTools();
    return this._itemList(tools);
  }

  getConsumableList() {
    const consumables = this.getConsumables();
    return this._itemList(consumables);
  }

  getEquipmentSummary() {
    const tools = this.getToolList();
    const consumables = this.getConsumableList();
    const weapons = stateManager.get('equipment.weapons') || {};
    const armor = stateManager.get('equipment.armor') || {};
    const equipped = stateManager.get('equipment.equipped') || {};

    return {
      tools,
      consumables,
      weapons: Object.keys(weapons),
      armor: Object.keys(armor),
      equipped,
      bonuses: this.getEquipBonusSummary(),
      ryo: this.getRyo()
    };
  }

  _itemList(items) {
    return Object.entries(items || {})
      .filter(([, info]) => info && typeof info === 'object' && info.quantity != null)
      .map(([name, info]) => ({
        name,
        quantity: Number(info?.quantity) || 0,
        quality: info?.quality || '普通'
      }))
      .filter(item => item.quantity > 0);
  }
}

export const equipmentSystem = new EquipmentSystem();
export default equipmentSystem;
