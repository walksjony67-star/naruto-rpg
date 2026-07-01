# Agent 模式重构 — 剩余变更文档

## 已完成 (阶段1+2)

| 文件 | 变更 |
|------|------|
| `agent-config.js` | `autoUpgrade: true` → `false` |
| `pipeline.js:72` | `execute()` 传 `messages` 给 AgentPipeline |
| `agent-pipeline.js` | `execute()` / `_run()` / `_writeDraft()` / `_polishDraft()` 透传 `mainMessages` |
| `agent-pipeline.js` | 角色代理触发条件：移除 `isFullMode` 限制 → 大纲含NPC即触发 |
| `agent-pipeline.js` | `_hasSignificantSuggestions` 阈值放宽：score<8 / suggestions≥2 / issues≥1 |
| `agent-runner.js` | 新增 Writer 继承模式：检测 `_inheritFromMainPipeline` → 复用主 Pipeline 消息数组 |
| `agent-runner.js` | 新增 `_buildWriterConstraint()`：大纲Markdown+审查硬约束+角色档案+NO_VAR_INSTRUCTION |
| `agent-runner.js` | `_buildPresetMessages` 中 `state.player?.name` → `state['玩家·姓名']` |
| `agent-prompts.js` | 4 个 critic 全部加上输出约束（最多5条/倒序/合并重复/评分标准） |
| `agent-prompts.js` | Writer / WriterPolish / Character / Outliner 提示词重写 |
| `agent-manifests.js` | critic-realism/character/detail 状态字段扩展（加 _relationships/_missions/_memory/_agent_memories） |

---

## 待完成

### 1. 删除 `_buildStateMd` 冗余调用

**文件**: `js/core/agent-pipeline.js`

**问题**: `_run()` 在 Stage 1 生成 `stateMd`，然后传给 `_brainstorm()`、`_generateOutline()`、`_buildCharacterTaskPrompt()` 的 taskPrompt 中。但所有 Agent 已经通过 `manifest.stateFields` 拿到状态数据（agent-runner.js 的 `_extractStateSlice`）。同一份数据在 taskPrompt 中以 Markdown 形式重复出现，浪费 token 且分散 AI 注意力。

**修改**: 删除 `stateMd` 生成和使用，让各 Agent 只通过 manifest 拿状态。

1. 在 `_run()` 中删除 stage 1 的 `_buildStateMd` 调用：

```js
// 删除这行 (约第64-65行):
onProgress('state_snap', '生成状态快照...');
const stateMd = this._buildStateMd(state);

// 改为:
onProgress('state_snap', '生成状态快照...');
```

2. 删除 `_brainstorm()` 的 `stateMd` 参数，taskPrompt 改为只含玩家输入：

```js
// 修改前 (约第150-157行):
async _brainstorm(state, userInput, stateMd) {
  ...
  taskPrompt: `当前场景摘要:\n${stateMd}\n\n请根据玩家输入提出 3-5 条剧情走向候选。`,
}

// 修改后:
async _brainstorm(state, userInput) {
  ...
  taskPrompt: '请根据当前状态和玩家输入，提出 3-5 条剧情走向候选。',
}
```

3. 删除 `_generateOutline()` 的 `stateMd` 参数，taskPrompt 改为：

```js
// 修改前 (约第167-179行):
async _generateOutline(state, userInput, stateMd, direction) {
  ...
  taskPrompt: `${stateMd}${hint}\n\n请为本回合生成叙事大纲。`,
}

// 修改后:
async _generateOutline(state, userInput, direction) {
  ...
  taskPrompt: `请根据当前状态为本回合生成叙事大纲。${hint}`,
}
```

4. 删除 `_buildCharacterTaskPrompt()` 的 `stateMd` 参数，场景部分直接用状态字段重构：

```js
// 修改前 (约第361-384行):
_buildCharacterTaskPrompt(npcName, state, stateMd, outline) {
  ...
  prompt += `\n场景:\n${stateMd}\n`;
}

// 修改后:
_buildCharacterTaskPrompt(npcName, state, outline) {
  // 从 state 中构建场景摘要
  const scenes = (outline.beats || []).map(b => b.scene).filter(Boolean);
  const sceneSummary = [
    `位置: ${state['世界·地点'] || '木叶隐村'} | 天气: ${state['世界·天气'] || '晴'}`,
    `时间: ${state['世界·时间'] || ''}`,
    scenes.length ? `剧情: ${scenes.join(' | ')}` : ''
  ].filter(Boolean).join('\n');
  prompt += `\n场景:\n${sceneSummary}\n`;
}
```

5. 删除 `_buildStateMd()` 方法本身（约第423-445行）。

6. 更新所有调用点（`_brainstorm`、`_generateOutline`、`_buildCharacterTaskPrompt` 的调用）。

**调用链更新**:

```js
// _run() 中约第73行:
selectedDirection = await this._brainstorm(state, userInput); // 去掉 stateMd

// _run() 中约第83行:
const outline = await this._generateOutline(state, userInput, selectedDirection); // 去掉 stateMd

// _run() 中约第100行 (_runCharacterAgents 内部调用):
taskPrompt: this._buildCharacterTaskPrompt(npcName, state, outline),
```

---

### 2. Writer/Polish 继承模式去掉重复的 manifest 处理

**文件**: `js/core/agent-runner.js`

**问题**: `run()` 方法中，agentType 为 writer/writer-polish 时，虽然 `_buildMessages()` 识别了继承模式并直接返回约束数组，但 `run()` 仍加载 manifest 并传给 `_buildMessages()`。这个 manifest 在继承模式下被忽略，但增加了不必要的开销。

**修改**: 不需要改动。当前的代码（继承模式在 `_buildMessages()` 的第一行就 return）已经正确。保持现状即可。

**验证要点**: writer-manifest 的 `includePreset` 在继承模式下不应再被读取（因为 `_buildMessages` 早期 return 跳过了预设构建逻辑）。

---

### 3. Critic 审查结果强化为硬约束

**文件**: `js/core/agent-pipeline.js`

**问题**: `_mergeOutlineReviews()` 将 critic issues 附加到 beats 上（`beat._reviews`），但这些只是"标记"没有强制执行。Writer 约束块虽然显示了这些标注，但没有强制约束语言。

**修改**: 改进 `_mergeOutlineReviews()` 让它生成可读性更强的硬约束文本：

```js
// 修改前 (约第213-228行):
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

// 修改后:
_mergeOutlineReviews(outline, reviews) {
    const merged = JSON.parse(JSON.stringify(outline));
    merged._hardConstraints = [];  // 新增：硬约束列表给 Writer
    
    for (const [, result] of reviews) {
      if (!result.success || !result.data?.issues) continue;
      for (const issue of result.data.issues) {
        if (issue.severity === 'error' && issue.beatId) {
          const beat = merged.beats.find(b => b.id === issue.beatId);
          if (beat) {
            beat._reviews = beat._reviews || [];
            beat._reviews.push(issue);
            merged._hardConstraints.push(
              `[Beat ${issue.beatId}] ${issue.rule}: ${issue.suggestion || issue.description}`
            );
          }
        }
      }
    }
    return merged;
}
```

然后在 `_writeDraft()` 中，将 `merged._hardConstraints` 注入到 extraContext 的 reviewSummary 中。

---

### 4. 更新 BRAINSTORMER 提示词约束

**文件**: `js/core/agent-prompts.js`

**当前内容** (第3-15行):
```js
BRAINSTORMER: `你是火影忍者TRPG的剧情头脑风暴器。

任务：根据当前场景和玩家输入，提出 3-5 条可能的剧情走向。

要求：
- 每条走向一句话概括 + 一句话展开（为什么有趣/合理）
- 至少包含：1条安全/预期内走向、1条意外但合理的走向、1条高风险高回报走向
- 考虑NPC的独立动机，不要一切围绕玩家转
- 战斗中不需要头脑风暴，直接跳过
- 走向应当与当前时间线和忍阶匹配，不可超出角色能力范围

输出严格JSON，不要附加任何额外文字：
{"candidates":[{"id":1,"direction":"...","reason":"...","risk":"low|medium|high"}],"recommended":1}`,
```

**修改为**:
```js
BRAINSTORMER: `你是火影忍者TRPG的剧情头脑风暴器。

任务：根据当前场景和玩家输入，提出 3-5 条可能的剧情走向。

要求：
- 每条走向一句话概括 + 一句话展开（为什么有趣/合理）
- 至少包含：1条安全/预期内走向、1条意外但合理的走向、1条高风险高回报走向
- 考虑NPC的独立动机，不要一切围绕玩家转
- 战斗中不需要头脑风暴，直接跳过（返回空candidates数组）
- 走向应当与当前时间线和忍阶匹配，不可超出角色能力范围

输出约束：
- 推荐字段(recommended)指向你认为最佳的候选id
- 不输出空话、"你好"、解释性文字

输出严格JSON，不要附加任何额外文字：
{"candidates":[{"id":1,"direction":"...","reason":"...","risk":"low|medium|high"}],"recommended":1}`,
```

---

### 5. Writer manifest 关闭 includePreset

**文件**: `js/core/agent-manifests.js`

**问题**: Writer manifest 的 `includePreset: true` 会在标准 Agent 模式（非继承）下推送多Agent合议预设的全部条目，这与主 Pipeline 的输出格式冲突。

**但是**: 现在 Writer 已经走继承模式（`_inheritFromMainPipeline: true`），manifest 的这个字段在继承模式下不会被读取。保险起见还是关掉：

```js
// 修改前 (约第50-57行):
writer: {
    stateFields: [...],
    includeHistory: true,
    historyTurns: 4,
    includePreset: true,   // ← 改为 false
    maxContextChars: 12000,
    systemPromptKey: 'WRITER'
},

// 修改后:
writer: {
    stateFields: [...],
    includeHistory: true,
    historyTurns: 4,
    includePreset: false,  // 继承模式下由主Pipeline控制预设
    maxContextChars: 12000,
    systemPromptKey: 'WRITER'
},
```

---

### 6. 阶段 4 — UI 透明度（后续可选）

**文件**: `js/ui/agent-progress.js`

**目标**: 让用户看到 Agent 模式的实际效果。

**待添加功能**:
1. 每个阶段显示实际耗时（通过 Date.now() 差值计算）
2. review 阶段显示 critic 评分
3. polish 阶段显示"已触发润色"或"无需润色(评分7.5)")
4. 完成后保留 5 秒可点击展开详情
5. 底部显示总 token 估算（通过各阶段 max_tokens 累加）

**实现思路**:
- 在 `_onProgress(stage, detail)` 中记录 `Date.now()` 作为阶段开始时间
- 当下一个阶段触发时，计算前一阶段耗时并存储到 `this._stageTimes[prevStage]`
- 在 `_update()` 渲染中，每个完成的阶段显示耗时
- 从 eventBus 监听 `agent:outline` 获取 critic 评分
- 从 eventBus 监听 `agent:draft` 获取 draft 信息

**不需要立即实施，标记为 TODO**。

---

### 7. 阶段 4 — 设置面板标注成本

**文件**: `js/ui/settings-panel.js`

**当前内容** (约第151-163行):
```html
<select name="agentMode" ...>
  <option value="standard" ...>标准 (大纲+审查+写作, +4次调用)</option>
  <option value="full" ...>完整 (头脑风暴+角色代理, +7-10次)</option>
</select>
```

**修改**: 在 mode select 的 `<option>` 文字中加上预计耗时，让用户做明确权衡：

```html
<select name="agentMode" ...>
  <option value="standard" ...>标准模式 (+3-4次调用, 约30-60s)</option>
  <option value="full" ...>完整模式 (+8-11次调用, 约90-180s)</option>
</select>
```

同时修改描述文字：
```html
<p style="font-size:11px;">
  开启后每回合由多个AI Agent协作生成：大纲→审查→写作→审查→润色。<br>
  完整模式增加头脑风暴和角色代理。建议战斗/重要场景开启，日常关闭。
</p>
```

---

## 验证检查清单

执行完以上变更后，按以下步骤验证：

1. **语法检查**: `node --check js/core/agent-pipeline.js js/core/agent-runner.js js/core/agent-prompts.js js/core/agent-manifests.js`
2. **搜索旧路径残留**: `rg "state\.player\.name|state\.player\?\.name" js/core/agent-runner.js` → 应无结果
3. **搜索导入检查**: `rg "import.*default-preset" js/core/agent-runner.js` → 确认存在（_buildPresetMessages 需要）
4. **搜索 NO_VAR_INSTRUCTION**: `rg "NO_VAR_INSTRUCTION" js/core/agent-runner.js` → 确认存在且只导入一次
5. **搜索 _buildStateMd**: `rg "_buildStateMd" js/core/agent-pipeline.js` → 应无结果（如果执行了第1步）
