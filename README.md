# Beyond Diff — VSCode Extension

像 Beyond Compare 一样对比两份文件的差异。

## 功能特性

- 🎨 **并排对比视图**：左右分栏展示原始与修改文件
- 🟢🔴🟡 **高亮差异行**：绿色=新增，红色=删除，黄色=修改
- 🔢 **行号显示**：两侧各自展示行号
- ⬆️⬇️ **差异导航**：一键跳转上一处/下一处差异（F7 / Shift+F7）
- 📊 **变更统计**：顶部汇总新增/删除/修改/未变行数
- 🔍 **内容搜索**：支持大小写/正则搜索（Ctrl+F）
- 🖥️ **打开内置编辑器**：一键跳转到 VSCode 原生 diff 编辑器

## 使用方式

### 方式一：命令面板

`Ctrl+Shift+P` → `Beyond Diff: Compare Two Files`，依次选择两个文件。

### 方式二：右键菜单（推荐）

1. 在资源管理器中右键文件A → **Beyond Diff: Select for Compare**
2. 右键文件B → **Beyond Diff: Compare with Selected**

### 方式三：当前文件与任意文件对比

在编辑器中右键 → **Beyond Diff: Compare Active File with...**

## 安装 & 开发

```bash
npm install
npm run compile

# 打包为 .vsix
npm install -g @vscode/vsce
vsce package

# 安装本地包
code --install-extension beyond-diff-0.1.0.vsix
```

按 F5 可在扩展开发宿主中直接调试。

## 键盘快捷键（diff 视图内）

| 快捷键 | 功能 |
|--------|------|
| F7 | 下一处差异 |
| Shift+F7 | 上一处差异 |
| Ctrl+F | 聚焦搜索框 |
| Enter / Shift+Enter | 搜索下一个/上一个 |
| Escape | 清除搜索 |
