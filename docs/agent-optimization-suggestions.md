# Agent 系统优化建议

基于对当前实现的审计和业界最佳实践（OpenCode、Aider、Cline等Agent架构），提出以下优化方向。

---

## 一、提示词质量优化

### 1.1 OUTLINER 提示词强化

**当前问题**：
- 对话标注规则埋在提示词中部，容易被忽略
- 没有明确的失败案例示范

**建议改进**：
```markdown
## 核心规则（违反将导致后续流程失败）

1. **对话标注格式**：
   - ✓ 正确："卡卡西: 你的查克拉控制需要加强"
   - ✗ 错误："路人A: 欢迎"、"中忍: 是的"
   - 必须使用确切NPC姓名，不用泛称

2. **mood 枚举约束**：
   - 仅限：紧张/轻松/热血/悲伤/日常/诡异
   - 不用："平静中带着紧张"

3. **variables 数组**：
   - 仅限：variable/combat/relationship/memory/mission
   - 必须与 beat 内容匹配
```

### 1.2 CRITIC 提示词优化

**当前问题**：
- "最多输出5条"约束较弱
- 评分标准不够具体

**建议改进**：
```markdown
输出约束（严格执行）：
- issues 数组最多 5 条，超过 5 条时只保留最严重的
- 按 severity 倒序排列（error 在前，warning 在后）
- 合并重复或相似问题为一条
- score 评分标准：
  * 10 = 无懈可击，可直接发布
  * 8-9 = 优秀，仅需微调
  * 6-7 = 合格，存在可改进点
  * 4-5 = 明显问题，需修正
  * 1-3 = 严重问题，必须重写

若全部beats无问题，输出：
{"issues":[],"approved":true,"summary":"大纲整体符合要求"}
```

### 1.3 WRITER 提示词精简

**当前问题**：
- 提示词假设Writer能看到"主系统已构建好的完整叙事上下文"，但实际这些内容在 `_buildWriterConstraint()` 中才注入
- "继承主系统的全部叙事铁律"这种指代不明确

**建议改进**：
```markdown
你是火影忍者TRPG的高级正文作家。你将收到：
- 主系统预设（沉浸铁律、世界书、Few-shot示例）
- [Writer硬约束]块（大纲、审查issues、角色档案）

执行准则：
1. 严格按 beats 顺序展开，每个 beat 必须体现
2. 审查 issues 中每一条都必须修正（非建议，是强制）
3. 角色档案中的NPC行为/对话/内心必须在正文中具体体现
4. 输出格式：<status_query /> → 正文 → 「」选项 → 结构标签

【关于变量标签】
- 若主系统启用二次模型：不输出 <var> 标签
- 若未启用：必须在正文末尾输出完整标签块
```

---

##二、Agent 配置优化

### 2.1 stateFields 精简

**问题**：部分 Agent 的 `stateFields` 包含冗余字段。

**建议调整**：

```javascript
// outliner: 当前包含所有技能（$prefix:技能·），但实际只需要知道"有哪些类型"
outliner: {
  stateFields: [
    '玩家·姓名', '玩家·忍阶', '玩家·所属村', '玩家·查克拉属性', '玩家·战力等级',
    '属性·查克拉', '属性·当前查克拉', '属性·体力', '属性·当前体力',
    '_missions', '世界·地点', '世界·时间', '世界·年代', '世界·天气',
    '_combat', '_memory.recent_summary', '_relationships'
  ],
  // 移除具体技能列表，改为在 extraContext 中注入"技能类型摘要"（如"掌握3种忍术、2种体术"）
}

// critic-detail: 当前只需场景信息，不需要 _relationships
'critic-detail': {
  stateFields: ['世界·地点', '世界·天气', '_combat'],
  // 移除 _relationships
}
```

### 2.2 historyTurns 优化

**问题**：
- `outliner` 设置 `historyTurns: 2`，但实际需要更长历史来保持剧情连贯性
- `writer` 设置 `historyTurns: 4`，可能导致token浪费

**建议**：
```javascript
outliner: { historyTurns: 3 },  // 增加1轮，帮助理解剧情走向
writer: { historyTurns: 3 },    // 减少1轮，因为已有 outline 提供结构
```

### 2.3 maxContextChars 调整

**问题**：部分 Agent 的上下文限制过于宽松。

**建议**：
```javascript
'critic-realism': { maxContextChars: 4000 },  // 当前5000，可压缩
'critic-character': { maxContextChars: 4000 }, // 当前5000，可压缩
brainstormer: { maxContextChars: 2500 },      // 当前3000，可压缩
```

---

## 三、Pipeline 流程优化

### 3.1 Critic 并行度提升

**当前实现**：
- outline review: 2个并行（realism + character）
- draft review: 1-2个并行（style + detail）

**建议**：
```javascript
// _reviewOutline 增加 detail critic（提前检查感官描写规划）
async _reviewOutline(state, outline) {
  const agents = [
    { type: 'critic-realism', ... },
    { type: 'critic-character', ... },
    { type: 'critic-detail', params: {
      taskPrompt: '请审查大纲中的场景描写规划是否具体（避免"一丝"、"仿佛"等懒惰词）',
      extraContext: { outline }
    }}
  ];
  return await this.runner.runParallel(agents);
}
```

### 3.2 Polish 阈值动态调整

**当前实现**：
```javascript
_hasSignificantSuggestions(reviews) {
  for (const [, result] of reviews) {
    if (score < 8 || suggestions.length >= 2 || issues.length >= 1) return true;
  }
  return false;
}
```

**建议**：根据 Agent 模式动态调整
```javascript
_hasSignificantSuggestions(reviews, isFullMode) {
  const threshold = isFullMode ? 7.5 : 8.0;  // 完整模式更宽容
  for (const [, result] of reviews) {
    if (score < threshold) return true;
    if (suggestions.length >= 3) return true;  // 从2改为3
    if (issues.filter(i => i.severity === 'error').length >= 1) return true;  // 只看error
  }
  return false;
}
```

### 3.3 Character Agent 失败降级

**当前实现**：Character Agent 失败时整个阶段跳过。

**建议**：部分失败时保留成功的结果
```javascript
async _runCharacterAgents(state, userInput, npcNames, outline) {
  const agents = npcNames.map(...);
  const results = await this.runner.runParallel(agents);
  
  const inputs = [];
  const failed = [];
  for (const [key, result] of results) {
    const npcName = key.replace(/^char-\d+-/, '');
    if (!result.success) {
      failed.push(npcName);
      continue;
    }
    inputs.push({ npcName, npc: npcName, ...result.data });
    eventBus.emit('agent:character', { npc: npcName, response: result.data });
  }
  
  if (failed.length > 0) {
    console.warn(`[AgentPipeline] Character agents failed for: ${failed.join(', ')}`);
  }
  
  return inputs;  // 返回部分成功的结果
}
```

---

## 四、Token 效率优化

### 4.1 状态注入压缩

**当前实现**：
```javascript
const stateText = JSON.stringify(stateSlice, null, 0).slice(0, manifest.maxContextChars);
userContent += `[当前游戏状态]\n${stateText}\n\n`;
```

**问题**：JSON 格式冗余（大量引号、括号）

**建议**：使用紧凑格式
```javascript
function formatStateCompact(stateSlice) {
  const lines = [];
  for (const [key, value] of Object.entries(stateSlice)) {
    if (key.startsWith('_')) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

// 使用
const stateText = formatStateCompact(stateSlice).slice(0, manifest.maxContextChars);
```

### 4.2 extraContext 条件注入

**当前实现**：所有 extraContext 字段都拼接到 userContent。

**建议**：按 Agent 类型选择性注入
```javascript
_buildMessages(agentType, manifest, { state, userInput, taskPrompt, extraContext }) {
  // ...
  
  let userContent = '';
  const stateSlice = this._extractStateSlice(state, manifest.stateFields);
  if (Object.keys(stateSlice).length > 0) {
    userContent += `[当前游戏状态]\n${formatStateCompact(stateSlice)}\n\n`;
  }

  // 按 Agent 类型注入
  const needsOutline = ['critic-realism', 'critic-character', 'critic-detail', 'character'];
  const needsDraft = ['critic-style', 'critic-detail', 'writer-polish'];
  const needsReviews = [];  // 无，因为 reviews 通过 writer constraint 注入
  
  if (needsOutline.includes(agentType) && extraContext.outline) {
    userContent += `[叙事大纲]\n${JSON.stringify(extraContext.outline)}\n\n`;
  }
  if (needsDraft.includes(agentType) && extraContext.draft) {
    userContent += `[正文草稿]\n${extraContext.draft}\n\n`;
  }
  // ...
}
```

### 4.3 历史消息裁剪优化

**当前实现**：直接取最后 N*2 条消息。

**建议**：智能裁剪（保留用户输入，压缩AI长回复）
```javascript
if (manifest.includeHistory && manifest.historyTurns > 0 && extraContext._pipeline) {
  const history = extraContext._pipeline.getHistory();
  const recent = history.slice(-(manifest.historyTurns * 2));
  
  // 压缩过长的 AI 回复
  const compressed = recent.map(msg => {
    if (msg.role === 'assistant' && msg.content.length > 800) {
      return {
        role: msg.role,
        content: msg.content.slice(0, 400) + '\n[...已省略中间部分...]\n' + msg.content.slice(-400)
      };
    }
    return msg;
  });
  
  if (compressed.length > 0) messages.push(...compressed);
}
```

---

## 五、错误处理增强

### 5.1 超时重试机制

**当前实现**：超时直接抛出错误。

**建议**：关键 Agent 自动重试
```javascript
async run(agentType, params, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await this._runOnce(agentType, params);
    } catch (err) {
      if (err instanceof AgentAbortError) throw err;
      if (attempt === retries) throw err;
      
      const isTimeout = err.message?.includes('timeout');
      if (isTimeout && ['outliner', 'writer'].includes(agentType)) {
        console.warn(`[AgentRunner] ${agentType} timeout, retry ${attempt + 1}/${retries}`);
        await new Promise(r => setTimeout(r, 1000));  // 等待1秒
        continue;
      }
      throw err;
    }
  }
}
```

### 5.2 JSON 解析失败降级

**当前实现**：JSON 解析失败时返回 `{_raw: text}`。

**建议**：对 Critic Agent 尝试修复
```javascript
_parseResponse(response, agentType) {
  const text = response.trim();
  
  // 尝试直接解析
  try { return JSON.parse(text); } catch {}
  
  // 尝试提取 JSON 块
  const jsonBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock) { try { return JSON.parse(jsonBlock[1]); } catch {} }
  
  // Critic Agent 专用：修复常见错误
  if (agentType.startsWith('critic-')) {
    try {
      let fixed = text
        .replace(/,(\s*[}\]])/g, '$1')  // 去掉尾随逗号
        .replace(/'/g, '"')             // 单引号改双引号
        .replace(/(\w+):/g, '"$1":');   // 键名加引号
      return JSON.parse(fixed);
    } catch {}
  }
  
  // Writer 返回原文
  if (['writer', 'writer-polish'].includes(agentType)) {
    return { _raw: text };
  }
  
  console.warn(`[AgentRunner] ${agentType} 解析失败，返回空结果`);
  return agentType.startsWith('critic-') 
    ? { issues: [], approved: false, summary: '解析失败' }
    : { _raw: text };
}
```

---

## 六、监控与调试

### 6.1 增加性能埋点

**建议**：在 `agent-pipeline.js` 中记录每个阶段耗时
```javascript
async _run(state, userInput, onProgress, isFullMode, isCombat, mainMessages) {
  const timings = {};
  const t0 = Date.now();
  
  onProgress('state_snap', '生成状态快照...');
  timings.state_snap = Date.now() - t0;
  this._checkAbort();
  
  // brainstorm
  let t1 = Date.now();
  if (isFullMode && !isCombat) {
    selectedDirection = await this._brainstorm(...);
    timings.brainstorm = Date.now() - t1;
  }
  
  // ...其他阶段
  
  timings.total = Date.now() - t0;
  eventBus.emit('agent:pipeline-complete', { timings });
  console.log('[AgentPipeline] Timings:', timings);
  
  return finalText;
}
```

### 6.2 Token 消耗统计

**建议**：在 `AIClient` 中记录每次调用的 token 消耗
```javascript
async chat(messages, options) {
  const response = await this._rawCall(messages, options);
  
  const usage = response.usage || {};
  eventBus.emit('ai:token-usage', {
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0
  });
  
  return response.content;
}
```

---

## 七、优先级排序

基于影响力和实施难度，建议优先实施：

### P0（立即实施）
1. ✅ 硬约束注入到 Writer（已修复）
2. OUTLINER 对话标注规则前置
3. Character Agent 部分失败降级

### P1（本周内）
4. Critic 提示词强化（评分标准）
5. stateFields 精简（outliner/critic-detail）
6. JSON 解析失败降级

### P2（迭代优化）
7. 历史消息智能裁剪
8. 状态注入压缩格式
9. 性能埋点和 Token 统计

### P3（长期优化）
10. 超时重试机制
11. Outline review 增加 detail critic
12. Polish 阈值动态调整

---

## 八、测试验证

每项优化完成后，建议通过以下场景验证：

1. **战斗场景**（full模式）：验证 Character Agent、Critic 并行度
2. **日常对话**（standard模式）：验证 Token 压缩、历史裁剪
3. **长篇任务**（10+ 回合）：验证历史记忆、状态压缩
4. **网络不稳定**：验证超时重试、降级逻辑

---

**文档版本**：v1.0  
**更新日期**：2026-06-30  
**作者**：Agent 系统重构小组
