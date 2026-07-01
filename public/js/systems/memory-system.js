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
      return stateManager.getSub('_memory') || {};
    }
    const memory = this._loadMemory();

    this._appendLines(memory, 'facts', Array.isArray(update.facts) ? update.facts : [], 90);
    this._appendLines(memory, 'long_term', Array.isArray(update.add) ? update.add : [], 60);
    this._appendLines(memory, 'pins', Array.isArray(update.pins) ? update.pins : [], 8);
    this._appendClues(memory, Array.isArray(update.clues) ? update.clues : []);
    this._appendLines(memory, 'important_events', [...(Array.isArray(update.events) ? update.events : []), ...(Array.isArray(update.important_events) ? update.important_events : [])], 40);

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
      const existing = this._linesToObj(memory.npc_notes);
      Object.assign(existing, update.npc_notes);
      memory.npc_notes = Object.entries(existing).map(([k, v]) => `${k}: ${v}`).join('\n');
    }

    this._trim(memory);
    memory.meta = memory.meta || { updated_at: null, sources: {} };
    memory.meta.updated_at = Date.now();
    memory.meta.sources[source] = (memory.meta.sources[source] || 0) + 1;
    this._saveMemory(memory);
    eventBus.emit('memory:updated', { source, memory });
    return memory;
  }

  rememberRecentTurn(userInput, aiResponse) {
    const memory = this._loadMemory();
    const summary = this.buildFallbackSummary(userInput, aiResponse, { includePrevious: false });
    memory.recent_summary = this._appendRollingSummary(memory.recent_summary || '', summary);
    this.recordTurnSummary(memory, { userInput, aiResponse, summary, source: 'local' });
    this._trim(memory);
    memory.meta = memory.meta || { updated_at: null, sources: {} };
    memory.meta.updated_at = Date.now();
    memory.meta.sources.local = (memory.meta.sources.local || 0) + 1;
    this._saveMemory(memory);
    return summary;
  }

  buildFallbackSummary(userInput, aiResponse, { includePrevious = true } = {}) {
    const memory = stateManager.getSub('_memory') || {};
    const previous = includePrevious ? (memory.recent_summary || '') : '';
    // B-26: 先限定长度再解释正则，避免灾难回溯
    const safeAi = String(aiResponse || '').slice(0, 4000);
    const clean = safeAi.replace(/<[^>]*>[\s\S]*?(?:<\/[^>]+>|$)/g, '').replace(/\s+/g, ' ').slice(0, 520);
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
    const turn = Number(stateManager.get('系统·回合数'));
    const entry = {
      turn,
      time: this._timeLabel(),
      summary: text.slice(0, TURN_SUMMARY_LIMIT),
      source,
      tags: Array.isArray(tags) ? tags.slice(0, 6) : []
    };

    const summaries = memory.turn_summaries ? memory.turn_summaries.split('\n').filter(Boolean) : [];
    summaries.push(`#${entry.turn} ${entry.summary}`);
    memory.turn_summaries = summaries.join('\n');

    const allSummaries = memory.turn_summaries || '';
    memory.recent_summary = this._appendRollingSummary(memory.compressed_summary || '', allSummaries);
    if (summaries.length > MAX_TURN_SUMMARIES) this.compressTurnSummaries(memory);
  }

  compressTurnSummaries(memory) {
    const lines = memory.turn_summaries ? memory.turn_summaries.split('\n').filter(Boolean) : [];
    const overflow = lines.slice(0, -KEEP_TURN_SUMMARIES_AFTER_COMPRESSION);
    const keep = lines.slice(-KEEP_TURN_SUMMARIES_AFTER_COMPRESSION);
    if (!overflow.length) return;
    const block = overflow.join('\n');
    const previous = memory.compressed_summary ? `${memory.compressed_summary}\n` : '';
    memory.compressed_summary = `${previous}[阶段摘要${(memory.compression_count || 0) + 1}]\n${block}`.slice(-COMPRESSED_SUMMARY_LIMIT);
    memory.turn_summaries = keep.join('\n');
    memory.compression_count = (memory.compression_count || 0) + 1;
  }

  buildPromptContext(memory) {
    if (!memory) memory = stateManager.getSub('_memory');
    if (!memory) return '';
    const parts = [];
    const state = stateManager.get();
    const location = state['世界·地点'] || '';
    const missions = state._missions || {};
    const activeMissions = Object.values(missions.active || {});
    const activeMissionNPCs = activeMissions.flatMap(m => {
      const title = m.title || '';
      const pattern = /(?:与|找|救|护送|追踪|协助|保护|会见)([^\s，。,!]{1,6}(?:大人|先生|老师|师傅|婆婆|爷爷|老板|队长))?/g;
      const matches = [...title.matchAll(pattern)].map(m => m[1]).filter(Boolean);
      return matches;
    });
    const relationships = state._relationships || {};
    const relationshipNPCs = Object.keys(relationships);
    const sceneNPCs = [...new Set([...activeMissionNPCs, ...relationshipNPCs])];

    const pinsLines = memory.pins ? memory.pins.split('\n').filter(Boolean) : [];
    if (pinsLines.length) parts.push(`## 置顶提醒\n${pinsLines.slice(-5).map(item => `- ${item}`).join('\n')}`);
    if (memory.compressed_summary) parts.push(`## 阶段压缩摘要\n${memory.compressed_summary}`);
    const turnLines = memory.turn_summaries ? memory.turn_summaries.split('\n').filter(Boolean) : [];
    if (turnLines.length) {
      parts.push(`## 最近回合小结\n${turnLines.slice(-6).map(item => `- ${item}`).join('\n')}`);
    }
    if (memory.recent_summary) parts.push(`## 最近剧情摘要\n${memory.recent_summary}`);

    const factsLines = memory.facts ? memory.facts.split('\n').filter(Boolean) : [];
    if (factsLines.length) parts.push(`## 近期事实\n${factsLines.slice(-16).map(item => `- ${item}`).join('\n')}`);
    else {
      const ltLines = memory.long_term ? memory.long_term.split('\n').filter(Boolean) : [];
      if (ltLines.length) parts.push(`## 长期记忆\n${ltLines.slice(-12).map(item => `- ${item}`).join('\n')}`);
    }

    const archivedLines = memory.archived ? memory.archived.split('\n').filter(Boolean) : [];
    if (archivedLines.length) {
      const relevantArchived = archivedLines.filter(fact => {
        if (!fact) return false;
        if (location && fact.includes(location)) return true;
        for (const npc of sceneNPCs) {
          if (npc && fact.includes(npc)) return true;
        }
        return false;
      });
      if (relevantArchived.length) {
        parts.push(`## 归档记忆(场景相关)\n${relevantArchived.slice(-8).map(item => `- ${item}`).join('\n')}`);
      }
    }

    const cluesLines = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
    if (cluesLines.length) parts.push(`## 未解线索\n${cluesLines.slice(-10).map(item => `- ${this.formatClueLine(item)}`).join('\n')}`);
    const impLines = memory.important_events ? memory.important_events.split('\n').filter(Boolean) : [];
    if (impLines.length) parts.push(`## 重要事件\n${impLines.slice(-8).map(item => `- ${item}`).join('\n')}`);

    const npcNotes = this._linesToObj(memory.npc_notes);
    const npcKeys = Object.keys(npcNotes);
    if (npcKeys.length) {
      parts.push(`## NPC记忆\n${npcKeys.slice(-8).map(name => `- ${name}: ${npcNotes[name]}`).join('\n')}`);
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

  formatClueLine(line) {
    try {
      const clue = JSON.parse(line);
      return this.formatClue(clue);
    } catch {
      return line;
    }
  }

  _loadMemory() {
    const raw = stateManager.getSub('_memory');
    if (!raw) return this._emptyMemory();
    return {
      pins: raw.pins || '',
      facts: raw.facts || '',
      clues: raw.clues || '',
      long_term: raw.long_term || '',
      archived: raw.archived || '',
      recent_summary: raw.recent_summary || '',
      turn_summaries: raw.turn_summaries || '',
      compressed_summary: raw.compressed_summary || '',
      compression_count: Number(raw.compression_count) || 0,
      important_events: raw.important_events || '',
      npc_notes: raw.npc_notes || '',
      meta: { updated_at: raw.meta?.updated_at || null, sources: { ...(raw.meta?.sources || {}) } }
    };
  }

  _emptyMemory() {
    return {
      pins: '', facts: '', clues: '', long_term: '', archived: '',
      recent_summary: '', turn_summaries: '', compressed_summary: '',
      compression_count: 0, important_events: '', npc_notes: '',
      meta: { updated_at: null, sources: {} }
    };
  }

  _saveMemory(memory) {
    stateManager.setSub('_memory', {
      pins: memory.pins || '',
      facts: memory.facts || '',
      clues: memory.clues || '',
      long_term: memory.long_term || '',
      archived: memory.archived || '',
      recent_summary: memory.recent_summary || '',
      turn_summaries: memory.turn_summaries || '',
      compressed_summary: memory.compressed_summary || '',
      compression_count: memory.compression_count || 0,
      important_events: memory.important_events || '',
      npc_notes: memory.npc_notes || '',
      meta: memory.meta || { updated_at: null, sources: {} }
    });
  }

  _linesToObj(str) {
    if (!str) return {};
    const obj = {};
    for (const line of str.split('\n').filter(Boolean)) {
      const idx = line.indexOf(': ');
      if (idx > 0) obj[line.slice(0, idx)] = line.slice(idx + 2);
    }
    return obj;
  }

  _appendLines(memory, field, values, limit) {
    if (!Array.isArray(values)) return;
    const existing = memory[field] ? memory[field].split('\n').filter(Boolean) : [];
    for (const item of values) {
      const text = this._memoryText(item).trim();
      if (text && !existing.includes(text)) existing.push(text.slice(0, 180));
    }
    if (existing.length > limit) existing.splice(0, existing.length - limit);
    memory[field] = existing.join('\n');
  }

  _appendClues(memory, clues) {
    if (!Array.isArray(clues) || !clues.length) return;
    let existing = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
    const existingClueMap = new Map();
    for (const line of existing) {
      try {
        const c = JSON.parse(line);
        existingClueMap.set(c.title || line, line);
      } catch {
        existingClueMap.set(line, line);
      }
    }
    for (const clue of clues) {
      const item = typeof clue === 'string'
        ? { title: clue.slice(0, 40), detail: clue.slice(0, 180), status: '未解', source: 'ai' }
        : {
            title: String(clue?.title || clue?.id || '未命名线索').slice(0, 40),
            detail: String(clue?.detail || clue?.description || '').slice(0, 180),
            status: String(clue?.status || '未解').slice(0, 20),
            source: clue?.source || 'ai'
          };
      const key = item.title;
      if (!existingClueMap.has(key)) {
        existingClueMap.set(key, JSON.stringify(item));
      }
    }
    existing = [...existingClueMap.values()].slice(-40);
    memory.clues = existing.join('\n');
  }

  _trim(memory) {
    const archiveOlder = (field, limit) => {
      const lines = memory[field] ? memory[field].split('\n').filter(Boolean) : [];
      if (lines.length <= limit) return;
      const overflow = lines.splice(0, lines.length - limit);
      const archived = memory.archived ? memory.archived.split('\n').filter(Boolean) : [];
      for (const item of overflow) {
        if (!archived.includes(item)) archived.push(item);
      }
      memory[field] = lines.join('\n');
      memory.archived = archived.slice(-600).join('\n');
    };
    archiveOlder('facts', 90);
    archiveOlder('long_term', 60);
    const pinsLines = memory.pins ? memory.pins.split('\n').filter(Boolean) : [];
    memory.pins = pinsLines.slice(-8).join('\n');
    const cluesLines = memory.clues ? memory.clues.split('\n').filter(Boolean) : [];
    memory.clues = cluesLines.slice(-40).join('\n');
    const tsLines = memory.turn_summaries ? memory.turn_summaries.split('\n').filter(Boolean) : [];
    memory.turn_summaries = tsLines.slice(-MAX_TURN_SUMMARIES).join('\n');
    const ieLines = memory.important_events ? memory.important_events.split('\n').filter(Boolean) : [];
    memory.important_events = ieLines.slice(-30).join('\n');
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
    return formatGameTime(stateManager.get('世界·时间'));
  }
}

export const memorySystem = new MemorySystem();
export default memorySystem;
