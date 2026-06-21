import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { formatGameTime } from '../utils/format.js';

const MAX_TURN_SUMMARIES = 8;
const KEEP_TURN_SUMMARIES_AFTER_COMPRESSION = 3;
const TURN_SUMMARY_LIMIT = 900;
const ROLLING_SUMMARY_LIMIT = 4000;
const COMPRESSED_SUMMARY_LIMIT = 6000;

class MemorySystem {
  constructor() {
    this._bound = false;
  }

  bindEvents() {
    if (this._bound) return;
    this._bound = true;
    eventBus.on('mission:added', mission => this.recordMissionAdded(mission));
    eventBus.on('mission:progress', mission => this.recordMissionProgress(mission));
    eventBus.on('mission:completed', mission => this.recordMissionCompleted(mission));
    eventBus.on('mission:abandoned', mission => this.recordMissionAbandoned(mission));
    eventBus.on('relationship:changed', data => this.recordRelationshipChange(data));
  }

  apply(update = {}, { source = 'ai', userInput = '', aiResponse = '' } = {}) {
    if (!update || typeof update !== 'object') {
      console.warn('[MemorySystem] apply called with non-object update:', typeof update);
      return stateManager.get('memory') || {};
    }
    const current = stateManager.get('memory') || {};
    const memory = this._cloneMemory(current);

    this._appendUnique(memory.facts, [...(Array.isArray(update.facts) ? update.facts : []), ...(Array.isArray(update.add) ? update.add : [])], 90, source);
    this._appendUnique(memory.long_term, Array.isArray(update.add) ? update.add : [], 60, source);
    this._appendUnique(memory.pins, Array.isArray(update.pins) ? update.pins : [], 8, source);
    this._mergeClues(memory.clues, Array.isArray(update.clues) ? update.clues : [], source);
    this._appendUnique(memory.important_events, [...(Array.isArray(update.events) ? update.events : []), ...(Array.isArray(update.important_events) ? update.important_events : [])], 40, source);

    if (update.summary) memory.recent_summary = String(update.summary).trim().slice(0, TURN_SUMMARY_LIMIT);
    if (userInput || aiResponse || update.summary) {
      this.recordTurnSummary(memory, {
        userInput,
        aiResponse,
        summary: update.summary,
        source,
        tags: update.turn_tags || update.tags || []
      });
    }
    if (!memory.recent_summary && (userInput || aiResponse)) memory.recent_summary = this.buildFallbackSummary(userInput, aiResponse);
    if (update.npc_notes && typeof update.npc_notes === 'object') {
      memory.npc_notes = { ...memory.npc_notes, ...update.npc_notes };
    }

    this._trim(memory);
    memory.meta.updated_at = Date.now();
    memory.meta.sources[source] = (memory.meta.sources[source] || 0) + 1;
    stateManager.update([{ path: 'memory', op: 'set', value: memory }]);
    eventBus.emit('memory:updated', { source, memory });
    return memory;
  }

  rememberRecentTurn(userInput, aiResponse) {
    const current = stateManager.get('memory') || {};
    const memory = this._cloneMemory(current);
    const summary = this.buildFallbackSummary(userInput, aiResponse, { includePrevious: false });
    memory.recent_summary = this._appendRollingSummary(current.recent_summary || '', summary);
    this.recordTurnSummary(memory, { userInput, aiResponse, summary, source: 'local' });
    this._trim(memory);
    memory.meta.updated_at = Date.now();
    memory.meta.sources.local = (memory.meta.sources.local || 0) + 1;
    stateManager.update([{ path: 'memory', op: 'set', value: memory }]);
    return summary;
  }

  buildFallbackSummary(userInput, aiResponse, { includePrevious = true } = {}) {
    const previous = includePrevious ? stateManager.get('memory.recent_summary') || '' : '';
    const clean = String(aiResponse || '').replace(/<[^>]*>[\s\S]*?(?:<\/[^>]+>|$)/g, '').replace(/\s+/g, ' ').slice(0, 520);
    const input = String(userInput || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const turn = [
      `玩家行动: ${input || '本回合未记录明确输入'}`,
      `剧情结果: ${clean || 'AI回复未留下可提取正文'}`,
      '延续要点: 下回合必须承接玩家刚才的选择、现场人物态度、已经暴露或尚未确认的线索，不要把本回合结果重置或遗忘。'
    ].join(' ');
    return [previous, turn].filter(Boolean).join('\n').slice(-ROLLING_SUMMARY_LIMIT);
  }

  recordTurnSummary(memory, { userInput = '', aiResponse = '', summary = '', source = 'local', tags = [] } = {}) {
    const text = String(summary || '').trim() || this.buildFallbackSummary(userInput, aiResponse, { includePrevious: false });
    if (!text) return;
    const turn = Number(stateManager.get('_meta.turn_count'));
    const entry = {
      turn,
      time: this._timeLabel(),
      summary: text.slice(0, TURN_SUMMARY_LIMIT),
      source,
      tags: Array.isArray(tags) ? tags.slice(0, 6) : []
    };
    memory.turn_summaries.push(entry);
    memory.recent_summary = this._appendRollingSummary(memory.compressed_summary || '', memory.turn_summaries.map(item => `#${item.turn} ${item.summary}`).join('\n'));
    if (memory.turn_summaries.length > MAX_TURN_SUMMARIES) this.compressTurnSummaries(memory);
  }

  compressTurnSummaries(memory) {
    const overflow = memory.turn_summaries.slice(0, -KEEP_TURN_SUMMARIES_AFTER_COMPRESSION);
    const keep = memory.turn_summaries.slice(-KEEP_TURN_SUMMARIES_AFTER_COMPRESSION);
    if (!overflow.length) return;
    const block = overflow.map(item => `#${item.turn} ${item.time}: ${item.summary}`).join('\n');
    const previous = memory.compressed_summary ? `${memory.compressed_summary}\n` : '';
    memory.compressed_summary = `${previous}[阶段摘要${(memory.compression_count || 0) + 1}]\n${block}`.slice(-COMPRESSED_SUMMARY_LIMIT);
    memory.turn_summaries = keep;
    memory.compression_count = (memory.compression_count || 0) + 1;
  }

  buildPromptContext(memory = stateManager.get('memory')) {
    if (!memory) return '';
    const parts = [];
    const state = stateManager.get();
    const location = state.world_state?.current_location || '';
    const activeMissionNPCs = (state.missions?.active || []).flatMap(m => {
      const title = m.title || '';
      const pattern = /(?:与|找|救|护送|追踪|协助|保护|会见)([^\s，。,!]{1,6}(?:大人|先生|老师|师傅|婆婆|爷爷|老板|队长))?/g;
      const matches = [...title.matchAll(pattern)].map(m => m[1]).filter(Boolean);
      return matches;
    });
    const relationshipNPCs = Object.keys(state.relationships || {});
    const sceneNPCs = [...new Set([...activeMissionNPCs, ...relationshipNPCs])];

    if (memory.pins?.length) parts.push(`## 置顶提醒\n${memory.pins.slice(-5).map(item => `- ${this._memoryText(item)}`).join('\n')}`);
    if (memory.compressed_summary) parts.push(`## 阶段压缩摘要\n${memory.compressed_summary}`);
    if (memory.turn_summaries?.length) {
      parts.push(`## 最近回合小结\n${memory.turn_summaries.slice(-6).map(item => `- #${item.turn} ${item.summary}`).join('\n')}`);
    }
    if (memory.recent_summary) parts.push(`## 最近剧情摘要\n${memory.recent_summary}`);
    if (memory.facts?.length) parts.push(`## 近期事实\n${memory.facts.slice(-16).map(item => `- ${this._memoryText(item)}`).join('\n')}`);
    else if (memory.long_term?.length) parts.push(`## 长期记忆\n${memory.long_term.slice(-12).map(item => `- ${this._memoryText(item)}`).join('\n')}`);

    if (memory.archived_facts?.length) {
      const relevantArchived = memory.archived_facts.filter(fact => {
        const text = this._memoryText(fact);
        if (!text) return false;
        if (location && text.includes(location)) return true;
        for (const npc of sceneNPCs) {
          if (npc && text.includes(npc)) return true;
        }
        return false;
      });
      if (relevantArchived.length) {
        parts.push(`## 归档记忆(场景相关)\n${relevantArchived.slice(-8).map(item => `- ${this._memoryText(item)}`).join('\n')}`);
      }
    }

    if (memory.clues?.length) parts.push(`## 未解线索\n${memory.clues.slice(-10).map(item => `- ${this.formatClue(item)}`).join('\n')}`);
    if (memory.important_events?.length) parts.push(`## 重要事件\n${memory.important_events.slice(-8).map(item => `- ${this._memoryText(item)}`).join('\n')}`);
    if (memory.npc_notes && Object.keys(memory.npc_notes).length) {
      parts.push(`## NPC记忆\n${Object.entries(memory.npc_notes).slice(-8).map(([name, note]) => `- ${name}: ${note}`).join('\n')}`);
    }
    return parts.length ? `[动态记忆 - 优先级高于世界书]\n${parts.join('\n\n')}` : '';
  }

  recordMissionAdded(mission = {}) {
    if (!mission.title) return;
    this.apply({
      pins: [`当前任务: [${mission.rank || 'D'}级] ${mission.title}`],
      facts: [`接取任务「${mission.title}」${mission.location ? `，地点: ${mission.location}` : ''}`],
      clues: mission.clues || []
    }, { source: 'mission' });
  }

  recordMissionProgress(mission = {}) {
    const note = mission.progress?.note;
    this.apply({
      pins: mission.title ? [`推进任务: ${mission.title}${note ? ` - ${note}` : ''}`] : [],
      facts: note && mission.title ? [`任务「${mission.title}」进展: ${note}`] : [],
      clues: mission.clues || []
    }, { source: 'mission' });
  }

  recordMissionCompleted(mission = {}) {
    if (!mission.title) return;
    this.apply({
      facts: [`完成任务「${mission.title}」，评价: ${mission.rating || '未评级'}`],
      events: [`${this._timeLabel()} 完成任务「${mission.title}」`],
      pins: []
    }, { source: 'mission' });
  }

  recordMissionAbandoned(mission = {}) {
    if (!mission.title) return;
    this.apply({
      facts: [`放弃任务「${mission.title}」`],
      events: [`${this._timeLabel()} 放弃任务「${mission.title}」`]
    }, { source: 'mission' });
  }

  recordRelationshipChange({ npc, relationship } = {}) {
    if (!npc || !relationship) return;
    const note = relationship.last_interaction || `${npc}当前好感${relationship.affection || 0}，信任${relationship.trust || 0}`;
    this.apply({
      npc_notes: { [npc]: note },
      facts: Math.abs(Number(relationship.affection) || 0) >= 60 ? [`${npc}与玩家关系显著: ${note}`] : []
    }, { source: 'relationship' });
  }

  formatClue(clue) {
    if (typeof clue === 'string') return clue;
    return `${clue.title || '线索'}${clue.status ? `(${clue.status})` : ''}: ${clue.detail || ''}`;
  }

  _cloneMemory(current) {
    return {
      pins: Array.isArray(current.pins) ? [...current.pins] : [],
      facts: Array.isArray(current.facts) ? [...current.facts] : [],
      clues: Array.isArray(current.clues) ? [...current.clues] : [],
      long_term: Array.isArray(current.long_term) ? [...current.long_term] : [],
      recent_summary: current.recent_summary || '',
      turn_summaries: Array.isArray(current.turn_summaries) ? [...current.turn_summaries] : [],
      compressed_summary: current.compressed_summary || '',
      compression_count: Number(current.compression_count) || 0,
      important_events: Array.isArray(current.important_events) ? [...current.important_events] : [],
      npc_notes: { ...(current.npc_notes || {}) },
      archived_facts: Array.isArray(current.archived_facts) ? [...current.archived_facts] : [],
      meta: { updated_at: current.meta?.updated_at || null, sources: { ...(current.meta?.sources || {}) } }
    };
  }

  _appendUnique(target, values, limit, source) {
    if (!Array.isArray(values)) return;
    for (const item of values) {
      const text = this._memoryText(item).trim();
      if (text && !target.some(existing => this._memoryText(existing) === text)) target.push(text.slice(0, 180));
    }
    if (target.length > limit) target.splice(0, target.length - limit);
  }

  _mergeClues(target, clues, source) {
    if (!Array.isArray(clues)) return;
    for (const clue of clues) {
      const item = typeof clue === 'string'
        ? { title: clue.slice(0, 40), detail: clue.slice(0, 180), status: '未解', source }
        : {
            title: String(clue?.title || clue?.id || '未命名线索').slice(0, 40),
            detail: String(clue?.detail || clue?.description || '').slice(0, 180),
            status: String(clue?.status || '未解').slice(0, 20),
            source: clue?.source || source
          };
      const existing = target.find(c => c.title === item.title);
      if (existing) Object.assign(existing, item);
      else target.push(item);
    }
  }

  _trim(memory) {
    const archiveOlder = (arr, limit) => {
      if (arr.length <= limit) return;
      const overflow = arr.splice(0, arr.length - limit);
      if (!memory.archived_facts) memory.archived_facts = [];
      for (const item of overflow) {
        if (!memory.archived_facts.some(f => f === item)) {
          memory.archived_facts.push(item);
        }
      }
      if (memory.archived_facts.length > 600) memory.archived_facts = memory.archived_facts.slice(-600);
    };
    archiveOlder(memory.facts, 90);
    archiveOlder(memory.long_term, 60);
    memory.pins = memory.pins.slice(-8);
    memory.clues = memory.clues.slice(-40);
    memory.turn_summaries = memory.turn_summaries.slice(-MAX_TURN_SUMMARIES);
    memory.important_events = memory.important_events.slice(-30);
  }

  _appendRollingSummary(prefix, text) {
    return [prefix, text].filter(Boolean).join('\n').slice(-ROLLING_SUMMARY_LIMIT);
  }

  _memoryText(item) {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') return item.text || item.detail || item.title || JSON.stringify(item);
    return String(item);
  }

  _timeLabel() {
    return formatGameTime(stateManager.get('world_state.calendar'));
  }
}

export const memorySystem = new MemorySystem();
export default memorySystem;
