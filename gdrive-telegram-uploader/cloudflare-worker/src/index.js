const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function html() {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Drive → Telegram</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0b0f;color:#f4f4f5;margin:0;padding:32px}
    .box{max-width:920px;margin:0 auto;background:#15151b;border:1px solid #282833;border-radius:18px;padding:24px;box-shadow:0 10px 40px #0008}
    h1{margin-top:0} input,textarea,button{font:inherit;border-radius:12px;border:1px solid #333;background:#0f0f14;color:#fff;padding:12px}
    textarea{width:100%;box-sizing:border-box;min-height:90px;resize:vertical} button{cursor:pointer;background:#2563eb;border-color:#2563eb;font-weight:700} button:disabled{opacity:.5;cursor:not-allowed}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.muted{color:#aaa}.file{display:grid;grid-template-columns:32px 1fr auto;gap:10px;align-items:center;padding:10px;border-bottom:1px solid #27272f}.file:hover{background:#1d1d25}.status{white-space:pre-wrap;background:#0f0f14;border:1px solid #27272f;border-radius:12px;padding:12px;margin-top:16px}.top{display:flex;gap:10px;margin-bottom:14px}.top input{flex:1}.small{font-size:12px;color:#aaa}.danger{color:#ff9b9b}
  </style>
</head>
<body><div class="box">
  <h1>Google Drive → Telegram</h1>
  <p class="muted">Выбери файлы из папки Drive, напиши сообщение, отправь в канал.</p>
  <div class="top"><input id="password" type="password" placeholder="Admin password" /><button onclick="loadFiles()">Загрузить список</button></div>
  <label>Сообщение перед файлами</label>
  <textarea id="message" placeholder="Например: Вот файлы за сегодня 👇"></textarea>
  <div class="row" style="margin:14px 0"><button onclick="sendSelected()" id="sendBtn">Отправить выбранные</button><span id="count" class="muted"></span></div>
  <div id="files"></div>
  <div id="status" class="status muted">Жду действия...</div>
</div>
<script>
const $ = id => document.getElementById(id);
let files = [];
let currentJob = null;
function authHeaders(){ return { "content-type":"application/json", "x-admin-password": $("password").value }; }
function fmt(bytes){ if(!bytes) return "—"; const u=["B","KB","MB","GB"]; let i=0,n=Number(bytes); while(n>=1024&&i<u.length-1){n/=1024;i++} return n.toFixed(i?2:0)+" "+u[i]; }
function setStatus(v){ $("status").textContent = typeof v === "string" ? v : JSON.stringify(v,null,2); }
function render(){
  $("files").innerHTML = files.map((f,i)=>`<label class="file"><input type="checkbox" data-i="${i}" checked><div><b>${escapeHtml(f.name)}</b><div class="small">${escapeHtml(f.mimeType||"")} · ${escapeHtml(f.modifiedTime||"")}</div></div><span>${fmt(f.size)}</span></label>`).join("");
  $("count").textContent = files.length ? `${files.length} файлов` : "";
}
function escapeHtml(s){ return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
async function loadFiles(){
  setStatus("Загружаю список Drive...");
  const r = await fetch("/api/list", { method:"POST", headers:authHeaders(), body:"{}" });
  const data = await r.json();
  if(!data.ok){ setStatus(data); return; }
  files = data.files || [];
  render();
  setStatus(`Готово. Найдено файлов: ${files.length}`);
}
async function sendSelected(){
  const selected = [...document.querySelectorAll('input[type=checkbox][data-i]:checked')].map(x => files[Number(x.dataset.i)]);
  if(!selected.length){ setStatus("Выбери хотя бы один файл"); return; }
  $("sendBtn").disabled = true;
  setStatus("Запускаю RunPod job...");
  const r = await fetch("/api/send", { method:"POST", headers:authHeaders(), body: JSON.stringify({ message: $("message").value, files: selected }) });
  const data = await r.json();
  if(!data.ok){ $("sendBtn").disabled=false; setStatus(data); return; }
  currentJob = data.jobId;
  setStatus({ started:true, jobId:currentJob, raw:data.raw });
  poll();
}
async function poll(){
  if(!currentJob) return;
  const r = await fetch(`/api/status/${currentJob}`, { headers:{ "x-admin-password": $("password").value } });
  const data = await r.json();
  setStatus(data);
  const st = data.raw?.status || data.status;
  if(["COMPLETED","FAILED","CANCELLED"].includes(st)){ $("sendBtn").disabled=false; return; }
  setTimeout(poll, 5000);
}
</script></body></html>`;
}

function checkAdmin(request, env) {
  const got = request.headers.get("x-admin-password") || "";
  return got && env.ADMIN_PASSWORD && got === env.ADMIN_PASSWORD;
}

async function googleAccessToken(env) {
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("refresh_token", env.GOOGLE_REFRESH_TOKEN);
  body.set("grant_type", "refresh_token");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data.access_token;
}

async function listDriveFiles(env) {
  const token = await googleAccessToken(env);
  const q = `'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q,
    pageSize: "1000",
    orderBy: "modifiedTime desc",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "files(id,name,size,mimeType,modifiedTime,webViewLink)"
  });
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return (data.files || []).map(f => ({ ...f, size: f.size ? Number(f.size) : 0 }));
}

async function startRunpod(env, payload) {
  const r = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ input: payload })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function runpodStatus(env, id) {
  const r = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_ENDPOINT_ID}/status/${id}`, {
    headers: { authorization: `Bearer ${env.RUNPOD_API_KEY}` }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/") return new Response(html(), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (!checkAdmin(request, env)) return new Response(JSON.stringify({ ok:false, error:"bad password" }), { status:401, headers:JSON_HEADERS });

      if (url.pathname === "/api/list" && request.method === "POST") {
        const files = await listDriveFiles(env);
        return new Response(JSON.stringify({ ok:true, files }), { headers:JSON_HEADERS });
      }
      if (url.pathname === "/api/send" && request.method === "POST") {
        const body = await request.json();
        const files = (body.files || []).map(f => ({ id:f.id, name:f.name, size:f.size || 0, mimeType:f.mimeType || "" }));
        const raw = await startRunpod(env, { message: body.message || "", files });
        return new Response(JSON.stringify({ ok:true, jobId: raw.id, raw }), { headers:JSON_HEADERS });
      }
      if (url.pathname.startsWith("/api/status/")) {
        const id = url.pathname.split("/").pop();
        const raw = await runpodStatus(env, id);
        return new Response(JSON.stringify({ ok:true, raw }), { headers:JSON_HEADERS });
      }
      return new Response("Not found", { status:404 });
    } catch (e) {
      return new Response(JSON.stringify({ ok:false, error:String(e) }), { status:500, headers:JSON_HEADERS });
    }
  }
};
