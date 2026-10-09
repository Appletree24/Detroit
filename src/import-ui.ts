export const importHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Detroit · 真实题目导入</title><link rel="stylesheet" href="/import.css"><script src="/import.js" defer></script></head>
<body><header><h1>真实题目与集合</h1><p>仅保存经批准的草稿与材料，不可执行。导入不调用模型、不运行项目或判分脚本、不产生模型费用。</p></header><main>
<p id="status" role="status" aria-live="polite">正在连接本地服务…</p>
<section aria-labelledby="import-heading"><h2 id="import-heading">1. 描述真实问题</h2><form id="import-form">
<label>导入方式<select id="import-mode"><option value="guided">引导式目录 / 附件导入</option><option value="manifest">协议 JSON 导入</option></select></label>
<div id="guided-fields">
<label>题目标题<input id="title" required placeholder="例如：PC / APP oncall 请求异常"></label><label>任务说明<textarea id="instruction" rows="4" placeholder="提供给未来模型的问题；不要在这里泄漏已知根因或答案"></textarea></label>
<div class="grid"><label>关联已有来源组<select id="source-group"><option value="">创建新来源（同一问题请选已有组）</option></select></label><label>来源类型<select id="source-kind"><option value="oncall">Oncall</option><option value="issue">Issue</option><option value="session">会话</option><option value="manual">手动</option></select></label><label>来源引用<input id="source-reference" placeholder="工单 / 会话链接或真实问题标识"></label><label>来源描述<input id="source-description"></label><label>来源用途<select id="source-purpose"><option value="improvement">改善（已用于优化）</option><option value="validation">独立验证（未用于优化）</option></select></label></div><p id="source-notice" class="notice">同源题目共享用途与已知暴露状态；未知语义重复不在检测范围内。</p>
<div class="grid"><label>任务起点<select id="start-kind"><option value="original">原始问题起点</option><option value="current">当前状态</option></select></label><label>起点说明<input id="start-description" placeholder="说明是否保留问题发生时的版本"></label></div>
<h3>工作区目录（可添加 PC / APP 等多个仓库）</h3><p>浏览器只上传你选择的文件。不读取主机路径，不恢复 Git 版本；版本号仅为你的声明。当前快照不能冒充原始起点。每个文件的角色由你明确选择。</p><div id="workspaces"></div><button id="add-workspace" type="button">添加工作区</button>
<h3>附件与角色</h3><p>旧诊断记录、已知根因应选“诊断”；验收样例 / 判分程序应选“评分”。只有“输入”是未来模型可见材料。保存不会执行任何附件。</p><label>选择附件（可多选）<input id="attachment-files" type="file" multiple></label><div id="attachments"></div>
<details><summary>环境、输出、验收与缺失说明（均为惰性描述）</summary><div class="grid"><label>环境 / 依赖（一行一项）<textarea id="requirements"></textarea></label><label>准备命令（一行一项；仅存储）<textarea id="preparation"></textarea></label><label>联网要求<select id="network"><option value="none">无</option><option value="host">需要联网（不授予权限）</option></select></label><label>凭据能力名称（一行一项；不要填写密钥）<textarea id="credentials"></textarea></label><label>输出格式<select id="output-format"><option value="text">文本</option><option value="json">JSON</option><option value="files">文件</option><option value="mixed">混合</option></select></label><label>输出要求<textarea id="output-description"></textarea></label><label>验收方式<select id="acceptance-kind"><option value="unspecified">尚未定义</option><option value="manual">人工</option><option value="command">命令（不执行）</option><option value="structured">结构化</option></select></label><label>验收说明<textarea id="acceptance-description"></textarea></label><label>已知缺失（一行一项）<textarea id="missing"></textarea></label></div></details>
</div>
<div id="manifest-fields" hidden><p>支持 detroit.case schemaVersion 1 清单，或 {manifest, files, warnings} 完整上传协议。files 使用 utf8 / base64；禁止 sourcePath 和工作区 path 主机路径。清单中的缺失项可保留为草稿。额外上传材料通过下面的工作区 ID + 相对路径匹配声明，不猜测附件角色。</p><label>上传协议 JSON<input id="manifest-file" type="file" accept=".json,application/json"></label><label>协议 JSON 内容<textarea id="manifest-json" rows="12" spellcheck="false"></textarea></label><label>额外协议材料<input id="protocol-files" type="file" multiple></label><div id="protocol-materials"></div></div>
<div class="grid"><label>保存目标<select id="save-case"><option value="">创建新题目</option></select></label><label>目标当前版本（防止陈旧覆盖）<input id="expected-revision" type="number" min="1" readonly></label></div><p>更新会创建不可变新版本，不覆盖历史或自动改动集合已固定的版本。</p>
<button id="preview-button" type="submit" disabled>预览待批准的材料</button>
</form></section>
<section aria-labelledby="preview-heading"><h2 id="preview-heading">2. 核对预览并批准保存</h2><div id="preview"><p>尚未预览。任何输入修改都会取消已有批准。</p></div><div id="approval-controls" hidden><label class="check"><input id="approve" type="checkbox">我已核对内容、角色、来源与缺失项，批准保存本次预览的确切材料</label><div class="grid"><label>保存时加入集合（可选）<select id="save-collection"><option value="">不加入集合</option></select></label><label>业务权重<input id="save-weight" type="number" min="0" step="any" value="1"></label></div><label class="check"><input id="save-exposure" type="checkbox">明确确认：将验证来源用于改善，整个来源组将记录暴露，不能再称独立未暴露验证</label><label>用途转换理由<input id="save-exposure-reason"></label><button id="save-button" type="button" disabled>批准并保存草稿</button></div></section>
<section aria-labelledby="cases-heading"><h2 id="cases-heading">3. 已保存草稿</h2><button id="refresh" type="button">刷新列表</button><div id="case-list"></div><div id="case-detail"></div></section>
<section aria-labelledby="collections-heading"><h2 id="collections-heading">4. 集合整理</h2><form id="collection-form"><div class="grid"><label>集合名称<input id="collection-name" required></label><label>用途<select id="collection-purpose"><option value="improvement">改善</option><option value="validation">独立验证</option></select></label><label class="check"><input id="collection-regression" type="checkbox">回归集合（组织属性，不代表可执行）</label></div><button id="create-collection" type="submit">创建集合</button></form><div id="collection-list"></div>
<form id="membership-form"><h3>将已保存版本加入集合</h3><div class="grid"><label>集合<select id="member-collection" required></select></label><label>题目<select id="member-case" required></select></label><label>版本<input id="member-revision" type="number" min="1" required></label><label>业务权重<input id="member-weight" type="number" min="0" step="any" value="1" required></label></div><p>验证来源加入改善集合必须明确确认并说明理由。已暴露来源不能加入独立验证集合；不会自动改标签。</p><label class="check"><input id="member-exposure" type="checkbox">确认将整个验证来源组标记为已用于改善 / 暴露</label><label>用途转换理由<input id="member-exposure-reason"></label><button id="add-membership" type="submit">加入 / 固定该版本</button></form></section>
<dialog id="material-dialog"><h2 id="material-title">材料内容</h2><p id="material-info"></p><pre id="material-content"></pre><button id="close-material" type="button">关闭</button></dialog>
</main></body></html>`;

export const importCss = `:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#203047;background:#f3f5f7;line-height:1.6}*{box-sizing:border-box}body{margin:0}header,main{max-width:1140px;margin:auto;padding:20px}header p{margin-bottom:0}h1{font-size:1.8rem}h2{font-size:1.3rem}h3{font-size:1.1rem}section{background:white;border:1px solid #d5dce5;border-radius:8px;padding:20px;margin:18px 0}label{display:block;font-weight:600;margin:10px 0}input,select,textarea,button{font:inherit}input:not([type=checkbox]),select,textarea{display:block;width:100%;padding:9px;border:1px solid #9caabb;border-radius:4px;background:white;color:inherit}textarea{resize:vertical}button{padding:8px 14px;margin:7px 6px 7px 0;border:1px solid #8698ac;background:#edf2f7;border-radius:4px;color:#203047;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #5685ba;outline-offset:2px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 18px}.check{font-weight:400}.check input{margin-right:8px}.notice,#status{padding:12px;background:#edf2f7;border-left:4px solid #7489a5}#status[data-error=true]{background:#fff0ee;border-color:#c15140}.workspace,.file-row,.case-card,.collection-card{padding:12px;border:1px solid #d5dce5;margin:10px 0;border-radius:4px}.file-row{display:grid;grid-template-columns:minmax(140px,2fr) minmax(140px,1fr) minmax(140px,1fr) auto;gap:8px;align-items:center;font-size:.9rem}.file-row label{margin:0}table{border-collapse:collapse;width:100%;font-size:.9rem}td,th{text-align:left;border-bottom:1px solid #d5dce5;padding:8px;vertical-align:top;overflow-wrap:anywhere}.table-wrap{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f7;padding:12px;max-height:420px;overflow:auto}code{overflow-wrap:anywhere}details{margin:14px 0}summary{cursor:pointer}dialog{width:min(900px,95vw);max-height:90vh;border:1px solid #8796a7;border-radius:8px}dialog::backdrop{background:#20304780}[hidden]{display:none!important}.muted{color:#54657a}.badge{font-weight:600;color:#735220}@media(max-width:650px){header,main{padding:10px}section{padding:14px}.file-row{grid-template-columns:1fr}h1{font-size:1.45rem}}`;

export const importJs = String.raw`"use strict";
const $ = id => document.getElementById(id);
const roles = {input:"输入（未来模型可见）",diagnostic:"诊断（不作为模型输入）",scoring:"评分（不作为模型输入）"};
let token = "", state = {cases:[],collections:[],sources:[]}, preview = null, approvedPayload = null, generation = 0, busy = false, workspaceSequence = 0, detailSequence = 0;
const workspaces = [], attachments = [], protocolFiles = [];
function node(tag, text, attrs) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; for (const [key,value] of Object.entries(attrs || {})) el.setAttribute(key,value); return el; }
function status(text, error=false) { $("status").textContent = text; $("status").dataset.error = String(error); }
async function api(path, body) { const response = await fetch(path, {headers:{"X-Detroit-Token":token,...(body === undefined ? {} : {"Content-Type":"application/json"})},...(body === undefined ? {} : {method:"POST",body:JSON.stringify(body)})}); if (!response.ok) { const text = await response.text(); let message=text; try {message=JSON.parse(text).error || text;} catch {} throw new Error(message); } return response.json(); }
function invalidate() { generation++; preview=null; approvedPayload=null; $("approve").checked=false; $("approval-controls").hidden=true; $("save-button").disabled=true; $("preview").replaceChildren(node("p","输入已更改，请重新预览并批准。")); }
function pending(value) { busy=value; $("preview-button").disabled=value || !token; $("save-button").disabled=value || !preview || !$("approve").checked; $("create-collection").disabled=value; $("add-membership").disabled=value; }
function lines(id) { return $(id).value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); }
function labelled(parent, text, control) { const label=node("label",text); label.append(control); parent.append(label); return control; }
function select(options, value) { const el=node("select"); for (const [key,text] of Object.entries(options)) el.append(node("option",text,{value:key})); el.value=value; return el; }
function fileRow(item, container, protocol=false) { const row=node("div",undefined,{class:"file-row"}); const path=node("input",undefined,{type:"text",value:item.path,"aria-label":"材料相对路径"}); path.addEventListener("input",()=>{item.path=path.value;}); labelled(row,"相对路径",path); if(protocol) { const workspace=node("input",undefined,{type:"text",value:item.workspaceId || "","aria-label":"协议材料工作区 ID（附件留空）"}); labelled(row,"工作区 ID（附件留空）",workspace); workspace.addEventListener("input",()=>{item.workspaceId=workspace.value || null;}); } const role=select(roles,item.role); labelled(row,"材料角色",role); role.addEventListener("change",()=>{item.role=role.value;}); const required=node("input",undefined,{type:"checkbox"}); required.checked=item.required; labelled(row,"必需",required); required.addEventListener("change",()=>{item.required=required.checked;}); const remove=node("button","移除",{type:"button"}); remove.addEventListener("click",()=>{item.removed=true;row.remove();invalidate();}); row.append(remove); container.append(row); }
function addWorkspace() {
  const number=++workspaceSequence;
  const item={files:[],ignored:[],ignoredCount:0};
  workspaces.push(item);
  const row=node("div",undefined,{class:"workspace"});
  row.append(node("h4","工作区 " + number));
  const grid=node("div",undefined,{class:"grid"});
  item.id=labelled(grid,"工作区 ID",node("input",undefined,{value:"workspace-"+number,pattern:"[a-z0-9][a-z0-9-]*",required:"", "aria-label":"工作区 ID"}));
  item.name=labelled(grid,"工作区名称",node("input",undefined,{value:"工作区 "+number,required:"","aria-label":"工作区名称"}));
  item.revision=labelled(grid,"版本声明（非检出证明）",node("input",undefined,{"aria-label":"工作区版本"}));
  item.snapshot=labelled(grid,"快照状态",select({original:"原始",current:"当前",unknown:"未知",missing:"缺失"},"unknown"));
  item.required=labelled(grid,"必需工作区",node("input",undefined,{type:"checkbox"}));
  item.required.checked=true;
  row.append(grid);
  const input=node("input",undefined,{type:"file",multiple:"",webkitdirectory:"","aria-label":"选择工作区目录"});
  labelled(row,"选择目录（重新选择会替换此目录材料）",input);
  const files=node("div");
  row.append(files);
  input.addEventListener("change",()=>{
    item.files=[]; item.ignored=[]; item.ignoredCount=0;
    files.replaceChildren();
    const excluded={".git":true,".detroit":true,"node_modules":true,".env":true,".npmrc":true,".pypirc":true,"credentials.json":true,"credentials":true,"id_rsa":true,"id_ed25519":true};
    for(const file of input.files) {
      const relative=file.webkitRelativePath || file.name;
      const parts=relative.split("/");
      const path=parts.length>1 ? parts.slice(1).join("/") : relative;
      if(path.split("/").some(part=>{
        const name=part.toLowerCase();
        return Object.hasOwn(excluded,name) || name.startsWith(".env.") || /\.(pem|key|p12|pfx)$/.test(name);
      })) {
        item.ignoredCount++;
        if(item.ignored.length<100)item.ignored.push(path);
        continue;
      }
      const uploaded={file,path,role:"input",required:true};
      item.files.push(uploaded);
    }
    if(item.ignoredCount)files.append(node("p","排除 "+item.ignoredCount+" 个版本管理 / 依赖 / 明显秘密文件。预览列出排除项（最多100条）；仍须检查剩余内容是否敏感。",{class:"notice"}));
    for(const uploaded of item.files)fileRow(uploaded,files);
    invalidate();
  });
  const remove=node("button","移除工作区",{type:"button"});
  remove.addEventListener("click",()=>{item.removed=true;row.remove();invalidate();});
  row.append(remove);
  $("workspaces").append(row);
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
function materialContent(title, bytes) { $("material-title").textContent=title; $("material-info").textContent=bytes.length+" 字节；下方以 UTF-8 文本显示。二进制或无效 UTF-8 请下载原始字节核对。"; $("material-content").textContent=new TextDecoder().decode(bytes); $("material-dialog").showModal(); }
function localBytes(file) { if(file.encoding==="utf8") return new TextEncoder().encode(file.data); const binary=atob(file.data); return Uint8Array.from(binary,x=>x.charCodeAt(0)); }
async function savedBytes(saved, material) { const response=await fetch("/api/cases/"+encodeURIComponent(saved.id)+"/materials/"+encodeURIComponent(material.id)+"?revision="+saved.revision,{headers:{"X-Detroit-Token":token}}); if(!response.ok)throw new Error("读取材料失败："+response.status); return new Uint8Array(await response.arrayBuffer()); }
function download(path, bytes) { const url=URL.createObjectURL(new Blob([bytes])); const link=node("a",undefined,{href:url,download:path.split("/").pop() || "material"}); document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function materialTable(materials, saved, files) { const wrap=node("div",undefined,{class:"table-wrap"}), table=node("table"), header=node("tr");for(const title of ["工作区 / 路径","角色 / 必需","状态 / 大小","SHA-256 / 权限","确切内容"])header.append(node("th",title,{scope:"col"}));const thead=node("thead");thead.append(header);table.append(thead);const body=node("tbody");for(const material of materials) { const tr=node("tr");tr.append(node("td",(material.workspaceId || "附件")+" / "+material.path),node("td",(roles[material.role] || material.role)+" / "+(material.required?"必需":"可选")),node("td",material.state+" / "+material.bytes+" 字节"),node("td",(material.sha256 || "无字节摘要")+" / "+material.mode.toString(8)));const action=node("td");if(material.state==="present") { const getBytes=()=> saved ? savedBytes(saved,material) : Promise.resolve(localBytes(files.find(x=>x.path===material.path && (x.workspaceId || null)===material.workspaceId))); for(const [label,isDownload] of [["预览内容",false],["下载原始字节",true]]) {const button=node("button",label,{type:"button","aria-label":label+"："+material.path});button.addEventListener("click",async()=>{button.disabled=true;try {const bytes=await getBytes();if(isDownload)download(material.path,bytes);else materialContent(material.path,bytes);}catch(error){status(error.message,true);}finally{button.disabled=false;}});action.append(button);} } tr.append(action);body.append(tr); }table.append(body);wrap.append(table);return wrap; }
function readiness(container, value, warnings=[]) {
  container.append(node("p","已保存 / 待保存草稿，不可执行：通用执行器未接入。",{class:"badge"}));
  container.append(node("p","材料完整："+(value.materialsComplete?"是":"否")+"；起点声明："+(value.baselineDeclared?"是":"否")+"；验收定义："+(value.acceptanceDefined?"是":"否")));
  const list=node("ul");
  for(const text of new Set([...value.blockers,...value.warnings,...warnings]))list.append(node("li",text));
  container.append(list);
}
function manifestView(manifest) { const details=node("details");details.append(node("summary","完整任务 / 来源 / 环境 / 输出 / 验收协议（命令不执行）"),node("pre",JSON.stringify(manifest,null,2)));return details; }
function updateSelect(id, values, empty) { const el=$(id), selected=el.value;el.replaceChildren();if(empty!==undefined)el.append(node("option",empty,{value:""}));for(const [value,text] of values)el.append(node("option",text,{value}));if([...el.options].some(x=>x.value===selected))el.value=selected; }
async function refresh() {
  state=await api("/api/state");
  updateSelect("source-group",state.sources.map(x=>[x.id,x.kind+" / "+(x.reference || x.id)+" / "+x.purpose+(x.exposedAt?"（已暴露）":"")]),"创建新来源（同一问题请选已有组）");
  updateSelect("save-case",state.cases.map(x=>[x.id,x.manifest.title+"（当前 v"+x.revision+"）"]),"创建新题目");
  updateSelect("member-case",state.cases.map(x=>[x.id,x.manifest.title+" / "+x.id]),"请选择题目");
  const collections=state.collections.map(x=>[x.id,x.name+" / "+x.purpose]);
  updateSelect("save-collection",collections,"不加入集合");
  updateSelect("member-collection",collections,"请选择集合");
  $("case-list").replaceChildren();
  if(!state.cases.length)$("case-list").append(node("p","暂无已保存草稿。"));
  for(const saved of state.cases) {
    const card=node("article",undefined,{class:"case-card"});
    card.append(node("h3",saved.manifest.title),node("p",saved.id+" · v"+saved.revision+" · 草稿，不可执行 · 来源 "+saved.sourceGroupId));
    const button=node("button","查看版本与材料",{type:"button","data-case-id":saved.id});
    button.addEventListener("click",()=>showCase(saved.id,saved.revision));
    card.append(button);
    $("case-list").append(card);
  }
  $("collection-list").replaceChildren();
  for(const collection of state.collections) {
    const card=node("article",undefined,{class:"collection-card"});
    card.append(node("h3",collection.name),node("p",collection.id+" · "+collection.purpose+(collection.regression?" · 回归":"")));
    let exposed=0;
    const entries=node("ul");
    for(const entry of collection.entries) {
      const saved=state.cases.find(x=>x.id===entry.caseId);
      const source=state.sources.find(x=>x.id===saved?.sourceGroupId);
      if(source?.purpose==="improvement")exposed++;
      entries.append(node("li",entry.caseId+" · v"+entry.revision+" · 权重 "+entry.weight+(source?.exposedAt?" · 来源已用于改善":"")));
    }
    if(collection.purpose==="validation" && exposed)card.append(node("p",exposed+" 个成员来源已经暴露；该历史集合不能当作当前独立验证证据。",{class:"notice"}));
    if(!collection.entries.length)entries.append(node("li","暂无成员"));
    card.append(entries);
    $("collection-list").append(card);
  }
}
async function showCase(id, revision) {
  const serial=++detailSequence;
  $("case-detail").replaceChildren(node("p","正在读取草稿版本…"));
  try {
    const saved=await api("/api/cases/"+encodeURIComponent(id)+"?revision="+revision);
    if (serial!==detailSequence) return;
    const container=$("case-detail");
    container.replaceChildren(node("h3",saved.manifest.title+" · v"+saved.revision),node("p","批准摘要："+saved.approvalDigest));
    const latest=state.cases.find(x=>x.id===id);
    const version=select(Object.fromEntries(Array.from({length:latest?.revision || revision},(_,i)=>[String(i+1),"历史版本 v"+(i+1)])),String(revision));
    version.id="detail-revision";
    labelled(container,"不可变版本历史",version);
    version.addEventListener("change",()=>showCase(id,Number(version.value)));
    readiness(container,saved.readiness);
    const source=state.sources.find(x=>x.id===saved.sourceGroupId);
    container.append(
      node("p","来源组："+saved.sourceGroupId+" · 当前用途："+(source?.purpose || "未知")+" · 暴露时间："+(source?.exposedAt || "未记录")+"（已知状态，不保证未知泄漏不存在）"),
      manifestView(saved.manifest),materialTable(saved.materials,saved)
    );
    const memberships=node("ul");
    for (const collection of state.collections) {
      for (const entry of collection.entries.filter(x=>x.caseId===id)) memberships.append(node("li",collection.name+" · 固定 v"+entry.revision+" · 权重 "+entry.weight));
    }
    container.append(node("h4","集合成员关系（不会自动随新版本更新）"),memberships);
    const edit=node("button","以此版本材料创建新修订",{type:"button",id:"edit-case"});
    edit.addEventListener("click",async()=>{
      edit.disabled=true;
      try {
        const files=[];
        for (const material of saved.materials.filter(x=>x.state==="present")) {
          const bytes=await savedBytes(saved,material);
          let binary="";
          for (let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
          files.push({workspaceId:material.workspaceId,path:material.path,role:material.role,required:material.required,mode:material.mode,data:btoa(binary),encoding:"base64"});
        }
        const manifest={...saved.manifest,source:{...saved.manifest.source,groupId:saved.sourceGroupId}};
        $("manifest-json").value=JSON.stringify({manifest,files,warnings:[]},null,2);
        $("import-mode").value="manifest";
        toggleMode();
        $("save-case").value=id;
        $("expected-revision").value=latest?.revision || revision;
        protocolFiles.length=0;
        $("protocol-materials").replaceChildren();
        invalidate();
        $("import-form").scrollIntoView({behavior:"smooth"});
        status("已载入历史材料与原来源组；将基于当前 v"+$("expected-revision").value+" 创建新版本。来源用途若发生变化需在协议中明确修正并重新批准。");
      } catch (error) {
        status(error.message,true);
      } finally {
        edit.disabled=false;
      }
    });
    container.append(edit);
  } catch (error) {
    status(error.message,true);
    $("case-detail").replaceChildren(node("p","读取失败，请重试。"));
  }
}
function toggleMode() { const guided=$("import-mode").value==="guided";$("guided-fields").hidden=!guided;$("manifest-fields").hidden=guided;for(const element of $("guided-fields").querySelectorAll("input,select,textarea"))element.disabled=!guided; }
$("import-form").addEventListener("input",invalidate);$("import-form").addEventListener("change",invalidate);
$("import-mode").addEventListener("change",toggleMode);
$("add-workspace").addEventListener("click",addWorkspace);
$("attachment-files").addEventListener("change",()=>{for(const file of $("attachment-files").files){const item={file,path:file.name,role:"diagnostic",required:false};attachments.push(item);fileRow(item,$("attachments"));}$("attachment-files").value="";});
$("protocol-files").addEventListener("change",()=>{
  let declarations=[];
  try {
    const parsed=JSON.parse($("manifest-json").value);
    declarations=(parsed.manifest || parsed).materials || [];
  } catch {}
  for (const file of $("protocol-files").files) {
    const matches=declarations.filter(x=>x.path===file.name);
    const declaration=matches.length===1 ? matches[0] : null;
    const item={file,path:file.name,workspaceId:declaration?.workspaceId || null,role:declaration?.role || "diagnostic",required:declaration?.required ?? false};
    protocolFiles.push(item);
    fileRow(item,$("protocol-materials"),true);
  }
  $("protocol-files").value="";
});
$("manifest-file").addEventListener("change",async()=>{const file=$("manifest-file").files[0];if(!file)return;try {if(file.size>100*1024*1024)throw new Error("协议文件超过 100 MiB");const text=await file.text();JSON.parse(text);$("manifest-json").value=text;invalidate();status("协议 JSON 已载入，请核对并预览。");}catch(error){status(error.message,true);}});
$("source-group").addEventListener("change",()=>{const source=state.sources.find(x=>x.id===$("source-group").value);if(source){$("source-kind").value=source.kind;$("source-reference").value=source.reference;$("source-description").value=source.description;$("source-purpose").value=source.purpose;$("source-notice").textContent="来源组当前用途："+source.purpose+"；暴露时间："+(source.exposedAt || "未记录")+"。更改用途可能要求明确确认暴露及理由，不会静默转换。";}});
$("save-case").addEventListener("change",()=>{
  const target=state.cases.find(x=>x.id===$("save-case").value);
  $("expected-revision").value=target?.revision || "";
  if (target) {
    const source=state.sources.find(x=>x.id===target.sourceGroupId);
    $("source-group").value=target.sourceGroupId;
    $("source-kind").value=target.manifest.source.kind;
    $("source-reference").value=target.manifest.source.reference;
    if(source) $("source-purpose").value=source.purpose;
    status("新修订须保留来源组 "+target.sourceGroupId+" 及其类型 / 引用；目标当前 v"+target.revision+"。历史不会覆盖，协议缺少 groupId 时自动绑定此来源。");
  }
});
$("import-form").addEventListener("submit",async event=>{event.preventDefault();if(busy)return;invalidate();const serial=generation;pending(true);status("正在读取选择的材料并计算预览摘要…");try {const proposed=await payload();const result=await api("/api/preview",proposed);if(serial!==generation){status("预览期间输入已更改，请重新预览。",true);return;}approvedPayload=proposed;preview=result;const container=$("preview");container.replaceChildren(node("p",result.fileCount+" 个文件 · "+result.totalBytes+" 字节"),node("p","批准摘要："+result.approvalDigest));readiness(container,result.readiness,result.warnings);container.append(manifestView(result.manifest),materialTable(result.materials,null,proposed.files));$("approval-controls").hidden=false;status("预览完成。请逐项核对确切内容、角色和警告，再明确批准保存。");}catch(error){status(error.message,true);}finally{pending(false);}});
$("approve").addEventListener("change",()=>{$("save-button").disabled=busy || !preview || !$("approve").checked;});
for(const id of ["save-collection","save-weight","save-exposure","save-exposure-reason"])$(id).addEventListener("input",()=>{$("approve").checked=false;$("save-button").disabled=true;});
$("save-button").addEventListener("click",async()=>{if(busy || !preview || !$("approve").checked)return;const confirmation={approvalDigest:preview.approvalDigest,approved:true,weight:Number($("save-weight").value),confirmExposure:$("save-exposure").checked,exposureReason:$("save-exposure-reason").value};if($("save-collection").value)confirmation.collectionId=$("save-collection").value;if($("save-case").value){confirmation.caseId=$("save-case").value;confirmation.expectedRevision=Number($("expected-revision").value);}pending(true);status("正在保存已批准的确切材料…");try {const saved=await api("/api/import",{payload:approvedPayload,confirmation});invalidate();await refresh();await showCase(saved.id,saved.revision);status("草稿已持久保存："+saved.id+" · v"+saved.revision+"。材料摘要可核对；仍不可执行。");}catch(error){invalidate();status(error.message+"；请重新预览后批准。",true);}finally{pending(false);}});
$("refresh").addEventListener("click",async()=>{try {await refresh();invalidate();status("列表已刷新；请重新预览以核对最新来源状态。");}catch(error){status(error.message,true);}});
$("collection-form").addEventListener("submit",async event=>{event.preventDefault();if(busy)return;pending(true);status("正在创建集合…");try {await api("/api/collections",{name:$("collection-name").value,purpose:$("collection-purpose").value,regression:$("collection-regression").checked});await refresh();status("集合已创建。");}catch(error){status(error.message,true);}finally{pending(false);}});
$("member-case").addEventListener("change",()=>{$("member-revision").value=state.cases.find(x=>x.id===$("member-case").value)?.revision || "";});
$("membership-form").addEventListener("submit",async event=>{event.preventDefault();if(busy)return;pending(true);status("正在保存集合成员与版本…");try {await api("/api/collections/"+encodeURIComponent($("member-collection").value)+"/cases",{caseId:$("member-case").value,revision:Number($("member-revision").value),weight:Number($("member-weight").value),confirmExposure:$("member-exposure").checked,exposureReason:$("member-exposure-reason").value});await refresh();invalidate();status("集合成员已持久保存；来源状态可能改变，请重新预览尚未保存的导入。");}catch(error){status(error.message,true);}finally{pending(false);}});
$("close-material").addEventListener("click",()=>$("material-dialog").close());
addWorkspace();addWorkspace();
(async()=>{try {const session=await fetch("/api/session");if(!session.ok)throw new Error("无法建立本地会话");token=(await session.json()).token;await refresh();pending(false);status("本地会话已连接。请选择材料并描述问题；所有保存均需明确批准。");}catch(error){status(error.message,true);}})();
`;
