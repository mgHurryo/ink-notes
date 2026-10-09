# Obsidian PDF 插件兼容性审计

审计日期：2026-10-10。基线：Ink Notes `0.8.0-beta.36`，`origin/master` 提交 `de6aad15d66eea601299c5e6b5708874791e9977`。修改位于正式 Local 仓库 `C:\Data\Project\gd-writtern`，分支 `fix/20261010-pdf-plugin-compatibility`。本轮未发布新版本。

## 范围与证据

读取 Obsidian 官方社区目录全部 **8,635** 条记录，固定目录 SHA 为 `c11633756f17f2b37557e3df6e16e0ba2fad35ba`。在 ID、名称、介绍、仓库名中检索不区分大小写的 `pdf` / `portable document`，并追加 Zotero、引用、Hover Editor、UNITADE、Readwise、KOReader、Highlightr、Xournal++ 等 12 个相邻入口，得到 **283** 个候选。初始严格关键词收集为 276 项；扩大匹配和相邻入口后补齐 7 项。

所有 283 个仓库均取得固定源码提交，收集 README、manifest 和优先入口源码共 **6,664** 个文件，无下载错误、无 GitHub tree 截断。281 个候选有符合条件的源码；`obsidian-markmind`、`mergdowntotex` 只有元数据或说明，不作源码兼容结论。37 个仓库超过每库 60 个源码文件的上限，已在逐项清单标注。

源码收集优先根/目录 `main`、`index`、`plugin` 和 PDF/view 文件；单文件上限 1 MB，排除依赖、vendor、构建目录、worker、测试和脚本。收集范围是筛查入口，不是对所有仓库逐行审查。扫描的仓库 HEAD 是该仓库的固定源码快照，**不等于用户安装的发布包版本**；manifest 版本仅提供参考。

| 分类 | 数量 | 结论与动作 |
| --- | ---: | --- |
| 源码确认原生视图依赖 | 49 | 启用时自动让出原生 PDF 打开；保留显式手写入口 |
| 独立视图/嵌入流程 | 19 | 其他自定义视图类型保持不变；未合并第三方笔迹格式 |
| PDF 页码/区域导航流程 | 4 | 保留原生 state、ephemeral state 和后续复用标签导航 |
| 文件处理/导入流程 | 11 | 未发现由我们的接管引起的直接冲突；并非完整兼容认证 |
| 其余源码初筛 | 198 | 提供固定源码入口和覆盖数，仍需真实组合验证 |
| 仅元数据 | 2 | 源码覆盖不足，保持未验证 |

逐项名称、插件 ID、分类和证据链接见 [完整目录](pdf-plugin-inventory.md)；准确 SHA、版本、平台限制、选取文件数、覆盖缺口见 [结构化证据](pdf-plugin-compatibility.json)。所有行的 `runtimeVerified` 均为 `false`。没有安装或执行下载的第三方插件，也没有读取用户 Vault 或服务凭据。

## 确认问题与修复

### 原生 PDF 视图被自动接管

原先只为 `pdf-plus` 让出视图。Jot、Handwritten Notes、PDF Writer、PDF Read Aloud、Fit PDF、翻译/高亮/批注插件，以及 Pandocit、Quarto 等流程依赖 `getLeavesOfType("pdf")`、`PDFViewerChild`、`.pdf-toolbar`、`.textLayer` 或原生文件变更监听。我们的视图是 `ink-notes-pdf-view`，只有 PDF 位图及笔迹层，替换原生类型会使这些功能没有执行对象。

现在根据逐项源码证据扩展到 49 个 ID，在每次打开时读取当前启用列表，因此运行中启用/禁用插件也能生效。没有将 OCR、转换、导出插件全部加入让出列表；自定义类型和非 PDF 文件始终透传。设置仍能关闭自动接管，覆盖未收录插件。

手写视图、笔、橡皮、套索、分页、缩放、锁定、笔迹保存、导出和原生笔记本功能均保留。命令和新增文件右键菜单可显式打开一个手写标签，原生标签保留第三方功能。**两套视图并存，不声称第三方文字层功能能在我们的位图视图内部工作。** 启用已知依赖插件后，普通打开 PDF 改为原生视图，这是有意的行为变化。

### 深链接和导航状态丢失

Omnisearch、All Outline、Eddie Doc 等使用 `#page=...`、`rect` 或选区定位；原先接管后手写视图固定从第一页开始。现在携带额外 persistent state 或任何非空 ephemeral state 的打开请求直接交给原生视图，原对象不被改写。已有手写标签收到后续 `setEphemeralState` 时，先保存笔迹再回到原生视图，并传递原状态。未知导航字段也保留，避免只支持部分插件参数。

### 返回原生标签后再次被接管

原先只在切换调用期间 suppress leaf，完成后马上释放。现在显式交还原生查看器的标签持续保持原生选择，弱引用不会阻止标签释放；切换失败才撤回 suppress 并显示错误。从源页返回时使用 `#page=N` 的 ephemeral subpath，页码来自 `sourceIndex`，不是包含插入空白页的笔记页序号。空白笔记页在原 PDF 无对应源页，不伪造页码。

### 外部修改 PDF 后导出使用旧坐标

其他插件可以改写原 PDF、添加/删除页面或重新编译文件。原先我们的视图只监听 sidecar；导出会读取新原文件而使用旧侧录坐标。现在 Vault `modify` 通知触发固定 SHA-256/字节数检查；内容相同的通知不阻塞编辑，内容不同则完成当前笔画并阻止继续编辑，保留旧笔迹及提示。加载期间 mtime 改变也会复核。无论是否收到通知，导出都再次检查所读取字节的 fingerprint，不匹配就取消，不生成错位副本。

未添加自动迁移坐标算法。原文件变化后需重新打开，沿用已有 fingerprint 不匹配的只读保护；源文件和旧 sidecar 不被强行覆盖。多插件同时改写 PDF 的互相冲突仍由第三方处理。

### 视图切换和异步写入可能丢失新笔迹

原先关闭/返回原生时先保存再完成活动笔画；卸载文件时还可能直接丢弃未保存 sidecar。现在先完成输入再保存，等待保存结果后释放 writer 和 PDF document。显式返回或卸载切换保存失败时保留内存数据并报错；关闭时尝试另存 conflict copy，若存储彻底不可用则准确提示未保存，不虚报已生成副本，并释放资源。修复写入/合并过程中发生新编辑却被旧写入标记为 clean 的问题：修改序号只用于判断在途写入是否覆盖最新修改，保留最新对象并串行续写，避免并发 flush 产生重复 writer。

另核对 `monkey-around` 实际实现：它会将自己在链中的 wrapper 置为原函数，**不存在**本轮早期怀疑的重新安装激活旧 wrapper 问题。没有为此增加补丁，增加卸载/重装/后安装 wrapper 的契约回归。不同插件自己改写或删除全局 wrapper 的情况不能由我们保证。

## 验证与限制

- 单元/宿主契约回归覆盖 native state 透传、后续 ephemeral 导航、右键入口、链式 wrapper 卸载重装、交还标签后再次导航、含空白页的源页码、活动笔画卸载、保存失败、并发 flush、新编辑与外部 sidecar 合并、源文件改变及导出 fingerprint。
- `npm test -- --exclude '.tmp/**'`：487 项通过，25 个测试文件。排除本地缓存内的历史测试副本，不关闭仓库测试。
- `npm run typecheck`、`npm run build`：通过；随源码重新生成受版本控制的 `main.js`、`main.js.map`。
- `npm run test:visual -- --workers=4`：58 项 Chromium 回归通过，覆盖桌面/移动布局、阅读模式、连续翻页、空白页、缩放锁定、手写/橡皮和渲染稳定性。这是我们自己的浏览器宿主，不是第三方插件联合运行。

**未验证**：真实 Obsidian 各版本上的插件安装组合，移动端 WebKit/Android WebView、独立弹窗、真实同步服务和设备压力输入，第三方各设置组合、源码快照与发布包差异。公共目录中未标明 PDF 能力的插件、BRAT/私有/下架插件不保证被发现；不能据此声称“世界上所有 PDF 插件已兼容”。真实宿主是否会因 `onUnloadFile` 保存错误拒绝切换需实机验证。`onClose` 无公开关闭否决机制，正常写入和 recovery copy 都失败时不能承诺最新笔迹已落盘，必须查看错误提示；原已保存文件不被删除。

## 优先联调矩阵

| 组合 | 重点核对 |
| --- | --- |
| PDF++ / PDF Scholia Scribe | 链接、矩形选择、批注命令、加载先后及热启停 |
| Jot / Handwritten Notes / PDF Writer / PDF Editor | 原生工具栏、首次落笔、修改原 PDF 后我们的只读/导出保护 |
| Fit PDF / PDF Scroll Lock / View Memory / PDF Pager HZ | 页码、缩放、滚动记忆及原生返回 |
| Open PDF Translate / PDF Selection Translator / LLM Translator | 文字选择、翻译菜单、并排标签 |
| PDF Read Aloud / Note Reader CosyVoice / Note Reader Mobile | 文本提取、朗读高亮、原生页切换 |
| Omnisearch / All Outline / Eddie Doc | 页码、rect、选区链接，新标签和复用手写标签 |
| Annotator / Octavo / Foxycape PDF / Zotflow / PDFium Gate / Pickme | 独立视图、扩展所有权、关闭后回到原生及状态保存 |
| 原文件编辑器 + Ink Notes 同时打开 | 延迟修改通知、加载中改写、写入时切换、磁盘写入失败 |
| Markmind / 私有与 BRAT 插件 | 源码不足，先关闭自动接管进行隔离联调 |

## 复核与发布

收集和报告使用仓库工具，缓存位于忽略的 `.tmp/pdf-compat-audit/`：

```powershell
node tools/audit-pdf-plugins.mjs c11633756f17f2b37557e3df6e16e0ba2fad35ba
node tools/report-pdf-compatibility.mjs
```

收集器重用同一缓存中已固定的仓库提交；删除或更换缓存意味着重新选择当时 HEAD，复核后必须审查新 SHA。报告生成器将生产 native ID 与已审查的源码行绑定，证据缺失时失败；测试检查自动让出列表与清单一致。

风险等级：中。普通打开 PDF 的路由变化、指纹计算及生命周期保存影响共享工作流。指纹计算仅在 PDF 改动和导出时发生，加载时只有 mtime 改变才增加检查；没有轮询、后台常驻网络、额外渲染或全局输入拦截。大 PDF 的哈希耗时需实机性能测试，本轮没有新增帧率声明。没有修改安全门禁、依赖或文件格式。

版本分类：PATCH；当前仍为 beta.36。发布必须经任务 PR → master 门禁 → release PR 门禁 → 干净构建 → annotated tag → tag 门禁 → GitHub Release。本轮仅开发与审计，不创建版本标签。回滚使用任务提交的 `git revert <commit>` 经 PR 恢复代码与 bundle；无需数据迁移，不删除 Vault 笔迹。
