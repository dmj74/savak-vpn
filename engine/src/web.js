/**
 * Savak ladder dashboard — a zero-dependency control panel.
 *
 * The dashboard exists for one reason: a "smart" selector that you cannot interrogate
 * is just a superstition. Every slider re-runs the real engine (measurement model →
 * gates → score → hysteresis → config) and the page shows *why* the phone would pick
 * what it picks, including the generated sing-box config validated against the
 * official schema on the server.
 */

import http from 'node:http';
import { planForNode, planAcrossNodes } from './index.js';
import { exampleProfile } from './profile.js';
import { synthesizeLink, CENSOR_PROFILES } from './probes.js';
import { POLICIES } from './tune.js';
import { validateConfig } from './validate.js';
import { RUNGS } from './ladder.js';

const PAGE = /* html */ `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Savak · پلکان هوشمند دور زدن فیلترینگ</title>
<style>
:root{
  --bg:#0a0d14; --panel:#111725; --panel2:#0d1320; --line:#1e2839;
  --fg:#e8eefc; --dim:#8fa0bd; --acc:#4dd6c1; --acc2:#7aa2ff; --warn:#ffb457; --bad:#ff6b7d;
}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#16233c 0%,var(--bg) 60%);color:var(--fg);
 font:14px/1.65 "Vazirmatn","Segoe UI",Tahoma,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:26px 18px 60px}
header{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
h1{font-size:22px;margin:0;font-weight:700;letter-spacing:-.2px}
h1 small{color:var(--dim);font-size:12px;font-weight:400;display:block;margin-top:4px}
.badge{font-size:11px;color:var(--acc);border:1px solid #24463f;background:#0f2b26;padding:4px 9px;border-radius:999px}
.grid{display:grid;grid-template-columns:322px 1fr;gap:16px}
@media(max-width:980px){.grid{grid-template-columns:1fr}}
.card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:14px;padding:14px 15px}
.card h2{font-size:12px;margin:0 0 10px;color:var(--dim);font-weight:600;letter-spacing:.4px;text-transform:uppercase}
label{display:block;font-size:12px;color:var(--dim);margin:12px 0 5px}
select,input[type=range]{width:100%}
select{background:#0b1220;color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:8px 9px;font:inherit}
input[type=range]{accent-color:var(--acc);padding:0}
.row{display:flex;gap:10px}.row>*{flex:1}
.val{color:var(--acc);font-variant-numeric:tabular-nums}
.chk{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fg);margin-top:10px}
.chk input{width:15px;height:15px;accent-color:var(--acc)}
.chosen{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.chosen .big{font-size:20px;font-weight:700;color:var(--acc)}
.chosen .why{color:var(--dim);font-size:12.5px;max-width:640px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:right;color:var(--dim);font-weight:600;font-size:11px;padding:6px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 6px;border-bottom:1px solid #16202f;vertical-align:top}
tr.on td{background:#0f2b26}
.bar{height:6px;border-radius:3px;background:#16202f;overflow:hidden;min-width:56px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--acc2),var(--acc))}
.mini{color:var(--dim);font-size:11.5px}
.pill{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);margin-inline-start:4px}
.pill.ok{color:var(--acc);border-color:#24463f;background:#0f2b26}
.pill.no{color:var(--bad);border-color:#4a2430;background:#2a1219}
ul.why{list-style:none;padding:0;margin:0}
ul.why li{padding:7px 0;border-bottom:1px dashed #1a2434;font-size:12.6px}
ul.why li b{color:var(--acc2);font-weight:600;font-variant-numeric:tabular-nums}
ul.why li span{color:var(--dim)}
pre{background:#070b12;border:1px solid var(--line);border-radius:11px;padding:12px;overflow:auto;max-height:340px;
 font:11.5px/1.55 ui-monospace,Menlo,Consolas,monospace;color:#c9d6f0;direction:ltr;text-align:left}
.ok{color:var(--acc)}.bad{color:var(--bad)}.warn{color:var(--warn)}
details{margin-top:8px}
summary{cursor:pointer;color:var(--dim);font-size:12px}
a{color:var(--acc2)}
footer{margin-top:22px;color:#5f7195;font-size:11.5px;text-align:center}
code{direction:ltr;display:inline-block}
</style></head>
<body>
<div class="wrap">
<header>
  <h1>Savak · پلکان هوشمند دور زدن فیلترینگ
    <small>هر پله = یکی از معروف‌ترین پروتکل‌های ضدسانسور دنیا؛ موتور با سنجش زنده‌ی خط، سریع‌ترین پله‌ی «قابل‌استفاده» را انتخاب می‌کند</small></h1>
  <div class="badge" id="ver">sing-box 1.14 · engine 0.2</div>
</header>

<div class="grid">
  <div class="card">
    <h2>شرایط خط</h2>
    <label>حالت (وزن‌ها)</label><select id="mode"></select>
    <label>دسترسی</label><select id="access"><option value="wifi">WiFi</option><option value="cellular">همراه</option></select>
    <label>پروفایل سانسور تشخیص‌داده‌شده</label><select id="censor"></select>
    <label>RTT — <span class="val" id="rttV"></span> ms</label>
    <input type="range" id="rtt" min="5" max="300" value="46"/>
    <label>پکت‌لاست — <span class="val" id="lossV"></span> %</label>
    <input type="range" id="loss" min="0" max="25" step="0.1" value="0.4"/>
    <label>پهنای باند — <span class="val" id="bwV"></span> Mbps</label>
    <input type="range" id="bw" min="1" max="500" value="180"/>
    <label>گره</label><select id="node"></select>
    <div class="chk"><input type="checkbox" id="root"/><label for="root" style="margin:0">دسترسی سوکت خام (spoof روی دسکتاپ)</label></div>
    <div class="chk"><input type="checkbox" id="legacy"/><label for="legacy" style="margin:0">اجازه‌ی پله‌های قدیمی (VMess)</label></div>
    <div class="chk"><input type="checkbox" id="allrows" checked/><label for="allrows" style="margin:0">نمایش پله‌های حذف‌شده</label></div>
  </div>

  <div>
    <div class="card chosen" id="chosen"></div>
    <div class="card" style="margin-top:16px">
      <h2>رتبه‌بندی پلکان (زنده)</h2>
      <div style="overflow:auto"><table id="ladder"></table></div>
    </div>
    <div class="row" style="margin-top:16px">
      <div class="card"><h2>تنظیمات اعمال‌شده (چرا سریع‌تر است؟)</h2><ul class="why" id="notes"></ul></div>
      <div class="card"><h2>ستیزگی روی سیم</h2><ul class="why" id="flags"></ul>
        <div id="warnings" style="margin-top:10px"></div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>کانفیگ خروجی <span id="vstat"></span></h2>
      <pre id="cfg"></pre>
      <details><summary>لینک‌های اشتراک (سازگار با Hiddify / v2rayNG / Shadowrocket)</summary><pre id="links"></pre></details>
    </div>
  </div>
</div>
<footer>محرمانه: این داشبورد فقط مدل سنجش و تولید کانفیگ را نشان می‌دهد؛ هیچ ترافیکی از مرورگر شما عبور نمی‌کند.</footer>
</div>
<script>
const $=s=>document.querySelector(s);
const opts=(el,items,labels)=>{el.innerHTML=items.map((v,i)=>\`<option value="\${v}">\${(labels&&labels[i])||v}</option>\`).join('')};
async function boot(){
  const meta=await fetch('/api/meta').then(r=>r.json());
  opts($('#mode'),meta.modes,meta.modeLabels);$('#mode').value='auto';
  opts($('#censor'),meta.censors,meta.censors.map(c=>meta.censorHints[c]));
  opts($('#node'),meta.nodes,meta.nodeLabels);
  ['mode','access','censor','rtt','loss','bw','node','root','legacy','allrows'].forEach(id=>{
    $('#'+id).addEventListener('input',run)});
  run();
}
let t=null;
function run(){clearTimeout(t);t=setTimeout(render,90)}
async function render(){
  const q=new URLSearchParams({mode:$('#mode').value,access:$('#access').value,censor:$('#censor').value,
    rtt:$('#rtt').value,loss:$('#loss').value,bw:$('#bw').value,node:$('#node').value,
    root:$('#root').checked?'1':'0',legacy:$('#legacy').checked?'1':'0'});
  ['rtt','loss','bw'].forEach(k=>$('#'+k+'V').textContent=$('#'+k).value);
  const p=await fetch('/api/plan?'+q).then(r=>r.json());
  const c=p.ladder.find(l=>l.rungId===p.chosen)||{};
  $('#chosen').innerHTML=\`<div><div class="big">\${p.chosen}</div><div class="mini">\${esc(c.lineage||'')}</div></div>
    <div class="why"><b>\${esc(p.decision.why)}</b><br/>امتیاز \${p.ladder.find(l=>l.rungId===p.chosen).score.toFixed(3)} — گره \${esc(p.node.label)} — سیگنال‌ها: \${p.signals.length?p.signals.map(esc).join('، '):'بدون سیگنال سانسور'}</div>\`;
  const rows=p.ranking.filter(r=>p.allrows||r.feasible).map(r=>{
    const l=p.ladder.find(x=>x.rungId===r.rungId);
    const parts=l?l.parts:null;
    const bar=v=>'<span class="bar" style="display:inline-block;width:56px"><i style="width:'+Math.round((v||0)*100)+'%"></i></span>';
    return '<tr class="'+(r.rungId===p.chosen?'on':'')+'"><td>'+(r.feasible?'':'<span class="pill no">حذف</span> ')+
      '<b>'+r.rungId+'</b><div class="mini">'+esc((l&&l.title)||'')+ '</div>'+
      (r.feasible?'':'<div class="mini">'+esc(r.reason)+'</div>')+'</td>'+
      '<td>'+(r.score||0).toFixed(3)+'<br/>'+bar(r.score/1.2)+'</td>'+
      (parts?'<td class="mini">thr '+bar(parts.throughput)+'<br/>lat '+bar(parts.latency)+'</td>'+
        '<td class="mini">stab '+bar(parts.stability)+'<br/>evade '+bar(parts.evasion)+'</td>'+
        '<td class="mini">cost '+bar(parts.cost)+(l&&l.measured?'<br/><span class="pill ok">اندازه‌گیری‌شده '+(l.measured.downMbps)+' Mbps</span>':'<br/>مدل')+'</td>'
      :'<td colspan="3"></td>')+'</tr>';
  }).join('');
  $('#ladder').innerHTML='<tr><th>پله</th><th>امتیاز</th><th>بازده/تأخیر</th><th>پایداری/ستیزگی</th><th>هزینه</th></tr>'+rows;
  $('#notes').innerHTML=(c.notes||[]).map(n=>'<li><b>'+esc(n.key)+'</b><br/><span>'+esc(n.why)+'</span></li>').join('')||'<li class="mini">—</li>';
  $('#flags').innerHTML=(c.flags||[]).map(f=>'<li><b>'+esc(f.flag)+'</b><br/><span>'+esc(f.note)+'</span></li>').join('');
  $('#warnings').innerHTML=(p.warnings||[]).map(w=>'<div class="warn">⚠ '+esc(w)+'</div>').join('');
  $('#cfg').textContent=JSON.stringify(p.config,null,2);
  $('#links').textContent=Object.entries(p.shareLinks).map(([k,v])=>k+':\\n  '+v).join('\\n\\n');
  const v=p.validation;
  $('#vstat').innerHTML=v?'<span class="'+(v.ok?'ok':'bad')+'">'+(v.ok?'✔ معتبر طبق اسکیمای رسمی sing-box':'✘ نامعتبر ('+v.engine+')')+'</span>'+(v.ok?'':' <span class="bad mini">'+v.errors.slice(0,6).map(esc).join(' | ')+'</span>'):'';
}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
boot();
</script>
</body></html>`;

function queryToArgs(url) {
  const q = Object.fromEntries(url.searchParams.entries());
  return {
    mode: q.mode ?? 'auto',
    access: q.access ?? 'wifi',
    censor: q.censor ?? 'none',
    rtt: Number(q.rtt ?? 46),
    loss: Number(q.loss ?? 0.4),
    bw: Number(q.bw ?? 180),
    node: q.node,
    root: q.root === '1',
    legacy: q.legacy === '1',
  };
}

export function createServer({ profile } = {}) {
  const prof = profile ?? exampleProfile();
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      if (url.pathname === '/api/meta') {
        return json(200, {
          modes: Object.keys(POLICIES),
          modeLabels: Object.values(POLICIES).map((p) => p.label),
          censors: Object.keys(CENSOR_PROFILES),
          censorHints: {
            none: 'بدون مزاحمت (خط تمیز)',
            'sni-only': 'فیلتر SNI',
            'udp-throttle': 'اختناق UDP / QoS پورت',
            'quic-kill': 'قطع QUIC',
            'udp-block': 'بلاک کامل UDP',
            'deep-packet': 'DPI عمیق (اثر انگشت + اندازه‌ی بسته)',
            'total-recall': 'فلج کامل (IP block + probe)',
          },
          nodes: prof.servers.map((s) => s.id),
          nodeLabels: prof.servers.map((s) => `${s.label} · ${s.address}`),
          rungs: RUNGS.map((r) => ({ id: r.id, title: r.title, family: r.family, lineage: r.lineage })),
        });
      }
      if (url.pathname === '/api/plan') {
        const a = queryToArgs(url);
        const link = synthesizeLink({ access: a.access, censor: a.censor, rttMs: a.rtt, lossPct: a.loss, downMbps: a.bw });
        const plan = planForNode({
          profile: prof,
          nodeId: a.node,
          policy: { mode: a.mode, allowLegacy: a.legacy },
          link,
          client: a.root
            ? { platform: 'linux', mtu: 1460, capabilities: { packetInjection: true, kernelTls: true, graphicalClient: false, cdnFronting: false, mptcp: true } }
            : { platform: 'android' },
        });
        const validation = await validateConfig(plan.config);
        return json(200, {
          ...plan,
          allrows: true,
          signals: Object.entries(link).filter(([, v]) => v === true).map(([k]) => k),
          validation,
        });
      }
      if (url.pathname === '/api/config') {
        const a = queryToArgs(url);
        const plan = planForNode({
          profile: prof,
          nodeId: a.node,
          policy: { mode: a.mode, allowLegacy: a.legacy },
          link: synthesizeLink({ access: a.access, censor: a.censor, rttMs: a.rtt, lossPct: a.loss, downMbps: a.bw }),
          client: {},
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="savak-${plan.node.id}-${plan.chosen}.json"` });
        return res.end(`${JSON.stringify(plan.config, null, 2)}\n`);
      }
      if (url.pathname === '/api/nodes') {
        const a = queryToArgs(url);
        return json(
          200,
          planAcrossNodes({
            profile: prof,
            policy: { mode: a.mode, allowLegacy: a.legacy },
            link: synthesizeLink({ access: a.access, censor: a.censor, rttMs: a.rtt, lossPct: a.loss, downMbps: a.bw }),
            client: {},
          }),
        );
      }
      if (url.pathname === '/api/rungs') return json(200, RUNGS);
      json(404, { error: 'not found' });
    } catch (e) {
      json(500, { error: e.message, stack: e.stack?.split('\n').slice(0, 4) });
    }
  });
}

export async function serve({ port = 8080 } = {}) {
  const server = createServer();
  await new Promise((r) => server.listen(port, '0.0.0.0', r));
  process.stdout.write(`savak dashboard → http://0.0.0.0:${port}\n`);
  return server;
}
