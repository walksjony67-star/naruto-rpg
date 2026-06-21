import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';

class WorldStateSystem {
  getWorldState() {
    return stateManager.get('world_state');
  }

  getCurrentLocation() {
    return stateManager.get('world_state.current_location') || '木叶隐村';
  }

  setLocation(location) {
    stateManager.update([
      { path: 'world_state.current_location', op: 'set', value: location }
    ]);
    eventBus.emit('world:location-changed', { location });
  }

  getCalendar() {
    return stateManager.get('world_state.calendar') || {
      year: '木叶48年', season: '春', day: 1, time_of_day: '清晨'
    };
  }

  advanceTime(mode = 'scene') {
    const cal = this._validateCalendar(this.getCalendar());
    const timeOrder = ['清晨', '上午', '正午', '午后', '傍晚', '夜晚', '深夜'];

    const currentTimeIdx = timeOrder.indexOf(cal.time_of_day || '清晨');

    switch (mode) {
      case 'moment':
        cal.time_of_day = timeOrder[Math.min(currentTimeIdx + 1, timeOrder.length - 1)];
        break;
      case 'scene':
        cal.time_of_day = timeOrder[Math.min(currentTimeIdx + 2, timeOrder.length - 1)];
        if (currentTimeIdx >= timeOrder.length - 2) {
          cal.day = (cal.day || 1) + 1;
          cal.time_of_day = timeOrder[0];
          this._checkSeasonChange(cal);
        }
        break;
      case 'day':
        cal.day = (cal.day || 1) + 1;
        cal.time_of_day = timeOrder[0];
        this._checkSeasonChange(cal);
        break;
    }

    cal.day = Math.max(1, Math.min(366, Number(cal.day) || 1));

    stateManager.update([
      { path: 'world_state.calendar', op: 'set', value: cal }
    ]);
    eventBus.emit('world:time-advanced', { calendar: cal });
    return cal;
  }

  _validateCalendar(cal) {
    if (!cal || typeof cal !== 'object') {
      console.warn('[WorldState] Calendar is invalid, resetting to default');
      return { year: '木叶48年', season: '春', day: 1, time_of_day: '清晨' };
    }
    return {
      year: cal.year || '木叶48年',
      season: cal.season || '春',
      day: Number.isFinite(Number(cal.day)) && Number(cal.day) > 0 ? Number(cal.day) : 1,
      time_of_day: cal.time_of_day || '清晨'
    };
  }

  _checkSeasonChange(cal) {
    const seasonDays = { '春': 90, '夏': 90, '秋': 90, '冬': 90 };
    const seasonOrder = ['春', '夏', '秋', '冬'];
    if (cal.day > (seasonDays[cal.season] || 90)) {
      cal.day = 1;
      const idx = seasonOrder.indexOf(cal.season);
      if (idx < seasonOrder.length - 1) {
        cal.season = seasonOrder[idx + 1];
      } else {
        cal.season = seasonOrder[0];
        cal.year = this._incrementYear(cal.year);
      }
    }
  }

  _incrementYear(yearStr) {
    const match = yearStr.match(/木叶(\d+)年/);
    if (match) {
      return `木叶${parseInt(match[1]) + 1}年`;
    }
    return yearStr;
  }

  getWeather() {
    return stateManager.get('world_state.weather') || '晴';
  }

  setWeather(weather) {
    stateManager.update([
      { path: 'world_state.weather', op: 'set', value: weather }
    ]);
  }

  triggerEvent(eventData) {
    if (!eventData || typeof eventData !== 'object') {
      console.warn('[WorldState] Invalid event data:', typeof eventData);
      return null;
    }
    const now = Date.now();
    const id = eventData.id || eventData.title || eventData.name || `event_${now}`;
    const status = String(eventData.status || 'triggered').toLowerCase();
    const finalStatuses = new Set(['completed', 'resolved', 'ended', 'failed', 'cancelled']);
    const currentEvents = stateManager.get('world_state.active_events') || [];
    const events = currentEvents.filter(event => this._eventId(event) !== id);
    const entry = {
      ...eventData,
      id,
      status,
      description: eventData.description || eventData.detail || '',
      updated_at: now,
      triggered_at: eventData.triggered_at || now
    };

    if (!finalStatuses.has(status)) events.push(entry);

    const eventLog = stateManager.get('world_state.event_log') || [];
    stateManager.update([
      { path: 'world_state.active_events', op: 'set', value: events },
      { path: 'world_state.event_log', op: 'set', value: [...eventLog, entry].slice(-100) }
    ]);
    eventBus.emit('world:event-triggered', entry);
    return entry;
  }

  getActiveEvents() {
    return stateManager.get('world_state.active_events') || [];
  }

  getTimeline() {
    return stateManager.get('world_state.timeline') || '木叶48年';
  }
  _eventId(event) {
    if (event == null) return '';
    if (typeof event === 'string') return event;
    return event.id || event.title || event.name || event.description || '';
  }
}

export const worldStateSystem = new WorldStateSystem();
export default worldStateSystem;
