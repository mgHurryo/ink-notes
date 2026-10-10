import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';

// Read-only upstream collection. Downloaded plugin code is never imported or executed.
const run = promisify(execFile);
const root = resolve('.tmp/pdf-compat-audit');
await mkdir(root, { recursive: true });
const gh = async (path) => JSON.parse((await run('gh', ['api', path], { timeout: 45000, maxBuffer: 15000000 })).stdout);
const get = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
};
const sha = process.argv[2] ?? (await gh('repos/obsidianmd/obsidian-releases/commits/master')).sha;
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full registry commit SHA');
const url = `https://raw.githubusercontent.com/obsidianmd/obsidian-releases/${sha}/community-plugins.json`;
const registry = JSON.parse(await get(url));
await writeFile(join(root, 'registry.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), sha, url, plugins: registry }, null, 2));
const pdf = /pdf|portable document/i;
const nearby = new Set(['zotlit', 'obsidian-citation-plugin', 'zotero-link', 'zotero-bridge', 'unitade', 'obsidian-hover-editor',
  'highlightr-plugin', 'xournalpp', 'obsidian-readwise', 'readwise-official', 'scrybble.ink', 'obsidian-koreader-plugin']);
const candidates = registry.filter(p => pdf.test(`${p.id} ${p.name} ${p.description} ${p.repo}`) || nearby.has(p.id));
const signals = /setViewState|registerExtensions|registerView|pdfViewer|pdfDocument|pdf-viewer|pdf-container|pdfPage|pdf-page|pdf-toolbar|textLayer|annotationLayer|getLeavesOfType|setEphemeralState|\.pdf|file-menu|layout-change|active-leaf-change|leaf\.view/i;
const results = [];
let next = 0;
async function audit(plugin) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(plugin.id) || !/^[\w.-]+\/[\w.-]+$/.test(plugin.repo)) throw new Error('Invalid plugin registry identity');
  const cache = join(root, `${plugin.id}.json`);
  let result;
  try { result = JSON.parse(await readFile(cache, 'utf8')); } catch {}
  if (result?.sha && !result.errors.length && result.collectorVersion === 2) { results.push(result); return; }
  const pinnedSha = result?.sha;
  result = { ...plugin, fetchedAt: new Date().toISOString(), files: [], errors: [] };
  try {
    const commit = await gh(`repos/${plugin.repo}/commits/${pinnedSha ?? 'HEAD'}`);
    result.sha = commit.sha;
    const tree = await gh(`repos/${plugin.repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    result.treeTruncated = tree.truncated;
    const blobs = tree.tree.filter(f => f.type === 'blob');
    const readme = blobs.find(f => /^readme\.(md|markdown)$/i.test(f.path));
    const manifest = blobs.find(f => f.path === 'manifest.json');
    const source = blobs.filter(f => /\.(ts|tsx|js|jsx|css)$/.test(f.path) && f.size < 1000000
      && !/(^|\/)(node_modules|vendor|dist|lib|build|test|tests|assets|pdfjs|pdfjs-dist|docs|examples|__tests__|__audit__|__mocks__|scripts|\.obsidian)\//i.test(f.path)
      && !/(\.min\.|\.(test|spec|d)\.[jt]sx?$|worker|codemirror|pdf\.js$)/i.test(f.path));
    const rank = path => /(^|\/)(main|index|plugin)\.[jt]sx?$/.test(path) ? 0 : /pdf|view/i.test(path) ? 1 : 2;
    source.sort((a,b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
    const selected = [readme, manifest, ...source.slice(0, 60)].filter(Boolean);
    result.sourceTotal = source.length;
    result.sourceSelected = Math.min(source.length, 60);
    result.collectorVersion = 2;
    for (let offset = 0; offset < selected.length; offset += 5) {
      const batch = await Promise.allSettled(selected.slice(offset, offset + 5).map(async f => {
        const fileUrl = `https://raw.githubusercontent.com/${plugin.repo}/${commit.sha}/${f.path}`;
        const body = await get(fileUrl);
        const local = join(root, plugin.id, f.path);
        const inside = relative(root, local);
        if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Repository path escapes the audit cache');
        await mkdir(dirname(local), { recursive: true });
        await writeFile(local, body);
        const matches = body.split('\n').flatMap((line,i) => signals.test(line) ? [{ line: i+1, text: line.trim().slice(0, 360) }] : []);
        result.files.push({ path: f.path, url: fileUrl, blob: f.sha, bytes: Buffer.byteLength(body), matches });
        if (f === manifest) result.manifest = JSON.parse(body);
      }));
      for (const item of batch) if (item.status === 'rejected') result.errors.push(String(item.reason));
    }
  } catch (error) { result.errors.push(String(error).slice(0, 500)); }
  await writeFile(cache, JSON.stringify(result, null, 2));
  results.push(result);
}
const workers = await Promise.allSettled(Array.from({ length: 6 }, async () => {
  while (next < candidates.length) {
    await audit(candidates[next++]);
    if (results.length % 25 === 0) console.log(`${results.length}/${candidates.length}`);
  }
}));
for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
results.sort((a,b) => a.id.localeCompare(b.id));
await writeFile(join(root, 'results.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), registrySha: sha,
  totalRegistry: registry.length, candidates: results }, null, 2));
console.log(`Completed ${results.length}; unavailable ${results.filter(p => !p.sha).length}; errors ${results.filter(p => p.errors.length).length}`);
