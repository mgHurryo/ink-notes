## 修改目标

修复 Ink Notes 评审发现的数据覆盖、输入竞态、无效轮询和大页面渲染问题，补齐页面生命周期、Markdown 嵌入与紧凑响应式界面，并改善慢速书写、橡皮和套索交互。

## 修改内容

- 将 notebook 升级到 schema 2，引入页面顺序和删除墓碑，并兼容 schema 1。
- 损坏 JSON 保存时 fail closed；保存采用 dirty revision 串行循环。
- 将 pointer interaction 锁定到落笔时的页面、工具与橡皮模式。
- 使用 Vault modify 事件取代轮询，并抑制自身写入事件。
- 增加页面复制、删除、排序、撤销/重做和 notebook 搜索选择。
- 增加只读 Markdown `ink` 代码块预览和打开定位入口。
- 收敛为 56px 工具栏，使用 Obsidian 主题变量，并覆盖 360/480/720/1280 宽度。
- 稳定慢速笔迹，增加笔画、圆形、方形橡皮及瞄准参考图案；笔画橡皮使用固定命中范围，不显示尺寸。
- 套索移动使用一次栅格化的合成预览；套索和橡皮通过完整 1x fallback 原子提交，再后台细化高分辨率 tile。

## 不包含的内容

- OCR、全文搜索、反向链接、图片/PDF 导出。
- Markdown 预览内编辑。
- 跨 notebook 页面移动或 CRDT 页面排序。
- WebGL/Worker 渲染后端。

## 风险等级

中等。持久化 schema、页面合并、编辑交互与渲染协调均有行为变化；旧 schema 可读，但旧版插件不了解 schema 2 页面元数据。

## 行为变化

- 损坏的 `.ink` 文件不再被静默覆盖。
- 外部文件修改按目标文件刷新，不再每 2.5 秒重载全部视图。
- 页面删除在同步后不会复活，页面操作可撤销/重做。
- 慢速书写过滤亚像素抖动；局部橡皮可选择圆形或方形并调整尺寸。
- 跨 tile 的擦除与套索移动不再表现为内容逐块消失或移动。

## 验证方式

- `npm run typecheck`
- `npm test`：11 files / 92 tests
- `npm run build`
- `npm run test:visual`：6 Playwright/Chrome tests，覆盖 360x720、480x720、720x900、1280x720、键盘焦点、非空墨迹像素和橡皮参考 UI。

## 性能 / 成本影响

- 移除周期性全视图读取和重绘。
- 橡皮只查询空间索引候选。
- 交互提交同步生成完整 1x 可见 fallback，随后按帧细化；避免同步高 DPI 全量绘制。
- 套索预览最多使用四百万像素，提交或重置后释放。
- 不增加运行时依赖。

## 安全影响

- 降低损坏文件被覆盖的数据丢失风险。
- Markdown 嵌入仅允许 `Ink Notes/` 下的 `.ink` 路径，并保持只读。
- 不新增网络、权限或 secret 使用。

## 发布方式

1. 合并任务分支到 `master` 并通过 CI/Qodana。
2. 完成真实 Obsidian、Apple Pencil、移动端内存和跨设备同步人工验证。
3. 由 `master` 提交 PR 到 `release`，重新执行门禁。
4. 基于 `release` 发布 `0.2.0-beta.1`。

## 回滚方式

回滚本 PR 的原子提交并重新构建 `main.js`。已经由新版本写入 schema 2 的文件应先保留备份；回滚到旧插件版本后不应继续执行页面删除或排序操作。

## 关联任务

- `plan/plans/plan-20260909-1540.md`
- `plan/reviews/REVIEW-2026-09-09-INK-INPUT.md`
