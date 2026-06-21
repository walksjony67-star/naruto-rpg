export const AGENT_MANIFESTS = {
  brainstormer: {
    stateFields: ['player.name', 'player.rank', 'player.village', 'player.current_goal', 'world_state', 'memory.recent_summary', 'combat'],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 3000,
    systemPromptKey: 'BRAINSTORMER'
  },
  outliner: {
    stateFields: ['player', 'attributes', 'skills', 'missions', 'world_state', 'combat', 'memory', 'relationships'],
    includeHistory: true,
    historyTurns: 2,
    includePreset: false,
    maxContextChars: 8000,
    systemPromptKey: 'OUTLINER'
  },
  'critic-realism': {
    stateFields: ['world_state', 'player.rank', 'player.village', 'player.chakra_nature', 'attributes'],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 4000,
    systemPromptKey: 'CRITIC_REALISM'
  },
  'critic-character': {
    stateFields: ['player', 'relationships', 'memory.npc_notes'],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 4000,
    systemPromptKey: 'CRITIC_CHARACTER'
  },
  'critic-detail': {
    stateFields: ['world_state.current_location', 'world_state.weather', 'combat'],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 3000,
    systemPromptKey: 'CRITIC_DETAIL'
  },
  'critic-style': {
    stateFields: [],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 3000,
    systemPromptKey: 'CRITIC_STYLE'
  },
  writer: {
    stateFields: ['player', 'attributes', 'skills', 'equipment', 'missions', 'relationships', 'world_state', 'combat', 'memory', 'progression'],
    includeHistory: true,
    historyTurns: 4,
    includePreset: true,
    maxContextChars: 12000,
    systemPromptKey: 'WRITER'
  },
  'writer-polish': {
    stateFields: ['player.name', 'world_state.current_location'],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 2000,
    systemPromptKey: 'WRITER_POLISH'
  },
  character: {
    stateFields: ['world_state.current_location', 'world_state.weather', 'combat'],
    includeHistory: false,
    historyTurns: 0,
    includePreset: false,
    maxContextChars: 2000,
    systemPromptKey: 'CHARACTER_AGENT'
  }
};

export const AGENT_TIMEOUTS = {
  brainstormer: 20000,
  outliner: 35000,
  'critic-realism': 20000,
  'critic-character': 20000,
  'critic-detail': 20000,
  'critic-style': 20000,
  writer: 90000,
  'writer-polish': 90000,
  character: 25000,
  pipeline_total: 240000
};
