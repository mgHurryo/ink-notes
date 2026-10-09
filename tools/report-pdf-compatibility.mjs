import { readFile, writeFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';

const audit = JSON.parse(await readFile('.tmp/pdf-compat-audit/results.json', 'utf8'));
const registry = JSON.parse(await readFile('.tmp/pdf-compat-audit/registry.json', 'utf8'));
const source = ts.createSourceFile('pdf-takeover.ts', await readFile('src/pdf-takeover.ts', 'utf8'), ts.ScriptTarget.Latest);
let nativeIds;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'PDF_VIEW_ENHANCER_PLUGIN_IDS') {
    nativeIds = new Set(node.initializer.elements.map(element => element.text));
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!nativeIds?.size) throw new Error('Native PDF dependency list was not found');

// Reviewed entrypoints. An expression must identify actual runtime integration, not only a README claim.
const native = {
  'annotations-everywhere': ['src/pdf/controller.ts', /getLeavesOfType\("pdf"/],
  'book-note': ['src/pdf/pdfAnnotationLayer.ts', /const PDF_VIEWER_SELECTOR/],
  'easy-pdf-highlight': ['main.js', /getLeavesOfType\('pdf'/],
  'fit-pdf': ['src/main.js', /getLeavesOfType\('pdf'/],
  'fleur-pdf': ['src/search.ts', /getLeavesOfType\('pdf'/],
  'fleurpdf-tint': ['src/main.ts', /view.getViewType\(\) === 'pdf'/],
  'freedraw-pdf': ['main.ts', /return view.viewer\?\.child\?\.pdfViewer/],
  'handwriting': ['src/main.ts', /getLeavesOfType\("pdf"/],
  'handwritten-notes': ['src/main.ts', /getLeavesOfType\("pdf"/],
  'icor-for-life-pdf-annotation': ['src/pdf/registry.ts', /getLeavesOfType\('pdf'/],
  'inkidian': ['src/main.ts', /querySelector.*pdf-toolbar-right/],
  'inkling': ['src/main.ts', /getViewType\(\) !== CORE_PDF_VIEW_TYPE/],
  'jot': ['src/overlay-manager.ts', /querySelector.*textLayer/],
  'lark-knowledge-ai': ['src/main.ts', /getLeavesOfType\("pdf"/],
  'llm-translator': ['src/pdfHighlight/HighlightOverlay.ts', /getLeavesOfType\("pdf"/],
  'local-pdf-annotator': ['src/main.ts', /leaf.view.getViewType\(\) === "pdf"/],
  'magicnotes': ['src/main.ts', /getLeavesOfType\('pdf'/],
  'marglow': ['src/pdf-adapter.ts', /const viewer = candidate\?\.viewer/],
  'native-pdf-handwriting': ['src/main.ts', /getLeavesOfType\("pdf"/],
  'native-search': ['main.ts', /const eventBus = child\?\.pdfViewer/],
  'note-reader-cosyvoice': ['src/main.js', /getLeavesOfType\('pdf'/],
  'note-reader-mobile': ['src/main.js', /const child = view.viewer/],
  'open-pdf-translate': ['main.ts', /activeLeaf.view.getViewType\(\) === 'pdf'/],
  'pandocit': ['src/readers/pdf/pdfNativeViewerUi.ts', /querySelector\('\.pdf-page-numbers/],
  'paper-reader': ['src/main.ts', /leaf.view.getViewType\(\) !== "pdf"/],
  'pdf-editor': ['src/compat/native-pdf.ts', /typeof object.getPage === 'function'/],
  'pdf-highlight-notes': ['src/main.ts', /getLeavesOfType\("pdf"/],
  'pdf-pager-hz': ['src/main.ts', /getLeavesOfType\("pdf"/],
  'pdf-plus': ['src/patchers/pdf-internals.ts', /patchObsidianViewer\(plugin, child.pdfViewer/],
  'pdf-read-aloud': ['main.js', /getLeavesOfType\('pdf'/],
  'pdf-scholia-scribe': ['src/patchers/pdf-internals.ts', /patchObsidianViewer\(plugin, child.pdfViewer/],
  'pdf-scroll-lock': ['main.js', /querySelector\('\.pdf-viewer-container/],
  'pdf-selection-translator': ['src/selection.ts', /const reader = start.closest/],
  'pdf-simple': ['src/viewer/dom.ts', /pdf-toolbar \.pdf-toolbar-right/],
  'pdf-toggle-dark-mode': ['main.ts', /const PDF_TOOLBAR_SELECTOR/],
  'pdf-versioning': ['main.ts', /getLeavesOfType\('pdf'/],
  'pdftion': ['src/main.ts', /const isPdfView = view.getViewType/],
  'qmd-as-md-obsidian': ['src/main.ts', /getLeavesOfType\('pdf'/],
  'reader-margins': ['src/host/obsidian-pdf-host.ts', /const pdfJsViewer = obsidianViewer.pdfViewer/],
  'reading-progress-bookmarks': ['src/adapters/pdf.ts', /const PDF_SCROLL_SELECTOR/],
  'reading-ruler': ['src/manager.ts', /const supported.*type === 'pdf'/],
  'siden': ['src/pdf/pdf-adapter.ts', /data-type="pdf"/],
  'study-pdf': ['src/obsidian-pdf-internals.ts', /const pdfViewer = view.viewer/],
  'supernote-annotations': ['src/main.js', /getLeavesOfType\('pdf'/],
  'third-mind-reader': ['pdf-gloss.ts', /getLeavesOfType\("pdf"/],
  'view-memory': ['src/main.ts', /const app = core && core.pdfViewer/],
  'word-memo': ['src/plugin.js', /if \(dtype === 'pdf'/],
  'yh-inklight': ['src/pdf/pdfAnnotationLayer.ts', /const PDF_VIEWER_SELECTOR/],
  'pdf-writer': ['src/features/PDFToolbarManager.ts', /querySelector\("\.pdf-toolbar/],
};
const independent = new Set(['obsidian-annotator', 'pdf-notes', 'slide-note', 'pdf-font-rewriter', 'zotflow',
  'foxycape-pdf', 'octavo', 'pickme', 'omni-viewer', 'paper-college', 'remark-my-words', 'qiaomu-reader',
  'ink-annotation', 'lumen-pdf-annotator', 'marinmind', 'pdfium-gate', 'media-slider', 'fleur-epub', 'unitade']);
const links = new Set(['omnisearch', 'all-outline', 'eddie-doc', 'zotero-deep-linker']);
const processing = new Set(['reflow', 'text-extractor', 'obsidian-ocr', 'obsidian-zotero-desktop-connector',
  'obsidian-citation-plugin', 'zotlit', 'obsidian-readwise', 'readwise-official', 'obsidian-koreader-plugin',
  'scrybble.ink', 'xournalpp', 'pdf-digital-signature']);
const statusNames = {
  'native-dependent': '原生依赖：自动让出', 'independent-view': '独立视图：不改类型',
  'native-link': '原生导航：保留状态', 'file-processing': '文件处理：未发现接管冲突',
  'source-screened': '源码初筛：待实机验证', 'metadata-only': '仅元数据：源码覆盖不足',
};
const plugins = [];
for (const plugin of audit.candidates) {
  const { id } = plugin;
  const status = nativeIds.has(id) ? 'native-dependent' : independent.has(id) ? 'independent-view' : links.has(id) ? 'native-link'
    : processing.has(id) ? 'file-processing' : plugin.sourceSelected ? 'source-screened' : 'metadata-only';
  let evidence = null;
  if (nativeIds.has(id)) {
    if (!native[id]) throw new Error(`Missing reviewed native evidence: ${id}`);
    const [path, expression] = native[id];
    const lines = (await readFile(`.tmp/pdf-compat-audit/${id}/${path}`, 'utf8')).split('\n');
    const index = lines.findIndex(line => expression.test(line));
    const collected = plugin.files.find(file => file.path === path);
    if (index < 0 || !collected) throw new Error(`Native evidence missing in pinned collection: ${id}/${path}`);
    evidence = { path, line: index + 1, text: lines[index].trim(), url: `https://github.com/${plugin.repo}/blob/${plugin.sha}/${path}#L${index+1}` };
  }
  const entrypoints = plugin.files.filter(file => /\.(ts|tsx|js|jsx)$/.test(file.path) && file.matches.length)
    .sort((a,b) => Number(!/(^|\/)(main|index|plugin)\./.test(a.path)) - Number(!/(^|\/)(main|index|plugin)\./.test(b.path)))
    .slice(0, 3).map(file => ({ path: file.path, url: `https://github.com/${plugin.repo}/blob/${plugin.sha}/${file.path}` }));
  plugins.push({ id, name: plugin.name, repo: plugin.repo, sha: plugin.sha, version: plugin.manifest?.version ?? null,
    desktopOnly: plugin.manifest?.isDesktopOnly ?? null, status, runtimeVerified: false, evidence, entrypoints,
    sourceFilesScanned: plugin.sourceSelected, eligibleSourceFiles: plugin.sourceTotal, limited: plugin.sourceSelected < plugin.sourceTotal,
    treeTruncated: plugin.treeTruncated ?? false, errors: plugin.errors });
}
for (const id of nativeIds) if (!plugins.some(plugin => plugin.id === id)) throw new Error(`Native plugin missing from inventory: ${id}`);
const counts = Object.fromEntries(Object.keys(statusNames).map(status => [status, plugins.filter(plugin => plugin.status === status).length]));
const report = { generatedAt: audit.fetchedAt, registrySha: audit.registrySha, registryUrl: registry.url,
  registryCount: audit.totalRegistry, candidateCount: plugins.length, filesCollected: audit.candidates.reduce((sum,p) => sum+p.files.length, 0),
  discovery: 'Case-insensitive pdf or portable document in id, name, description or repository, plus 12 explicit adjacent plugins.',
  scope: 'Static evidence only. Maximum 60 eligible source files per repository, maximum 1 MB per file; excludes vendored/build-directory code, worker, test and script files. No third-party plugin was executed.',
  counts, plugins };
await mkdir('docs', { recursive: true });
await writeFile('docs/pdf-plugin-compatibility.json', JSON.stringify(report, null, 2) + '\n');
const escape = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
const rows = plugins.map(plugin => {
  const evidence = plugin.evidence ? `[${escape(plugin.evidence.path)}:${plugin.evidence.line}](${plugin.evidence.url})`
    : plugin.entrypoints[0] ? `[${escape(plugin.entrypoints[0].path)}](${plugin.entrypoints[0].url})` : `[仓库](https://github.com/${plugin.repo}/tree/${plugin.sha})`;
  return `| \`${plugin.id}\` | ${escape(plugin.name)} | ${statusNames[plugin.status]} | ${plugin.sourceFilesScanned}/${plugin.eligibleSourceFiles}${plugin.limited ? '（截取）' : ''} | ${evidence} |`;
});
await writeFile('docs/pdf-plugin-inventory.md', `# PDF 插件筛查目录\n\n固定社区目录提交：\`${audit.registrySha}\`；检索 ${audit.totalRegistry} 项，候选 ${plugins.length} 项。\n\n本表所有行均未进行真实 Obsidian 安装组合验证；状态是源码审查分类，不是兼容认证。源码列为已扫描/符合收集条件的文件数，不能视为仓库总文件覆盖率。准确的各仓库 SHA、版本、桌面限制和覆盖缺口见 [JSON 清单](pdf-plugin-compatibility.json)，方法和风险见 [审计报告](pdf-plugin-compatibility.md)。\n\n| ID | 名称 | 分类 | 源码覆盖 | 固定版本证据 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`);
console.log(JSON.stringify({ ...counts, candidates: plugins.length, native: nativeIds.size }, null, 2));
