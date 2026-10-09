export const importHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Detroit · 真实题目导入</title>
  <link rel="stylesheet" href="/import.css">
  <script src="/import.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">跳转到主要内容</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="工作空间导航">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M6 5h6a7 7 0 0 1 0 14H6V5Z" stroke="currentColor" stroke-width="2"/><path d="M10 9h2a3 3 0 0 1 0 6h-2V9Z" fill="currentColor"/></svg>
        </span>
        <div><span class="brand-name">Detroit</span><span class="brand-description">真实题目工作空间</span></div>
      </div>
      <div class="nav-label">工作空间</div>
      <nav class="main-nav" aria-label="主导航">
        <button type="button" data-view="import" aria-current="page">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <span>新建导入</span>
        </button>
        <button type="button" data-view="cases">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h4M10 12h5m-5 4h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <span>题目草稿</span><span id="case-count" class="nav-count" aria-label="题目草稿数量">—</span>
        </button>
        <button type="button" data-view="collections">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M3 11h18" stroke="currentColor" stroke-width="1.8"/></svg>
          <span>集合管理</span><span id="collection-count" class="nav-count" aria-label="集合数量">—</span>
        </button>
      </nav>
      <div class="sidebar-note">
        <span class="local-label"><span class="local-dot" aria-hidden="true"></span>本地导入 · 明确批准</span>
        <p>整理真实问题与材料。保存草稿，不调用模型，不执行项目。</p>
      </div>
    </aside>

    <main id="main-content" class="main-content">
      <header class="app-header">
        <div>
          <p class="eyebrow">本地工作空间</p>
          <h1 id="view-title">新建导入</h1>
          <p id="view-subtitle" class="view-subtitle">把真实问题和所需材料，整理为可追溯的题目草稿。</p>
        </div>
        <span id="connection-state" class="connection-state" data-state="connecting">正在连接</span>
      </header>
      <p id="status" class="status-bar" role="status" aria-live="polite">正在连接本地服务…</p>

      <section id="page-import" class="app-page" aria-labelledby="view-title">
        <div class="page-toolbar">
          <nav class="import-steps" aria-label="导入步骤">
            <a href="#task-section"><span>1</span>描述任务</a>
            <a href="#materials-section"><span>2</span>准备材料</a>
            <a href="#preview-section"><span>3</span>核对与批准</a>
          </nav>
          <span class="badge">草稿 · 不可执行</span>
        </div>
        <div class="import-grid">
          <form id="import-form" class="import-form">
            <div class="mode-bar">
              <label for="import-mode">导入方式</label>
              <select id="import-mode">
                <option value="guided">引导式目录 / 附件导入</option>
                <option value="manifest">协议 JSON 导入</option>
              </select>
            </div>
            <div id="guided-fields" class="form-stack">
              <section id="task-section" class="card" aria-labelledby="import-heading">
                <div class="section-heading">
                  <span class="section-number" aria-hidden="true">01</span>
                  <div><h2 id="import-heading">描述真实问题</h2><p>明确任务目标，保留问题发生时的上下文。</p></div>
                </div>
                <label for="title">题目标题 <span class="field-hint">必填</span></label>
                <input id="title" required placeholder="例如：PC / APP oncall 请求异常">
                <label for="instruction">任务说明</label>
                <textarea id="instruction" rows="5" placeholder="描述现象、需要解决的问题和预期结果；不要在这里泄漏已知根因或答案"></textarea>
                <p class="field-help">这段说明将提供给未来模型。已知根因与答案请作为「诊断」材料单独上传。</p>
                <div class="grid">
                  <label>任务起点
                    <select id="start-kind"><option value="original">原始问题起点</option><option value="current">当前状态</option></select>
                  </label>
                  <label>起点说明<input id="start-description" placeholder="说明是否保留问题发生时的版本"></label>
                </div>
                <details class="details-block source-details">
                  <summary>来源与用途 <span class="summary-hint">关联同一真实问题，记录来源用途</span></summary>
                  <div class="details-content">
                    <label>关联已有来源组<select id="source-group"><option value="">创建新来源（同一问题请选已有组）</option></select></label>
                    <div class="grid">
                      <label>来源类型<select id="source-kind"><option value="oncall">Oncall</option><option value="issue">Issue</option><option value="session">会话</option><option value="manual">手动</option></select></label>
                      <label>来源用途<select id="source-purpose"><option value="improvement">改善（已用于优化）</option><option value="validation">独立验证（未用于优化）</option></select></label>
                    </div>
                    <label>来源引用<input id="source-reference" placeholder="工单 / 会话链接或真实问题标识"></label>
                    <label>来源描述<input id="source-description"></label>
                    <p id="source-notice" class="notice">同源题目共享用途与已知暴露状态；未知语义重复不在检测范围内。</p>
                  </div>
                </details>
              </section>

              <section id="materials-section" class="card" aria-labelledby="materials-heading">
                <div class="section-heading">
                  <span class="section-number" aria-hidden="true">02</span>
                  <div><h2 id="materials-heading">准备任务材料</h2><p>选择工作区快照，为每份材料明确分配角色。</p></div>
                </div>
                <div class="privacy-note">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m8 12 3 3 5-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <p>只上传你选择的文件，不读取主机路径。请检查敏感内容；保存不会执行任何材料。</p>
                </div>
                <div class="subsection-heading"><h3>工作区目录</h3><span class="muted">可添加 PC / APP 等多个仓库</span></div>
                <p class="field-help">目录是浏览器选择时的快照，不恢复 Git 版本。版本号仅为你的声明；当前快照不能冒充原始起点。</p>
                <div id="workspaces" class="workspace-list"></div>
                <button id="add-workspace" class="button-secondary add-button" type="button">
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                  添加工作区
                </button>
                <div class="attachment-section">
                  <h3>附件与角色</h3>
                  <div class="role-guide" aria-label="材料角色说明">
                    <div><span class="role-label">输入</span><p>未来模型可见的问题材料</p></div>
                    <div><span class="role-label">诊断</span><p>旧诊断、根因与已知答案</p></div>
                    <div><span class="role-label">评分</span><p>验收样例与判分程序</p></div>
                  </div>
                  <p class="field-help">只有「输入」是未来模型可见材料；诊断和评分材料不会作为模型输入。</p>
                  <label class="upload-panel">选择附件 <span class="field-hint">可多选</span><input id="attachment-files" type="file" multiple></label>
                  <div id="attachments" class="file-list"></div>
                </div>
              </section>

              <details class="card advanced-details">
                <summary>环境、输出与验收 <span class="summary-hint">可选 · 仅存储描述，不执行命令</span></summary>
                <div class="details-content">
                  <div class="grid">
                    <label>环境 / 依赖（一行一项）<textarea id="requirements" rows="3"></textarea></label>
                    <label>准备命令（一行一项；仅存储）<textarea id="preparation" rows="3"></textarea></label>
                    <label>联网要求<select id="network"><option value="none">无</option><option value="host">需要联网（不授予权限）</option></select></label>
                    <label>凭据能力名称（一行一项；不要填写密钥）<textarea id="credentials" rows="3"></textarea></label>
                    <label>输出格式<select id="output-format"><option value="text">文本</option><option value="json">JSON</option><option value="files">文件</option><option value="mixed">混合</option></select></label>
                    <label>输出要求<textarea id="output-description" rows="3"></textarea></label>
                    <label>验收方式<select id="acceptance-kind"><option value="unspecified">尚未定义</option><option value="manual">人工</option><option value="command">命令（不执行）</option><option value="structured">结构化</option></select></label>
                    <label>验收说明<textarea id="acceptance-description" rows="3"></textarea></label>
                  </div>
                  <label>已知缺失（一行一项）<textarea id="missing" rows="3" placeholder="明确记录暂时无法提供的材料或信息"></textarea></label>
                </div>
              </details>
            </div>

            <section id="manifest-fields" class="card protocol-card" hidden aria-labelledby="protocol-heading">
              <div class="section-heading">
                <span class="section-number" aria-hidden="true">01</span>
                <div><h2 id="protocol-heading">协议 JSON 导入</h2><p>导入已有清单，或基于已保存材料创建新修订。</p></div>
              </div>
              <p class="field-help">支持 detroit.case schemaVersion 1 清单，或 {manifest, files, warnings} 完整上传协议。files 使用 utf8 / base64；禁止 sourcePath 和工作区 path 主机路径。缺失项可保留为草稿。</p>
              <label class="upload-panel">上传协议 JSON<input id="manifest-file" type="file" accept=".json,application/json"></label>
              <label>协议 JSON 内容<textarea id="manifest-json" class="code-input" rows="16" spellcheck="false"></textarea></label>
              <label class="upload-panel">额外协议材料<input id="protocol-files" type="file" multiple></label>
              <p class="field-help">通过工作区 ID + 相对路径匹配声明，不猜测附件角色。</p>
              <div id="protocol-materials" class="file-list"></div>
            </section>

            <section class="card save-target-card" aria-labelledby="save-target-heading">
              <h2 id="save-target-heading">保存目标</h2>
              <div class="grid">
                <label>保存目标<select id="save-case"><option value="">创建新题目</option></select></label>
                <label>目标当前版本 <span class="field-hint">防止陈旧覆盖</span><input id="expected-revision" type="number" min="1" readonly></label>
              </div>
              <p class="field-help">更新创建不可变新版本，不覆盖历史，也不会改动集合已固定的版本。</p>
              <button id="preview-button" class="button-primary button-wide" type="submit" disabled>
                预览待批准的材料
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <p class="submit-note">预览不会保存。核对确切材料后，再明确批准。</p>
            </section>
          </form>

          <aside id="preview-section" class="card preview-panel" aria-labelledby="preview-heading">
            <div class="section-heading">
              <span class="section-number" aria-hidden="true">03</span>
              <div><p class="eyebrow">先核对，再保存</p><h2 id="preview-heading">导入预览</h2></div>
            </div>
            <p class="preview-description">核对文件、角色、来源与缺失项，批准本次预览的确切材料。</p>
            <div id="preview">
              <div class="empty-state preview-empty">
                <span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v5h4M10 12h5m-5 4h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></span>
                <h3>等待材料预览</h3>
                <p>完成左侧任务与材料后，点击「预览待批准的材料」。任何输入修改都会取消已有批准。</p>
              </div>
            </div>
            <div id="approval-controls" class="approval-panel" hidden>
              <div class="approval-heading"><h3>明确批准</h3><span class="badge">仅保存草稿</span></div>
              <label class="check approval-check"><input id="approve" type="checkbox"><span>我已核对内容、角色、来源与缺失项，批准保存本次预览的确切材料</span></label>
              <div class="grid approval-grid">
                <label>保存时加入集合（可选）<select id="save-collection"><option value="">不加入集合</option></select></label>
                <label>业务权重<input id="save-weight" type="number" min="0" step="any" value="1"></label>
              </div>
              <details class="details-block exposure-details">
                <summary>涉及来源用途转换？</summary>
                <div class="details-content">
                  <label class="check"><input id="save-exposure" type="checkbox"><span>明确确认：将验证来源用于改善，整个来源组将记录暴露，不能再称独立未暴露验证</span></label>
                  <label>用途转换理由<input id="save-exposure-reason"></label>
                </div>
              </details>
              <button id="save-button" class="button-primary button-wide" type="button" disabled>批准并保存草稿</button>
              <p class="submit-note">不调用模型、不运行项目或判分脚本，不产生模型费用。</p>
            </div>
          </aside>
        </div>
      </section>

      <section id="page-cases" class="app-page" hidden aria-labelledby="cases-heading">
        <div class="page-toolbar">
          <div><h2 id="cases-heading" class="page-section-title">已保存题目</h2><p class="muted">每次批准形成不可变版本，材料与来源可追溯。</p></div>
          <span class="badge">草稿 · 不可执行</span>
        </div>
        <div class="cases-grid">
          <section class="card cases-list-panel" aria-label="题目草稿列表">
            <div class="list-toolbar">
              <label class="search-field" for="case-search"><span>搜索草稿</span><input id="case-search" type="search" placeholder="标题、题目 ID 或来源引用" autocomplete="off"></label>
              <button id="refresh" class="button-secondary" type="button">刷新列表</button>
            </div>
            <div id="case-list" class="case-list"><p class="muted">正在加载已保存草稿…</p></div>
          </section>
          <section id="case-detail" class="card case-detail" aria-label="题目版本与材料详情">
            <div class="empty-state">
              <span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 4h14v16H5V4Zm4 5h6m-6 4h6m-6 4h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
              <h3>查看题目详情</h3><p>从列表选择草稿，核对历史版本、材料与集合成员关系。</p>
            </div>
          </section>
        </div>
      </section>

      <section id="page-collections" class="app-page" hidden aria-labelledby="collections-heading">
        <div class="page-toolbar">
          <div><h2 id="collections-heading" class="page-section-title">组织题目集合</h2><p class="muted">按业务用途整理草稿，明确固定每个成员的版本。</p></div>
          <span class="badge">组织草稿 · 不可执行</span>
        </div>
        <div class="collections-grid">
          <div class="form-stack">
            <form id="collection-form" class="card">
              <div class="section-heading"><div><h2>创建集合</h2><p>明确用途，让后续整理保持一致。</p></div></div>
              <label>集合名称<input id="collection-name" required placeholder="例如：APP 请求异常回归"></label>
              <label>用途<select id="collection-purpose"><option value="improvement">改善</option><option value="validation">独立验证</option></select></label>
              <label class="check"><input id="collection-regression" type="checkbox"><span>回归集合（组织属性，不代表可执行）</span></label>
              <button id="create-collection" class="button-primary" type="submit">创建集合</button>
            </form>
            <form id="membership-form" class="card">
              <div class="section-heading"><div><h2>加入已保存版本</h2><p>固定版本，不随题目的新修订自动更新。</p></div></div>
              <label>集合<select id="member-collection" required></select></label>
              <label>题目<select id="member-case" required></select></label>
              <div class="grid">
                <label>版本<input id="member-revision" type="number" min="1" required></label>
                <label>业务权重<input id="member-weight" type="number" min="0" step="any" value="1" required></label>
              </div>
              <p class="notice">验证来源加入改善集合须明确确认并说明理由。已暴露来源不能加入独立验证集合；不会自动改标签。</p>
              <label class="check"><input id="member-exposure" type="checkbox"><span>确认将整个验证来源组标记为已用于改善 / 暴露</span></label>
              <label>用途转换理由<input id="member-exposure-reason"></label>
              <button id="add-membership" class="button-primary" type="submit">加入 / 固定该版本</button>
            </form>
          </div>
          <section class="card collection-list-panel" aria-label="已保存集合">
            <div class="section-heading"><div><h2>已保存集合</h2><p>查看成员版本、业务权重与来源状态。</p></div></div>
            <div id="collection-list" class="collection-list"><p class="muted">正在加载集合…</p></div>
          </section>
        </div>
      </section>
    </main>
  </div>

  <dialog id="material-dialog" aria-labelledby="material-title">
    <h2 id="material-title">材料内容</h2>
    <p id="material-info" class="muted"></p>
    <pre id="material-content"></pre>
    <button id="close-material" class="button-secondary" type="button">关闭</button>
  </dialog>
</body>
</html>`;

export const importCss = `
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #24332e;
  background: #f6f8f7;
  font-size: 14px;
  line-height: 1.6;
  --accent: #176b55;
  --accent-hover: #115440;
  --accent-soft: #edf5f0;
  --text-muted: #65736c;
  --border: #dfe6e1;
  --radius: 12px;
}

* { box-sizing: border-box; }
body { margin: 0; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; }
button, a, input, select, textarea, summary { -webkit-tap-highlight-color: transparent; }
button, input, select, textarea { color: inherit; }
button { cursor: pointer; }
a { color: var(--accent); }
svg { display: block; width: 20px; height: 20px; flex-shrink: 0; }
h1, h2, h3, h4, p { margin: 0; }
h1 { font-size: 28px; font-weight: 650; letter-spacing: -.04em; line-height: 1.35; }
h2 { font-size: 18px; font-weight: 650; line-height: 1.5; letter-spacing: -.02em; }
h3 { font-size: 15px; font-weight: 650; line-height: 1.5; }
h4 { font-size: 14px; font-weight: 650; }
ul { padding-left: 20px; }
p, li, h1, h2, h3, h4, label, summary { overflow-wrap: anywhere; }
:focus-visible { outline: 3px solid #6ba58a; outline-offset: 3px; }
button, input, select, textarea, a, summary { scroll-margin-top: 24px; }
section, aside { scroll-margin-top: 24px; }

.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 20;
  padding: 8px 16px;
  background: #fff;
  border: 1px solid var(--accent);
  border-radius: 6px;
  transform: translateY(-150%);
}
.skip-link:focus { transform: translateY(0); }
.app-shell { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 100vh; }
.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 32px 16px 24px;
  background: #fff;
  border-right: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 12px; padding: 0 8px; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  background: var(--accent);
  color: #fff;
  border-radius: 11px;
}
.brand-mark svg { width: 26px; height: 26px; }
.brand-name { display: block; font-size: 21px; font-weight: 750; letter-spacing: -.05em; line-height: 1.3; }
.brand-description { display: block; margin-top: 4px; color: var(--text-muted); font-size: 11px; letter-spacing: .025em; }
.nav-label { margin: 40px 12px 12px; color: #758078; font-size: 11px; font-weight: 600; letter-spacing: .1em; }
.main-nav { display: grid; gap: 8px; }
.main-nav button {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #59675f;
  text-align: left;
  font-weight: 550;
}
.main-nav button:hover { background: #f6f8f6; }
.main-nav button[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 650; }
.nav-count { margin-left: auto; padding: 1px 7px; border-radius: 5px; background: #f0f3f0; color: #637069; font-size: 11px; font-variant-numeric: tabular-nums; }
.main-nav button[aria-current="page"] .nav-count { background: #dbece1; color: var(--accent); }
.sidebar-note { margin-top: auto; padding: 24px 12px 0; }
.sidebar-note p { margin-top: 10px; color: var(--text-muted); font-size: 12px; line-height: 1.8; }
.local-label { display: flex; gap: 8px; align-items: center; color: #52645a; font-size: 11px; font-weight: 600; }
.local-dot { width: 6px; height: 6px; border-radius: 50%; background: #7d9185; }
.main-content { min-width: 0; width: 100%; max-width: 1576px; margin: 0 auto; padding: 40px 40px 64px; }
.app-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.eyebrow { margin-bottom: 8px; color: var(--text-muted); font-size: 11px; font-weight: 600; letter-spacing: .08em; }
.view-subtitle { margin-top: 8px; color: var(--text-muted); font-size: 13px; }
.connection-state { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; margin-top: 10px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 20px; background: #fff; color: #65736c; font-size: 11px; }
.connection-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #8b978f; }
.connection-state[data-state="connected"]::before { background: var(--accent); }
.connection-state[data-state="error"], .connection-state[data-state="failed"] { color: #993f36; border-color: #e9c5bf; }
.connection-state[data-state="error"]::before, .connection-state[data-state="failed"]::before { background: #b45647; }
.status-bar { margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: #5d6d63; font-size: 12px; }
.status-bar[data-error="true"] { border-color: #e5bdb6; background: #fff4f1; color: #963b30; }
body[data-busy="true"] .status-bar { border-color: #b8d5c5; }
.app-page { min-width: 0; }
.page-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 24px; }
.page-toolbar p { margin-top: 4px; font-size: 12px; }
.page-section-title { font-size: 16px; }
.import-steps { display: flex; flex-wrap: wrap; gap: 24px; }
.import-steps a { display: inline-flex; align-items: center; gap: 8px; color: #586b60; text-decoration: none; font-size: 12px; font-weight: 550; }
.import-steps a:hover { color: var(--accent); }
.import-steps a span { display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid #d6e2d9; border-radius: 50%; background: #fff; color: #566b5e; font-size: 11px; font-variant-numeric: tabular-nums; }
.badge { display: inline-flex; align-items: center; max-width: 100%; width: fit-content; padding: 4px 9px; border: 1px solid #e7ddc4; border-radius: 5px; background: #fbf8ef; color: #776039; font-size: 11px; font-weight: 550; line-height: 1.6; }
.page-toolbar > .badge { flex-shrink: 0; }
.import-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 380px); gap: 24px; align-items: start; }
.import-form, .form-stack { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.card { min-width: 0; padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; box-shadow: 0 2px 3px #24332e02; }
.mode-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
.mode-bar label { margin: 0; white-space: nowrap; font-size: 12px; }
.mode-bar select { width: min(100%, 280px); min-width: 0; margin: 0; }
.section-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
.section-heading > div { min-width: 0; }
.section-heading p:not(.eyebrow) { margin-top: 4px; color: var(--text-muted); font-size: 12px; }
.section-heading .eyebrow { margin-bottom: 2px; font-size: 10px; }
.section-number { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; margin-top: 2px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 650; font-variant-numeric: tabular-nums; }
label { display: block; margin: 16px 0 8px; font-size: 12px; font-weight: 600; line-height: 1.7; }
input:not([type="checkbox"]), select, textarea {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid #cdd8d0;
  border-radius: 7px;
  background: #fff;
  line-height: 1.5;
  font-size: 13px;
}
label > input:not([type="checkbox"]), label > select, label > textarea { margin-top: 8px; }
input::placeholder, textarea::placeholder { color: #7c887f; opacity: 1; }
input:focus, select:focus, textarea:focus { border-color: #5d9d7d; }
input:disabled, select:disabled, textarea:disabled, input[readonly] { background: #f5f7f5; color: #68746b; }
textarea { resize: vertical; }
input[type="checkbox"] { flex-shrink: 0; width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--accent); }
.field-hint { margin-left: 4px; color: var(--text-muted); font-size: 11px; font-weight: 400; }
.field-help { margin-top: 8px; color: var(--text-muted); font-size: 12px; line-height: 1.8; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.grid > * { min-width: 0; }
.check, label:has(> input[type="checkbox"]) { display: flex; align-items: flex-start; gap: 10px; font-weight: 400; font-size: 12px; }
.check span { min-width: 0; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; max-width: 100%; padding: 9px 14px; border: 1px solid #d0dbd3; border-radius: 7px; background: #fff; color: #405d4d; font-size: 12px; font-weight: 600; line-height: 1.5; }
button:hover { background: #f3f7f4; border-color: #a9c3b1; }
button:disabled { opacity: .52; cursor: not-allowed; }
.button-primary { border-color: var(--accent); background: var(--accent); color: #fff; }
.button-primary:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
.button-secondary { background: #fff; }
.button-wide { width: 100%; }
.add-button { margin-top: 16px; }
.add-button svg { width: 16px; height: 16px; }
.submit-note { margin-top: 10px; text-align: center; color: var(--text-muted); font-size: 11px; }
.notice { margin: 12px 0; padding: 12px; border: 1px solid #e5dfcd; border-radius: 7px; background: #fbf9f1; color: #776446; font-size: 12px; line-height: 1.8; }
.privacy-note { display: flex; gap: 10px; padding: 12px 14px; border: 1px solid #dce8df; border-radius: 8px; background: #f6faf7; color: #4e6d5c; font-size: 12px; line-height: 1.8; }
.privacy-note svg { margin-top: 2px; width: 18px; height: 18px; }
.subsection-heading { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; align-items: baseline; margin-top: 24px; }
.subsection-heading .muted { font-size: 11px; }
.muted { color: var(--text-muted); }
.workspace-list, .file-list { min-width: 0; }
.workspace { margin-top: 16px; padding: 20px; border: 1px solid #dce5df; border-radius: 9px; background: #fafcfb; }
.workspace h4 { margin-bottom: 4px; }
.workspace-meta, .file-meta { color: var(--text-muted); font-size: 11px; }
.workspace > button { margin-top: 16px; }
.workspace input, .workspace select { background: #fff; }
.upload-panel, .workspace label:has(> input[type="file"]) { display: block; padding: 16px; border: 1px dashed #b8cdc0; border-radius: 8px; background: #f8fbf9; font-weight: 600; }
input[type="file"] { min-height: auto; padding: 0; border: 0; border-radius: 0; background: transparent; color: #6e7b71; font-size: 11px; }
input[type="file"]::file-selector-button { margin-right: 10px; padding: 7px 10px; border: 1px solid #c8d8ce; border-radius: 5px; background: #fff; color: #405f4d; font: inherit; font-weight: 550; cursor: pointer; }
.file-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(125px, .8fr); align-items: start; gap: 10px 12px; margin-top: 12px; padding: 14px; border: 1px solid #e0e7e2; border-radius: 7px; background: #fff; }
.file-row > label { margin: 0; }
.file-row input:not([type="checkbox"]), .file-row select { font-size: 12px; }
.file-row > button { justify-self: start; min-height: 32px; padding: 5px 10px; font-size: 11px; }
.file-actions, .card-actions, .material-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.workspace-heading, .card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.workspace-heading { align-items: center; margin-bottom: 12px; }
.workspace-heading h4, .card-header h3 { margin: 0; }
.card-meta {
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.8;
}
.file-row > .file-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  grid-column: 1 / -1;
  gap: 4px 12px;
}
.file-meta strong {
  min-width: 0;
  color: #405c49;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
  font-weight: 550;
  overflow-wrap: anywhere;
}
.file-meta span { font-variant-numeric: tabular-nums; }
.file-row > label:first-of-type { grid-column: 1 / -1; }
.file-row > .file-actions {
  align-self: end;
  justify-content: flex-end;
  min-height: 40px;
}
.file-actions .check { margin: 0; align-items: center; }
.file-actions .check input { margin: 0; }
.file-actions button { min-height: 32px; padding: 5px 10px; font-size: 11px; }
.button-quiet {
  min-height: 32px;
  padding: 5px 10px;
  border-color: #e1e8e3;
  background: transparent;
  color: #69766d;
  font-size: 11px;
  font-weight: 500;
}
.button-quiet:hover { border-color: #c2d1c6; background: #f6f8f6; }
.row-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.row-actions button { margin: 0; }
.material-state { display: block; color: var(--text-muted); font-size: 11px; }
.review-item { line-height: 1.8; }
.review-raw {
  margin-top: 4px;
  color: #778279;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.readiness-grid { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.readiness-chip { align-items: center; }
.stat-value {
  display: block;
  color: #2f5740;
  font-size: 20px;
  font-weight: 650;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.digest-details {
  padding: 12px;
  border: 1px solid #e2e9e3;
  border-radius: 7px;
  background: #fafcfb;
}
.digest-details p { margin-top: 8px; color: #657568; font-size: 11px; }
.digest-details code { display: block; margin-top: 8px; font-size: 10px; }
.membership-list { padding-left: 20px; color: #5b7061; font-size: 12px; }
.attachment-section { margin-top: 24px; padding-top: 24px; border-top: 1px solid #e6ece7; }
.role-guide { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
.role-guide > div { padding: 10px; border: 1px solid #e1e8e3; border-radius: 7px; background: #fafcfb; }
.role-label { color: #42674f; font-size: 12px; font-weight: 650; }
.role-guide p { margin-top: 4px; color: var(--text-muted); font-size: 11px; line-height: 1.7; }
.details-block { margin-top: 20px; border-top: 1px solid #e4ebe5; padding-top: 16px; }
summary { color: #4c6153; cursor: pointer; font-size: 12px; font-weight: 600; }
summary::marker { color: #779282; }
.summary-hint { margin-left: 6px; color: var(--text-muted); font-size: 11px; font-weight: 400; }
.details-content { padding-top: 8px; }
.advanced-details > summary { font-size: 13px; }
.advanced-details .summary-hint { display: block; margin: 6px 0 0 16px; }
.protocol-card .field-help { margin-bottom: 16px; }
.code-input { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.8; }
.save-target-card h2 { font-size: 15px; }
.save-target-card .button-primary { margin-top: 20px; }
.preview-panel { position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow: auto; scrollbar-width: thin; scrollbar-color: #c5d4c9 transparent; }
.preview-panel .section-heading { margin-bottom: 16px; }
.preview-description { margin-bottom: 20px; color: var(--text-muted); font-size: 12px; line-height: 1.8; }
.empty-state { padding: 40px 16px; text-align: center; color: var(--text-muted); }
.empty-state h3 { margin: 16px 0 8px; color: #4c6153; }
.empty-state p { font-size: 12px; line-height: 1.9; }
.empty-icon { display: grid; place-items: center; width: 48px; height: 48px; margin: 0 auto; border: 1px solid #e0e9e2; border-radius: 12px; background: #f5f9f6; color: #789582; }
.empty-icon svg { width: 26px; height: 26px; }
.preview-empty { padding: 32px 8px 40px; border: 1px dashed #dce6de; border-radius: 8px; background: #fcfdfc; }
#preview { min-width: 0; font-size: 12px; }
#preview > h3 { margin: 20px 0 8px; }
#preview > p { margin: 12px 0; }
.preview-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 16px 0; }
.summary-stat { min-width: 0; padding: 12px; border: 1px solid #e0e8e2; border-radius: 7px; background: #f7faf8; }
.summary-stat strong { display: block; color: #2f5740; font-size: 20px; font-weight: 650; line-height: 1.4; font-variant-numeric: tabular-nums; }
.summary-stat span { color: var(--text-muted); font-size: 11px; }
.readiness { margin: 16px 0; }
.readiness > .badge { margin-bottom: 12px; }
.readiness-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.chip, .readiness-chip { display: inline-flex; gap: 4px; max-width: 100%; padding: 4px 8px; border: 1px solid #dfe6e1; border-radius: 5px; background: #f7f9f7; color: #5b6c60; font-size: 11px; }
.readiness-chip[data-state="complete"] { border-color: #d2e3d7; background: #f0f7f2; color: #476c52; }
.readiness-chip[data-state="missing"] { border-color: #e5d9bd; background: #fbf7ed; color: #7b6235; }
.review-list { margin: 12px 0; padding-left: 20px; color: #796442; font-size: 12px; }
.review-list li + li { margin-top: 6px; }
.approval-panel { margin-top: 24px; padding-top: 20px; border-top: 2px solid #bed7c8; }
.approval-heading { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: 8px; }
.approval-heading h3 { color: #2d6349; }
.approval-check { margin-top: 16px; padding: 14px; border: 1px solid #d0e3d7; border-radius: 8px; background: #f0f7f2; color: #355e45; }
.approval-grid { grid-template-columns: minmax(0, 1fr); }
.approval-panel .button-primary { margin-top: 20px; }
.exposure-details { margin-top: 16px; }
.table-wrap { min-width: 0; max-width: 100%; margin: 16px 0; overflow: auto; border: 1px solid #e0e7e1; border-radius: 8px; scrollbar-width: thin; }
table { width: 100%; min-width: 640px; border-collapse: collapse; font-size: 11px; }
th, td { padding: 12px; border-bottom: 1px solid #e5ebe6; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #f6f9f7; color: #66766b; font-weight: 600; white-space: nowrap; }
td { max-width: 220px; }
tr:last-child td { border-bottom: 0; }
td button { min-height: 30px; padding: 5px 8px; margin: 0 4px 4px 0; font-size: 11px; }
.material-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
.material-role { font-size: 11px; }
pre { max-width: 100%; max-height: 420px; margin: 12px 0; padding: 16px; overflow: auto; border: 1px solid #e0e7e2; border-radius: 7px; background: #f7f9f7; color: #536458; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
code { overflow-wrap: anywhere; }
#preview details, .case-detail details { margin: 16px 0; }
.cases-grid { display: grid; grid-template-columns: minmax(280px, .85fr) minmax(0, 1.15fr); gap: 24px; align-items: start; }
.list-toolbar { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #e5ebe6; }
.search-field { flex: 1; min-width: 0; margin: 0; }
.search-field span { display: block; margin-bottom: 8px; }
.list-toolbar button { flex-shrink: 0; }
.case-list, .collection-list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.case-card, .collection-card { min-width: 0; padding: 18px; border: 1px solid #dfe7e1; border-radius: 9px; background: #fff; }
.case-card:hover { border-color: #aac5b3; }
.case-card[data-selected="true"], .case-card[aria-current="true"] { border-color: #a4c4b0; background: #f5faf6; }
.case-card h3, .collection-card h3 { margin-bottom: 8px; }
.case-card p, .collection-card p { margin: 8px 0; color: var(--text-muted); font-size: 11px; line-height: 1.8; }
.case-card > button, .case-card .card-actions { margin-top: 12px; }
.case-meta, .collection-meta { color: var(--text-muted); font-size: 11px; line-height: 1.8; }
.case-detail > h3 { font-size: 19px; }
.case-detail > p { margin: 12px 0; color: var(--text-muted); font-size: 12px; }
.case-detail > h4 { margin-top: 24px; }
.case-detail > button { margin-top: 16px; }
.case-detail > ul { font-size: 12px; color: #5d6f61; }
.case-detail-heading { display: flex; align-items: flex-start; flex-wrap: wrap; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.collections-grid { display: grid; grid-template-columns: minmax(280px, 360px) minmax(0, 1fr); gap: 24px; align-items: start; }
.collection-list-panel { min-height: 320px; }
.collection-card ul { margin: 12px 0 0; color: #5b7061; font-size: 12px; }
.collection-card li + li { margin-top: 8px; }
#collection-form button, #membership-form button { margin-top: 16px; }
dialog { width: min(900px, calc(100vw - 32px)); max-height: calc(100vh - 48px); padding: 24px; border: 1px solid #b8cbbc; border-radius: 12px; background: #fff; color: #24332e; box-shadow: 0 16px 64px #132c2133; }
dialog::backdrop { background: #132c2166; }
dialog h2 { margin-bottom: 12px; overflow-wrap: anywhere; }

@media (min-width: 1600px) {
  .main-content { padding-right: 56px; padding-left: 56px; }
  .import-grid { grid-template-columns: minmax(0, 1fr) 420px; gap: 32px; }
}

@media (max-width: 1190px) {
  .app-shell { grid-template-columns: 200px minmax(0, 1fr); }
  .main-content { padding: 32px 24px 48px; }
  .import-grid { grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; }
  .card { padding: 20px; }
  .workspace { padding: 16px; }
  .import-steps { gap: 12px; }
  .page-toolbar { flex-wrap: wrap; }
  .cases-grid { grid-template-columns: minmax(0, 1fr); }
  .collections-grid { grid-template-columns: minmax(260px, .85fr) minmax(0, 1fr); gap: 16px; }
}

@media (max-width: 1000px) {
  .import-grid { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .preview-panel { position: static; max-height: none; overflow: visible; }
  .approval-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .collections-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: 720px) {
  .app-shell { display: block; }
  .sidebar { position: static; height: auto; padding: 20px 20px 12px; border-right: 0; border-bottom: 1px solid var(--border); }
  .brand { padding: 0; }
  .brand-mark { width: 34px; height: 34px; border-radius: 9px; }
  .brand-name { font-size: 19px; }
  .brand-description { margin-top: 2px; font-size: 10px; }
  .nav-label, .sidebar-note { display: none; }
  .main-nav { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin-top: 20px; }
  .main-nav button { gap: 6px; justify-content: center; min-height: 44px; padding: 10px 6px; font-size: 12px; }
  .main-nav button svg { width: 16px; height: 16px; }
  .nav-count { margin-left: 0; padding: 0 4px; font-size: 10px; }
  .main-content { padding: 24px 20px 40px; }
  .app-header { gap: 12px; margin-bottom: 20px; }
  h1 { font-size: 24px; }
  .view-subtitle { font-size: 12px; }
  .connection-state { margin-top: 4px; padding: 5px 8px; font-size: 10px; }
  .eyebrow { font-size: 10px; }
  .status-bar { margin-bottom: 20px; }
  .page-toolbar { gap: 12px; margin-bottom: 20px; }
  .import-steps { width: 100%; justify-content: space-between; gap: 6px; }
  .import-steps a { gap: 5px; font-size: 11px; }
  .card { padding: 20px; }
  .import-form, .form-stack { gap: 20px; }
  .mode-bar { padding: 12px 16px; }
  .mode-bar select { font-size: 12px; }
  .summary-hint { display: block; margin: 4px 0 0 16px; }
  .preview-panel { overflow: visible; }
}

@media (max-width: 440px) {
  .sidebar { padding: 16px 16px 8px; }
  .main-nav { margin-top: 16px; }
  .main-nav button { gap: 5px; font-size: 11px; }
  .main-nav button svg { width: 14px; height: 14px; }
  .main-content { padding: 24px 16px 32px; }
  .app-header { flex-wrap: wrap; }
  .connection-state { margin-top: 0; }
  .card { padding: 16px; border-radius: 10px; }
  .section-heading { gap: 10px; margin-bottom: 20px; }
  h2 { font-size: 17px; }
  .section-number { width: 28px; height: 28px; font-size: 11px; }
  .grid, .approval-grid { grid-template-columns: minmax(0, 1fr); }
  .mode-bar { display: block; padding: 12px 16px; }
  .mode-bar label { margin-bottom: 8px; }
  .mode-bar select { width: 100%; }
  .workspace { padding: 14px; }
  .file-row { grid-template-columns: minmax(0, 1fr); }
  .file-row > .file-actions { justify-content: space-between; }
  .role-guide { gap: 6px; }
  .role-guide > div { padding: 8px; }
  .role-guide p { font-size: 10px; }
  .upload-panel, .workspace label:has(> input[type="file"]) { padding: 12px; }
  .list-toolbar { flex-wrap: wrap; gap: 10px; }
  .search-field { flex-basis: 100%; }
  .list-toolbar button { min-height: 36px; }
  .cases-grid, .collections-grid { gap: 20px; }
  .case-card, .collection-card { padding: 14px; }
  .empty-state { padding: 32px 8px; }
  dialog { padding: 16px; }
}
`;
