export const importJs = String.raw`"use strict";
const $ = id => document.getElementById(id);
const roles = {
  input: "输入（未来模型可见）",
  diagnostic: "诊断（不作为模型输入）",
  scoring: "评分（不作为模型输入）"
};
const purposes = {improvement: "改善", validation: "独立验证"};
const materialStates = {present: "已上传", missing: "缺失"};
const views = {
  import: {title: "新建导入", subtitle: "描述真实问题，核对材料后批准保存。"},
  cases: {title: "题目草稿", subtitle: "查看确切材料与历史版本；已保存草稿不可执行。"},
  collections: {title: "集合管理", subtitle: "整理题目，固定版本；集合用途不代表执行能力。"}
};
const reviewLabels = {
  missing_materials: "缺少任务材料",
  missing_input_materials: "缺少模型输入材料",
  missing_instruction: "尚未填写任务说明",
  missing_start_snapshot: "缺少原始起点声明",
  acceptance_not_defined: "尚未定义验收要求",
  executor_not_connected: "通用执行器未接入，当前仅保存草稿",
  sensitive_material_review_required: "请检查并移除不应收录的敏感内容",
  import_does_not_execute_commands: "导入只保存材料，不执行任何命令",
  source_group_exposed_for_improvement: "来源已用于改善，不能作为独立未暴露验证",
  source_validation_conflict_requires_confirmation_and_reason: "来源用途冲突，需明确确认并说明理由",
  source_exposure_requires_confirmation_and_reason: "验证来源将用于改善，需明确确认暴露及理由",
  missing_required_material: "缺少必需材料",
  optional_material_missing: "可选材料缺失",
  explicit_sensitive_file_requires_review: "敏感文件需逐项核对",
  missing_workspace_materials: "工作区缺少输入材料",
  missing_declared: "已声明缺失项",
  snapshot_revision_unverified: "版本仅为声明，未验证检出",
  snapshot_original_user_declared: "原始快照由你声明，未独立验证",
  browser_snapshot_non_atomic: "浏览器目录上传不是原子快照",
  local_path_ignored: "已排除版本管理、依赖或明显秘密文件",
  additional_ignored_files: "另有排除文件，路径列表已截断"
};
let token = "";
let state = {cases: [], collections: [], sources: []};
let preview = null, approvedPayload = null, generation = 0, busy = false;
let workspaceSequence = 0, detailSequence = 0, selectedCase = "";
let stateLoaded = false, connection = "connecting";
const workspaces = [], attachments = [], protocolFiles = [];

function node(tag, text, attrs) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, value);
  return el;
}

function status(text, error = false) {
  $("status").textContent = error && text === "Failed to fetch"
    ? "无法连接本地服务。确认 serve 正在运行后，再刷新列表。（Failed to fetch）"
    : text;
  $("status").dataset.error = String(error);
}

function connectionState(value) {
  connection = value;
  const labels = {connecting: "连接中", connected: "本地服务已连接", error: "本地连接失败"};
  $("connection-state").textContent = labels[value];
  $("connection-state").dataset.state = value;
}

function switchView(view, updateHash = true) {
  if (!Object.hasOwn(views, view)) view = "import";
  for (const name of Object.keys(views)) $("page-" + name).hidden = name !== view;
  for (const link of document.querySelectorAll("[data-view]")) {
    const active = link.dataset.view === view;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    link.classList.toggle("active", active);
  }
  $("view-title").textContent = views[view].title;
  $("view-subtitle").textContent = views[view].subtitle;
  if (updateHash && location.hash !== "#" + view) location.hash = view;
}

async function api(path, body) {
  const response = await fetch(path, {
    headers: {"X-Detroit-Token": token, ...(body === undefined ? {} : {"Content-Type": "application/json"})},
    ...(body === undefined ? {} : {method: "POST", body: JSON.stringify(body)})
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function emptyState(title, description) {
  const el = node("div", undefined, {class: "empty-state"});
  el.append(node("h3", title), node("p", description, {class: "muted"}));
  return el;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " 字节";
  const unit = bytes < 1024 * 1024 ? "KiB" : "MiB";
  const divisor = unit === "KiB" ? 1024 : 1024 * 1024;
  return (bytes / divisor).toFixed(1) + " " + unit + "（" + bytes + " 字节）";
}

function invalidate() {
  generation++;
  preview = null;
  approvedPayload = null;
  $("approve").checked = false;
  $("approval-controls").hidden = true;
  $("save-button").disabled = true;
  $("preview").replaceChildren(emptyState("等待核对材料", "填写任务、选择材料，再预览并明确批准。输入变动会取消已有批准。"));
}

function pending(value) {
  busy = value;
  document.body.classList.toggle("is-busy", value);
  $("status").setAttribute("aria-busy", String(value));
  $("preview-button").disabled = value || !token;
  $("save-button").disabled = value || !preview || !$("approve").checked || !token;
  $("create-collection").disabled = value || !token;
  $("add-membership").disabled = value || !token;
  $("refresh").disabled = value;
}

function lines(id) {
  return $(id).value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function labelled(parent, text, control) {
  const label = node("label", text);
  if (control.type === "checkbox") label.className = "check";
  label.append(control);
  parent.append(label);
  return control;
}

function select(options, value) {
  const el = node("select");
  for (const [key, text] of Object.entries(options)) el.append(node("option", text, {value: key}));
  el.value = value;
  return el;
}

function fileRow(item, container, protocol = false) {
  const row = node("div", undefined, {class: "file-row"});
  const meta = node("div", undefined, {class: "file-meta"});
  meta.append(
    node("strong", item.file.name),
    node("span", formatBytes(item.file.size), {class: "muted"})
  );
  row.append(meta);
  const path = node("input", undefined, {type: "text", value: item.path, "aria-label": "材料相对路径"});
  path.addEventListener("input", () => { item.path = path.value; });
  labelled(row, "相对路径", path);
  if (protocol) {
    const workspace = node("input", undefined, {
      type: "text", value: item.workspaceId || "", "aria-label": "协议材料工作区 ID（附件留空）"
    });
    labelled(row, "工作区 ID（附件留空）", workspace);
    workspace.addEventListener("input", () => { item.workspaceId = workspace.value || null; });
  }
  const role = select(roles, item.role);
  labelled(row, "材料角色", role);
  role.addEventListener("change", () => { item.role = role.value; });
  const actions = node("div", undefined, {class: "file-actions"});
  const required = node("input", undefined, {type: "checkbox"});
  required.checked = item.required;
  labelled(actions, "必需材料", required);
  required.addEventListener("change", () => { item.required = required.checked; });
  const remove = node("button", "移除", {type: "button"});
  remove.addEventListener("click", () => {
    item.removed = true;
    row.remove();
    invalidate();
  });
  actions.append(remove);
  row.append(actions);
  container.append(row);
}
function addWorkspace() {
  const number = ++workspaceSequence;
  const item = {files: [], ignored: [], ignoredCount: 0};
  workspaces.push(item);
  const row = node("div", undefined, {class: "workspace"});
  const heading = node("div", undefined, {class: "workspace-heading"});
  heading.append(node("h4", "工作区 " + number));
  const remove = node("button", "移除工作区", {type: "button"});
  remove.addEventListener("click", () => {
    item.removed = true;
    row.remove();
    invalidate();
  });
  heading.append(remove);
  row.append(heading);
  const grid = node("div", undefined, {class: "grid workspace-meta"});
  item.id = labelled(grid, "工作区 ID", node("input", undefined, {
    value: "workspace-" + number, pattern: "[a-z0-9][a-z0-9-]*", required: "", "aria-label": "工作区 ID"
  }));
  item.name = labelled(grid, "工作区名称", node("input", undefined, {
    value: "工作区 " + number, required: "", "aria-label": "工作区名称"
  }));
  item.revision = labelled(grid, "版本声明（非检出证明）", node("input", undefined, {"aria-label": "工作区版本"}));
  item.snapshot = labelled(grid, "快照状态", select({
    original: "原始", current: "当前", unknown: "未知", missing: "缺失"
  }, "unknown"));
  item.required = labelled(grid, "必需工作区", node("input", undefined, {type: "checkbox"}));
  item.required.checked = true;
  row.append(grid);
  const upload = node("div", undefined, {class: "upload-panel"});
  const input = node("input", undefined, {
    type: "file", multiple: "", webkitdirectory: "", "aria-label": "选择工作区目录"
  });
  labelled(upload, "选择目录", input);
  upload.append(node("p", "重新选择将替换此工作区材料；只上传所选文件，不检出 Git 版本。", {class: "muted"}));
  row.append(upload);
  const files = node("div");
  files.append(node("p", "尚未选择目录。快照状态默认未知，请按真实情况声明。", {class: "muted"}));
  row.append(files);
  input.addEventListener("change", () => {
    item.files = [];
    item.ignored = [];
    item.ignoredCount = 0;
    files.replaceChildren();
    const excluded = {
      ".git": true, ".detroit": true, node_modules: true, ".env": true, ".npmrc": true,
      ".pypirc": true, "credentials.json": true, credentials: true, id_rsa: true, id_ed25519: true
    };
    for (const file of input.files) {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split("/");
      const path = parts.length > 1 ? parts.slice(1).join("/") : relative;
      if (path.split("/").some(part => {
        const name = part.toLowerCase();
        return Object.hasOwn(excluded, name) || name.startsWith(".env.") || /\.(pem|key|p12|pfx)$/.test(name);
      })) {
        item.ignoredCount++;
        if (item.ignored.length < 100) item.ignored.push(path);
        continue;
      }
      item.files.push({file, path, role: "input", required: true});
    }
    const totalBytes = item.files.reduce((total, file) => total + file.file.size, 0);
    files.append(node("p", item.files.length + " 个文件 · " + formatBytes(totalBytes), {class: "muted"}));
    if (item.ignoredCount) {
      const excludedDetails = node("details", undefined, {class: "details-block"});
      excludedDetails.append(
        node("summary", "已排除 " + item.ignoredCount + " 个版本管理 / 依赖 / 明显秘密文件"),
        node("p", "路径最多显示 100 条；仍须检查剩余内容是否敏感。", {class: "notice"}),
        node("pre", item.ignored.join("\n"))
      );
      files.append(excludedDetails);
    }
    for (const uploaded of item.files) fileRow(uploaded, files);
    invalidate();
  });
  $("workspaces").append(row);
  toggleMode();
  invalidate();
}
async function uploaded(item, workspaceId) {
  if (item.file.size>16*1024*1024) throw new Error("单个材料超过 16 MiB："+item.path);
  const bytes=new Uint8Array(await item.file.arrayBuffer());
  let binary="";
  for (let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return {workspaceId,path:item.path,data:btoa(binary),encoding:"base64",role:item.role,required:item.required,mode:420};
}
async function payload() {
  const selected=$("import-mode").value==="manifest"
    ? protocolFiles.filter(x=>!x.removed)
    : [...workspaces.filter(x=>!x.removed).flatMap(x=>x.files.filter(file=>!file.removed)),...attachments.filter(x=>!x.removed)];
  if(selected.length>10000)throw new Error("材料超过 10000 个文件，请缩小选择范围。");
  if(selected.reduce((total,item)=>total+item.file.size,0)>64*1024*1024)throw new Error("材料总计超过 64 MiB，请缩小选择范围。");
  let result;
  if ($("import-mode").value === "manifest") {
    const parsed = JSON.parse($("manifest-json").value);
    result = parsed.manifest ? parsed : {manifest:parsed,files:[],warnings:[]};
    result.files = result.files || [];
    result.manifest.materials = result.manifest.materials || [];
    for (const item of protocolFiles.filter(x=>!x.removed)) {
      const file = await uploaded(item,item.workspaceId);
      const declaration = result.manifest.materials.find(x=>x.path===file.path && (x.workspaceId || null)===file.workspaceId);
      if (declaration) {
        declaration.role = file.role;
        declaration.required = file.required;
        declaration.state = "present";
        delete declaration.sha256;
        file.mode = declaration.mode ?? 420;
      } else {
        result.manifest.materials.push({workspaceId:file.workspaceId,path:file.path,role:file.role,required:file.required,mode:file.mode,state:"present"});
      }
      const index = result.files.findIndex(x=>x.path===file.path && (x.workspaceId || null)===file.workspaceId);
      if (index<0) result.files.push(file); else result.files[index]=file;
    }
  } else {
    result = {
      manifest:{
        kind:"detroit.case",schemaVersion:1,title:$("title").value,instruction:$("instruction").value,
        source:{kind:$("source-kind").value,reference:$("source-reference").value,description:$("source-description").value,
          usedForImprovement:$("source-purpose").value==="improvement",
          ...($("source-group").value ? {groupId:$("source-group").value}:{})},
        start:{kind:$("start-kind").value,description:$("start-description").value},
        workspaces:workspaces.filter(x=>!x.removed).map(x=>({id:x.id.value,name:x.name.value,revision:x.revision.value || null,snapshot:x.snapshot.value,required:x.required.checked})),
        materials:[],
        environment:{requirements:lines("requirements"),preparation:lines("preparation"),network:$("network").value,credentials:lines("credentials")},
        output:{format:$("output-format").value,description:$("output-description").value},
        acceptance:{kind:$("acceptance-kind").value,description:$("acceptance-description").value},missing:lines("missing")
      }, files:[],warnings:[]
    };
    for (const workspace of workspaces.filter(x=>!x.removed)) {
      for (const item of workspace.files.filter(x=>!x.removed)) result.files.push(await uploaded(item,workspace.id.value));
    }
    for (const item of attachments.filter(x=>!x.removed)) result.files.push(await uploaded(item,null));
    for(const workspace of workspaces.filter(x=>!x.removed)) {
      result.warnings.push("browser_snapshot_non_atomic:"+workspace.id.value);
      for(const path of workspace.ignored)result.warnings.push("local_path_ignored:"+workspace.id.value+"/"+path);
      if(workspace.ignoredCount>workspace.ignored.length)result.warnings.push("additional_ignored_files:"+workspace.id.value+":"+(workspace.ignoredCount-workspace.ignored.length));
    }
    result.manifest.materials = result.files.map(({workspaceId,path,role,required,mode})=>({workspaceId,path,role,required,mode,state:"present"}));
  }
  const target = state.cases.find(x=>x.id===$("save-case").value);
  if (target && !result.manifest.source.groupId) result.manifest.source.groupId=target.sourceGroupId;
  if (result.manifest.workspaces?.some(x=>Object.hasOwn(x,"path")) || result.manifest.materials?.some(x=>Object.hasOwn(x,"sourcePath"))) {
    throw new Error("Web 导入禁止主机 path / sourcePath。请上传材料字节；本地主机路径只能通过 CLI 导入。");
  }
  return result;
}
function materialContent(title, bytes) {
  $("material-title").textContent = title;
  $("material-info").textContent = formatBytes(bytes.length) + "；下方以 UTF-8 文本显示。二进制或无效 UTF-8 请下载原始字节核对。";
  $("material-content").textContent = new TextDecoder().decode(bytes);
  $("material-dialog").showModal();
}

function localBytes(file) {
  if (file.encoding === "utf8") return new TextEncoder().encode(file.data);
  const binary = atob(file.data);
  return Uint8Array.from(binary, x => x.charCodeAt(0));
}

async function savedBytes(saved, material) {
  const response = await fetch(
    "/api/cases/" + encodeURIComponent(saved.id) + "/materials/" + encodeURIComponent(material.id) + "?revision=" + saved.revision,
    {headers: {"X-Detroit-Token": token}}
  );
  if (!response.ok) throw new Error("读取材料失败：" + response.status);
  return new Uint8Array(await response.arrayBuffer());
}

function download(path, bytes) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = node("a", undefined, {href: url, download: path.split("/").pop() || "material"});
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function materialTable(materials, saved, files) {
  if (!materials.length) return emptyState("没有材料声明", "请在完整协议中核对任务需要的材料与缺失项。");
  const wrap = node("div", undefined, {class: "table-wrap", tabindex: "0", "aria-label": "完整材料与角色表"});
  const table = node("table");
  const header = node("tr");
  for (const title of ["工作区 / 路径", "角色 / 必需", "状态 / 大小", "SHA-256 / 权限", "确切内容"]) {
    header.append(node("th", title, {scope: "col"}));
  }
  const thead = node("thead");
  thead.append(header);
  table.append(thead);
  const body = node("tbody");
  for (const material of materials) {
    const tr = node("tr");
    const path = node("td", undefined, {class: "material-path"});
    path.append(node("strong", material.path), node("span", material.workspaceId || "附件", {class: "muted"}));
    const role = node("td", undefined, {class: "material-role"});
    role.append(
      node("span", roles[material.role] || material.role),
      node("span", material.required ? "必需材料" : "可选材料", {class: "chip"})
    );
    const digest = node("td");
    const details = node("details", undefined, {class: "details-block"});
    details.append(node("summary", "SHA-256"), node("code", material.sha256 || "无字节摘要"));
    digest.append(details, node("span", "权限 " + material.mode.toString(8), {class: "muted"}));
    tr.append(path, role, node("td", (materialStates[material.state] || material.state) + " · " + formatBytes(material.bytes)), digest);
    const action = node("td", undefined, {class: "material-actions"});
    if (material.state === "present") {
      for (const [label, isDownload] of [["预览内容", false], ["下载原始字节", true]]) {
        const button = node("button", label, {type: "button", "aria-label": label + "：" + material.path});
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const bytes = saved
              ? await savedBytes(saved, material)
              : localBytes(files.find(x => x.path === material.path && (x.workspaceId || null) === material.workspaceId));
            if (isDownload) download(material.path, bytes);
            else materialContent(material.path, bytes);
          } catch (error) {
            status(error.message, true);
          } finally {
            button.disabled = false;
          }
        });
        action.append(button);
      }
    } else {
      action.append(node("span", "无可读取字节", {class: "muted"}));
    }
    tr.append(action);
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function readiness(container, value, warnings = []) {
  const section = node("div", undefined, {class: "readiness"});
  section.append(node("p", "草稿不可执行 · 通用执行器未接入", {class: "badge"}));
  const chips = node("div", undefined, {class: "readiness-chips"});
  for (const [label, complete, missing] of [
    ["材料", value.materialsComplete, "不完整"],
    ["起点声明", value.baselineDeclared, "缺失"],
    ["验收定义", value.acceptanceDefined, "未定义"]
  ]) {
    chips.append(node("span", label + " · " + (complete ? "已具备" : missing), {
      class: "readiness-chip", "data-state": complete ? "complete" : "missing"
    }));
  }
  section.append(chips);
  const blockers = new Set(value.blockers);
  const messages = [...new Set([...value.blockers, ...value.warnings, ...warnings])];
  if (messages.length) {
    section.append(node("h4", "保存前核对 · " + value.blockers.length + " 项缺失 / 阻碍"));
    const list = node("ul", undefined, {class: "review-list"});
    for (const raw of messages) {
      const divider = raw.indexOf(":");
      const key = divider < 0 ? raw : raw.slice(0, divider);
      const suffix = divider < 0 ? "" : raw.slice(divider + 1);
      const label = Object.hasOwn(reviewLabels, key) ? reviewLabels[key] : raw;
      const item = node("li", undefined, {"data-severity": blockers.has(raw) ? "blocker" : "warning"});
      item.append(node("span", (blockers.has(raw) ? "缺失 · " : "注意 · ") + label));
      if (suffix && Object.hasOwn(reviewLabels, key)) item.append(node("span", " · " + suffix, {class: "muted"}));
      list.append(item);
    }
    section.append(list);
    const details = node("details", undefined, {class: "details-block"});
    details.append(node("summary", "查看原始核对标识"), node("pre", messages.join("\n")));
    section.append(details);
  }
  container.append(section);
}

function manifestView(manifest) {
  const details = node("details", undefined, {class: "details-block"});
  details.append(
    node("summary", "完整任务 / 来源 / 环境 / 输出 / 验收协议（命令不执行）"),
    node("pre", JSON.stringify(manifest, null, 2))
  );
  return details;
}

function updateSelect(id, values, empty) {
  const el = $(id), selected = el.value;
  el.replaceChildren();
  if (empty !== undefined) el.append(node("option", empty, {value: ""}));
  for (const [value, text] of values) el.append(node("option", text, {value}));
  if ([...el.options].some(x => x.value === selected)) el.value = selected;
}

function renderCases() {
  const list = $("case-list");
  list.replaceChildren();
  if (!stateLoaded) {
    list.append(emptyState("草稿尚未载入", connection === "error" ? "连接失败，请查看上方错误并刷新重试。" : "正在读取本地保存的草稿…"));
    return;
  }
  const query = $("case-search").value.trim().toLocaleLowerCase();
  const matches = state.cases.filter(saved =>
    [saved.manifest.title, saved.id, saved.manifest.source.reference].some(value =>
      String(value || "").toLocaleLowerCase().includes(query)
    )
  );
  if (!matches.length) {
    list.append(emptyState(
      state.cases.length ? "没有匹配的草稿" : "还没有题目草稿",
      state.cases.length ? "试试题目标题、ID 或来源引用；搜索只筛选已载入的草稿。" : "从「新建导入」选择材料，核对后批准保存。"
    ));
    return;
  }
  for (const saved of matches) {
    const card = node("article", undefined, {class: "case-card", "data-selected": String(selectedCase === saved.id)});
    card.append(
      node("h3", saved.manifest.title),
      node("p", saved.id, {class: "case-meta"}),
      node("span", "v" + saved.revision + " · 草稿，不可执行", {class: "chip"}),
      node("p", "来源 " + (saved.manifest.source.reference || saved.sourceGroupId), {class: "case-meta"})
    );
    const actions = node("div", undefined, {class: "card-actions"});
    const button = node("button", "查看版本与材料", {type: "button", "data-case-id": saved.id});
    button.addEventListener("click", () => showCase(saved.id, saved.revision));
    actions.append(button);
    card.append(actions);
    list.append(card);
  }
}

async function refresh() {
  try {
    if (!token) {
      connectionState("connecting");
      const session = await fetch("/api/session");
      if (!session.ok) throw new Error("无法建立本地会话：" + session.status);
      token = (await session.json()).token;
    }
    state = await api("/api/state");
    stateLoaded = true;
    connectionState("connected");
  } catch (error) {
    token = "";
    connectionState("error");
    renderCases();
    if (!stateLoaded) {
      $("collection-list").replaceChildren(emptyState("集合尚未载入", "连接失败，请查看上方错误并刷新重试。"));
    }
    throw error;
  }
  $("case-count").textContent = String(state.cases.length);
  $("collection-count").textContent = String(state.collections.length);
  updateSelect("source-group", state.sources.map(x => [
    x.id, x.kind + " / " + (x.reference || x.id) + " / " + (purposes[x.purpose] || x.purpose) + (x.exposedAt ? "（已暴露）" : "")
  ]), "创建新来源（同一问题请选已有组）");
  updateSelect("save-case", state.cases.map(x => [x.id, x.manifest.title + "（当前 v" + x.revision + "）"]), "创建新题目");
  updateSelect("member-case", state.cases.map(x => [x.id, x.manifest.title + " / " + x.id]), "请选择题目");
  const collections = state.collections.map(x => [x.id, x.name + " / " + (purposes[x.purpose] || x.purpose)]);
  updateSelect("save-collection", collections, "不加入集合");
  updateSelect("member-collection", collections, "请选择集合");
  renderCases();
  $("collection-list").replaceChildren();
  if (!state.collections.length) {
    $("collection-list").append(emptyState("还没有集合", "创建改善或独立验证集合，再固定题目的确切版本。"));
  }
  for (const collection of state.collections) {
    const card = node("article", undefined, {class: "collection-card"});
    card.append(
      node("h3", collection.name),
      node("span", (purposes[collection.purpose] || collection.purpose) + (collection.regression ? " · 回归" : ""), {class: "chip"}),
      node("p", collection.id + " · " + collection.entries.length + " 个固定版本", {class: "collection-meta"})
    );
    let exposed = 0;
    const entries = node("ul");
    for (const entry of collection.entries) {
      const saved = state.cases.find(x => x.id === entry.caseId);
      const source = state.sources.find(x => x.id === saved?.sourceGroupId);
      if (source?.purpose === "improvement") exposed++;
      const row = node("li");
      row.append(node("span", (saved?.manifest.title || entry.caseId) + " · v" + entry.revision + " · 权重 " + entry.weight + (source?.exposedAt ? " · 来源已用于改善" : "")));
      const view = node("button", "查看固定版本", {type: "button"});
      view.addEventListener("click", () => showCase(entry.caseId, entry.revision));
      row.append(view);
      entries.append(row);
    }
    if (collection.purpose === "validation" && exposed) {
      card.append(node("p", exposed + " 个成员来源已经暴露；该历史集合不能当作当前独立验证证据。", {class: "notice"}));
    }
    if (!collection.entries.length) entries.append(node("li", "暂无成员；可在下方加入题目版本。", {class: "muted"}));
    card.append(entries);
    $("collection-list").append(card);
  }
}
async function showCase(id, revision) {
  const serial = ++detailSequence;
  selectedCase = id;
  switchView("cases");
  renderCases();
  $("case-detail").replaceChildren(node("p", "正在读取草稿版本…", {class: "muted"}));
  $("case-detail").scrollIntoView({behavior: "smooth", block: "start"});
  try {
    const saved = await api("/api/cases/" + encodeURIComponent(id) + "?revision=" + revision);
    if (serial !== detailSequence) return;
    const container = $("case-detail");
    const heading = node("div", undefined, {class: "case-detail-heading"});
    heading.append(node("h3", saved.manifest.title), node("span", "不可变版本 v" + saved.revision, {class: "chip"}));
    const digest = node("details", undefined, {class: "details-block"});
    digest.append(node("summary", "批准摘要"), node("code", saved.approvalDigest));
    container.replaceChildren(heading, digest);
    const latest = state.cases.find(x => x.id === id);
    const version = select(Object.fromEntries(
      Array.from({length: latest?.revision || revision}, (_, i) => [String(i + 1), "历史版本 v" + (i + 1)])
    ), String(revision));
    version.id = "detail-revision";
    labelled(container, "不可变版本历史", version);
    version.addEventListener("change", () => showCase(id, Number(version.value)));
    readiness(container, saved.readiness);
    const source = state.sources.find(x => x.id === saved.sourceGroupId);
    container.append(
      node("p", "来源组：" + saved.sourceGroupId + " · 当前用途：" + (purposes[source?.purpose] || source?.purpose || "未知") + " · 暴露时间：" + (source?.exposedAt || "未记录") + "（已知状态，不保证未知泄漏不存在）", {class: "case-meta"}),
      manifestView(saved.manifest),
      node("h4", "材料与角色"),
      materialTable(saved.materials, saved)
    );
    const memberships = node("ul");
    for (const collection of state.collections) {
      for (const entry of collection.entries.filter(x => x.caseId === id)) {
        memberships.append(node("li", collection.name + " · 固定 v" + entry.revision + " · 权重 " + entry.weight));
      }
    }
    if (!memberships.children.length) memberships.append(node("li", "尚未加入集合。", {class: "muted"}));
    container.append(node("h4", "集合成员关系（不会自动随新版本更新）"), memberships);
    const edit = node("button", "以此版本材料创建新修订", {type: "button", id: "edit-case"});
    edit.addEventListener("click", async () => {
      if (busy) return;
      edit.disabled = true;
      pending(true);
      status("正在读取历史材料，准备新修订…");
      try {
        const files = [];
        for (const material of saved.materials.filter(x => x.state === "present")) {
          const bytes = await savedBytes(saved, material);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          files.push({
            workspaceId: material.workspaceId, path: material.path, role: material.role,
            required: material.required, mode: material.mode, data: btoa(binary), encoding: "base64"
          });
        }
        const manifest = {...saved.manifest, source: {...saved.manifest.source, groupId: saved.sourceGroupId}};
        switchView("import");
        $("import-mode").value = "manifest";
        toggleMode();
        $("manifest-json").value = JSON.stringify({manifest, files, warnings: []}, null, 2);
        $("save-case").value = id;
        $("expected-revision").value = state.cases.find(x => x.id === id)?.revision || revision;
        protocolFiles.length = 0;
        $("protocol-files").value = "";
        $("manifest-file").value = "";
        $("protocol-materials").replaceChildren();
        invalidate();
        $("manifest-fields").scrollIntoView({behavior: "smooth", block: "start"});
        $("manifest-json").focus({preventScroll: true});
        status("历史材料与原来源组已载入协议。将基于当前 v" + $("expected-revision").value + " 创建新版本；若来源用途变化，请在协议中明确修正并重新批准。");
      } catch (error) {
        status(error.message, true);
      } finally {
        edit.disabled = false;
        pending(false);
      }
    });
    container.append(edit);
    return saved;
  } catch (error) {
    if (serial !== detailSequence) return;
    status(error.message, true);
    const failed = emptyState("读取版本失败", "上方保留了服务返回的确切错误。可重新选择题目重试。");
    const retry = node("button", "重新读取版本", {type: "button"});
    retry.addEventListener("click", () => showCase(id, revision));
    failed.append(retry);
    $("case-detail").replaceChildren(failed);
  }
}

function toggleMode() {
  const guided = $("import-mode").value === "guided";
  $("guided-fields").hidden = !guided;
  $("manifest-fields").hidden = guided;
  for (const element of $("guided-fields").querySelectorAll("input,select,textarea,button")) {
    element.disabled = !guided;
  }
  for (const element of $("manifest-fields").querySelectorAll("input,select,textarea,button")) {
    element.disabled = guided;
  }
  const steps = document.querySelectorAll(".import-steps a");
  for (const [index, target, label] of [
    [0, guided ? "task-section" : "manifest-fields", guided ? "描述任务" : "协议内容"],
    [1, guided ? "materials-section" : "protocol-files", guided ? "准备材料" : "额外材料"]
  ]) {
    steps[index].setAttribute("href", "#" + target);
    steps[index].replaceChildren(node("span", String(index + 1)), document.createTextNode(label));
  }
}
for (const link of document.querySelectorAll("[data-view]")) {
  link.addEventListener("click", event => {
    event.preventDefault();
    switchView(link.dataset.view);
  });
}
for (const link of document.querySelectorAll(".import-steps a")) {
  link.addEventListener("click", event => {
    event.preventDefault();
    const target = $(link.getAttribute("href").slice(1));
    target.scrollIntoView({behavior: "smooth", block: "start"});
    if (target.matches("input,textarea,select")) target.focus({preventScroll: true});
  });
}
window.addEventListener("hashchange", () => switchView(location.hash.slice(1), false));
$("case-search").addEventListener("input", renderCases);
$("import-form").addEventListener("input", invalidate);
$("import-form").addEventListener("change", invalidate);
$("import-mode").addEventListener("change", toggleMode);
$("add-workspace").addEventListener("click", addWorkspace);
$("attachment-files").addEventListener("change", () => {
  for (const file of $("attachment-files").files) {
    const item = {file, path: file.name, role: "diagnostic", required: false};
    attachments.push(item);
    fileRow(item, $("attachments"));
  }
  $("attachment-files").value = "";
});
$("protocol-files").addEventListener("change", () => {
  let declarations = [];
  try {
    const parsed = JSON.parse($("manifest-json").value);
    declarations = (parsed.manifest || parsed).materials || [];
  } catch {}
  for (const file of $("protocol-files").files) {
    const matches = declarations.filter(x => x.path === file.name);
    const declaration = matches.length === 1 ? matches[0] : null;
    const item = {
      file, path: file.name, workspaceId: declaration?.workspaceId || null,
      role: declaration?.role || "diagnostic", required: declaration?.required ?? false
    };
    protocolFiles.push(item);
    fileRow(item, $("protocol-materials"), true);
  }
  $("protocol-files").value = "";
});
$("manifest-file").addEventListener("change", async () => {
  const file = $("manifest-file").files[0];
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error("协议文件超过 100 MiB");
    const text = await file.text();
    JSON.parse(text);
    $("manifest-json").value = text;
    invalidate();
    status("协议 JSON 已载入，请核对并预览。");
  } catch (error) {
    status(error.message, true);
  }
});
$("source-group").addEventListener("change", () => {
  const source = state.sources.find(x => x.id === $("source-group").value);
  if (source) {
    $("source-kind").value = source.kind;
    $("source-reference").value = source.reference;
    $("source-description").value = source.description;
    $("source-purpose").value = source.purpose;
    $("source-notice").textContent = "来源组当前用途：" + (purposes[source.purpose] || source.purpose) + "；暴露时间：" + (source.exposedAt || "未记录") + "。更改用途可能要求明确确认暴露及理由，不会静默转换。";
  }
});
$("save-case").addEventListener("change", () => {
  const target = state.cases.find(x => x.id === $("save-case").value);
  $("expected-revision").value = target?.revision || "";
  if (target) {
    const source = state.sources.find(x => x.id === target.sourceGroupId);
    $("source-group").value = target.sourceGroupId;
    $("source-kind").value = target.manifest.source.kind;
    $("source-reference").value = target.manifest.source.reference;
    if (source) $("source-purpose").value = source.purpose;
    status("新修订须保留来源组 " + target.sourceGroupId + " 及其类型 / 引用；目标当前 v" + target.revision + "。历史不会覆盖，协议缺少 groupId 时自动绑定此来源。");
  }
});
$("import-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !token) return;
  invalidate();
  const serial = generation;
  pending(true);
  status("正在读取选择的材料并计算预览摘要…");
  try {
    const proposed = await payload();
    const result = await api("/api/preview", proposed);
    if (serial !== generation) {
      status("预览期间输入已更改，请重新预览。", true);
      return;
    }
    approvedPayload = proposed;
    preview = result;
    const summary = node("div", undefined, {class: "preview-summary"});
    for (const [label, value] of [["材料文件", result.fileCount + " 个"], ["上传字节", formatBytes(result.totalBytes)]]) {
      const stat = node("div", undefined, {class: "summary-stat"});
      stat.append(node("span", label, {class: "muted"}), node("strong", value));
      summary.append(stat);
    }
    const digest = node("details", undefined, {class: "details-block"});
    digest.append(node("summary", "本次批准摘要"), node("code", result.approvalDigest));
    const container = $("preview");
    container.replaceChildren(summary, digest);
    readiness(container, result.readiness, result.warnings);
    container.append(
      manifestView(result.manifest),
      node("h4", "核对材料、角色与原始字节"),
      materialTable(result.materials, null, proposed.files)
    );
    $("approval-controls").hidden = false;
    status("预览完成。请核对确切内容、角色和警告，再明确批准保存。");
  } catch (error) {
    status(error.message, true);
    $("preview").replaceChildren(emptyState("预览未完成", "上方保留确切错误；请修正输入后重新预览。"));
  } finally {
    pending(false);
  }
});
$("approve").addEventListener("change", () => {
  $("save-button").disabled = busy || !preview || !$("approve").checked || !token;
});
for (const id of ["save-collection", "save-weight", "save-exposure", "save-exposure-reason"]) {
  $(id).addEventListener("input", () => {
    $("approve").checked = false;
    $("save-button").disabled = true;
  });
}
$("save-button").addEventListener("click", async () => {
  if (busy || !preview || !$("approve").checked || !token) return;
  const confirmation = {
    approvalDigest: preview.approvalDigest, approved: true,
    weight: Number($("save-weight").value), confirmExposure: $("save-exposure").checked,
    exposureReason: $("save-exposure-reason").value
  };
  if ($("save-collection").value) confirmation.collectionId = $("save-collection").value;
  if ($("save-case").value) {
    confirmation.caseId = $("save-case").value;
    confirmation.expectedRevision = Number($("expected-revision").value);
  }
  let saved = null;
  pending(true);
  status("正在保存已批准的确切材料…");
  try {
    saved = await api("/api/import", {payload: approvedPayload, confirmation});
    if ($("save-case").value === saved.id) $("expected-revision").value = String(saved.revision);
    invalidate();
    switchView("cases");
    await refresh();
    const displayed = await showCase(saved.id, saved.revision);
    if (displayed) status("草稿已持久保存：" + saved.id + " · v" + saved.revision + "。材料摘要可核对；仍不可执行。");
  } catch (error) {
    invalidate();
    status(saved
      ? "草稿已保存：" + saved.id + " · v" + saved.revision + "，但列表读取失败：" + error.message + "。请刷新列表，不必重复保存。"
      : error.message + "；请重新预览后批准。", true);
  } finally {
    pending(false);
  }
});
$("refresh").addEventListener("click", async () => {
  if (busy) return;
  pending(true);
  status("正在重新读取本地草稿与集合…");
  try {
    await refresh();
    invalidate();
    status("列表已刷新；请重新预览以核对最新来源状态。");
  } catch (error) {
    status(error.message, true);
  } finally {
    pending(false);
  }
});
$("collection-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !token) return;
  pending(true);
  status("正在创建集合…");
  let created = false;
  try {
    await api("/api/collections", {
      name: $("collection-name").value, purpose: $("collection-purpose").value,
      regression: $("collection-regression").checked
    });
    created = true;
    await refresh();
    status("集合已创建，可将题目版本加入集合。");
  } catch (error) {
    status((created ? "集合已创建，但列表读取失败，请刷新：" : "") + error.message, true);
  } finally {
    pending(false);
  }
});
$("member-case").addEventListener("change", () => {
  $("member-revision").value = state.cases.find(x => x.id === $("member-case").value)?.revision || "";
});
$("membership-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !token) return;
  pending(true);
  status("正在保存集合成员与版本…");
  let joined = false;
  try {
    await api("/api/collections/" + encodeURIComponent($("member-collection").value) + "/cases", {
      caseId: $("member-case").value, revision: Number($("member-revision").value),
      weight: Number($("member-weight").value), confirmExposure: $("member-exposure").checked,
      exposureReason: $("member-exposure-reason").value
    });
    joined = true;
    invalidate();
    await refresh();
    status("集合成员已持久保存；来源状态可能改变，请重新预览尚未保存的导入。");
  } catch (error) {
    status((joined ? "成员已保存，但列表读取失败，请刷新：" : "") + error.message, true);
  } finally {
    pending(false);
  }
});
$("close-material").addEventListener("click", () => $("material-dialog").close());
switchView(location.hash.slice(1), false);
$("case-detail").replaceChildren(emptyState("选择一个题目", "在左侧打开草稿，查看历史版本、材料与集合成员关系。"));
addWorkspace();
addWorkspace();
toggleMode();
renderCases();
pending(true);
(async () => {
  try {
    await refresh();
    status("本地服务已连接。请选择材料并描述问题；所有保存均需明确批准。");
  } catch (error) {
    status(error.message, true);
  } finally {
    pending(false);
  }
})();
`;
