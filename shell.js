/* 적바림 설치형 앱 — 시작 파일 (3.3)
 * 이 파일은 공개 저장소(GitHub Pages)에 올라가요. 업무 내용·웹 앱 주소·열쇠는 들어 있지 않아요.
 *  · 처음: 적바림 설정에서 「앱으로 열기」를 누르면 주소 끝의 #exec=…(웹 앱 주소)를 이 기기에만 저장해요.
 *  · 화면 코드(Index.html)는 서버에서 한 번 받아 이 기기(IndexedDB)에 저장해 두고, 다음부터는 바로 열어요.
 *  · 서버 함수는 화면에 보이지 않는 「숨은 연결 화면」(웹 앱 주소?bridge=1)을 거쳐 불러요. 구글 로그인은 크롬의 로그인을 그대로 써요.
 *  · 서버 버전이 바뀌면 새 화면 코드를 받아 두고 바꿔요.
 *  · 3.3: 화면이 열린 뒤 인터넷·서버 연결이 안 되면 화면을 막지 않고 위쪽에 알려요. 그동안 부른 서버 함수는 바로 「연결 안 됨」으로
 *    돌려줘서 화면이 이 기기에 적어 두게 하고, 다시 이어지면 jb:ready 신호를 보내요. 「공유 → 적바림」으로 받은 것도 화면에 넘겨줘요.
 *  · 3.4: 기기에서 PDF를 만들 때 쓰는 도구(lib/)·글꼴(fonts/)이 이 저장소에 있어요. 화면이 처음 쓸 때 받아 이 기기에 둬요.
 */
(function (W) {
  'use strict';
  if (W.__jbShell) return;

  var SHELL = '3.4.0';
  var T = W.JB_TEST || {}; // 시험할 때만 써요 — 실제 앱에는 없어요
  var EXEC_RE = T.execRe || /^https:\/\/script\.google\.com\/(?:a\/[A-Za-z0-9.-]+\/)?macros\/(?:u\/\d+\/)?s\/[A-Za-z0-9_-]+\/exec$/;
  var BRIDGE_RE = T.bridgeRe || /^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/;
  var WAIT_MS = T.waitMs || 15000;     // 숨은 연결 화면을 기다리는 가장 긴 시간 — 넘으면 도움말을 띄워요
  var GRACE_MS = T.graceMs || 6000;    // 연결 화면이 다 열렸는데도 소식이 없을 때 더 기다리는 시간
  var CALL_MS = T.callMs || 400000;    // 서버 함수 하나를 기다리는 가장 긴 시간 (Apps Script 실행 한도 6분 + 여유)
  var AUTO_MS = T.autoMs !== undefined ? T.autoMs : 30000; // 연 뒤 이 시간 안에, 아무것도 누르지 않았으면 새 버전으로 바로 바꿔요
  var UI_MS = T.uiMs || 12000;         // 화면 코드가 이 안에 서버를 한 번도 부르지 않으면 화면 코드가 깨진 것으로 봐요
  var AWAY_MS = T.awayMs || 30 * 60000; // 이만큼 다른 앱에 있다 돌아오면 연결과 새 버전을 확인해요
  var RETRY_MS = T.retryMs || 5000;    // 연결이 안 될 때 뒤에서 다시 해 보는 간격 (5초 → 10초 → … 최대 1분)
  var KEY_EXEC = 'jb.exec', KEY_TIMES = 'jb.times', KEY_UPDATED = 'jb.updated';
  var API_RE = /^api[A-Za-z0-9]+$/;
  var me = document.currentScript;
  var BASE = (me && me.src ? me.src : location.href).replace(/[?#].*$/, '').replace(/[^\/]*$/, '');

  // 문서를 화면 코드로 바꿔도 남는 상태 (같은 창의 전역 객체에 붙여 둬요)
  var J = W.__jbShell = { shell: SHELL, base: BASE, exec: '', ui: '', server: '', pending: '', t: {}, touched: false, bootCalled: false, updating: null, bip: null, lastError: '', helpKind: '', hiddenAt: 0 };
  var B = { el: null, win: null, origin: '', ready: false, gen: 0, queue: [], inflight: {}, seq: 0, timer: 0, grace: 0, note: '' };

  /* ───────── 작은 도구 ───────── */
  function now() { return Math.round(performance.now()); }
  function mark(k) { if (J.t[k] === undefined) J.t[k] = now(); }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function later(fn) { setTimeout(fn, 0); }
  function rethrow(x) { setTimeout(function () { throw x; }, 0); }
  function noop() { /* 아무것도 안 해요 */ }
  function store(kind, k, v) {
    try { var s = W[kind]; if (v === undefined) return s.getItem(k) || ''; if (v) s.setItem(k, v); else s.removeItem(k); } catch (e) { /* 저장 공간을 못 쓰는 환경 */ }
    return '';
  }
  function lsGet(k) { return store('localStorage', k); }
  function lsSet(k, v) { store('localStorage', k, v); }
  function ssGet(k) { return store('sessionStorage', k); }
  function ssSet(k, v) { store('sessionStorage', k, v); }

  /* ───────── 기기에 저장 (IndexedDB) ───────── */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      if (!W.indexedDB) { rej(new Error('IndexedDB 없음')); return; }
      var r = W.indexedDB.open('jeokbarim', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.onblocked = function () { rej(new Error('IndexedDB 막힘')); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function idbGet(k) {
    return db().then(function (d) {
      return new Promise(function (res, rej) { var q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { rej(q.error); }; });
    }).catch(function () { return null; });
  }
  function idbSet(k, v) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction('kv', 'readwrite'), os = tx.objectStore('kv');
        if (v === null) os.delete(k); else os.put(v, k);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function okUi(rec) {
    return !!(rec && rec.version && typeof rec.html === 'string' && /<head(?:\s[^>]*)?>/i.test(rec.html) && /<\/html>\s*$/i.test(rec.html));
  }

  /* ───────── 웹 앱 주소 ───────── */
  function validExec(v) { v = String(v || '').trim(); return EXEC_RE.test(v) ? v : ''; }
  // 주소 끝의 #exec=… 을 읽고 주소창에서는 지워요 (?add= 같은 다른 표시는 그대로)
  function takeHashExec() {
    var h = String(location.hash || '').replace(/^#/, ''), m = /(?:^|&)exec=([^&]*)/.exec(h);
    if (!m) return null;
    var v = '';
    try { v = decodeURIComponent(m[1]); } catch (e) { v = ''; }
    var rest = h.split('&').filter(function (p) { return p && p.indexOf('exec=') !== 0; }).join('&');
    try { history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : '')); } catch (e) { /* 그대로 둬요 */ }
    return v;
  }

  /* ───────── 시작 화면 (처음 연결·화면 받기) ───────── */
  function status(text, wait) {
    var el = document.getElementById('jb-status');
    if (el) { el.textContent = text; el.className = wait === false ? '' : 'wait'; }
  }
  function panel(html) { var el = document.getElementById('jb-body'); if (el) el.innerHTML = html; return el; }

  function showSetup(err) {
    status('처음 한 번만 연결하면 돼요', false);
    var el = panel('<p>지금 쓰는 적바림과 이 앱을 이어 줘요.</p>' +
      '<ol><li>크롬에서 적바림을 열어요</li><li>설정 › <b>폰·PC에 앱으로 설치</b>에서 「앱으로 열기」를 눌러요</li></ol>' +
      '<p class="sub">그러면 이 화면이 다시 열리면서 저절로 이어져요.</p>' +
      '<details' + (err ? ' open' : '') + '><summary>웹 앱 주소를 직접 넣기</summary><div>' +
      '<label>적바림 웹 앱 주소<input id="jb-exec" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec"></label>' +
      '<button type="button" id="jb-go">연결</button><p class="err" id="jb-err" role="alert">' + esc(err || '') + '</p></div></details>');
    if (!el) return;
    var input = el.querySelector('#jb-exec'), go = el.querySelector('#jb-go');
    function submit() {
      var v = validExec(input.value);
      if (!v) { el.querySelector('#jb-err').textContent = '…/exec 로 끝나는 적바림 웹 앱 주소를 넣어 주세요.'; input.focus(); return; }
      lsSet(KEY_EXEC, v);
      J.exec = v;
      panel('');
      boot();
    }
    go.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  }

  function start() {
    mark('shell');
    listen();
    regSW();
    var h = takeHashExec(), err = '';
    if (h !== null) {
      if (validExec(h)) lsSet(KEY_EXEC, validExec(h));
      else err = '이 주소로는 이을 수 없어요. 배포한 웹 앱 주소(…/exec)를 넣어 주세요.';
    }
    J.exec = validExec(lsGet(KEY_EXEC));
    if (!J.exec) { showSetup(err); return; }
    boot();
  }

  function boot() {
    status('여는 중');
    idbGet('ui').then(function (rec) { if (okUi(rec)) openUi(rec); else firstInstall(); });
  }

  // 처음 한 번: 숨은 연결 화면으로 화면 코드를 받아 기기에 저장한 뒤 열어요
  function firstInstall() {
    status('처음 한 번 화면을 받아 오는 중');
    send('apiUiCode', [], {
      ok: function (r) {
        var rec = r && { version: String(r.version || ''), html: String(r.html || ''), at: Date.now() };
        if (!okUi(rec)) { help('old'); return; }
        mark('down');
        idbSet('ui', rec).catch(noop).then(function () { openUi(rec); });
      },
      fail: function (err) { help(/apiUiCode|없는 기능/.test(String(err && err.message)) ? 'old' : 'timeout'); }
    });
  }

  // 저장해 둔 화면 코드로 이 문서를 바꿔요. 바꾼 문서의 <head> 맨 앞에서 install()이 돌아요.
  function openUi(rec) {
    var html = prepare(rec.html);
    J.ui = String(rec.version);
    bridgeClose('');
    document.open();
    document.write(html);
    document.close();
  }
  function prepare(html) {
    var m = /<head(?:\s[^>]*)?>/i.exec(html), at = m.index + m[0].length;
    var tags = '\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      '<meta name="theme-color" content="#F5F6F8"><title>적바림</title>' +
      '<link rel="manifest" href="' + esc(BASE + 'manifest.webmanifest') + '">' +
      '<link rel="icon" type="image/png" sizes="192x192" href="' + esc(BASE + 'icons/icon-192.png') + '">' +
      '<link rel="apple-touch-icon" href="' + esc(BASE + 'icons/apple-touch-icon.png') + '">' +
      '<script>window.__jbShell && window.__jbShell.install();</' + 'script>\n';
    // 글꼴 파일을 기다리느라 화면 코드가 늦게 돌지 않도록, 글꼴은 뒤에서 받아요 (도착하면 바로 바뀌어요)
    var rest = html.slice(at).replace(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/[^"]*)">/i, '<link rel="stylesheet" href="$1" media="print" onload="this.media=\'all\'">');
    return html.slice(0, at) + tags + rest;
  }

  /* ───────── 화면 코드 안에서: google.script.* 흉내 ───────── */
  J.install = function () {
    mark('ui');
    if (J.t.bridge !== undefined) { J.t.firstBridge = J.t.bridge; delete J.t.bridge; } // 처음 설치할 때 화면을 받느라 쓴 연결은 따로 둬요
    W.google = { script: { run: runner({}), history: histApi, url: urlApi, host: hostApi } };
    W.__jb = api;
    listen();
    bridgeOpen();
    setTimeout(function () { if (!J.bootCalled) help('ui'); }, UI_MS);
    var upd = ssGet(KEY_UPDATED);
    if (upd) {
      ssSet(KEY_UPDATED, '');
      if (upd.split('|')[0] === J.ui) whenBody(function () { note('적바림을 ' + J.ui + ' 버전으로 바꿨어요'); });
    }
  };
  function whenBody(fn) { if (document.body) later(fn); else document.addEventListener('DOMContentLoaded', fn); }

  function runner(o) {
    var base = {
      withSuccessHandler: function (f) { return runner({ ok: f, fail: o.fail, user: o.user }); },
      withFailureHandler: function (f) { return runner({ ok: o.ok, fail: f, user: o.user }); },
      withUserObject: function (u) { return runner({ ok: o.ok, fail: o.fail, user: u }); }
    };
    return new Proxy(base, {
      get: function (t, k) {
        if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
        if (typeof k === 'string' && API_RE.test(k)) return function () { send(k, Array.prototype.slice.call(arguments), o); };
        return t[k];
      },
      has: function (t, k) { return Object.prototype.hasOwnProperty.call(t, k) || (typeof k === 'string' && API_RE.test(k)); }
    });
  }

  // google.script.history · url: 앱 주소의 ?…·#… 를 그대로 써요 (예: ?add=spend 바로가기)
  var changeHandler = null;
  function qs(params) {
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      (Array.isArray(v) ? v : [v]).forEach(function (x) { if (x !== undefined && x !== null) q.append(k, String(x)); });
    });
    var s = q.toString();
    return s ? '?' + s : '';
  }
  function loc() {
    var one = {}, many = {};
    new URLSearchParams(location.search).forEach(function (v, k) { if (!(k in one)) one[k] = v; (many[k] = many[k] || []).push(v); });
    return { hash: String(location.hash || '').replace(/^#/, ''), parameter: one, parameters: many };
  }
  var histApi = {
    push: function (state, params, hash) { history.pushState(state === undefined ? null : state, '', location.pathname + qs(params) + (hash ? '#' + hash : '')); },
    replace: function (state, params, hash) { history.replaceState(state === undefined ? null : state, '', location.pathname + qs(params) + (hash ? '#' + hash : '')); },
    setChangeHandler: function (fn) { changeHandler = typeof fn === 'function' ? fn : null; }
  };
  var urlApi = { getLocation: function (cb) { later(function () { cb(loc()); }); } };
  var hostApi = { close: function () { try { W.close(); } catch (e) { /* 못 닫아요 */ } }, setHeight: noop, setWidth: noop, editor: { focus: noop } };

  /* ───────── 숨은 연결 화면 ───────── */
  function bridgeUrl() { return J.exec + (J.exec.indexOf('?') < 0 ? '?' : '&') + 'bridge=1'; }
  function bridgeOpen() {
    bridgeClose('연결을 다시 시작했어요. 다시 시도해 주세요.');
    var f = document.createElement('iframe'), gen = ++B.gen;
    f.id = 'jb-bridge';
    f.title = '적바림 서버 연결';
    f.tabIndex = -1;
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-40px;top:-40px;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    f.addEventListener('load', function () {
      if (gen !== B.gen || B.ready) return;
      if (navigator.onLine === false) { help('offline'); return; }
      clearTimeout(B.grace);
      B.grace = setTimeout(function () { if (gen === B.gen && !B.ready) help(navigator.onLine === false ? 'offline' : (B.note || 'timeout')); }, GRACE_MS);
    });
    f.src = bridgeUrl();
    B.el = f;
    document.documentElement.appendChild(f);
    B.timer = setTimeout(function () { if (gen === B.gen && !B.ready) help(navigator.onLine === false ? 'offline' : (B.note || 'timeout')); }, WAIT_MS);
    if (J.ui && navigator.onLine === false) later(function () { if (gen === B.gen && !B.ready) help('offline'); }); // 3.3: 끊긴 것을 알면 바로
  }
  function bridgeClose(why) {
    clearTimeout(B.timer);
    clearTimeout(B.grace);
    if (why) dropInflight(why);
    if (B.el && B.el.parentNode) B.el.parentNode.removeChild(B.el);
    B.el = null; B.win = null; B.origin = ''; B.ready = false; B.note = '';
  }
  // 연결 화면 안쪽(몇 겹 아래)에서 온 소식인지 봐요
  function fromBridge(src) {
    var top = B.el && B.el.contentWindow, w = src;
    if (!top || !w) return false;
    for (var i = 0; i < 6; i++) {
      if (w === top) return true;
      var p = null;
      try { p = w.parent; } catch (e) { return false; }
      if (!p || p === w) return false;
      w = p;
    }
    return false;
  }
  function onMessage(e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || typeof m.jb !== 'string' || m.jb === 'call' || m.jb === 'ping') return;
    if (!BRIDGE_RE.test(e.origin) || !fromBridge(e.source)) return;
    if (m.jb === 'ready') { onReady(e.source, e.origin, m); return; }
    if (m.jb === 'noshell' || m.jb === 'denied') { B.note = m.jb; if (!B.ready) help(m.jb); return; }
    if ((m.jb === 'ok' || m.jb === 'err') && e.source === B.win) settle(m);
  }
  function onReady(win, origin, m) {
    var restarted = B.ready && m.boot;
    B.win = win; B.origin = origin; B.note = '';
    if (restarted) dropInflight('서버 연결이 다시 시작됐어요. 다시 시도해 주세요.');
    if (B.probe) { clearTimeout(B.probe); B.probe = 0; }
    if (B.ready) return;
    B.ready = true;
    clearTimeout(B.timer);
    clearTimeout(B.grace);
    clearTimeout(J.retryTimer);
    J.retries = 0;
    mark('bridge');
    if (J.helpKind !== 'ui') hideHelp(); // 화면 코드가 깨졌다는 안내는 연결과 상관없으니 그대로 둬요
    var q = B.queue;
    B.queue = [];
    q.forEach(post);
    if (J.ui) { emit('jb:net'); emit('jb:ready'); } // 3.3: 화면이 기다리던 것을 다시 보내게 알려요
  }

  function send(fn, args, o) {
    var job = { id: ++B.seq, fn: fn, args: args || [], o: o || {} };
    if (fn === 'apiBootstrap') J.bootCalled = true;
    if (B.ready && B.win) post(job);
    else if (offNow()) { later(function () { finish(job, false, new Error(offMsg())); }); if (!B.el) bridgeOpen(); } // 3.3: 기다리게 두지 않아요
    else { B.queue.push(job); if (!B.el) bridgeOpen(); }
  }
  // 3.3: 화면이 열린 뒤 인터넷·서버 연결이 안 되는 동안 (화면은 이 기기에 적어 두었다가 연결되면 보내요)
  function soft(kind) { return kind === 'offline' || kind === 'timeout'; }
  function offNow() { return !!J.ui && soft(J.helpKind); }
  function offMsg() { return J.helpKind === 'offline' ? '인터넷에 연결돼 있지 않아요. 연결되면 다시 보내요.' : '적바림 서버에 연결하지 못했어요. 연결되면 다시 보내요.'; }
  // 연결을 기다리던 호출은 「연결 안 됨」으로 끝내요 (화면 쪽에서 다시 보내요)
  function failQueue() {
    var q = B.queue;
    B.queue = [];
    q.forEach(function (job) { finish(job, false, new Error(offMsg())); });
  }
  function emit(name) { try { W.dispatchEvent(new Event(name)); } catch (e) { /* 옛 브라우저 */ } }
  function post(job) {
    try { B.win.postMessage({ jb: 'call', id: job.id, fn: job.fn, args: job.args }, B.origin); } catch (x) { finish(job, false, x instanceof Error ? x : new Error(String(x))); return; }
    B.inflight[job.id] = job;
    job.timer = setTimeout(function () {
      if (!B.inflight[job.id]) return;
      delete B.inflight[job.id];
      finish(job, false, new Error('서버 응답이 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'));
    }, CALL_MS);
  }
  function settle(m) {
    var job = B.inflight[m.id];
    if (!job) return;
    delete B.inflight[m.id];
    clearTimeout(job.timer);
    if (m.jb === 'ok') finish(job, true, m.r);
    else finish(job, false, new Error(String(m.e || '서버에서 문제가 생겼어요.')));
  }
  function dropInflight(why) {
    var ids = Object.keys(B.inflight);
    ids.forEach(function (id) {
      var job = B.inflight[id];
      delete B.inflight[id];
      clearTimeout(job.timer);
      finish(job, false, new Error(why));
    });
  }
  function finish(job, ok, val) {
    var f = ok ? job.o.ok : job.o.fail;
    if (!ok && /HTTP 40[13]\b|Authorization is required/i.test(String(val && val.message))) later(function () { help('login'); });
    if (typeof f === 'function') { try { f(val, job.o.user); } catch (x) { rethrow(x); } }
    else if (!ok && W.console) W.console.warn('[적바림] ' + job.fn + ': ' + (val && val.message));
    if (ok && job.fn === 'apiBootstrap') afterBoot(val);
  }

  /* ───────── 새 버전 ───────── */
  function afterBoot(r) {
    mark('boot');
    J.server = String((r && r.version) || '');
    if (J.t.down === undefined) {
      var list = recentTimes();
      list.unshift(J.t.boot);
      lsSet(KEY_TIMES, JSON.stringify(list.slice(0, 10)));
    }
    if (J.server && J.ui && J.server !== J.ui) fetchUpdate(false);
  }
  function recentTimes() {
    var v = [];
    try { v = JSON.parse(lsGet(KEY_TIMES) || '[]'); } catch (e) { v = []; }
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'number' && x > 0; }) : [];
  }
  // 새 화면 코드를 받아 기기에 저장해요. 다 받으면 받은 버전을 돌려줘요 (받을 것이 없으면 '')
  function fetchUpdate(manual) {
    if (J.updating) return J.updating;
    J.updating = new Promise(function (res) {
      send('apiUiCode', [], {
        ok: function (r) {
          var rec = r && { version: String(r.version || ''), html: String(r.html || ''), at: Date.now() };
          if (!okUi(rec) || rec.version === J.ui) { J.updating = null; res(''); return; }
          idbSet('ui', rec).then(function () {
            J.pending = rec.version;
            J.updating = null;
            res(rec.version);
            if (!manual) applySoon();
          }, function () { J.updating = null; res(''); });
        },
        fail: function () { J.updating = null; res(''); }
      });
    });
    return J.updating;
  }
  // 열고 바로(아무것도 누르기 전)라면 조용히 바꾸고, 쓰는 중이면 위에 띠를 띄워요
  function applySoon() {
    if (!J.pending) return;
    if (J.touched || document.visibilityState !== 'visible' || now() > AUTO_MS) { bar(); return; }
    if (B.queue.length || Object.keys(B.inflight).length) { setTimeout(applySoon, 400); return; }
    applyUpdate(true);
  }
  function applyUpdate(auto) {
    ssSet(KEY_UPDATED, J.pending + (auto ? '|auto' : ''));
    location.reload();
  }
  function checkUpdate() {
    return new Promise(function (res) {
      send('apiVersion', [], {
        ok: function (r) {
          J.server = String((r && r.version) || J.server || '');
          if (J.pending && J.pending === J.server) { res(J.pending); return; }
          if (!J.server || J.server === J.ui) { res(''); return; }
          fetchUpdate(true).then(res);
        },
        fail: function () { res(null); }
      });
    });
  }

  /* ───────── 듣기 (문서를 바꾸면 지워지므로 바꾼 뒤 다시 걸어요) ───────── */
  function listen() {
    W.addEventListener('message', onMessage);
    W.addEventListener('popstate', onPop);
    W.addEventListener('online', onOnline);
    W.addEventListener('pointerdown', onTouch, true);
    W.addEventListener('keydown', onTouch, true);
    W.addEventListener('beforeinstallprompt', onBip);
    W.addEventListener('appinstalled', onInstalled);
    W.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisible);
  }
  function onPop(e) { if (changeHandler) { var h = changeHandler; later(function () { h({ state: e.state, location: loc() }); }); } }
  function onOnline() { if (!B.ready && J.exec && (J.helpKind === 'offline' || J.helpKind === 'timeout')) reconnect(); }
  function onTouch() { J.touched = true; }
  function onBip(e) { J.bip = e; } // 크롬이 띄우는 설치 안내는 그대로 두고, 설정 화면의 「이 기기에 설치」에서도 쓸 수 있게 잡아 둬요
  function onInstalled() { J.bip = null; J.installed = true; }
  function onError(e) { if (!J.lastError && e && e.message) J.lastError = String(e.message); }
  function onVisible() {
    if (document.visibilityState !== 'visible') { J.hiddenAt = now(); return; }
    if (!J.exec) return;
    // 로그인·설정을 고치러 다녀왔으면 바로 다시 이어 봐요
    if (!B.ready) { if (J.helpKind && J.helpKind !== 'ui') reconnect(); return; }
    if (J.helpKind === 'login') { reconnect(); return; }
    if (!J.bootCalled) return;
    if (J.hiddenAt && now() - J.hiddenAt > AWAY_MS) {
      J.hiddenAt = 0;
      // 오래 쉬었다 돌아오면: 연결이 살아 있는지, 새 버전이 나왔는지 가볍게 물어봐요
      clearTimeout(B.probe);
      B.probe = setTimeout(function () { B.probe = 0; reconnect(); }, 8000);
      send('apiVersion', [], {
        ok: function (r) {
          clearTimeout(B.probe); B.probe = 0;
          var v = String((r && r.version) || '');
          if (v) J.server = v;
          if (v && v !== J.ui && v !== J.pending) fetchUpdate(true).then(function (got) { if (got) bar(); });
        },
        fail: function () { clearTimeout(B.probe); B.probe = 0; }
      });
    }
  }
  function reconnect() { J.retries = 0; hideHelp(); bridgeOpen(); if (J.ui) emit('jb:net'); }
  // 인터넷이 끊겼거나 연결 화면이 안 뜰 때: 안내는 그대로 두고 뒤에서 조금씩 간격을 늘려 다시 해 봐요
  function retryLater() {
    clearTimeout(J.retryTimer);
    if (B.ready || (J.helpKind !== 'offline' && J.helpKind !== 'timeout')) return;
    J.retries = (J.retries || 0) + 1;
    J.retryTimer = setTimeout(function () {
      if (!B.ready && (J.helpKind === 'offline' || J.helpKind === 'timeout')) bridgeOpen();
    }, Math.min(RETRY_MS * Math.pow(2, J.retries - 1), 60000));
  }
  function resetExec() {
    lsSet(KEY_EXEC, '');
    idbSet('ui', null).catch(noop).then(function () { location.replace(BASE); });
  }
  function refetch() { idbSet('ui', null).catch(noop).then(function () { location.reload(); }); }
  function isStandalone() {
    try { return W.matchMedia('(display-mode: standalone)').matches || W.navigator.standalone === true; } catch (e) { return false; }
  }

  /* ───────── 서비스 워커 (시작 파일을 기기에 두어 바로 열어요) ───────── */
  function regSW() {
    if (T.noSW || !('serviceWorker' in navigator)) return;
    try { navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE }).catch(noop); } catch (e) { /* 다음에 다시 */ }
  }

  /* ───────── 도움말·알림 ───────── */
  var CSS = '#jb-help{position:fixed;inset:0;z-index:2147483000;background:rgba(245,246,248,.97);overflow-y:auto;display:flex;align-items:flex-start;justify-content:center;padding:calc(32px + env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom))}' +
    '#jb-help .jb-card{width:100%;max-width:460px;background:#FFFFFF;border:1px solid #E6E8EC;border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;color:#1B1F24;font-size:15px;line-height:1.5;box-shadow:0 8px 24px rgba(27,31,36,.08);text-align:left}' +
    '#jb-help h2{margin:0;font-size:18px;font-weight:700;line-height:1.35}#jb-help p,#jb-help ol{margin:0;color:#3A414A}#jb-help ol{padding-left:20px;display:flex;flex-direction:column;gap:6px}' +
    '#jb-help .jb-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;background:#F5F6F8;border-radius:10px;padding:8px 10px;word-break:break-all;color:#1B1F24}' +
    '#jb-help .jb-btns{display:flex;flex-direction:column;gap:8px;margin-top:4px}' +
    '#jb-help .jb-pri,#jb-help .jb-sec{font:inherit;min-height:46px;border-radius:12px;display:flex;align-items:center;justify-content:center;text-decoration:none;font-weight:700;cursor:pointer;padding:0 14px}' +
    '#jb-help .jb-pri{border:0;background:#2448B8;color:#FFFFFF}#jb-help .jb-sec{border:1px solid #E6E8EC;background:#FFFFFF;color:#1B1F24}' +
    '#jb-help .jb-more{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;font-size:13px}#jb-help .jb-link{font:inherit;border:0;background:none;padding:6px 0;color:#2448B8;cursor:pointer;text-decoration:underline}' +
    '#jb-help .jb-sub{font-size:13px;color:#5F6873}' +
    '#jb-bar,#jb-off{position:fixed;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top));z-index:2147482000;max-width:560px;margin:0 auto;background:#1B1F24;color:#FFFFFF;border-radius:14px;padding:8px 8px 8px 16px;display:flex;align-items:center;gap:8px;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(27,31,36,.18)}' +
    '#jb-bar span,#jb-off span{flex:1}#jb-bar button,#jb-off button{font:inherit;border:0;border-radius:10px;min-height:40px;padding:0 12px;cursor:pointer}#jb-bar .jb-apply,#jb-off .jb-apply{background:#FFFFFF;color:#1B1F24;font-weight:700}#jb-bar .jb-x{background:transparent;color:#FFFFFF;font-size:20px;width:40px;padding:0}' +
    '#jb-off .jb-more2{background:transparent;color:#FFFFFF;text-decoration:underline;padding:0 6px}' +
    '#jb-note{position:fixed;left:50%;transform:translateX(-50%);top:calc(12px + env(safe-area-inset-top));z-index:2147482000;background:#1B1F24;color:#FFFFFF;border-radius:999px;padding:9px 16px;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(27,31,36,.18);max-width:calc(100% - 32px);text-align:center}';
  function ensureStyle() {
    if (document.getElementById('jb-style')) return;
    var s = document.createElement('style');
    s.id = 'jb-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  function host() { return document.body || document.documentElement; }

  function helpHtml(kind) {
    var exec = J.exec;
    var open = exec ? '<a class="jb-sec" href="' + esc(exec) + '" target="_blank" rel="noopener">적바림 열어 로그인 확인 ↗</a>' : '';
    var retry = '<button type="button" class="jb-pri" data-jb="retry">다시 연결</button>';
    var more = '<div class="jb-more">' + (exec ? '<a class="jb-link" href="' + esc(exec) + '" target="_blank" rel="noopener">예전 방식으로 열기</a>' : '') +
      '<button type="button" class="jb-link" data-jb="reset">연결 주소 다시 넣기</button></div>';
    var close = J.ui && soft(kind) ? '<button type="button" class="jb-sec" data-jb="close">닫고 계속 쓰기</button>' : ''; // 3.3: 화면은 이 기기에 적어 둘 수 있어요
    if (kind === 'offline') return '<h2>인터넷에 연결돼 있지 않아요</h2><p>' + (J.ui ? '적은 것은 이 기기에 두었다가 연결되면 보내요.' : '연결되면 바로 이어서 열어요.') + '</p><div class="jb-btns">' + retry + close + '</div>';
    if (kind === 'noshell' || kind === 'denied') {
      return '<h2>' + (kind === 'noshell' ? '적바림에 이 앱 주소가 아직 없어요' : '적바림에 저장한 앱 주소와 달라요') + '</h2>' +
        '<p>적바림(예전 방식)을 열어 <b>설정 › 폰·PC에 앱으로 설치</b>의 앱 주소에 아래 주소를 저장한 뒤 「다시 연결」을 눌러 주세요.</p>' +
        '<p class="jb-code">' + esc(BASE) + '</p><div class="jb-btns">' + retry + (exec ? '<a class="jb-sec" href="' + esc(exec) + '" target="_blank" rel="noopener">적바림 열기 ↗</a>' : '') + '</div>' + more;
    }
    if (kind === 'login') {
      return '<h2>구글 로그인을 확인해 주세요</h2><p>로그인이 끝났거나 다른 계정으로 바뀐 것 같아요. 적바림을 만든 구글 계정으로 로그인한 뒤 돌아와 「다시 연결」을 눌러 주세요.</p>' +
        '<div class="jb-btns">' + open + retry + '</div>' + more;
    }
    if (kind === 'old') {
      return '<h2>서버를 3.0 이상으로 배포해 주세요</h2><p>Apps Script에 적바림 3.0 이상을 새 버전으로 배포한 뒤 「다시 연결」을 눌러 주세요. 그동안은 예전 방식으로 쓸 수 있어요.</p>' +
        '<div class="jb-btns">' + retry + '</div>' + more;
    }
    if (kind === 'ui') {
      return '<h2>화면을 여는 중 문제가 생겼어요</h2><p>기기에 저장해 둔 화면 코드를 지우고 서버에서 다시 받아 올게요.</p>' +
        (J.lastError ? '<p class="jb-sub">' + esc(J.lastError.slice(0, 200)) + '</p>' : '') +
        '<div class="jb-btns"><button type="button" class="jb-pri" data-jb="refetch">화면 다시 받기</button></div>' + more;
    }
    return '<h2>적바림 서버에 연결하지 못했어요</h2><p>아래를 확인한 뒤 「다시 연결」을 눌러 주세요.</p><ol>' +
      '<li><b>구글 로그인</b> — 적바림을 만든 구글 계정으로 로그인돼 있어야 해요. 아래 버튼으로 적바림이 열리면 그 창을 닫고 돌아오세요.</li>' +
      '<li><b>여러 계정</b> — 크롬에 구글 계정이 여러 개 로그인돼 있으면 적바림을 만든 계정이 첫 번째(기본) 계정이어야 해요.</li>' +
      '<li><b>쿠키 차단</b> — 크롬 설정에서 서드 파티 쿠키를 막아 두었다면 <b>' + esc(location.host) + '</b>에서는 허용해 주세요.</li>' +
      '<li><b>서버 버전</b> — Apps Script에 적바림 3.0 이상을 배포했는지 확인해 주세요.</li></ol>' +
      (J.ui ? '<p class="jb-sub">그동안 적은 것은 이 기기에 두었다가 연결되면 보내요.</p>' : '') +
      '<div class="jb-btns">' + retry + open + close + '</div>' + more;
  }
  function help(kind, modal) {
    if (B.ready && (kind === 'timeout' || kind === 'offline' || kind === 'noshell' || kind === 'denied')) return;
    if (kind === 'ui' && J.bootCalled) return;
    ensureStyle();
    if (J.ui && soft(kind) && !modal) {
      // 3.3: 화면이 열린 뒤에는 막지 않아요 — 위쪽에 알리고(화면이 직접 보여 주면 그쪽에), 기다리던 호출은 「연결 안 됨」으로 끝내요
      var was = J.helpKind;
      dropModal();
      J.helpKind = kind;
      failQueue();
      if (api.ownNet) dropOff(); else offBar(kind);
      if (was !== kind) emit('jb:net');
      retryLater();
      return;
    }
    dropOff();
    var el = document.getElementById('jb-help');
    if (el && el.getAttribute('data-kind') === kind) { retryLater(); return; } // 같은 안내는 다시 그리지 않아요 (읽던 자리 그대로)
    if (!el) {
      el = document.createElement('div');
      el.id = 'jb-help';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.addEventListener('click', onHelpClick);
      host().appendChild(el);
    }
    el.setAttribute('data-kind', kind);
    el.innerHTML = '<div class="jb-card">' + helpHtml(kind) + '</div>';
    var prev = J.helpKind;
    J.helpKind = kind;
    if (J.ui && soft(kind)) failQueue();
    if (J.ui && prev !== kind) emit('jb:net');
    retryLater();
  }
  function hideHelp() {
    dropModal();
    dropOff();
    J.helpKind = '';
  }
  function dropModal() {
    var el = document.getElementById('jb-help');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  // 옛 화면 코드(3.2 이하)를 쓸 때: 위쪽 띠로 알려요 (화면은 그대로 쓸 수 있어요)
  function offBar(kind) {
    var el = document.getElementById('jb-off');
    if (el && el.getAttribute('data-kind') === kind) return;
    if (!el) {
      el = document.createElement('div');
      el.id = 'jb-off';
      el.setAttribute('role', 'status');
      el.addEventListener('click', onHelpClick);
      host().appendChild(el);
    }
    el.setAttribute('data-kind', kind);
    el.innerHTML = '<span>' + (kind === 'offline' ? '인터넷에 연결돼 있지 않아요' : '적바림 서버에 연결하지 못했어요') + '</span>' +
      (kind === 'timeout' ? '<button type="button" class="jb-more2" data-jb="more">도움말</button>' : '') +
      '<button type="button" class="jb-apply" data-jb="retry">다시 연결</button>';
  }
  function dropOff() {
    var el = document.getElementById('jb-off');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function onHelpClick(e) {
    e.stopPropagation(); // 적바림 화면의 누르기 처리로 넘기지 않아요
    var b = e.target && e.target.closest ? e.target.closest('[data-jb]') : null;
    if (!b) return;
    e.preventDefault();
    var a = b.getAttribute('data-jb');
    if (a === 'retry') reconnect();
    else if (a === 'reset') resetExec();
    else if (a === 'refetch') refetch();
    else if (a === 'more') help(J.helpKind, true);
    else if (a === 'close') { dropModal(); if (soft(J.helpKind) && !api.ownNet) offBar(J.helpKind); }
  }
  function bar() {
    if (!J.pending || document.getElementById('jb-bar')) return;
    ensureStyle();
    var el = document.createElement('div');
    el.id = 'jb-bar';
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>새 버전(' + esc(J.pending) + ')이 준비됐어요</span><button type="button" class="jb-apply" data-jb="apply">지금 바꾸기</button><button type="button" class="jb-x" data-jb="later" aria-label="나중에 바꾸기">×</button>';
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var b = e.target && e.target.closest ? e.target.closest('[data-jb]') : null;
      if (!b) return;
      if (b.getAttribute('data-jb') === 'apply') applyUpdate(false);
      else if (el.parentNode) el.parentNode.removeChild(el); // 다음에 열 때 새 버전으로 열려요
    });
    host().appendChild(el);
  }
  function note(text) {
    ensureStyle();
    var el = document.getElementById('jb-note');
    if (!el) { el = document.createElement('div'); el.id = 'jb-note'; el.setAttribute('role', 'status'); host().appendChild(el); }
    el.textContent = text;
    clearTimeout(J.noteTimer);
    J.noteTimer = setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  }

  /* ───────── 적바림 화면(설정)에서 쓰는 창구 ───────── */
  var api = {
    shell: SHELL,
    base: BASE,
    get ui() { return J.ui; },
    get server() { return J.server; },
    get pending() { return J.pending; },
    get exec() { return J.exec; },
    times: function () { return { ui: J.t.ui, bridge: J.t.bridge, boot: J.t.boot, down: J.t.down, recent: recentTimes() }; },
    standalone: isStandalone,
    canInstall: function () { return !!J.bip; },
    install: function () {
      var p = J.bip;
      if (!p || typeof p.prompt !== 'function') return Promise.resolve('none');
      J.bip = null;
      try { p.prompt(); } catch (e) { return Promise.resolve('none'); }
      return Promise.resolve(p.userChoice).then(function (c) { return (c && c.outcome) || ''; }, function () { return ''; });
    },
    checkUpdate: checkUpdate,
    applyUpdate: function () { if (J.pending) applyUpdate(false); },
    reset: resetExec,
    reconnect: reconnect,
    state: function () { return { ready: B.ready, origin: B.origin, queue: B.queue.length, inflight: Object.keys(B.inflight).length, seq: B.seq, gen: B.gen, help: J.helpKind, touched: J.touched }; },
    // 3.3: 연결 상태 — kind: ''(이어짐·잇는 중) · offline · timeout · login …  화면이 직접 위쪽에 보여 주면 ownNet = true 로 알려 줘요
    ownNet: false,
    net: function () { return { ready: B.ready, kind: J.helpKind, connecting: !B.ready && !J.helpKind }; },
    help: function () { if (soft(J.helpKind)) help(J.helpKind, true); },
    // 3.3: 「공유 → 적바림」으로 받은 것을 꺼내요 (한 번 꺼내면 기기에서 지워요)
    shared: function () {
      return idbGet('share').then(function (s) {
        if (!s) return null;
        return idbSet('share', null).catch(noop).then(function () { return sharedOut(s); });
      });
    }
  };
  function sharedOut(s) {
    var files = (s.files || []).map(function (f) {
      if (!f || !f.data) return null;
      try { return new File([f.data], f.name || '공유한 파일', { type: f.type || '' }); } catch (e) {
        var b = new Blob([f.data], { type: f.type || '' });
        b.name = f.name || '공유한 파일';
        return b;
      }
    }).filter(Boolean);
    return { at: s.at || 0, title: String(s.title || ''), text: String(s.text || ''), url: String(s.url || ''), files: files, more: s.more || 0 };
  }

  start();
})(window);
