// The dashboard page — served as one static document; it polls /api/state.
// Dark, warm-charcoal, single red accent. A tool, but a considered one.
export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-coord</title>
<style>
  :root{ --bg:#15120f; --panel:#1d1916; --line:#2c2622; --ink:#ece6df; --mut:#8a807650; --mut2:#9a8f83;
         --red:#cc2323; --reddim:#7a1212; --ok:#7bba6e; }
  *{box-sizing:border-box} html,body{margin:0}
  body{background:radial-gradient(1200px 600px at 80% -10%,#221c17,transparent),var(--bg);
       color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto;min-height:100vh;padding:28px 32px}
  mono,.mono,code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace}
  header{display:flex;align-items:baseline;gap:16px;margin-bottom:24px;border-bottom:1px solid var(--line);padding-bottom:16px}
  h1{font-size:22px;font-weight:300;letter-spacing:.18em;text-transform:uppercase;margin:0}
  h1 b{color:var(--red);font-weight:600}
  .count{color:var(--mut2);font-size:13px} .count b{color:var(--ink);font-weight:600}
  .deg{margin-left:auto;background:var(--reddim);color:#fff;padding:4px 12px;border-radius:3px;font-size:12px;letter-spacing:.05em;display:none}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px;margin-bottom:28px}
  .repo{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
  .repo h2{margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:.04em;display:flex;gap:8px;align-items:center}
  .repo h2 .b{color:var(--mut2);font-weight:400}
  .agent{padding:9px 0;border-top:1px solid var(--line);display:flex;gap:10px;align-items:flex-start}
  .agent:first-of-type{border-top:0}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--ok);margin-top:6px;flex:none;box-shadow:0 0 8px var(--ok)}
  .dot.idle{background:#b8923f;box-shadow:none} .dot.codex{background:var(--red);box-shadow:0 0 8px var(--red)}
  .nm{font-weight:600;font-size:13px} .nm .tool{color:var(--mut2);font-weight:400;font-size:11px;margin-left:6px}
  .task{color:var(--mut2);font-size:12px} .file{color:var(--red);font-size:12px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
  .card h3{margin:0 0 10px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut2);font-weight:600}
  .row{display:flex;gap:10px;padding:5px 0;font-size:12.5px;border-top:1px solid var(--line)}
  .row:first-of-type{border-top:0}
  .row .who{color:var(--mut2);margin-left:auto;font-size:11px}
  .empty{color:var(--mut2);font-size:12px;font-style:italic}
  .feed{max-height:260px;overflow:auto} .feed .row .t{color:var(--mut2);font-size:11px;min-width:58px}
  .ev{color:var(--red)} .ev.release,.ev.intent{color:var(--mut2)}
</style></head>
<body>
  <header><h1>agent<b>·</b>coord</h1><span class="count"><b id="n">0</b> live agents</span><span class="deg" id="deg">⚠ DEGRADED — enforcement off</span></header>
  <div class="grid" id="fleet"></div>
  <div class="cols">
    <div class="card"><h3>Resource leases</h3><div id="res"></div></div>
    <div class="card"><h3>Queue</h3><div id="queue"></div></div>
  </div>
  <div class="card" style="margin-top:16px"><h3>Activity</h3><div class="feed" id="feed"></div></div>
<script>
const $=s=>document.querySelector(s);
const base=p=>p?p.replace(/\\/+$/,'').split('/').pop():'—';
const esc=s=>String(s??'').replace(/[<&]/g,c=>({'<':'&lt;','&':'&amp;'}[c]));
const fresh=t=>Date.now()-new Date(t).getTime()<90000;
async function tick(){
  let s; try{ s=await (await fetch('/api/state',{cache:'no-store'})).json(); }catch{ return; }
  $('#n').textContent=s.agents.length;
  $('#deg').style.display=s.degraded?'block':'none';
  const byRepo={};
  for(const a of s.agents){ (byRepo[a.repo_path||'(no repo)']=byRepo[a.repo_path||'(no repo)']||[]).push(a); }
  $('#fleet').innerHTML=Object.entries(byRepo).map(([repo,as])=>\`
    <div class="repo"><h2>\${esc(base(repo))} <span class="b">\${esc(as[0]?.branch||'')}</span></h2>
    \${as.map(a=>\`<div class="agent"><div class="dot \${a.tool==='codex'?'codex':''} \${fresh(a.last_heartbeat)?'':'idle'}"></div>
      <div><div class="nm">\${esc(a.agent_id)}<span class="tool">\${esc(a.tool)}</span></div>
      \${a.editing?\`<div class="file">⚙ \${esc(a.editing)}</div>\`:''}
      \${a.current_task?\`<div class="task">\${esc(a.current_task)}</div>\`:''}</div></div>\`).join('')}
    </div>\`).join('')||'<div class="empty">no live agents</div>';
  $('#res').innerHTML=s.resourceLeases.map(r=>\`<div class="row"><span class="mono">\${esc(r.resource_id)}</span><span class="who">\${esc(r.agent_id)}</span></div>\`).join('')||'<div class="empty">none</div>';
  $('#queue').innerHTML=s.queue.map(q=>\`<div class="row"><span class="mono">\${esc((q.key||'').split('||').pop())}</span><span class="who">\${esc(q.agent_id)}</span></div>\`).join('')||'<div class="empty">none</div>';
  $('#feed').innerHTML=s.recent.map(e=>\`<div class="row"><span class="t">\${esc((e.ts||'').slice(11,19))}</span><span class="ev \${esc(e.event)}">\${esc(e.event)}</span><span>\${esc(e.detail||'')}</span><span class="who">\${esc(e.agent_id)}</span></div>\`).join('')||'<div class="empty">none</div>';
}
tick(); setInterval(tick,1500);
</script>
</body></html>`;
