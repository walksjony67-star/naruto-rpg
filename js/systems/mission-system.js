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
    const activeMissions = stateManager.get('missions.active') || [];
    const idx = activeMissions.findIndex(m => m.id === data.id);
    let mission = null;
    if (idx !== -1) {
      mission = activeMissions.splice(idx, 1)[0];
      stateManager.update([
        { path: 'missions.active', op: 'set', value: activeMissions }
      ]);
    }
    if (!mission) {
      console.warn('[MissionSystem] Completing inactive mission from instruction:', data.id);
      mission = data;
    }

    mission = { ...(mission || {}), ...data, status: 'completed', completed_at: Date.now() };
    const updates = [
      { path: 'missions.completed', op: 'push', value: mission },
      { path: 'missions.stats.total_done', op: 'add', value: 1 },
      { path: 'missions.stats.total_completed', op: 'add', value: 1 },
      { path: 'progression.missions_done', op: 'add', value: 1 }
    ];
    const rankKey = this._rankKey(mission.rank);
    if (rankKey) updates.push({ path: `missions.stats.${rankKey}`, op: 'add', value: 1 });
    stateManager.update(updates);

    const expReward = data.exp_reward ?? data.reward?.exp ?? mission.reward_exp ?? 0;
    const ryoReward = data.ryo_reward ?? data.reward?.ryo ?? mission.reward_ryo ?? 0;
    if (expReward) {
      stateManager.update([{ path: 'progression.exp', op: 'add', value: expReward }]);
    }
    if (ryoReward) {
      stateManager.update([{ path: 'equipment.ryo', op: 'add', value: ryoReward }]);
    }

    eventBus.emit('mission:completed', mission);
    return mission;
  }

  _addMission(data) {
    const activeMissions = stateManager.get('missions.active') || [];
    const existingIdx = data.id ? activeMissions.findIndex(m => m.id === data.id) : -1;
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

    if (existingIdx !== -1) {
      activeMissions[existingIdx] = {
        ...activeMissions[existingIdx],
        ...mission,
        progress: { ...(activeMissions[existingIdx].progress || {}), ...(mission.progress || {}) },
        clues: this._mergeClues(activeMissions[existingIdx].clues || [], mission.clues || []),
        created_at: activeMissions[existingIdx].created_at,
        updated_at: Date.now()
      };
      stateManager.update([{ path: 'missions.active', op: 'set', value: activeMissions }]);
      eventBus.emit('mission:updated-active', activeMissions[existingIdx]);
      return activeMissions[existingIdx];
    }

    stateManager.update([
      { path: 'missions.active', op: 'push', value: mission }
    ]);

    eventBus.emit('mission:added', mission);
    return mission;
  }

  _updateMissionProgress(data) {
    const activeMissions = stateManager.get('missions.active') || [];
    const idx = activeMissions.findIndex(m => m.id === data.id);
    if (idx === -1) return null;

    const mission = {
      ...activeMissions[idx],
      ...data,
      status: 'active',
      updated_at: Date.now()
    };
    if (data.progress && typeof data.progress === 'object') {
      mission.progress = { ...(activeMissions[idx].progress || {}), ...data.progress };
    }
    if (Array.isArray(data.clues)) {
      const existing = Array.isArray(activeMissions[idx].clues) ? activeMissions[idx].clues : [];
      mission.clues = this._mergeClues(existing, data.clues).slice(-20);
    }
    activeMissions[idx] = mission;
    stateManager.update([{ path: 'missions.active', op: 'set', value: activeMissions }]);
    eventBus.emit('mission:progress', mission);
    return mission;
  }

  _failMission(data) {
    const activeMissions = stateManager.get('missions.active') || [];
    const idx = activeMissions.findIndex(m => m.id === data.id);
    let mission = null;
    if (idx !== -1) {
      mission = activeMissions.splice(idx, 1)[0];
    }
    mission = { ...(mission || {}), ...data, status: 'failed', failed_at: Date.now() };
    const updates = [
      { path: 'missions.active', op: 'set', value: activeMissions },
      { path: 'missions.failed', op: 'push', value: mission },
      { path: 'missions.stats.total_done', op: 'add', value: 1 },
      { path: 'missions.stats.total_failed', op: 'add', value: 1 }
    ];
    const rankKey = this._rankKey(mission.rank);
    if (rankKey) updates.push({ path: `missions.stats.${rankKey}`, op: 'add', value: 1 });
    stateManager.update(updates);
    eventBus.emit('mission:failed', mission);
    return mission;
  }

  _abandonMission(data) {
    const activeMissions = stateManager.get('missions.active') || [];
    const idx = activeMissions.findIndex(m => m.id === data.id);
    if (idx === -1) return null;
    const mission = { ...activeMissions.splice(idx, 1)[0], ...data, status: 'abandoned', abandoned_at: Date.now() };
    stateManager.update([
      { path: 'missions.active', op: 'set', value: activeMissions },
      { path: 'missions.failed', op: 'push', value: mission },
      { path: 'missions.stats.total_abandoned', op: 'add', value: 1 },
      { path: 'progression.reputation.木叶隐村', op: 'add', value: -10 }
    ]);
    eventBus.emit('mission:abandoned', mission);
    return mission;
  }

  getActiveMissions() {
    return stateManager.get('missions.active') || [];
  }

  getCompletedMissions() {
    return stateManager.get('missions.completed') || [];
  }

  getAvailableMissions() {
    return stateManager.get('missions.available') || [];
  }

  getMissionStats() {
    return stateManager.get('missions.stats') || { total_done: 0, d_rank: 0, c_rank: 0, b_rank: 0, a_rank: 0, s_rank: 0 };
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
