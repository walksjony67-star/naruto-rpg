import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';

class RelationshipSystem {
  processInstruction(data) {
    if (!data || typeof data !== 'object') {
      console.warn('[RelationshipSystem] Invalid relationship instruction:', typeof data);
      return;
    }
    if (!data.npc) {
      console.warn('[RelationshipSystem] Relationship instruction missing npc:', data);
      return;
    }

    const path = `relationships.${data.npc}`;
    const current = this._normalizeRelationship(stateManager.get(path));

    const affectionChange = data.affection_change ?? data.affection_delta ?? 0;
    const trustChange = data.trust_change ?? data.trust_delta ?? 0;
    const respectChange = data.respect_change ?? data.respect_delta ?? 0;
    if (affectionChange) current.affection = (current.affection || 0) + affectionChange;
    if (trustChange) current.trust = (current.trust || 0) + trustChange;
    if (respectChange) current.respect = (current.respect || 0) + respectChange;
    if (data.reason) {
      current.last_interaction = data.reason;
      current.last_interaction_at = Date.now();
    }
    if (data.info) current.info = data.info;
    if (data.role) current.role = data.role;
    if (data.faction) current.faction = data.faction;
    if (data.status) current.status = data.status;
    if (data.location) current.location = data.location;
    if (data.history) current.history = data.history;
    if (data.inner_thoughts) current.inner_thoughts = data.inner_thoughts;
    if (Array.isArray(data.tags)) current.tags = [...new Set([...(current.tags || []), ...data.tags])].slice(-12);
    if (Array.isArray(data.known_secrets)) current.known_secrets = [...new Set([...(current.known_secrets || []), ...data.known_secrets])].slice(-12);
    if (Array.isArray(data.promises)) current.promises = [...(current.promises || []), ...data.promises].slice(-12);
    if (Array.isArray(data.debts)) current.debts = [...(current.debts || []), ...data.debts].slice(-12);

    current.affection = Math.max(-100, Math.min(100, current.affection || 0));
    current.trust = Math.max(-100, Math.min(100, current.trust || 0));
    current.respect = Math.max(0, Math.min(100, current.respect || 0));

    stateManager.update([{ path, op: 'set', value: current }]);
    eventBus.emit('relationship:changed', { npc: data.npc, relationship: current });
    return current;
  }

  getRelationship(npc) {
    return this._normalizeRelationship(stateManager.get(`relationships.${npc}`));
  }

  getAllRelationships() {
    return stateManager.get('relationships') || {};
  }

  getSortedRelationships() {
    const all = this.getAllRelationships();
    return Object.entries(all)
      .map(([name, data]) => ({ name, ...this._normalizeRelationship(data) }))
      .sort((a, b) => (b.affection || 0) - (a.affection || 0));
  }

  getAffectionLevel(value) {
    if (value >= 80) return '挚友';
    if (value >= 60) return '好友';
    if (value >= 30) return '友好';
    if (value >= 0) return '中立';
    if (value >= -30) return '冷淡';
    if (value >= -60) return '敌意';
    return '仇恨';
  }

  getTrustLevel(value) {
    if (value >= 80) return '完全信任';
    if (value >= 50) return '信任';
    if (value >= 20) return '基本信任';
    if (value >= -20) return '观望';
    if (value >= -50) return '怀疑';
    return '不信任';
  }

  addRelationship(npc, initialData = {}) {
    const data = {
      ...this._normalizeRelationship(initialData),
      first_met: Date.now()
    };
    stateManager.update([
      { path: `relationships.${npc}`, op: 'set', value: data }
    ]);
    return data;
  }

  _normalizeRelationship(value) {
    if (typeof value === 'number') {
      return { affection: value, trust: 0, respect: 0, info: '' };
    }
    if (!value || typeof value !== 'object') {
      return { affection: 0, trust: 0, respect: 0, info: '' };
    }
    return {
      ...value,
      affection: Number(value.affection) || 0,
      trust: Number(value.trust) || 0,
      respect: Number(value.respect) || 0,
      info: value.info || '',
      history: value.history || '',
      inner_thoughts: value.inner_thoughts || '',
      role: value.role || '',
      faction: value.faction || '',
      status: value.status || 'neutral',
      tags: Array.isArray(value.tags) ? value.tags : [],
      known_secrets: Array.isArray(value.known_secrets) ? value.known_secrets : [],
      promises: Array.isArray(value.promises) ? value.promises : [],
      debts: Array.isArray(value.debts) ? value.debts : []
    };
  }
}

export const relationshipSystem = new RelationshipSystem();
export default relationshipSystem;
