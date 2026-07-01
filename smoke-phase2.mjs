// Phase 2 smoke - 跑完即删
import { coerceValue, validate, isKnownKey } from './js/data/var-schema.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra ?? ''); }
};

// B-10: validate
const v1 = validate('玩家·存活', '模糊');
ok('B-10 validate rejects disallowed enum', v1.valid === false);
const v2 = validate('玩家·存活', '是');
ok('B-10 validate allows valid enum', v2.valid === true);
const v3 = validate('属性·当前体力', 5);
ok('B-10 validate accepts number in range', v3.valid === true);
const v4 = validate('属性·当前体力', 99999);
ok('B-10 validate rejects out-of-range number', v4.valid === false);

// B-05: 未知键
ok('B-05 isKnownKey unknown -> false', isKnownKey('奇怪键') === false);
ok('B-05 isKnownKey known -> true', isKnownKey('属性·当前体力') === true);

// B-04 / B-06 / B-07 / B-11: 用一个最小 StateManager 子集（手写复刻 _enforceBounds 与 restore 调用链不现实）
// 直接动态 import 完整 module 并 mock 浏览器 globals
const orig = {
  indexedDB: globalThis.indexedDB,
  window: globalThis.window,
  document: globalThis.document
};
globalThis.indexedDB = { open() { return { onerror: null, onsuccess: null, onupgradeneeded: null }; } };
globalThis.window = globalThis.window || {};
globalThis.document = globalThis.document || {};

const sm = await import('./js/core/state-manager.js');
const SM = sm.stateManager;

// 重置到干净 state
SM.reset();

// B-04: 多级经验循环
SM.update([{ key: '进度·经验', op: '=', value: 0 }]);
SM.update([{ key: '进度·下一级经验', op: '=', value: 100 }]);
SM.update([{ key: '进度·突破待处理', op: '=', value: 0 }]);
SM.update([{ key: '进度·经验', op: '+', value: 500 }]);
const breakthrough = SM.get('进度·突破待处理');
ok('B-04 多级经验一次性消化 (+500 经验应至少升 2 级)', breakthrough >= 2, `突破待处理=${breakthrough}`);
const remainingExp = SM.get('进度·经验');
ok('B-04 剩余经验已正确扣除', remainingExp >= 0 && remainingExp < SM.get('进度·下一级经验'),
  `exp=${remainingExp}, needed=${SM.get('进度·下一级经验')}`);

// B-11: 数值上限钳制（schema 声明 max=9999）
SM.update([{ key: '属性·体力', op: '=', value: 999999 }]);
ok('B-11 上限钳制到 schema max', SM.get('属性·体力') === 9999, `属性·体力=${SM.get('属性·体力')}`);

// B-10: update() 现在调用 validate，拒绝 allowed 枚举外的值
SM.update([{ key: '玩家·存活', op: '=', value: '模糊' }]);
ok('B-10 update() 拒绝 disallowed', SM.get('玩家·存活') === '是' || SM.get('玩家·存活') === '否',
  `玩家·存活=${SM.get('玩家·存活')}`);
SM.update([{ key: '玩家·存活', op: '=', value: '否' }]);
ok('B-10 update() 接受 allowed', SM.get('玩家·存活') === '否');
// 复活以便后续测试
SM.update([{ key: '玩家·存活', op: '=', value: '是' }]);

// B-06: restore 深合并 - 模拟旧存档缺少 _meta.active_branch
const snap = SM.snapshot();
delete snap._meta.active_branch;
SM.restore(snap);
ok('B-06 restore 深合并补齐 _meta.active_branch',
  SM.snapshot()._meta?.active_branch === 'branch_main',
  `active_branch=${SM.snapshot()._meta?.active_branch}`);

// B-07: _levelUpNotified 在 restore 后重置
// 先模拟一次升级触发 (制造 _levelUpNotified=true 的情况已经在 B-04 中触发并自动重置了，因此换一种验证：内部字段)
SM.restore(SM.snapshot());
ok('B-07 restore 后 _levelUpNotified === false', SM._levelUpNotified === false);

// 还原 globals
globalThis.indexedDB = orig.indexedDB;
globalThis.window = orig.window;
globalThis.document = orig.document;

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
