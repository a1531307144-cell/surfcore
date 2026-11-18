/**
 * 平台启动开关（platforms.start.{qq,bili}）的配置归一/迁移。
 *
 * 为什么单独测：
 *   2026-10-24 之前 QQ 的自动启动是 `bridge.autoStart`（默认 false），B站 无条件启动。
 *   新开关如果直接读新字段，老用户的显式选择会丢；这里钉住「显式 > enabled >
 *   bridge.autoStart > 默认」的优先级，以及保存时把旧字段镜像回去。
 *
 * 全程在临时 DSH_HOME 里跑，不碰真实 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-platform-start-'));
const stateDir = path.join(tmp, 'surfcore');
const unifiedFile = path.join(stateDir, 'config.json');
process.env.DSH_HOME = tmp;
process.env.USERPROFILE = tmp;

const store = await import('../plugins/surfcore/lib/store.js');
const writeUnified = (value) => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(unifiedFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

try {
  // 1) 老配置：bridge.autoStart=true，没有 platforms.start → QQ 跟随旧开关。
  writeUnified({ version: 1, bridge: { autoStart: true }, platforms: { enabled: ['qq', 'bili'] } });
  assert.deepEqual(store.readUnified().config.platforms.start, { qq: true, bili: true },
    '老配置 autoStart=true 应迁移成 QQ 启动开');

  // 2) 老配置：autoStart=false → QQ 关、B站 仍默认开。
  writeUnified({ version: 1, bridge: { autoStart: false }, platforms: { enabled: ['qq', 'bili'] } });
  assert.deepEqual(store.readUnified().config.platforms.start, { qq: false, bili: true },
    '老配置 autoStart=false 应迁移成 QQ 启动关，B站 默认开');

  // 3) 显式 platforms.start 优先于旧字段与 enabled 数组。
  writeUnified({
    version: 1,
    bridge: { autoStart: true },
    platforms: { enabled: ['qq', 'bili'], start: { qq: false, bili: false } },
  });
  assert.deepEqual(store.readUnified().config.platforms.start, { qq: false, bili: false },
    '显式 platforms.start 必须优先于 bridge.autoStart');

  // 4) 没有 start、但 enabled 数组里明确只剩 bili → 视为 QQ 关。
  writeUnified({ version: 1, platforms: { enabled: ['bili'] } });
  assert.deepEqual(store.readUnified().config.platforms.start, { qq: false, bili: true },
    'platforms.enabled 应作为第二优先级的迁移来源');

  // 5) 全新用户：没有旧字段时 QQ 默认开、B站 默认关（2026-11-16 安全加固）。
  writeUnified({ version: 1 });
  assert.deepEqual(store.readUnified().config.platforms.start, { qq: true, bili: false },
    '没有旧字段时默认只启动 QQ，B站 需要用户显式打开');

  // 6) 保存：只收布尔，并把 bridge.autoStart 镜像成 QQ 的选择。
  writeUnified({ version: 1, platforms: { start: { qq: true, bili: true } } });
  const saved = store.saveUnified({ platforms: { start: { qq: false, bili: true } } });
  assert.deepEqual(saved.config.platforms.start, { qq: false, bili: true });
  const onDisk = JSON.parse(fs.readFileSync(unifiedFile, 'utf8'));
  assert.deepEqual(onDisk.platforms.start, { qq: false, bili: true });
  assert.equal(onDisk.bridge.autoStart, false, '旧字段 bridge.autoStart 应镜像 new QQ 开关（降级可读）');

  // 7) 非布尔值不能把开关意外打开：B站 缺省 = 关，QQ 缺省 = 开。
  writeUnified({ version: 1 });
  const coerced = store.saveUnified({ platforms: { start: { qq: 'off', bili: 0 } } });
  assert.deepEqual(coerced.config.platforms.start, { qq: true, bili: false },
    '非布尔值按安全缺省处理（B站 只有明确 true 才开）');

  // 8) 纯函数也能独立用（不读文件）：显式值优先，B站 缺省关。
  assert.deepEqual(
    store.platformStartsFrom({ platforms: { start: { qq: false } }, bridge: { autoStart: true } }),
    { qq: false, bili: false },
  );

  // 9) 隐藏命令行窗口：默认关，只收明确 true，落盘可读。
  writeUnified({ version: 1 });
  assert.equal(store.readUnified().config.platforms.hideConsoles, true, '隐藏命令行默认开');
  const hidden = store.saveUnified({ platforms: { hideConsoles: true } });
  assert.equal(hidden.config.platforms.hideConsoles, true);
  assert.equal(JSON.parse(fs.readFileSync(unifiedFile, 'utf8')).platforms.hideConsoles, true);
  assert.equal(store.saveUnified({ platforms: { hideConsoles: 'yes' } }).config.platforms.hideConsoles, false,
    '非布尔 hideConsoles 不能意外打开');

  // 10) 2026-11-16 加固：统一配置里的凭据读给 UI 必须脱敏；保存时 ******** 要还原。
  writeUnified({
    version: 1,
    updates: { githubToken: 'ghp_unit_test_only' },
    vectorMemory: { token: 'vec_unit_test_only' },
  });
  const all = store.readAll();
  assert.equal(all.unified.updates.githubToken, store.MASK, 'GitHub PAT 不能明文回传 UI');
  assert.equal(all.unified.vectorMemory.token, store.MASK, '向量记忆 token 不能明文回传 UI');
  assert.ok(all.qq.consoleToken === store.MASK || all.qq.consoleToken === undefined || all.qq.consoleToken === '',
    'QQ 配置的脱敏行为保持原样');
  store.saveUnified({ updates: { githubToken: store.MASK }, vectorMemory: { token: store.MASK } });
  const persisted = JSON.parse(fs.readFileSync(unifiedFile, 'utf8'));
  assert.equal(persisted.updates.githubToken, 'ghp_unit_test_only', '保存回传的 ******** 必须还原成旧值');
  assert.equal(persisted.vectorMemory.token, 'vec_unit_test_only', '向量 token 的 ******** 也要还原');

  console.log('platform-start tests OK');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
