import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';

class MissionSystem {
  processInstruction(missionData) {
    if (!missionData || typeof missionData !== 'object') {
      console.warn('[MissionSystem] Invalid mission instruction:', typeof missionData);
      return;
    }
    missionData = this._normalizeInstruction(missionData);

    if (missionData.status === 'completed') {
      this._completeMission(missionData);
    } else if (missionData.status === 'active') {
      this._addMission(missionData);
    } else if (missionData.status === 'progress') {
      this._updateMissionProgress(missionData);
    } else if (missionData.status === 'failed') {
      this._failMission(missionData);
    } else if (missionData.status === 'abandoned') {
      this._abandonMission(missionData);
    }

    eventBus.emit('mission:updated', missionData);
  }

  _completeMission(data) {
    const missions = stateManager.getSub('_missions') || {};
    const active = missions.active || {};
    let mission = active[data.id] || data;

    delete active[data.id];
    missions.active = active;

    const missionId = data.id || mission.id;
    if (!missionId) {
      console.warn('[MissionSystem] _completeMission called without valid mission id');
      return null;
    }
    mission = { ...mission, ...data, status: 'completed', completed_at: Date.now() };
    const completed = missions.completed || {};
    completed[missionId] = mission;
    missions.completed = completed;

    const stats = missions.stats || { total_done: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 };
    stats.total_done = (stats.total_done || 0) + 1;
    const rankKey = this._rankKey(mission.rank);
    if (rankKey) stats[rankKey] = (stats[rankKey] || 0) + 1;
    missions.stats = stats;
    stateManager.setSub('_missions', missions);

    stateManager.update([{ key: '进度·已完成任务', op: '+', value: 1 }]);

    const expReward = data.exp_reward ?? data.reward?.exp ?? mission.reward_exp ?? 0;
    const ryoReward = data.ryo_reward ?? data.reward?.ryo ?? mission.reward_ryo ?? 0;
    if (expReward) {
      stateManager.update([{ key: '进度·经验', op: '+', value: expReward }]);
    }
    if (ryoReward) {
      stateManager.update([{ key: '进度·金钱', op: '+', value: ryoReward }]);
    }

    eventBus.emit('mission:completed', mission);
    return mission;
  }

  _addMission(data) {
    const missions = stateManager.getSub('_missions') || {};
    const active = missions.active || {};

    const mission = {
      id: data.id || `mission_${Date.now()}`,
      rank: data.rank || 'D',
      title: data.title || '未知任务',
      description: data.description || '',
      type: data.type || '杂务',
      client: data.client || data.requester || '',
      location: data.location || '',
      objective: data.objective || data.description || '',
      risk: data.risk || '低',
      deadline: data.deadline || '',
      reward_ryo: data.reward?.ryo || data.ryo_reward || 0,
      reward_exp: data.reward?.exp || data.exp_reward || 0,
      clues: data.clues || [],
      progress: data.progress || { current_step: 0, total_steps: data.steps?.length || 0, steps: data.steps || [] },
      status: 'active',
      created_at: Date.now()
    };

    const existing = active[mission.id];
    if (existing) {
      mission.id = existing.id;
      mission.created_at = existing.created_at;
      mission.progress = { ...(existing.progress || {}), ...(mission.progress || {}) };
      mission.clues = this._mergeClues(existing.clues || [], mission.clues || []);
      mission.updated_at = Date.now();
      active[mission.id] = { ...existing, ...mission };
      missions.active = active;
      stateManager.setSub('_missions', missions);
      eventBus.emit('mission:updated-active', active[mission.id]);
      return active[mission.id];
    }

    active[mission.id] = mission;
    missions.active = active;
    stateManager.setSub('_missions', missions);

    eventBus.emit('mission:added', mission);
    return mission;
  }

  _updateMissionProgress(data) {
    const missions = stateManager.getSub('_missions') || {};
    const active = missions.active || {};
    const mission = active[data.id];
    if (!mission) return null;

    const updated = {
      ...mission,
      ...data,
      status: 'active',
      updated_at: Date.now()
    };
    if (data.progress && typeof data.progress === 'object') {
      updated.progress = { ...(mission.progress || {}), ...data.progress };
    }
    if (Array.isArray(data.clues)) {
      const existing = Array.isArray(mission.clues) ? mission.clues : [];
      updated.clues = this._mergeClues(existing, data.clues).slice(-20);
    }
    active[data.id] = updated;
    missions.active = active;
    stateManager.setSub('_missions', missions);
    eventBus.emit('mission:progress', updated);
    return updated;
  }

  _failMission(data) {
    const missions = stateManager.getSub('_missions') || {};
    const active = missions.active || {};
    let mission = active[data.id];
    delete active[data.id];
    if (!mission) mission = data;
    mission = { ...mission, ...data, status: 'failed', failed_at: Date.now() };

    missions.active = active;
    const failed = missions.failed || {};
    failed[mission.id] = mission;
    missions.failed = failed;

    const stats = missions.stats || { total_done: 0, total_failed: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 };
    stats.total_failed = (stats.total_failed || 0) + 1;
    missions.stats = stats;
    stateManager.setSub('_missions', missions);

    eventBus.emit('mission:failed', mission);
    return mission;
  }

  _abandonMission(data) {
    const missions = stateManager.getSub('_missions') || {};
    const active = missions.active || {};
    const mission = active[data.id];
    if (!mission) return null;
    delete active[data.id];
    missions.active = active;

    const abandoned = { ...mission, ...data, status: 'abandoned', abandoned_at: Date.now() };
    const failed = missions.failed || {};
    failed[abandoned.id] = abandoned;
    missions.failed = failed;

    const stats = missions.stats || { total_done: 0, total_failed: 0, total_abandoned: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 };
    stats.total_abandoned = (stats.total_abandoned || 0) + 1;
    missions.stats = stats;
    stateManager.setSub('_missions', missions);

    eventBus.emit('mission:abandoned', abandoned);
    return abandoned;
  }

  getActiveMissions() {
    const missions = stateManager.getSub('_missions') || {};
    const active = missions.active || {};
    return Object.values(active);
  }

  getCompletedMissions() {
    const missions = stateManager.getSub('_missions') || {};
    const completed = missions.completed || {};
    return Object.values(completed);
  }

  getAvailableMissions() {
    const missions = stateManager.getSub('_missions') || {};
    const available = missions.available || {};
    return Object.values(available);
  }

  getMissionStats() {
    const missions = stateManager.getSub('_missions') || {};
    return missions.stats || { total_done: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 };
  }

  _rankKey(rank) {
    const key = `${String(rank || 'D').trim().toLowerCase()}_rank`;
    return ['d_rank', 'c_rank', 'b_rank', 'a_rank', 's_rank'].includes(key) ? key : null;
  }

  _normalizeInstruction(data) {
    const next = { ...data };
    const isNewMissionStatus = next.status === 'accepted' || next.status === 'in_progress';
    if (isNewMissionStatus) next.status = 'active';
    if (next.progress_update && !next.progress) {
      next.progress = {
        current_step: next.progress_update.step,
        note: next.progress_update.note
      };
      if (!isNewMissionStatus) next.status = 'progress';
    }
    return next;
  }

  _mergeClues(existing, incoming) {
    const result = [...existing];
    for (const clue of incoming) {
      const key = this._clueKey(clue);
      if (!key || result.some(item => this._clueKey(item) === key)) continue;
      result.push(clue);
    }
    return result;
  }

  _clueKey(clue) {
    if (typeof clue === 'string') return clue.trim();
    if (!clue || typeof clue !== 'object') return '';
    return `${clue.title || ''}|${clue.detail || clue.description || ''}`.trim();
  }
}

export const missionSystem = new MissionSystem();
export default missionSystem;
