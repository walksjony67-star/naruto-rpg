# Agent 高质量正文生成系统 — 功能设计文档

> 版本: 1.0 | 状态: 设计阶段  
> 定位: 可选功能，用户在游戏开始时勾选启用（消耗更多 Token，生成更慢，质量显著提升）

---

## 一、系统概述

### 1.1 问题背景

当前 `MessagePipeline` 采用单次 AI 调用模式：构建 prompt → 单次 stream → 解析指令。这种模式在速度和成本上最优，但存在质量天花板：
- 单次生成难以兼顾"叙事质量"与"变量准确性"
- 长篇正文容易出现前后矛盾、细节遗漏、风格漂移
- NPC 行为缺乏独立视角，容易被叙事者的全知视角污染
- 缺乏自我审查机制，错误只能靠二次变量更新器事后补救

### 1.2 设计目标

构建 **GM（主控）+ 多 Sub-Agent** 的流水线架构：

```
用户输入 → GM 编排 → [头脑风暴] → [大纲生成] → [评审团审查] → [正文写作] → [细节/风格审查] → 最终输出
```

**核心原则：**
1. **渐进精炼** — 从粗到细，每个阶段只关注一个维度
2. **职责隔离** — 每个 Agent 只看到与自身职责相关的上下文（Manifest 控制）
3. **可降级** — 任何 Sub-Agent 失败不阻塞主流程，降级为单次生成
4. **向后兼容** — 关闭此功能时，系统行为与现有 `MessagePipeline` 完全一致

---

## 二、架构总览

### 2.1 Agent 角色定义

| Agent | 角色 | 输入 | 输出 | 模型建议 |
|-------|------|------|------|----------|
| **GM（主控）** | 流水线编排器 | 用户输入 + 全量状态 | 各阶段调度指令 | 不单独调用，运行在主线程 |
| **Brainstormer（头脑风暴）** | 剧情可能性发散 | 场景摘要 + 近期记忆 + 用户输入 | 3-5 条剧情走向候选 | 快速模型（低 token） |
| **Outliner（大纲师）** | 结构化叙事骨架 | 选定走向 + 完整状态 | 分段大纲（场景→对话→行动→结果） | 主模型 |
| **Critic-Realism（合理性审查）** | 世界观/时间线合规 | 大纲 + 时间线规则 + 世界状态 | 修改建议列表 | 快速模型 |
| **Critic-Character（角色一致性审查）** | NPC/PC 行为审查 | 大纲 + 角色档案 + 关系数据 | 修改建议列表 | 快速模型 |
| **Critic-Detail（细节审查）** | 感官/战斗/环境细节 | 初稿 + 场景设定 | 细节增补建议 | 快速模型 |
| **Critic-Style（风格审查）** | 文风/节奏/禁忌词 | 初稿 + 风格规范 | 风格修改建议 | 快速模型 |
| **Writer（正文作家）** | 高质量叙事生成 | 审核后大纲 + 状态 + 记忆 | 完整正文 + 变量标签 | 主模型（高 max_tokens） |
| **CharacterAgent（角色代理）** | 独立角色视角（高级模式） | 角色私有记忆 + 场景摘要 | 角色行为/对话/内心独白 | 快速模型 |

### 2.2 流水线阶段图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AgentPipeline                                │
│                                                                     │
│  Stage 1: 状态快照                                                   │
│  ┌──────────┐                                                       │
│  │ StateSnap │─→ state.md (压缩的当前状态文本)                         │
│  └──────────┘                                                       │
│       │                                                             │
│  Stage 2: 头脑风暴 (可选, 非战斗回合)                                  │
│  ┌──────────────┐                                                   │
│  │ Brainstormer  │─→ candidates[] (3-5 条走向)                       │
│  └──────────────┘                                                   │
│       │                                                             │
│  Stage 3: 大纲生成                                                   │
│  ┌──────────┐                                                       │
│  │ Outliner  │─→ outline (结构化场景大纲)                              │
│  └──────────┘                                                       │
│       │                                                             │
│  Stage 4: 大纲审查 (并行)                                             │
│  ┌──────────────────┐  ┌─────────────────────┐                      │
│  │ Critic-Realism    │  │ Critic-Character     │                     │
│  └────────┬─────────┘  └────────┬────────────┘                      │
│           └──────┬──────────────┘                                    │
│                  ▼                                                   │
│          reviewedOutline (合并修改建议后的大纲)                         │
│                  │                                                   │
│  Stage 5: 角色代理 (高级模式, 并行)                                    │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                          │
│  │ CharAgent1 │ │ CharAgent2 │ │ CharAgent3 │                        │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘                          │
│        └──────┬──────┴──────┬──────┘                                 │
│               ▼                                                      │
│       characterInputs[] (各角色行为/对话素材)                           │
│               │                                                      │
│  Stage 6: 正文写作                                                    │
│  ┌────────┐                                                          │
│  │ Writer  │─→ draft (初稿正文 + 变量标签)                              │
│  └────────┘                                                          │
│       │                                                              │
│  Stage 7: 细节 + 风格审查 (并行)                                       │
│  ┌──────────────┐  ┌──────────────┐                                  │
│  │ Critic-Detail │  │ Critic-Style  │                                 │
│  └──────┬───────┘  └──────┬───────┘                                  │
│         └──────┬──────────┘                                          │
│                ▼                                                     │
│  Stage 8: 最终润色                                                    │
│  ┌────────┐                                                          │
│  │ Writer  │─→ finalText (最终正文 + 变量标签)                          │
│  └────────┘                                                          │
│       │                                                              │
│  Stage 9: 归档 + 输出                                                 │
│  ┌─────────┐                                                         │
│  │ Archive  │─→ 记忆更新 + 角色记忆更新 + 呈现给用户                     │
│  └─────────┘                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 简化模式 vs 完整模式

用户可选两种 Agent 模式（在设置中切换）：

| 模式 | 阶段 | 预估额外调用次数 | 适用场景 |
|------|------|-----------------|---------|
| **标准 Agent** | 大纲→大纲审查(2)→写作→风格审查 | +4 次 | 日常探索、对话、训练 |
| **完整 Agent** | 头脑风暴→大纲→大纲审查(2)→角色代理(N)→写作→细节审查→风格审查→润色 | +7~10 次 | 重大剧情、战斗、转折点 |

GM 可根据场景自动判断：战斗/Boss/关键剧情自动升级为完整模式。

---

## 三、核心数据结构

### 3.1 state.md — 实时状态文本

每回合由 GM 从 `stateManager.get()` 生成的压缩文本快照，供所有 Agent 共享：

```javascript
// js/core/agent-pipeline.js

_buildStateMd(state) {
  return `# 当前状态快照
## 角色: ${state.player.name} | ${state.player.rank} | ${state.player.village}
## 属性: 查克拉${state.attributes.chakra_current}/${state.attributes.chakra} 体力${state.attributes.stamina_current}/${state.attributes.stamina}
## 位置: ${state.world_state.current_location} | ${formatGameTime(state.world_state.calendar)}
## 战斗: ${state.combat?.is_active ? `进行中 vs ${state.combat.enemy_name}` : '无'}
## 近期摘要: ${state.memory?.recent_summary?.slice(0, 500) || '无'}
## 活跃任务: ${state.missions?.active?.map(m => m.title).join(', ') || '无'}
## 关键关系: ${this._topRelationships(state.relationships, 5)}`;
}
```

### 3.2 Manifest — Agent 上下文注入配置

每个 Agent 只接收与其职责相关的上下文切片，通过 Manifest 配置：

```javascript
const AGENT_MANIFESTS = {
  brainstormer: {
    stateFields: ['player.name', 'player.rank', 'world_state', 'memory.recent_summary'],
    includeHistory: false,
    includePreset: false,
    maxContextChars: 3000,
    systemPromptKey: 'BRAINSTORMER'
  },
  outliner: {
    stateFields: ['player', 'attributes', 'skills', 'missions', 'world_state', 'combat', 'memory'],
    includeHistory: true,
    historyTurns: 2,
    includePreset: true,
    maxContextChars: 8000,
    systemPromptKey: 'OUTLINER'
  },
  'critic-realism': {
    stateFields: ['world_state', 'player.rank', 'player.village'],
    includeHistory: false,
    includePreset: false,
    maxContextChars: 4000,
    systemPromptKey: 'CRITIC_REALISM'
  },
  'critic-character': {
    stateFields: ['player', 'relationships', 'memory.npc_notes'],
    includeHistory: false,
    includePreset: false,
    maxContextChars: 4000,
    systemPromptKey: 'CRITIC_CHARACTER'
  },
  'critic-detail': {
    stateFields: ['world_state.current_location', 'world_state.weather', 'combat'],
    includeHistory: false,
    includePreset: false,
    maxContextChars: 3000,
    systemPromptKey: 'CRITIC_DETAIL'
  },
  'critic-style': {
    stateFields: [],
    includeHistory: false,
    includePreset: true,
    maxContextChars: 3000,
    systemPromptKey: 'CRITIC_STYLE'
  },
  writer: {
    stateFields: ['player', 'attributes', 'skills', 'equipment', 'missions', 'relationships', 'world_state', 'combat', 'memory'],
    includeHistory: true,
    historyTurns: 4,
    includePreset: true,
    maxContextChars: 12000,
    systemPromptKey: 'WRITER'
  },
  character: {
    stateFields: ['world_state.current_location', 'combat'],
    includeHistory: false,
    includePreset: false,
    maxContextChars: 2000,
    systemPromptKey: 'CHARACTER_AGENT'
  }
};
```

### 3.3 角色代理记忆 — 独立第一人称记忆系统

每个重要 NPC 维护独立的第一人称记忆，与全局记忆隔离：

```javascript
// 存储在 state.agent_memories[npcName]
const characterMemorySchema = {
  npcName: 'うずまきナルト',
  personality: '热血、执着、重视同伴',
  currentMood: '兴奋',
  privateGoals: ['成为火影', '追回佐助'],
  knownFacts: [
    '今天和小樱一起训练了',
    '听说有新的任务来了'
  ],
  relationToPlayer: {
    impression: '有趣的同期，实力在成长',
    trust: 45,
    lastInteraction: '一起吃了拉面'
  },
  recentActions: [],
  internalMonologue: ''
};
```

---

## 四、Agent Prompt 设计

### 4.1 Brainstormer Prompt

```javascript
const AGENT_PROMPTS = {
  BRAINSTORMER: `你是火影忍者TRPG的剧情头脑风暴器。

任务：根据当前场景和玩家输入，提出 3-5 条可能的剧情走向。

要求：
- 每条走向一句话概括 + 一句话展开（为什么有趣/合理）
- 至少包含：1条安全/预期内走向、1条意外但合理的走向、1条高风险高回报走向
- 考虑NPC的独立动机，不要一切围绕玩家转
- 战斗中不需要头脑风暴，直接跳过

输出格式（严格JSON）：
{
  "candidates": [
    {"id": 1, "direction": "...", "reason": "...", "risk": "low|medium|high"},
    ...
  ],
  "recommended": 1
}`,

  OUTLINER: `你是火影忍者TRPG的大纲构建师。

任务：将选定的剧情走向展开为结构化的叙事大纲。

大纲要求：
- 分为 3-6 个叙事段落（beat），每个 beat 包含：场景描写要点、对话要点、行动结果
- 标注每个 beat 的情感节奏（紧张/轻松/热血/悲伤/日常）
- 标注需要输出的变量标签类型（variable/combat/relationship/memory）
- 战斗场景要细化到招式交换级别

输出格式（严格JSON）：
{
  "beats": [
    {
      "id": 1,
      "scene": "描写要点...",
      "dialogue": ["角色A: 大意...", "角色B: 大意..."],
      "action": "行动与结果...",
      "mood": "紧张",
      "variables": ["relationship", "memory"]
    }
  ],
  "estimatedLength": 1200,
  "variableSummary": "预计变量变化概述..."
}`,

  CRITIC_REALISM: `你是火影忍者TRPG的合理性审查员。

任务：审查叙事大纲是否违反世界观规则。

审查清单：
1. 时间线合规：当前年代是否允许出现该事件/人物/组织/忍术？
2. 实力合理性：角色的行为是否超出其忍阶应有的能力范围？
3. 认知隔离：NPC是否知道了他们不该知道的信息？
4. 主角光环：玩家是否获得了不合理的优待或奇遇？
5. 资源守恒：查克拉/体力消耗是否与行动匹配？

输出格式（严格JSON）：
{
  "issues": [
    {"beatId": 1, "severity": "error|warning", "rule": "时间线", "description": "...", "suggestion": "..."}
  ],
  "approved": false,
  "summary": "整体评价..."
}`,

  CRITIC_CHARACTER: `你是火影忍者TRPG的角色一致性审查员。

任务：审查大纲中的角色行为是否符合人设。

审查清单：
1. NPC是否OOC（Out of Character）？对照其已知性格、动机、当前情绪
2. 对话语气是否符合角色年龄、身份、与玩家的关系亲疏？
3. 关系变化速度是否合理？（不能一次对话就从陌生变成挚友）
4. NPC的独立动机是否被尊重？（不能沦为玩家的工具人）

输出格式（严格JSON）：
{
  "issues": [
    {"beatId": 1, "npc": "角色名", "severity": "error|warning", "description": "...", "suggestion": "..."}
  ],
  "approved": false,
  "summary": "整体评价..."
}`,

  CRITIC_DETAIL: `你是火影忍者TRPG的细节审查员。

任务：审查初稿的感官描写和战斗细节质量。

审查清单：
1. 是否有具象的感官描写？（视觉、听觉、触觉、嗅觉、味觉至少覆盖2种）
2. 战斗是否有分镜感？（招式的物理运动轨迹、身体反应、查克拉流动描写）
3. 环境是否活的？（天气、光线、周围人反应、背景声音）
4. 是否使用了禁忌懒惰词？（一丝、一抹、仿佛、似乎、闪过 → 应替换为具体描写）

输出格式（严格JSON）：
{
  "suggestions": [
    {"location": "第X段", "type": "sensory|combat|environment|wording", "current": "原文片段...", "improved": "建议改写..."}
  ],
  "score": 7,
  "summary": "整体细节评价..."
}`,

  CRITIC_STYLE: `你是火影忍者TRPG的风格审查员。

任务：审查初稿的文风和节奏。

审查清单：
1. 是否保持日式轻小说节奏？（描写→对话→行动→结果 循环）
2. 段落长度是否适中？（避免超长段落或碎片化）
3. 对话是否自然？（符合口语习惯，不像书面报告）
4. 正文是否混入了数值？（严禁正文出现具体数字）
5. 是否有重复表达或冗余描写？
6. 行动选项「」是否自然衔接？
7. 情感节奏是否有起伏？（不能全程高潮或全程平淡）

输出格式（严格JSON）：
{
  "suggestions": [
    {"location": "第X段", "type": "rhythm|dialogue|value_leak|redundancy|options", "description": "...", "suggestion": "..."}
  ],
  "score": 8,
  "summary": "整体风格评价..."
}`,

  WRITER: `你是火影忍者TRPG的高级正文作家。

你将收到一份经过审查的叙事大纲和审查建议。请基于这些输入写出高质量的叙事正文。

写作要求：
- 严格按照大纲的 beat 结构展开，不要遗漏任何 beat
- 融入审查建议的改进点
- 第三人称叙述，直接使用角色名字
- 感官描写丰富，至少覆盖视觉+听觉+一种其他感官
- 战斗描写分镜式，招式有物理运动轨迹
- 对话符合角色性格、年龄、身份
- 正文 >= 900字，战斗/转折 >= 1400字
- 行动选项用「」标记在文末，每行一个
- 严禁正文出现任何数值
- 在正文末尾输出所有变量标签

如果收到角色代理的行为素材，优先使用其对话和内心描写来丰富正文。`,

  CHARACTER_AGENT: `你是一个火影忍者世界中的角色。你需要以第一人称视角思考和行动。

重要规则：
- 你只知道你应该知道的事情（认知隔离）
- 你有自己的目标和动机，不是为玩家服务的工具
- 你的行为必须符合你的性格设定
- 你对玩家角色的态度取决于你们的关系和过往互动

根据当前场景，输出你的行为：
{
  "action": "你会做什么（具体行动描写）",
  "dialogue": "你会说什么（符合角色语气的台词，可为空）",
  "innerThought": "你的内心独白（第一人称）",
  "moodShift": "情绪变化（如有）",
  "towardsPlayer": "对玩家角色的态度变化（如有）"
}`
};
```

---

## 五、代码框架设计

### 5.1 文件结构

```
js/
  core/
    agent-pipeline.js       ← 核心：Agent 流水线编排器
    agent-runner.js          ← Agent 调用执行器（封装 AI 调用）
    agent-prompts.js         ← 所有 Agent 的 system prompt
    agent-manifests.js       ← Manifest 配置（每个 Agent 的上下文注入规则）
  data/
    agent-config.js          ← Agent 模式默认配置
  ui/
    agent-progress.js        ← Agent 进度 UI 组件
```

### 5.2 AgentRunner — Agent 调用执行器

```javascript
// js/core/agent-runner.js

import { AIClient } from './ai-client.js';
import { stateManager } from './state-manager.js';
import { AGENT_MANIFESTS } from './agent-manifests.js';
import { AGENT_PROMPTS } from './agent-prompts.js';

class AgentRunner {
  constructor() {
    this._client = null;
    this._aborted = false;
  }

  /**
   * 配置 Agent 专用的 AI 客户端
   * 支持为 Agent 调用使用独立的模型/API（如用廉价模型跑 Critic）
   */
  configure(overrides = {}) {
    const baseConfig = stateManager.getAPIConfig() || {};
    const agentConfig = stateManager.get('settings.agent') || {};
    
    this._client = new AIClient();
    this._client.configure({
      ...baseConfig,
      // Agent 可使用独立的 API 配置
      apiUrl: agentConfig.apiUrl || baseConfig.apiUrl,
      apiKey: agentConfig.apiKey || baseConfig.apiKey,
      model: overrides.model || agentConfig.model || baseConfig.model,
      ...overrides
    });
  }

  abort() {
    this._aborted = true;
    this._client?.cancel();
  }

  /**
   * 执行单个 Agent 调用
   * @param {string} agentType - Agent 类型（对应 manifest key）
   * @param {object} params
   * @param {object} params.state - 当前游戏状态
   * @param {string} params.userInput - 用户输入
   * @param {string} params.taskPrompt - 本次任务的具体指令
   * @param {object} params.extraContext - 额外上下文（如大纲、审查结果）
   * @param {object} params.options - 生成选项覆盖
   * @returns {Promise<object>} 解析后的 JSON 结果
   */
  async run(agentType, { state, userInput, taskPrompt, extraContext = {}, options = {} }) {
    if (this._aborted) throw new Error('Agent pipeline aborted');
    
    const manifest = AGENT_MANIFESTS[agentType];
    if (!manifest) throw new Error(`Unknown agent type: ${agentType}`);

    const messages = this._buildMessages(agentType, manifest, {
      state, userInput, taskPrompt, extraContext
    });

    const genOptions = {
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 2048,
      top_p: options.top_p ?? 0.9,
      ...options
    };

    const response = await this._client.chat(messages, genOptions);
    return this._parseResponse(response, agentType);
  }

  /**
   * 并行执行多个 Agent
   * @param {Array<{type: string, params: object}>} agents
   * @returns {Promise<Map<string, object>>} agentType → result
   */
  async runParallel(agents) {
    const results = new Map();
    const promises = agents.map(async ({ type, params }) => {
      try {
        const result = await this.run(type, params);
        results.set(type, { success: true, data: result });
      } catch (err) {
        results.set(type, { success: false, error: err.message });
      }
    });
    await Promise.allSettled(promises);
    return results;
  }

  /**
   * 根据 Manifest 构建 Agent 的消息列表
   */
  _buildMessages(agentType, manifest, { state, userInput, taskPrompt, extraContext }) {
    const messages = [];

    // System prompt：Agent 角色定义
    const systemPrompt = AGENT_PROMPTS[manifest.systemPromptKey];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 按 Manifest 注入状态切片
    const stateSlice = this._extractStateSlice(state, manifest.stateFields);
    if (Object.keys(stateSlice).length > 0) {
      const stateText = JSON.stringify(stateSlice, null, 0)
        .slice(0, manifest.maxContextChars || 8000);
      messages.push({ role: 'system', content: `[当前状态]\n${stateText}` });
    }

    // 主预设注入（仅 Writer/Outliner 需要）
    if (manifest.includePreset) {
      // 复用现有 getMainPreset() 的文风破限条目
      // 但只取 enabled 且 role=system 的关键条目，避免 token 浪费
      messages.push({
        role: 'system',
        content: '[写作风格指令] 遵守主预设中的文风规范，保持日式轻小说节奏。'
      });
    }

    // 聊天历史（仅部分 Agent 需要）
    if (manifest.includeHistory && manifest.historyTurns > 0) {
      const pipeline = extraContext._pipeline;
      if (pipeline) {
        const history = pipeline.getHistory();
        const recentTurns = history.slice(-(manifest.historyTurns * 2));
        messages.push(...recentTurns);
      }
    }

    // 任务指令 + 额外上下文
    let userContent = taskPrompt || '';
    if (extraContext.outline) {
      userContent += `\n\n[叙事大纲]\n${JSON.stringify(extraContext.outline)}`;
    }
    if (extraContext.reviews) {
      userContent += `\n\n[审查建议]\n${JSON.stringify(extraContext.reviews)}`;
    }
    if (extraContext.draft) {
      userContent += `\n\n[初稿正文]\n${extraContext.draft}`;
    }
    if (extraContext.characterInputs) {
      userContent += `\n\n[角色代理素材]\n${JSON.stringify(extraContext.characterInputs)}`;
    }
    if (userInput) {
      userContent += `\n\n[玩家输入] ${userInput}`;
    }

    messages.push({ role: 'user', content: userContent });

    return messages;
  }

  /**
   * 按字段路径列表从 state 中提取子集
   */
  _extractStateSlice(state, fields) {
    if (!fields || fields.length === 0) return {};
    const slice = {};
    for (const field of fields) {
      const parts = field.split('.');
      let source = state;
      let target = slice;
      for (let i = 0; i < parts.length; i++) {
        const key = parts[i];
        if (source == null) break;
        if (i === parts.length - 1) {
          target[key] = source[key];
        } else {
          if (!target[key]) target[key] = {};
          target = target[key];
          source = source[key];
        }
      }
    }
    return slice;
  }

  /**
   * 解析 Agent 返回的 JSON
   * 容错：尝试从文本中提取 JSON 块
   */
  _parseResponse(response, agentType) {
    if (!response) return null;
    
    // 尝试直接解析
    try {
      return JSON.parse(response);
    } catch {}
    
    // 尝试提取 ```json 块
    const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1]); } catch {}
    }
    
    // 尝试提取第一个 { ... } 或 [ ... ]
    const braceMatch = response.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[1]); } catch {}
    }

    // 解析失败，返回原始文本
    console.warn(`[AgentRunner] Failed to parse ${agentType} response as JSON`);
    return { _raw: response };
  }
}

export { AgentRunner };
```

### 5.3 AgentPipeline — 流水线编排器

```javascript
// js/core/agent-pipeline.js

import { stateManager } from './state-manager.js';
import { eventBus } from './event-bus.js';
import { AgentRunner } from './agent-runner.js';
import { instructionParser } from '../instruction-parser.js';
import { formatGameTime } from '../utils/format.js';

class AgentPipeline {
  constructor({ pipeline, memorySystem }) {
    this.pipeline = pipeline;         // 引用现有 MessagePipeline（复用历史/记忆）
    this.memorySystem = memorySystem;
    this.runner = new AgentRunner();
    this._aborted = false;
  }

  /**
   * 检查是否启用 Agent 模式
   */
  static isEnabled() {
    return stateManager.get('settings.agent.enabled') === true;
  }

  /**
   * 获取当前 Agent 模式
   * @returns {'standard'|'full'}
   */
  static getMode() {
    return stateManager.get('settings.agent.mode') || 'standard';
  }

  /**
   * 中止流水线
   */
  abort() {
    this._aborted = true;
    this.runner.abort();
  }

  /**
   * 执行完整的 Agent 流水线
   * 
   * 此方法替代 MessagePipeline.process() 中的单次 AI 调用。
   * 在 pipeline.process() 中的调用点：
   *   if (AgentPipeline.isEnabled()) {
   *     fullResponse = await this._agentPipeline.execute(state, userInput);
   *   } else {
   *     fullResponse = await aiClient.chatStream(messages, options, onChunk);
   *   }
   * 
   * @param {object} state - 当前游戏状态
   * @param {string} userInput - 玩家输入
   * @param {function} onProgress - 进度回调 (stage, detail)
   * @returns {Promise<string>} 最终正文（含变量标签）
   */
  async execute(state, userInput, onProgress = () => {}) {
    this._aborted = false;
    this.runner.configure();
    
    const mode = AgentPipeline.getMode();
    const isCombat = state.combat?.is_active;
    const isFullMode = mode === 'full';

    try {
      // ── Stage 1: 状态快照 ──
      onProgress('state_snap', '生成状态快照...');
      const stateMd = this._buildStateMd(state);

      // ── Stage 2: 头脑风暴（完整模式 + 非战斗） ──
      let selectedDirection = null;
      if (isFullMode && !isCombat) {
        onProgress('brainstorm', '头脑风暴中...');
        selectedDirection = await this._brainstorm(state, userInput, stateMd);
      }
      this._checkAbort();

      // ── Stage 3: 大纲生成 ──
      onProgress('outline', '构建叙事大纲...');
      const outline = await this._generateOutline(state, userInput, stateMd, selectedDirection);
      this._checkAbort();

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
          characterInputs = await this._runCharacterAgents(state, userInput, stateMd, involvedNPCs, reviewedOutline);
        }
      }
      this._checkAbort();

      // ── Stage 6: 正文写作 ──
      onProgress('writing', '正文写作中...');
      const draft = await this._writeDraft(state, userInput, reviewedOutline, outlineReviews, characterInputs);
      this._checkAbort();

      // ── Stage 7: 细节 + 风格审查（并行） ──
      onProgress('review_draft', '审查正文质量...');
      const draftReviews = await this._reviewDraft(state, draft, isFullMode);
      this._checkAbort();

      // ── Stage 8: 最终润色（仅在有修改建议时） ──
      let finalText = draft;
      if (this._hasSignificantSuggestions(draftReviews)) {
        onProgress('polish', '最终润色中...');
        finalText = await this._polishDraft(state, userInput, draft, draftReviews);
      }
      this._checkAbort();

      // ── Stage 9: 归档 ──
      onProgress('archive', '归档记忆...');
      if (isFullMode && characterInputs.length > 0) {
        this._archiveCharacterMemories(state, characterInputs, finalText);
      }

      onProgress('done', '生成完成');
      return finalText;

    } catch (err) {
      if (err.message === 'Agent pipeline aborted') {
        throw err;
      }
      // 降级：Agent 流水线失败时，回退到单次生成
      console.warn('[AgentPipeline] Pipeline failed, falling back to single-shot:', err.message);
      eventBus.emit('agent:fallback', { reason: err.message });
      onProgress('fallback', '降级为标准生成...');
      return null; // 返回 null 让调用方回退到 aiClient.chatStream
    }
  }

  // ── 各阶段实现 ──

  async _brainstorm(state, userInput, stateMd) {
    const result = await this.runner.run('brainstormer', {
      state,
      userInput,
      taskPrompt: `当前场景摘要:\n${stateMd}\n\n请根据玩家输入提出剧情走向候选。`,
      options: { temperature: 0.9, max_tokens: 1024 }
    });

    if (!result?.candidates?.length) return null;
    
    // GM 决策：选择 recommended 或根据规则选择
    const recommended = result.recommended || 1;
    const selected = result.candidates.find(c => c.id === recommended) || result.candidates[0];
    
    eventBus.emit('agent:brainstorm', { candidates: result.candidates, selected });
    return selected;
  }

  async _generateOutline(state, userInput, stateMd, direction) {
    const directionHint = direction
      ? `\n\n[选定的剧情走向] ${direction.direction}\n理由: ${direction.reason}`
      : '';

    const result = await this.runner.run('outliner', {
      state,
      userInput,
      taskPrompt: `${stateMd}${directionHint}\n\n请为本回合生成叙事大纲。`,
      extraContext: { _pipeline: this.pipeline },
      options: { temperature: 0.7, max_tokens: 2048 }
    });

    if (!result?.beats?.length) {
      throw new Error('Outliner failed to produce valid outline');
    }
    return result;
  }

  async _reviewOutline(state, outline) {
    const results = await this.runner.runParallel([
      {
        type: 'critic-realism',
        params: {
          state,
          taskPrompt: '请审查以下叙事大纲的世界观合理性。',
          extraContext: { outline },
          options: { temperature: 0.3, max_tokens: 1024 }
        }
      },
      {
        type: 'critic-character',
        params: {
          state,
          taskPrompt: '请审查以下叙事大纲中角色行为的一致性。',
          extraContext: { outline },
          options: { temperature: 0.3, max_tokens: 1024 }
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
      if (result.success && result.data) {
        reviewSummary.push({ agent: type, ...result.data });
      }
    }

    const result = await this.runner.run('writer', {
      state,
      userInput,
      taskPrompt: '请基于审核后的大纲和审查建议，写出高质量叙事正文。正文末尾附上变量标签。',
      extraContext: {
        outline,
        reviews: reviewSummary,
        characterInputs: characterInputs.length > 0 ? characterInputs : undefined,
        _pipeline: this.pipeline
      },
      options: { temperature: 0.85, max_tokens: 8192 }
    });

    // Writer 返回的可能是纯文本而非 JSON
    if (typeof result === 'string') return result;
    if (result?._raw) return result._raw;
    if (result?.text) return result.text;
    throw new Error('Writer produced no valid output');
  }

  async _reviewDraft(state, draft, isFullMode) {
    const agents = [
      {
        type: 'critic-style',
        params: {
          state,
          taskPrompt: '请审查以下正文的风格和节奏。',
          extraContext: { draft },
          options: { temperature: 0.3, max_tokens: 1024 }
        }
      }
    ];

    if (isFullMode) {
      agents.push({
        type: 'critic-detail',
        params: {
          state,
          taskPrompt: '请审查以下正文的感官描写和战斗细节质量。',
          extraContext: { draft },
          options: { temperature: 0.3, max_tokens: 1024 }
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

    const result = await this.runner.run('writer', {
      state,
      userInput,
      taskPrompt: `请根据以下审查建议润色正文。保持大纲结构不变，只改进文字质量。保留所有变量标签。\n\n[修改建议]\n${JSON.stringify(suggestions)}`,
      extraContext: { draft, _pipeline: this.pipeline },
      options: { temperature: 0.75, max_tokens: 8192 }
    });

    if (typeof result === 'string') return result;
    if (result?._raw) return result._raw;
    return draft; // 润色失败就用原稿
  }

  // ── 角色代理 ──

  _extractInvolvedNPCs(outline, state) {
    const npcSet = new Set();
    for (const beat of outline.beats || []) {
      for (const line of beat.dialogue || []) {
        const match = line.match(/^(.+?)[:：]/);
        if (match) npcSet.add(match[1].trim());
      }
    }
    // 过滤掉玩家自己
    npcSet.delete(state.player?.name);
    // 最多 3 个角色代理
    return [...npcSet].slice(0, 3);
  }

  async _runCharacterAgents(state, userInput, stateMd, npcNames, outline) {
    const agents = npcNames.map(npcName => ({
      type: 'character',
      params: {
        state,
        userInput,
        taskPrompt: this._buildCharacterTaskPrompt(npcName, state, stateMd, outline),
        options: { temperature: 0.8, max_tokens: 1024 }
      }
    }));

    const results = await this.runner.runParallel(agents);
    const inputs = [];
    
    let i = 0;
    for (const npcName of npcNames) {
      const key = 'character'; // runParallel 会覆盖同 key，需改进
      const result = results.get(key);
      if (result?.success && result.data) {
        inputs.push({ npc: npcName, ...result.data });
      }
      i++;
    }
    return inputs;
  }

  _buildCharacterTaskPrompt(npcName, state, stateMd, outline) {
    const rel = state.relationships?.[npcName];
    const npcNotes = state.memory?.npc_notes?.[npcName] || '';
    const charMemory = state.agent_memories?.[npcName];

    let prompt = `你是「${npcName}」。\n`;
    if (rel) {
      prompt += `与玩家关系：好感${rel.affection || 0} 信任${rel.trust || 0} 尊重${rel.respect || 0}`;
      if (rel.role) prompt += ` 角色:${rel.role}`;
      prompt += '\n';
    }
    if (npcNotes) {
      prompt += `GM备注：${npcNotes}\n`;
    }
    if (charMemory) {
      prompt += `你的私有记忆：\n`;
      prompt += `- 性格: ${charMemory.personality}\n`;
      prompt += `- 当前情绪: ${charMemory.currentMood}\n`;
      prompt += `- 目标: ${charMemory.privateGoals?.join(', ')}\n`;
      prompt += `- 近期记忆: ${charMemory.knownFacts?.slice(-5).join('; ')}\n`;
    }
    prompt += `\n场景:\n${stateMd}\n`;
    prompt += `\n本回合大纲:\n${JSON.stringify(outline.beats?.map(b => b.scene) || [])}\n`;
    prompt += `\n请以「${npcName}」的第一人称视角，输出你在这个场景中的行为、对话和内心想法。`;

    return prompt;
  }

  _archiveCharacterMemories(state, characterInputs, finalText) {
    const agentMemories = state.agent_memories || {};
    const updates = [];

    for (const input of characterInputs) {
      const npcName = input.npc;
      const existing = agentMemories[npcName] || {
        npcName,
        personality: '',
        currentMood: '平静',
        privateGoals: [],
        knownFacts: [],
        relationToPlayer: {},
        recentActions: []
      };

      // 更新情绪
      if (input.moodShift) existing.currentMood = input.moodShift;
      
      // 追加已知事实
      if (input.action) {
        existing.knownFacts.push(input.action);
        if (existing.knownFacts.length > 20) {
          existing.knownFacts = existing.knownFacts.slice(-15);
        }
      }

      // 记录最近行为
      existing.recentActions.push({
        turn: stateManager.get('_meta.turn_count'),
        action: input.action,
        dialogue: input.dialogue
      });
      if (existing.recentActions.length > 10) {
        existing.recentActions = existing.recentActions.slice(-8);
      }

      updates.push({ path: `agent_memories.${npcName}`, op: 'set', value: existing });
    }

    if (updates.length > 0) {
      stateManager.batchUpdate(updates);
    }
  }

  // ── 工具方法 ──

  _buildStateMd(state) {
    const lines = [
      `# 状态快照`,
      `角色: ${state.player.name} | ${state.player.rank} | ${state.player.village}`,
      `查克拉: ${state.attributes.chakra_current}/${state.attributes.chakra} | 体力: ${state.attributes.stamina_current}/${state.attributes.stamina}`,
      `位置: ${state.world_state?.current_location || '木叶隐村'} | ${formatGameTime(state.world_state?.calendar)}`,
      `天气: ${state.world_state?.weather || '晴'}`,
    ];
    if (state.combat?.is_active) {
      lines.push(`战斗: vs ${state.combat.enemy_name} (查克拉 ${state.combat.enemy_chakra}/${state.combat.enemy_chakra_max})`);
    }
    if (state.missions?.active?.length) {
      lines.push(`任务: ${state.missions.active.map(m => `[${m.rank}]${m.title}`).join(', ')}`);
    }
    if (state.memory?.recent_summary) {
      lines.push(`近期: ${state.memory.recent_summary.slice(0, 400)}`);
    }
    return lines.join('\n');
  }

  _topRelationships(relationships, limit) {
    if (!relationships) return '无';
    return Object.entries(relationships)
      .sort((a, b) => Math.abs(b[1]?.affection || 0) - Math.abs(a[1]?.affection || 0))
      .slice(0, limit)
      .map(([name, r]) => `${name}(好感${r.affection || 0})`)
      .join(', ') || '无';
  }

  _checkAbort() {
    if (this._aborted) throw new Error('Agent pipeline aborted');
  }
}

export { AgentPipeline };
```

### 5.4 与现有 MessagePipeline 的集成点

在 `pipeline.js` 的 `process()` 方法中，Agent 模式替换核心 AI 调用：

```javascript
// js/core/pipeline.js — process() 方法修改示意

async process(userInput) {
  // ... 现有前置逻辑不变 ...
  
  let fullResponse = '';
  
  if (AgentPipeline.isEnabled()) {
    // ── Agent 模式 ──
    const agentPipeline = new AgentPipeline({
      pipeline: this,
      memorySystem: this.memorySystem
    });
    this._currentAgentPipeline = agentPipeline;

    const onProgress = (stage, detail) => {
      eventBus.emit('agent:progress', { stage, detail });
    };

    const onChunk = (chunk) => {
      fullResponse += chunk;
      eventBus.emit('pipeline:chunk', { chunk, response: fullResponse });
    };

    const agentResult = await agentPipeline.execute(state, userInput, onProgress);
    
    if (agentResult === null) {
      // 降级：回退到标准单次生成
      fullResponse = await aiClient.chatStream(messages, this._getGenerationOptions(), onChunk);
    } else {
      fullResponse = agentResult;
      // Agent 模式的结果直接作为 stream 一次性推送
      eventBus.emit('pipeline:chunk', { chunk: fullResponse, response: fullResponse });
    }
  } else {
    // ── 标准模式（现有逻辑不变） ──
    const onChunk = (chunk) => {
      fullResponse += chunk;
      eventBus.emit('pipeline:chunk', { chunk, response: fullResponse });
    };
    fullResponse = await aiClient.chatStream(messages, this._getGenerationOptions(), onChunk);
  }

  // ... 后续指令解析、记忆更新等逻辑不变 ...
}
```

### 5.5 取消支持

```javascript
// pipeline.js cancel() 方法扩展
cancel() {
  this._cancelled = true;
  aiClient.cancel();
  // Agent 模式取消
  if (this._currentAgentPipeline) {
    this._currentAgentPipeline.abort();
  }
}
```

---

## 六、UI 设计

### 6.1 Agent 进度组件

Agent 模式运行时，替换现有的 loading spinner 为多阶段进度条：

```javascript
// js/ui/agent-progress.js

class AgentProgress extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const STAGES = [
      { key: 'state_snap',       label: '状态快照',     icon: '📋' },
      { key: 'brainstorm',       label: '头脑风暴',     icon: '💡' },
      { key: 'outline',          label: '大纲构建',     icon: '📝' },
      { key: 'review_outline',   label: '大纲审查',     icon: '🔍' },
      { key: 'character_agents', label: '角色代理',     icon: '🎭' },
      { key: 'writing',          label: '正文写作',     icon: '✍️' },
      { key: 'review_draft',     label: '质量审查',     icon: '📖' },
      { key: 'polish',           label: '最终润色',     icon: '✨' },
    ];

    this._stages = STAGES;
    this._currentStage = null;
    this._render();
  }

  connectedCallback() {
    this._unsub = eventBus.on('agent:progress', ({ stage, detail }) => {
      this._currentStage = stage;
      this._update(stage, detail);
    });
  }

  disconnectedCallback() {
    this._unsub?.();
  }

  _render() { /* Shadow DOM 渲染：横向步骤指示器 + 当前阶段描述 */ }
  _update(stage, detail) { /* 高亮当前阶段，灰化未来阶段，勾选已完成阶段 */ }
}

customElements.define('agent-progress', AgentProgress);
```

### 6.2 设置面板集成

在设置面板的"AI 配置"区域添加 Agent 模式开关：

```
┌─ Agent 正文模式 ─────────────────────────────────┐
│                                                   │
│  [  ] 启用 Agent 高质量正文模式                     │
│       消耗约 4-10 倍 Token，生成时间约 30-90 秒      │
│                                                   │
│  模式:  ○ 标准 (大纲+审查+写作, +4次调用)            │
│         ○ 完整 (含头脑风暴+角色代理, +7-10次)        │
│                                                   │
│  Agent 模型 (可选):                                 │
│  [ 留空则使用主模型 _____________________ ]          │
│                                                   │
│  Critic 模型 (可选, 建议用快速/廉价模型):             │
│  [ 留空则使用主模型 _____________________ ]          │
│                                                   │
└───────────────────────────────────────────────────┘
```

对应的状态路径：

```javascript
// state.settings.agent
{
  enabled: false,
  mode: 'standard',       // 'standard' | 'full'
  agentModel: '',         // 留空 = 使用主模型
  criticModel: '',        // 留空 = 使用主模型（建议用快速模型降低成本）
  autoUpgrade: true       // 战斗/Boss 自动升级为完整模式
}
```

---

## 七、Token 预算与成本分析

### 7.1 各 Agent 的 Token 预算

| Agent | 输入上限 | 输出上限 | 说明 |
|-------|---------|---------|------|
| Brainstormer | ~3K | ~1K | 轻量级，只需场景摘要 |
| Outliner | ~8K | ~2K | 需要完整状态 |
| Critic (×2-4) | ~4K | ~1K | 并行执行，各自独立 |
| Writer | ~12K | ~8K | 最大消耗，需要所有上游输出 |
| CharacterAgent (×1-3) | ~2K | ~1K | 并行执行，上下文最小 |

### 7.2 成本对比

| 模式 | 总输入 Token | 总输出 Token | 相对成本 |
|------|-------------|-------------|---------|
| 标准单次 | ~8K | ~4K | 1× |
| 标准 Agent | ~30K | ~12K | ~3.5× |
| 完整 Agent | ~45K | ~18K | ~5.5× |

若 Critic 使用廉价模型（如 GPT-4o-mini），完整模式成本可降至约 3×。

---

## 八、错误处理与降级策略

### 8.1 降级链

```
完整 Agent → 标准 Agent → 单次生成
     ↓             ↓            ↓
  任何 Stage    Outliner/Writer  ai-client
  失败时回退    失败时回退        失败时报错
```

### 8.2 单 Agent 失败处理

| Agent 失败 | 处理方式 |
|-----------|---------|
| Brainstormer | 跳过，直接进入 Outliner（无方向提示） |
| Outliner | **致命**，降级到单次生成 |
| Critic-* | 跳过该审查，继续后续阶段 |
| Writer | **致命**，降级到单次生成 |
| CharacterAgent | 跳过该角色，Writer 自行补充 |
| 润色阶段 | 使用初稿作为最终输出 |

### 8.3 超时控制

每个 Agent 调用设置独立超时（默认 30 秒），整个流水线设置总超时（默认 180 秒）：

```javascript
const AGENT_TIMEOUTS = {
  brainstormer: 15000,
  outliner: 30000,
  'critic-realism': 15000,
  'critic-character': 15000,
  'critic-detail': 15000,
  'critic-style': 15000,
  writer: 60000,
  character: 20000,
  pipeline_total: 180000
};
```

---

## 九、记忆与连续性

### 9.1 全局记忆（现有系统）

Agent 模式不改变现有 `MemorySystem` 的工作方式。Writer 的最终输出仍包含 `<memory>` 标签，由现有 `instructionParser` 解析并交给 `MemorySystem.apply()` 处理。

### 9.2 角色私有记忆（新增）

每个被角色代理驱动过的 NPC 在 `state.agent_memories` 下维护独立记忆：

```javascript
// state.agent_memories = {
//   '旗木卡卡西': {
//     personality: '冷静、迟到、重视同伴',
//     currentMood: '警惕',
//     privateGoals: ['培养第七班', '守护木叶'],
//     knownFacts: [
//       '玩家在训练中展现了不错的查克拉控制',
//       '昨天发现了可疑的外来忍者踪迹'
//     ],
//     relationToPlayer: {
//       impression: '有潜力的学生',
//       trust: 30
//     },
//     recentActions: [
//       { turn: 12, action: '观察玩家的修炼', dialogue: '嘛...进步不错' }
//     ]
//   }
// }
```

这些记忆只在对应角色代理运行时注入，不污染其他 Agent 的上下文。

### 9.3 周期大纲（未来扩展）

可选的"周记本"功能：每 7 个游戏日（约 20-30 回合），GM 自动生成一份周期大纲，总结本周期的主线/支线发展，作为下个周期 Outliner 的参考。此功能属于远期目标，不在 V1 实现。

---

## 十、EventBus 事件清单

Agent 系统新增的事件：

| 事件 | 触发时机 | payload |
|------|---------|---------|
| `agent:progress` | 每个 Stage 开始 | `{ stage, detail }` |
| `agent:brainstorm` | 头脑风暴完成 | `{ candidates, selected }` |
| `agent:outline` | 大纲生成完成 | `{ outline }` |
| `agent:review` | 审查完成 | `{ type, result }` |
| `agent:character` | 角色代理完成 | `{ npc, response }` |
| `agent:draft` | 初稿完成 | `{ draft }` |
| `agent:polish` | 润色完成 | `{ finalText }` |
| `agent:fallback` | 降级到单次生成 | `{ reason }` |
| `agent:error` | Agent 调用失败 | `{ agentType, error }` |

---

## 十一、实现优先级

### Phase 1 — MVP（最小可行）
1. `AgentRunner` — Agent 调用执行器（含 Manifest 上下文裁剪）
2. `AgentPipeline` — 标准模式流水线（Outliner → Critic×2 → Writer → Style Review）
3. `pipeline.js` 集成点（`AgentPipeline.isEnabled()` 分支）
4. 设置面板开关（enabled toggle + mode radio）
5. 基础进度 UI

### Phase 2 — 完整模式
6. Brainstormer Agent
7. CharacterAgent + `state.agent_memories` 持久化
8. 细节审查 Agent
9. 润色阶段
10. 自动升级逻辑（战斗/Boss 自动切换完整模式）

### Phase 3 — 优化
11. Critic 独立模型配置（用廉价模型降低成本）
12. Agent 调用结果缓存（同一回合内避免重复调用）
13. 流式进度（Writer 阶段 chunk by chunk 推送，而非等全部完成）
14. 周期大纲系统

---

## 十二、与现有系统的兼容性矩阵

| 现有模块 | 影响 | 说明 |
|---------|------|------|
| `ai-client.js` | **无修改** | AgentRunner 内部创建独立 AIClient 实例 |
| `pipeline.js` | **最小修改** | `process()` 添加 if 分支；`cancel()` 扩展 |
| `instruction-parser.js` | **无修改** | Writer 输出仍使用标准 XML 标签 |
| `state-manager.js` | **无修改** | 新增 `agent_memories` 路径，但 StateManager 本身不需改动 |
| `memory-system.js` | **无修改** | 标准 `<memory>` 标签照常处理 |
| `settings-panel.js` | **添加配置区** | 新增 Agent 模式开关和模型配置 |
| `default-preset.js` | **无修改** | Writer Agent 复用主预设的文风规范 |
| 事件总线 | **新增事件** | 添加 `agent:*` 系列事件 |
| IndexedDB | **无修改** | `agent_memories` 存在 state 中，跟随 timeline 存档 |
