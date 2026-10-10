## 修改目标

修复桌面鼠标拖拽在页面边缘无法翻页、连续触控板手势丢失，以及缩放时笔迹闪烁。

## 修改内容

- 阅读模式左键、中键、空格拖拽复用图库翻页；放大页面平移到实际滚动边界后，同一次拖拽可以继续翻页。取消、捕获丢失及窗口失焦回弹。
- 横向触控板滚轮使用已有动画与保存/渲染交接，后续批次合并到目标页；同一批次惯性只推进一页。
- Ink 笔记本桌面缩放保持原始页面栅格并合成缩放；PDF 桌面缩放保持原密度，180ms 无新输入后精绘。
- Worker 瓦片完成时按当前倍率选择最合适的缓存，避免旧倍率晚到替换新画面。
- 增加鼠标边界、取消、慢速 PDF/Worker 交接、缩放密度与像素覆盖回归；更新 main.js/main.js.map。

## 不包含的内容

不涉及笔迹文件格式、PDF 源文件改写、第三方插件同视图整合、依赖升级或生产发布。

## 风险等级

中。修改共享输入和瓦片显示路径，覆盖 Ink/PDF；真实硬件与宿主联测尚未执行。

## 行为变化

桌面平移到边界后可以继续拖动翻页；触控板连续独立手势会累计目标页。编辑模式普通左键仍写字。缩放期间显示原栅格，停下180ms后恢复目标密度。

## 验证方式

- `npx vitest run --exclude 'tests/visual/**' --exclude '.tmp/**' --reporter=dot`: 491 tests pass.
- `npx playwright test --reporter=line --workers=4`: 62 Chromium tests pass.
- `npm run typecheck`, `npm run build`, `git diff --check`: pass.
- Desktop/mobile screenshots inspected; wheel zoom checks retained tile nodes during motion and nonzero ink pixels after settling.
- 未验证：真实 Obsidian、实体触控板、iPad WebKit、跨窗口迁移。

## 性能 / 成本影响

减少连续桌面缩放的密度重绘及过时结果反复挂载；最终清晰度保持原限制。未执行硬件帧率基准。

## 安全影响

无新增网络、权限或数据格式。保留保存/Worker 交接与原有写入仲裁。

## 发布方式

任务分支到 master PR，通过门禁后 master 到 release PR，再按项目流程发布 PATCH。当前仍为 0.8.0-beta.36。

## 回滚方式

正常 revert 本次桌面修复提交及生成构建；无需数据迁移。

## 关联任务

用户反馈：电脑端鼠标/触控板滑动卡在边缘，桌面缩放笔迹闪烁，iPad正常。
