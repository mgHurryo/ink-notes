## 修改目标

修复桌面触控板连续左右滑动数次后被持续抑制，导致翻页间歇性失效的问题。

## 修改内容

- 横向连续 wheel 事件在 55ms 静默后直接开始新手势，不再要求新手势首个 delta 大于上一惯性 delta 的 1.8 倍且达到 48px。
- 保留没有静默间隔时的加速续滑识别、惯性尾部抑制、鼠标滚轮刻度和每轮最多两页限制。
- 增加首个新 delta 小于前一轮惯性 delta、且设备不发送近零尾部事件时的连续多轮回归测试。

## 不包含的内容

- 不改变垂直滚轮滚动/边缘翻页行为、鼠标滚轮刻度、页面动画或输入设备权限。
- 不添加运行时依赖。

## 风险等级

低至中。横向连续 wheel 流的手势边界行为改变；由于浏览器 WheelEvent 没有可移植的手势结束信号，55ms 静默被用作重新起势边界。

## 行为变化

同方向触控板横滑在事件流静默 55ms 后可立即重新累计翻页位移，不再等待 delta 达到相对峰值条件；惯性流本身仍每轮最多翻两页。

## 验证方式

- `npm run typecheck`
- `npm test -- --exclude '.tmp/**'`（37 files / 880 tests）
- `npx playwright test tests/visual/desktop-input.spec.ts --grep "trackpad|wheel"`（14 tests）
- `npm run build`
- `git diff --check`
- 实体触控板验证尚未执行。

## 性能 / 成本影响

无新增运行时工作或依赖；新手势边界只在已有 wheel 事件回调中比较时间戳。

## 安全影响

无权限、网络或敏感数据变化。

## 发布方式

合并至 `master` 并通过 CI 后，从 `master` 准备 `0.1.5-beta.14` 晋级 PR；仅在 `release` PR 检查通过后创建 beta.14 tag 和 GitHub prerelease。

## 回滚方式

回滚本 PR 的单个提交并重新构建 `main.js`。

## 关联任务

- 用户反馈：触控板左右滑动数次后卡住，翻页后继续卡住。
