/**
 * The inspector page, as one server-sent HTML document.
 *
 * It is deliberately not part of the settings client bundle: that page is React inside DSH's
 * shell, needs a build step and only appears in the Web UI it is loaded by, while this page is
 * opened directly in a tab and has to work whether or not the client bundle was rebuilt. One
 * document, no imports, no framework.
 *
 * The token is inlined here because this document is the one thing served without one: the
 * page could not fetch it otherwise. Another origin may fetch this HTML, but it cannot read
 * the reply (no CORS headers), so it never learns the token — which is exactly what the token
 * is for.
 */
import { ROUTE, TOKEN_HEADER } from './protocol'

export function inspectorPage(token: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev 浏览器 · 交互式检查器</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 20px 24px 60px; background: #16181d; color: #e6e8ec;
  font: 14px/1.6 system-ui, "Segoe UI", sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 24px 0 8px; }
p.hint { color: #9aa3b2; margin: 0 0 16px; }
section { max-width: 1080px; }
label { display: block; margin: 10px 0; }
input, textarea { width: 100%; box-sizing: border-box; background: #1e2127; color: inherit;
  border: 1px solid #333843; border-radius: 6px; padding: 8px; font: inherit; }
textarea { min-height: 56px; resize: vertical; }
button { background: #2b3040; color: inherit; border: 1px solid #3a4152; border-radius: 6px;
  padding: 6px 12px; font: inherit; cursor: pointer; margin-right: 8px; }
button:disabled { opacity: .4; cursor: default; }
button.primary { background: #2f6fd0; border-color: #2f6fd0; }
#state { padding: 10px 12px; background: #1e2127; border: 1px solid #333843; border-radius: 6px; }
#note { color: #e0b35a; margin: 8px 0; }
#frame { max-width: 100%; border: 1px solid #333843; border-radius: 6px; margin-top: 12px;
  display: none; }
table { border-collapse: collapse; width: 100%; margin-top: 12px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #2a2f39; vertical-align: top; }
th { color: #9aa3b2; font-weight: 600; }
td.p { width: 110px; }
.bar { display: inline-block; height: 8px; background: #2f6fd0; border-radius: 4px;
  vertical-align: middle; }
#log { padding-left: 20px; margin: 12px 0 0; }
#log li { margin: 2px 0; }
#log li.wait { color: #e0b35a; }
#log li.err { color: #e06a6a; }
#runs button { display: block; margin: 4px 0; text-align: left; width: 100%; }
.strip { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.strip figure { margin: 0; width: 200px; }
.strip img { width: 100%; border: 1px solid #333843; border-radius: 4px; cursor: pointer; }
.strip figcaption { color: #9aa3b2; font-size: 12px; }
details { margin-top: 10px; }
summary { cursor: pointer; color: #9aa3b2; }
pre { background: #1e2127; border: 1px solid #333843; border-radius: 6px; padding: 8px;
  overflow: auto; max-height: 280px; font-size: 12px; }
</style>
</head>
<body>
<section>
  <h1>Jev 浏览器 · 交互式检查器</h1>
  <p class="hint">手动跑一次任务：能看到每一步在选哪个元素、把握多大，可以在动作执行前停下、单步走，也可以回看之前跑过的运行。</p>

  <label>目标<textarea id="goal" placeholder="例如：查一趟明天苏黎世到伦敦的单程航班，把最早那班的价格记下来"></textarea></label>
  <label>起始网址<input id="url" placeholder="https://example.com"></label>
  <label>必须出现（每行一条，前缀 ! 表示必须不出现；可留空）<textarea id="expect"></textarea></label>
  <button id="go" class="primary">开始运行</button>

  <div id="state">未开始</div>
  <div id="note"></div>
  <div>
    <button id="pause">暂停</button>
    <button id="continue">继续</button>
    <button id="step">单步</button>
    <button id="stop">停止</button>
  </div>
  <img id="frame" alt="当前页面">
  <div id="table"></div>
  <ol id="log"></ol>
</section>

<section>
  <h2>已跑过的运行（含原始往返留痕与逐帧画面）</h2>
  <div id="runs"></div>
  <div id="replay"></div>
</section>

<script>
var TOKEN = ${JSON.stringify(token)};
var HEADER = ${JSON.stringify(TOKEN_HEADER)};
var ROUTE = ${JSON.stringify(ROUTE)};

function api(path, init) {
  var headers = Object.assign({}, (init && init.headers) || {});
  headers[HEADER] = TOKEN;
  return fetch(ROUTE + path, Object.assign({}, init, { headers: headers })).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (body) {
      if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
      return body;
    });
  });
}

var seen = 0;
var frameKey = '';
var $ = function (id) { return document.getElementById(id); };

function button(id, path, body) {
  $(id).onclick = function () {
    api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) })
      .catch(function (e) { $('note').textContent = e.message; });
  };
}

button('go', '/inspector/start', function () {
  return {
    goal: $('goal').value,
    url: $('url').value,
    expect: $('expect').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean)
  };
});
button('pause', '/inspector/control', function () { return { action: 'pause' }; });
button('continue', '/inspector/control', function () { return { action: 'resume' }; });
button('step', '/inspector/control', function () { return { action: 'step' }; });
button('stop', '/inspector/control', function () { return { action: 'stop' }; });

function render(s) {
  $('state').textContent = s.state;
  $('note').textContent = s.note || '';
  $('go').disabled = s.running;
  $('pause').disabled = !s.running || s.paused;
  $('continue').disabled = !s.running || !s.paused;
  $('step').disabled = !s.running;
  $('stop').disabled = !s.running;

  if (s.steps) {
    s.steps.forEach(function (item) {
      if (item.seq <= seen) return;
      seen = item.seq;
      var li = document.createElement('li');
      li.textContent = item.line;
      if (item.kind === 'waiting') li.className = 'wait';
      if (item.kind === 'error') li.className = 'err';
      $('log').appendChild(li);
      if (item.table) showTable(item.table);
    });
    $('log').scrollTop = $('log').scrollHeight;
  }

  if (s.frame && s.frame.file) {
    var key = s.frame.run + '/' + s.frame.file;
    if (key !== frameKey) {
      frameKey = key;
      $('frame').src = ROUTE + '/inspector/frame?run=' + encodeURIComponent(s.frame.run) + '&file=' + encodeURIComponent(s.frame.file) + '&token=' + encodeURIComponent(TOKEN);
      $('frame').style.display = 'block';
    }
  }

  if (s.runs) {
    var box = $('runs');
    box.textContent = '';
    if (!s.runs.length) box.textContent = '（还没有跑过）';
    s.runs.forEach(function (run) {
      var b = document.createElement('button');
      b.textContent = run.label;
      b.onclick = function () { showRun(run.name); };
      box.appendChild(b);
    });
  }
}

function showTable(table) {
  var rows = ['<table><tr><th>#</th><th>元素</th><th>可做的动作</th><th class="p">把握</th></tr>'];
  table.forEach(function (row) {
    var p = typeof row.probability === 'number' ? row.probability : null;
    var bar = p === null ? '—' : '<span class="bar" style="width:' + Math.round(p * 90) + 'px"></span> ' + p.toFixed(2);
    rows.push('<tr><td>' + esc(row.index) + '</td><td>' + esc(row.label) + '</td><td>' +
      esc((row.operations || []).join('/')) + '</td><td class="p">' + bar + '</td></tr>');
  });
  $('table').innerHTML = rows.join('') + '</table>';
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function showRun(name) {
  api('/inspector/run?run=' + encodeURIComponent(name)).then(function (run) {
    var box = $('replay');
    box.textContent = '';
    var head = document.createElement('p');
    head.textContent = run.label;
    box.appendChild(head);

    var strip = document.createElement('div');
    strip.className = 'strip';
    run.frames.forEach(function (frame) {
      var figure = document.createElement('figure');
      var img = document.createElement('img');
      img.src = ROUTE + '/inspector/frame?run=' + encodeURIComponent(name) + '&file=' + encodeURIComponent(frame.file) + '&token=' + encodeURIComponent(TOKEN);
      var caption = document.createElement('figcaption');
      caption.textContent = (frame.at_ms / 1000).toFixed(1) + ' 秒';
      figure.appendChild(img);
      figure.appendChild(caption);
      strip.appendChild(figure);
    });
    box.appendChild(strip);

    if (run.frames.length > 1) {
      var play = document.createElement('button');
      play.textContent = '按真实节奏播放';
      play.onclick = function () { play(strip); };
      box.appendChild(play);
    }

    run.trace.forEach(function (record) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = record.line;
      var pre = document.createElement('pre');
      pre.textContent = JSON.stringify(record.raw, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      box.appendChild(details);
    });
  }).catch(function (e) { $('note').textContent = e.message; });
}

/** Walk the recorded frames at the gaps they were recorded with — the run, as it happened. */
function play(strip) {
  var figures = Array.prototype.slice.call(strip.children);
  var times = figures.map(function (figure) {
    return { figure: figure, at: parseFloat(figure.lastChild.textContent) * 1000 };
  });
  times.forEach(function (item) { item.figure.style.outline = ''; });
  var index = 0;
  function next() {
    if (index > 0) times[index - 1].figure.style.outline = '';
    if (index >= times.length) return;
    times[index].figure.style.outline = '2px solid #2f6fd0';
    times[index].figure.scrollIntoView({ block: 'nearest' });
    var wait = index + 1 < times.length ? Math.max(0, times[index + 1].at - times[index].at) : 1200;
    index += 1;
    setTimeout(next, Math.min(wait, 4000));
  }
  next();
}

function poll() {
  api('/inspector/state').then(render, function (e) { $('note').textContent = e.message; });
}
setInterval(poll, 800);
poll();
</script>
</body>
</html>
`
}
