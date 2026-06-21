import { stateManager } from './state-manager.js';
import { eventBus } from './event-bus.js';
import { AgentRunner, AgentAbortError } from './agent-runner.js';
import { AGENT_TIMEOUTS } from './agent-manifests.js';
import { getAgentConfig } from '../data/agent-config.js';
import { formatGameTime } from '../utils/format.js';

class AgentPipeline {
  constructor({ pipeline, memorySystem }) {
    this.pipeline = pipeline;
    this.memorySystem = memorySystem;
    this.runner = new AgentRunner();
    this._aborted = false;
    this._totalTimer = null;
  }

  static isEnabled() {
    return getAgentConfig().enabled === true;
  }

  static getMode() {
    return getAgentConfig().mode || 'standard';
  }

  abort() {
    this._aborted = true;
    this.runner.abort();
    if (this._totalTimer) { clearTimeout(this._totalTimer); this._totalTimer = null; }
  }

  async execute(state, userInput, onProgress = () => {}) {
    this._aborted = false;
    this.runner.configure();

    const mode = AgentPipeline.getMode();
    const isCombat = !!state.combat?.is_active;
    const agentCfg = getAgentConfig();
    const isFullMode = mode === 'full' || (agentCfg.autoUpgrade && isCombat);

    const totalTimeout = AGENT_TIMEOUTS.pipeline_total || 240000;
    const totalPromise = new Promise((_, reject) => {
      this._totalTimer = setTimeout(() => reject(new Error('Agent pipeline total timeout')), totalTimeout);
    });

    try {
      const result = await Promise.race([
        this._run(state, userInput, onProgress, isFullMode, isCombat),
        totalPromise
      ]);
      return result;
    } catch (err) {
      if (err instanceof AgentAbortError) throw err;
      console.warn('[AgentPipeline] Pipeline failed, falling back:', err.message);
      eventBus.emit('agent:fallback', { reason: err.message });
      onProgress('fallback', `降级为标准生成: ${err.message}`);
      return null;
    } finally {
      if (this._totalTimer) { clearTimeout(this._totalTimer); this._totalTimer = null; }
    }
  }

  async _run(state, userInput, onProgress, isFullMode, isCombat) {
    // ── Stage 1: 状态快照 ──
    onProgress('state_snap', '生成状态快照...');
    const stateMd = this._buildStateMd(state);
    this._checkAbort();

    // ── Stage 2: 头脑风暴（完整模式 + 非战斗） ──
    let selectedDirection = null;
    if (isFullMode && !isCombat) {
      onProgress('brainstorm', '头脑风暴中...');
      try {
        selectedDirection = await this._brainstorm(state, userInput, stateMd);
      } catch (err) {
        console.warn('[AgentPipeline] Brainstorm failed, skipping:', err.message);
        eventBus.emit('agent:stage-skip', { stage: 'brainstorm', reason: err.message });
      }
      this._checkAbort();
    }

    // ── Stage 3: 大纲生成 ──
    onProgress('outline', '构建叙事大纲...');
    const outline = await this._generateOutline(state, userInput, stateMd, selectedDirection);
    this._checkAbort();
    eventBus.emit('agent:outline', { outline });

    // ── Stage 4: 大纲审查（并行） ──
    onProgress('review_outline', '审查大纲合理性...');
    const outlineReviews = await this._reviewOutline(state, outline);
    const reviewedOutline = this._mergeOutlineReviews(outline, outlineReviews);
    this._checkAbort();

    // ── Stage 5: 角色代理（完整模式，并行） ──
    let characterInputs = [];
    if (isFullMode) {
      const involvedNPCs = this._extractInvolvedNPCs(outline, state);
      if (involvedNPCs.length > 0) {
        onProgress('character_agents', `角色代理运行中 (${involvedNPCs.length})...`);
        try {
          characterInputs = await this._runCharacterAgents(state, userInput, stateMd, involvedNPCs, reviewedOutline);
        } catch (err) {
          console.warn('[AgentPipeline] Character agents failed, skipping:', err.message);
          eventBus.emit('agent:stage-skip', { stage: 'character_agents', reason: err.message });
        }
        this._checkAbort();
      }
    }

    // ── Stage 6: 正文写作 ──
    onProgress('writing', '正文写作中...');
    const draft = await this._writeDraft(state, userInput, reviewedOutline, outlineReviews, characterInputs);
    this._checkAbort();
    eventBus.emit('agent:draft', { draft: typeof draft === 'string' ? draft.slice(0, 200) : '' });

    // ── Stage 7: 细节 + 风格审查（并行） ──
    onProgress('review_draft', '审查正文质量...');
    let draftReviews;
    try {
      draftReviews = await this._reviewDraft(state, draft, isFullMode);
    } catch (err) {
      console.warn('[AgentPipeline] Draft review failed, skipping:', err.message);
      draftReviews = new Map();
    }
    this._checkAbort();

    // ── Stage 8: 最终润色 ──
    let finalText = draft;
    if (this._hasSignificantSuggestions(draftReviews)) {
      onProgress('polish', '最终润色中...');
      try {
        finalText = await this._polishDraft(state, userInput, draft, draftReviews);
      } catch (err) {
        console.warn('[AgentPipeline] Polish failed, using raw draft:', err.message);
      }
    }
    this._checkAbort();

    // ── Stage 9: 归档 ──
    onProgress('archive', '归档记忆...');
    if (isFullMode && characterInputs.length > 0) {
      this._archiveCharacterMemories(state, characterInputs);
    }

    onProgress('done', '生成完成');
    return finalText;
  }

  // ── Stage Implementations ──

  async _brainstorm(state, userInput, stateMd) {
    const result = await this.runner.run('brainstormer', {
      state,
      userInput,
      taskPrompt: `当前场景摘要:\n${stateMd}\n\n请根据玩家输入提出 3-5 条剧情走向候选。`,
      options: { temperature: 0.9, max_tokens: 1024 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'brainstormer', chunk })
    });

    if (!result?.candidates?.length) return null;

    const rec = result.recommended || 1;
    const selected = result.candidates.find(c => c.id === rec) || result.candidates[0];
    eventBus.emit('agent:brainstorm', { candidates: result.candidates, selected });
    return selected;
  }

  async _generateOutline(state, userInput, stateMd, direction) {
    const hint = direction
      ? `\n\n[选定的剧情走向] ${direction.direction}\n理由: ${direction.reason}`
      : '';

    const result = await this.runner.run('outliner', {
      state,
      userInput,
      taskPrompt: `${stateMd}${hint}\n\n请为本回合生成叙事大纲。`,
      extraContext: { _pipeline: this.pipeline },
      options: { temperature: 0.7, max_tokens: 2048 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'outliner', chunk })
    });

    if (!result?.beats?.length) throw new Error('Outliner 未能生成有效大纲');
    return result;
  }

  async _reviewOutline(state, outline) {
    const results = await this.runner.runParallel([
      {
        type: 'critic-realism',
        key: 'critic-realism',
        params: {
          state,
          taskPrompt: '请审查以下叙事大纲的世界观合理性。',
          extraContext: { outline },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-realism', chunk })
        }
      },
      {
        type: 'critic-character',
        key: 'critic-character',
        params: {
          state,
          taskPrompt: '请审查以下叙事大纲中角色行为的一致性。',
          extraContext: { outline },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-character', chunk })
        }
      }
    ]);
    return results;
  }

  _mergeOutlineReviews(outline, reviews) {
    const merged = JSON.parse(JSON.stringify(outline));
    for (const [, result] of reviews) {
      if (!result.success || !result.data?.issues) continue;
      for (const issue of result.data.issues) {
        if (issue.severity === 'error' && issue.beatId) {
          const beat = merged.beats.find(b => b.id === issue.beatId);
          if (beat) {
            beat._reviews = beat._reviews || [];
            beat._reviews.push(issue);
          }
        }
      }
    }
    return merged;
  }

  async _writeDraft(state, userInput, outline, reviews, characterInputs) {
    const reviewSummary = [];
    for (const [type, result] of reviews) {
      if (result.success && result.data) reviewSummary.push({ agent: type, ...result.data });
    }

    const result = await this.runner.run('writer', {
      state,
      userInput,
      taskPrompt: '请基于审核后的大纲和审查建议，写出高质量叙事正文。正文末尾附上变量标签（<variable>、<relationship>、<memory> 等）。',
      extraContext: {
        outline,
        reviews: reviewSummary,
        characterInputs: characterInputs.length > 0 ? characterInputs : undefined,
        _pipeline: this.pipeline
      },
      options: { temperature: 0.85, max_tokens: 8192 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'writer', chunk })
    });

    if (typeof result === 'string') return result;
    if (result?._raw) return result._raw;
    if (result?.text) return result.text;
    throw new Error('Writer 未能生成有效正文');
  }

  async _reviewDraft(state, draft, isFullMode) {
    const agents = [
      {
        type: 'critic-style',
        key: 'critic-style',
        params: {
          state,
          taskPrompt: '请审查以下正文的风格和节奏。',
          extraContext: { draft },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-style', chunk })
        }
      }
    ];
    if (isFullMode) {
      agents.push({
        type: 'critic-detail',
        key: 'critic-detail',
        params: {
          state,
          taskPrompt: '请审查以下正文的感官描写和战斗细节质量。',
          extraContext: { draft },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-detail', chunk })
        }
      });
    }
    return await this.runner.runParallel(agents);
  }

  _hasSignificantSuggestions(reviews) {
    for (const [, result] of reviews) {
      if (!result.success) continue;
      const score = result.data?.score;
      if (typeof score === 'number' && score < 7) return true;
      if (result.data?.suggestions?.length > 3) return true;
    }
    return false;
  }

  async _polishDraft(state, userInput, draft, draftReviews) {
    const suggestions = [];
    for (const [type, result] of draftReviews) {
      if (result.success && result.data?.suggestions) {
        suggestions.push(...result.data.suggestions.map(s => ({ ...s, from: type })));
      }
    }
    if (!suggestions.length) return draft;

    const result = await this.runner.run('writer-polish', {
      state,
      userInput,
      taskPrompt: '请根据审查建议润色正文。保持结构和变量标签不变，只改进文字质量。',
      extraContext: { draft, suggestions },
      options: { temperature: 0.75, max_tokens: 8192 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'writer-polish', chunk })
    });

    const text = typeof result === 'string' ? result : (result?._raw || null);
    return text && text.length > draft.length * 0.5 ? text : draft;
  }

  // ── 角色代理 ──

  _extractInvolvedNPCs(outline, state) {
    const npcSet = new Set();
    for (const beat of outline.beats || []) {
      for (const line of beat.dialogue || []) {
        const match = String(line).match(/^(.+?)[:：]/);
        if (match) {
          const name = match[1].trim();
          if (name.length >= 2 && name.length <= 10) npcSet.add(name);
        }
      }
    }
    const playerName = state.player?.name;
    if (playerName) npcSet.delete(playerName);
    return [...npcSet].slice(0, 3);
  }

  async _runCharacterAgents(state, userInput, stateMd, npcNames, outline) {
    const agents = npcNames.map((npcName, idx) => ({
      type: 'character',
      key: `char-${idx}-${npcName}`,
      params: {
        state,
        userInput,
        taskPrompt: this._buildCharacterTaskPrompt(npcName, state, stateMd, outline),
        options: { temperature: 0.8, max_tokens: 1024 },
        onChunk: (chunk) => eventBus.emit('agent:stream', { agent: `char-${npcName}`, chunk })
      }
    }));

    const results = await this.runner.runParallel(agents);
    const inputs = [];
    for (const [key, result] of results) {
      if (!result.success) continue;
      const npcName = key.replace(/^char-\d+-/, '');
      inputs.push({ npc: npcName, ...result.data });
      eventBus.emit('agent:character', { npc: npcName, response: result.data });
    }
    return inputs;
  }

  _buildCharacterTaskPrompt(npcName, state, stateMd, outline) {
    const rel = state.relationships?.[npcName];
    const npcNotes = state.memory?.npc_notes?.[npcName] || '';
    const charMemory = state.agent_memories?.[npcName];

    let prompt = `你现在是「${npcName}」。\n`;
    if (rel) {
      prompt += `与玩家(${state.player?.name || '玩家'})的关系: 好感${rel.affection || 0} 信任${rel.trust || 0} 尊重${rel.respect || 0}`;
      if (rel.role) prompt += ` 角色:${rel.role}`;
      prompt += '\n';
    }
    if (npcNotes) prompt += `GM备注: ${npcNotes}\n`;
    if (charMemory) {
      prompt += `你的私有记忆:\n`;
      if (charMemory.personality) prompt += `- 性格: ${charMemory.personality}\n`;
      if (charMemory.currentMood) prompt += `- 当前情绪: ${charMemory.currentMood}\n`;
      if (charMemory.privateGoals?.length) prompt += `- 目标: ${charMemory.privateGoals.join(', ')}\n`;
      if (charMemory.knownFacts?.length) prompt += `- 近期记忆: ${charMemory.knownFacts.slice(-5).join('; ')}\n`;
    }
    prompt += `\n场景:\n${stateMd}\n`;
    const scenes = (outline.beats || []).map(b => b.scene).filter(Boolean);
    if (scenes.length) prompt += `\n本回合大纲:\n${scenes.join('\n')}\n`;
    prompt += `\n请以「${npcName}」的第一人称视角，输出你在这个场景中的行为、对话和内心想法。`;
    return prompt;
  }

  _archiveCharacterMemories(state, characterInputs) {
    const agentMemories = state.agent_memories || {};
    const updates = [];
    const turn = stateManager.get('_meta.turn_count') || 0;

    for (const input of characterInputs) {
      const npcName = input.npc;
      if (!npcName) continue;

      const existing = agentMemories[npcName] ? JSON.parse(JSON.stringify(agentMemories[npcName])) : {
        npcName,
        personality: '',
        currentMood: '平静',
        privateGoals: [],
        knownFacts: [],
        relationToPlayer: {},
        recentActions: []
      };

      if (input.moodShift) existing.currentMood = input.moodShift;
      if (input.action) {
        existing.knownFacts.push(input.action);
        if (existing.knownFacts.length > 20) existing.knownFacts = existing.knownFacts.slice(-15);
      }
      existing.recentActions.push({
        turn,
        action: input.action || '',
        dialogue: input.dialogue || ''
      });
      if (existing.recentActions.length > 10) existing.recentActions = existing.recentActions.slice(-8);

      updates.push({ path: `agent_memories.${npcName}`, op: 'set', value: existing });
    }

    if (updates.length > 0) stateManager.batchUpdate(updates);
  }

  // ── Utility ──

  _buildStateMd(state) {
    const lines = [
      `# 状态快照`,
      `角色: ${state.player.name || '未知'} | ${state.player.rank} | ${state.player.village}`,
      `查克拉: ${state.attributes.chakra_current}/${state.attributes.chakra} | 体力: ${state.attributes.stamina_current}/${state.attributes.stamina}`,
      `精神: ${state.attributes.spirit_current}/${state.attributes.spirit} | 意志: ${state.attributes.willpower_current}/${state.attributes.willpower}`,
      `位置: ${state.world_state?.current_location || '木叶隐村'} | ${formatGameTime(state.world_state?.calendar)}`,
      `天气: ${state.world_state?.weather || '晴'}`
    ];
    if (state.combat?.is_active) {
      lines.push(`战斗: vs ${state.combat.enemy_name} (查克拉 ${state.combat.enemy_chakra}/${state.combat.enemy_chakra_max})`);
    }
    if (state.missions?.active?.length) {
      lines.push(`任务: ${state.missions.active.map(m => `[${m.rank || 'D'}]${m.title}`).join(', ')}`);
    }
    if (state.memory?.recent_summary) {
      lines.push(`近期摘要: ${state.memory.recent_summary.slice(0, 400)}`);
    }
    const topRels = this._topRelationships(state.relationships, 5);
    if (topRels !== '无') lines.push(`关键关系: ${topRels}`);
    return lines.join('\n');
  }

  _topRelationships(relationships, limit) {
    if (!relationships || Object.keys(relationships).length === 0) return '无';
    return Object.entries(relationships)
      .sort((a, b) => Math.abs(b[1]?.affection || 0) - Math.abs(a[1]?.affection || 0))
      .slice(0, limit)
      .map(([name, r]) => `${name}(好感${r.affection || 0})`)
      .join(', ');
  }

  _checkAbort() {
    if (this._aborted) throw new AgentAbortError();
  }
}

export { AgentPipeline };
