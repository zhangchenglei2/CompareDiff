import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Global state: file selected for comparison
let selectedFilePath: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Beyond Diff activated');

  // Command: Compare two files (via quick pick)
  const openDiffCmd = vscode.commands.registerCommand('beyondDiff.openDiff', async () => {
    const fileA = await pickFile('Select File A (original)');
    if (!fileA) return;
    const fileB = await pickFile('Select File B (modified)');
    if (!fileB) return;
    await openDiffPanel(context, fileA, fileB);
  });

  // Command: Right-click -> Select for Compare
  const selectCmd = vscode.commands.registerCommand(
    'beyondDiff.selectForCompare',
    async (uri?: vscode.Uri) => {
      const filePath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!filePath) {
        vscode.window.showErrorMessage('No file selected.');
        return;
      }
      selectedFilePath = filePath;
      await vscode.commands.executeCommand('setContext', 'beyondDiff.hasSelectedFile', true);
      vscode.window.showInformationMessage(
        `Beyond Diff: "${path.basename(filePath)}" selected. Right-click another file to compare.`
      );
    }
  );

  // Command: Right-click -> Compare with Selected
  const compareWithSelectedCmd = vscode.commands.registerCommand(
    'beyondDiff.compareWithSelected',
    async (uri?: vscode.Uri) => {
      if (!selectedFilePath) {
        vscode.window.showErrorMessage('No file selected for comparison. Right-click a file and choose "Select for Compare" first.');
        return;
      }
      const filePath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!filePath) {
        vscode.window.showErrorMessage('No target file.');
        return;
      }
      await openDiffPanel(context, selectedFilePath, filePath);
      // Reset selection
      selectedFilePath = undefined;
      await vscode.commands.executeCommand('setContext', 'beyondDiff.hasSelectedFile', false);
    }
  );

  // Command: Compare active file with another (via file picker)
  const compareActiveCmd = vscode.commands.registerCommand(
    'beyondDiff.compareActiveWithFile',
    async () => {
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!activeFile) {
        vscode.window.showErrorMessage('No active file to compare.');
        return;
      }
      const other = await pickFile('Select file to compare with');
      if (!other) return;
      await openDiffPanel(context, activeFile, other);
    }
  );

  context.subscriptions.push(openDiffCmd, selectCmd, compareWithSelectedCmd, compareActiveCmd);
}

async function pickFile(prompt: string): Promise<string | undefined> {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: prompt,
  });
  return result?.[0]?.fsPath;
}

async function openDiffPanel(
  context: vscode.ExtensionContext,
  fileA: string,
  fileB: string
) {
  const panel = vscode.window.createWebviewPanel(
    'beyondDiff',
    `Diff: ${path.basename(fileA)} ↔ ${path.basename(fileB)}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  let contentA: string;
  let contentB: string;
  try {
    contentA = fs.readFileSync(fileA, 'utf-8');
    contentB = fs.readFileSync(fileB, 'utf-8');
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to read files: ${e}`);
    panel.dispose();
    return;
  }

  const diffResult = computeDiff(contentA, contentB);
  panel.webview.html = getWebviewContent(
    path.basename(fileA),
    path.basename(fileB),
    fileA,
    fileB,
    diffResult
  );

  // Handle messages from webview (e.g. open native diff)
  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === 'openNativeDiff') {
        const uriA = vscode.Uri.file(fileA);
        const uriB = vscode.Uri.file(fileB);
        await vscode.commands.executeCommand(
          'vscode.diff',
          uriA,
          uriB,
          `${path.basename(fileA)} ↔ ${path.basename(fileB)}`
        );
      }
    },
    undefined,
    context.subscriptions
  );
}

// ─── Diff Engine (Myers-like LCS) ────────────────────────────────────────────

interface DiffLine {
  type: 'equal' | 'insert' | 'delete' | 'replace';
  lineNumA: number | null;
  lineNumB: number | null;
  textA: string;
  textB: string;
}

function computeDiff(textA: string, textB: string): DiffLine[] {
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');

  // LCS-based diff
  const m = linesA.length;
  const n = linesB.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const raw: Array<{ type: 'equal' | 'insert' | 'delete'; ia?: number; ib?: number }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      raw.push({ type: 'equal', ia: i - 1, ib: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: 'insert', ib: j - 1 });
      j--;
    } else {
      raw.push({ type: 'delete', ia: i - 1 });
      i--;
    }
  }
  raw.reverse();

  // Collapse adjacent delete+insert -> replace
  const result: DiffLine[] = [];
  let k = 0;
  while (k < raw.length) {
    const cur = raw[k];
    if (cur.type === 'delete' && k + 1 < raw.length && raw[k + 1].type === 'insert') {
      result.push({
        type: 'replace',
        lineNumA: (cur.ia ?? 0) + 1,
        lineNumB: (raw[k + 1].ib ?? 0) + 1,
        textA: linesA[cur.ia!],
        textB: linesB[raw[k + 1].ib!],
      });
      k += 2;
    } else if (cur.type === 'equal') {
      result.push({
        type: 'equal',
        lineNumA: (cur.ia ?? 0) + 1,
        lineNumB: (cur.ib ?? 0) + 1,
        textA: linesA[cur.ia!],
        textB: linesB[cur.ib!],
      });
      k++;
    } else if (cur.type === 'delete') {
      result.push({
        type: 'delete',
        lineNumA: (cur.ia ?? 0) + 1,
        lineNumB: null,
        textA: linesA[cur.ia!],
        textB: '',
      });
      k++;
    } else {
      // insert
      result.push({
        type: 'insert',
        lineNumA: null,
        lineNumB: (cur.ib ?? 0) + 1,
        textA: '',
        textB: linesB[cur.ib!],
      });
      k++;
    }
  }
  return result;
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/ /g, '&nbsp;')
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
}

function getWebviewContent(
  nameA: string,
  nameB: string,
  pathA: string,
  pathB: string,
  diff: DiffLine[]
): string {
  let additions = 0, deletions = 0, modifications = 0;
  for (const d of diff) {
    if (d.type === 'insert') additions++;
    else if (d.type === 'delete') deletions++;
    else if (d.type === 'replace') modifications++;
  }

  // Build diff rows
  const rows = diff.map((d, idx) => {
    const isChanged = d.type !== 'equal';
    const rowClass = d.type;
    const lineNumA = d.lineNumA !== null ? String(d.lineNumA) : '';
    const lineNumB = d.lineNumB !== null ? String(d.lineNumB) : '';
    let cellA = '', cellB = '';

    if (d.type === 'equal') {
      cellA = `<span>${escapeHtml(d.textA)}</span>`;
      cellB = `<span>${escapeHtml(d.textB)}</span>`;
    } else if (d.type === 'delete') {
      cellA = `<span class="line-content">${escapeHtml(d.textA)}</span>`;
      cellB = `<span class="empty-line"></span>`;
    } else if (d.type === 'insert') {
      cellA = `<span class="empty-line"></span>`;
      cellB = `<span class="line-content">${escapeHtml(d.textB)}</span>`;
    } else {
      // replace
      cellA = `<span class="line-content">${escapeHtml(d.textA)}</span>`;
      cellB = `<span class="line-content">${escapeHtml(d.textB)}</span>`;
    }

    return `<tr class="diff-row ${rowClass}" data-idx="${idx}" data-changed="${isChanged}">
      <td class="line-num">${lineNumA}</td>
      <td class="code-cell left">${cellA}</td>
      <td class="separator"></td>
      <td class="line-num">${lineNumB}</td>
      <td class="code-cell right">${cellB}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Beyond Diff</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  /* ── Toolbar ── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    background: var(--vscode-titleBar-activeBackground, #3c3c3c);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .toolbar h2 { font-size: 13px; font-weight: 600; color: var(--vscode-titleBar-activeForeground, #ccc); margin-right: 8px; }
  .stats { display: flex; gap: 10px; font-size: 12px; }
  .stat-add  { color: #4ec99b; }
  .stat-del  { color: #f48771; }
  .stat-mod  { color: #e5c07b; }
  .stat-eq   { color: var(--vscode-descriptionForeground, #888); }
  .toolbar-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  button {
    padding: 4px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  button.primary {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  /* ── File headers ── */
  .file-headers {
    display: grid;
    grid-template-columns: 40px 1fr 4px 1fr;
    background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
  }
  .file-header {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-tab-activeForeground, #ccc);
  }
  .file-header.left { grid-column: 2; border-right: 1px solid var(--vscode-panel-border, #444); }
  .file-header.right { grid-column: 4; }
  /* ── Diff table ── */
  .diff-container {
    flex: 1;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  col.col-linenum { width: 40px; }
  col.col-code { width: calc(50% - 22px); }
  col.col-sep { width: 4px; }
  .line-num {
    width: 40px;
    min-width: 40px;
    text-align: right;
    padding: 1px 6px;
    user-select: none;
    color: var(--vscode-editorLineNumber-foreground, #858585);
    font-size: 11px;
    vertical-align: top;
    border-right: 1px solid var(--vscode-panel-border, #333);
  }
  .code-cell {
    padding: 1px 8px;
    white-space: pre;
    overflow: hidden;
    vertical-align: top;
    line-height: 1.5;
  }
  .code-cell.left { border-right: 1px solid var(--vscode-panel-border, #333); }
  .separator { width: 4px; background: var(--vscode-panel-border, #333); }

  /* ── Row colors ── */
  tr.equal { }
  tr.equal:hover td { background: rgba(255,255,255,0.03); }
  tr.insert td { background: rgba(78, 201, 155, 0.12); }
  tr.insert td.code-cell.right { background: rgba(78, 201, 155, 0.22); }
  tr.insert td.code-cell.left  { background: rgba(255,255,255,0.03); }
  tr.delete td { background: rgba(244, 135, 113, 0.12); }
  tr.delete td.code-cell.left  { background: rgba(244, 135, 113, 0.22); }
  tr.delete td.code-cell.right { background: rgba(255,255,255,0.03); }
  tr.replace td { background: rgba(229, 192, 123, 0.10); }
  tr.replace td.code-cell { background: rgba(229, 192, 123, 0.20); }

  /* ── Current diff highlight ── */
  tr.current-diff td { outline: 2px solid var(--vscode-focusBorder, #007fd4) !important; outline-offset: -2px; }

  /* ── Search bar ── */
  .search-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 14px;
    background: var(--vscode-editorWidget-background, #252526);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    flex-shrink: 0;
  }
  .search-bar input {
    flex: 1;
    max-width: 280px;
    padding: 3px 8px;
    background: var(--vscode-input-background, #3c3c3c);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 3px;
    font-size: 12px;
    outline: none;
  }
  .search-bar input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
  .search-bar label { font-size: 12px; color: var(--vscode-descriptionForeground, #888); display: flex; align-items: center; gap: 4px; }
  mark { background: rgba(255, 215, 0, 0.4); color: inherit; border-radius: 2px; }
  mark.current-match { background: rgba(255, 140, 0, 0.7); }
</style>
</head>
<body>

<div class="toolbar">
  <h2>🔍 Beyond Diff</h2>
  <div class="stats">
    <span class="stat-add">+${additions} added</span>
    <span class="stat-del">−${deletions} deleted</span>
    <span class="stat-mod">~ ${modifications} modified</span>
    <span class="stat-eq">${diff.filter(d => d.type === 'equal').length} unchanged</span>
  </div>
  <div class="toolbar-right">
    <button id="btn-prev" title="Previous difference (Shift+F7)">◀ Prev</button>
    <span id="diff-counter" style="font-size:12px; color:var(--vscode-descriptionForeground,#888)">0 / 0</span>
    <button id="btn-next" title="Next difference (F7)">Next ▶</button>
    <button class="primary" id="btn-native" title="Open in VSCode built-in diff editor">Open in Editor</button>
  </div>
</div>

<div class="search-bar">
  <input id="search-input" type="text" placeholder="Search in diff… (Ctrl+F)" />
  <label><input type="checkbox" id="search-case"> Case sensitive</label>
  <label><input type="checkbox" id="search-regex"> Regex</label>
  <span id="search-status" style="font-size:12px; color:var(--vscode-descriptionForeground,#888);"></span>
  <button id="btn-search-prev">↑</button>
  <button id="btn-search-next">↓</button>
</div>

<div class="file-headers">
  <div></div>
  <div class="file-header left" title="${escapeHtml(pathA)}">📄 ${escapeHtml(nameA)}</div>
  <div></div>
  <div class="file-header right" title="${escapeHtml(pathB)}">📄 ${escapeHtml(nameB)}</div>
</div>

<div class="diff-container" id="diff-container">
  <table>
    <colgroup>
      <col class="col-linenum">
      <col class="col-code">
      <col class="col-sep">
      <col class="col-linenum">
      <col class="col-code">
    </colgroup>
    <tbody id="diff-body">
${rows}
    </tbody>
  </table>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // ── Diff navigation ──────────────────────────────────────────────────────
  const changedRows = Array.from(document.querySelectorAll('tr[data-changed="true"]'));
  let currentDiffIdx = -1;

  function updateCounter() {
    document.getElementById('diff-counter').textContent =
      changedRows.length === 0 ? 'No differences'
      : currentDiffIdx >= 0 ? \`\${currentDiffIdx + 1} / \${changedRows.length}\`
      : \`0 / \${changedRows.length}\`;
  }

  function goToDiff(idx) {
    if (changedRows.length === 0) return;
    // Remove old highlight
    if (currentDiffIdx >= 0) changedRows[currentDiffIdx].classList.remove('current-diff');
    currentDiffIdx = (idx + changedRows.length) % changedRows.length;
    const row = changedRows[currentDiffIdx];
    row.classList.add('current-diff');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateCounter();
  }

  document.getElementById('btn-next').addEventListener('click', () => goToDiff(currentDiffIdx + 1));
  document.getElementById('btn-prev').addEventListener('click', () => goToDiff(currentDiffIdx - 1));

  document.getElementById('btn-native').addEventListener('click', () => {
    vscode.postMessage({ command: 'openNativeDiff' });
  });

  // Auto-navigate to first diff
  if (changedRows.length > 0) goToDiff(0);
  updateCounter();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F7' && !e.shiftKey) { e.preventDefault(); goToDiff(currentDiffIdx + 1); }
    if (e.key === 'F7' && e.shiftKey)  { e.preventDefault(); goToDiff(currentDiffIdx - 1); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      document.getElementById('search-input').focus();
    }
  });

  // ── Search ───────────────────────────────────────────────────────────────
  let searchMatches = [];
  let searchIdx = -1;

  function clearSearch() {
    document.querySelectorAll('mark').forEach(m => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    searchMatches = [];
    searchIdx = -1;
    document.getElementById('search-status').textContent = '';
  }

  function doSearch() {
    clearSearch();
    const query = document.getElementById('search-input').value;
    if (!query) return;
    const caseSensitive = document.getElementById('search-case').checked;
    const useRegex = document.getElementById('search-regex').checked;

    let pattern;
    try {
      const escaped = query.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
      pattern = useRegex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    } catch {
      document.getElementById('search-status').textContent = 'Invalid regex';
      return;
    }

    const codeCells = document.querySelectorAll('.code-cell');
    codeCells.forEach(cell => {
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      textNodes.forEach(tn => {
        const text = tn.nodeValue;
        pattern.lastIndex = 0;
        const parts = [];
        let lastIdx = 0, m;
        while ((m = pattern.exec(text)) !== null) {
          if (m.index > lastIdx) parts.push(document.createTextNode(text.slice(lastIdx, m.index)));
          const mark = document.createElement('mark');
          mark.textContent = m[0];
          searchMatches.push(mark);
          parts.push(mark);
          lastIdx = pattern.lastIndex;
          if (m[0].length === 0) { pattern.lastIndex++; break; }
        }
        if (parts.length === 0) return;
        if (lastIdx < text.length) parts.push(document.createTextNode(text.slice(lastIdx)));
        const frag = document.createDocumentFragment();
        parts.forEach(p => frag.appendChild(p));
        tn.parentNode.replaceChild(frag, tn);
      });
    });

    document.getElementById('search-status').textContent = \`\${searchMatches.length} match\${searchMatches.length !== 1 ? 'es' : ''}\`;
    if (searchMatches.length > 0) navigateSearch(0);
  }

  function navigateSearch(idx) {
    if (searchMatches.length === 0) return;
    if (searchIdx >= 0) searchMatches[searchIdx].classList.remove('current-match');
    searchIdx = (idx + searchMatches.length) % searchMatches.length;
    searchMatches[searchIdx].classList.add('current-match');
    searchMatches[searchIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('search-status').textContent = \`\${searchIdx + 1} / \${searchMatches.length}\`;
  }

  let searchDebounce;
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(doSearch, 250);
  });
  document.getElementById('search-case').addEventListener('change', doSearch);
  document.getElementById('search-regex').addEventListener('change', doSearch);
  document.getElementById('btn-search-next').addEventListener('click', () => navigateSearch(searchIdx + 1));
  document.getElementById('btn-search-prev').addEventListener('click', () => navigateSearch(searchIdx - 1));
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) navigateSearch(searchIdx - 1);
    else if (e.key === 'Enter') navigateSearch(searchIdx + 1);
    if (e.key === 'Escape') {
      clearSearch();
      document.getElementById('search-input').value = '';
      document.getElementById('diff-container').focus();
    }
  });
</script>
</body>
</html>`;
}

export function deactivate() {}
