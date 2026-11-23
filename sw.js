/* 적바림 설치형 앱 — 서비스 워커 (3.3)
 * 시작 파일(이 저장소의 파일)만 기기에 저장해 두고 바로 열어요. 서버(Apps Script)로 가는 요청과 업무 내용은 건드리지 않아요.
 * 저장해 둔 것을 먼저 보여 주고, 뒤에서 새 파일을 받아 다음에 열 때 써요.
 * 3.3: 다른 앱에서 「공유 → 적바림」으로 보낸 사진·PDF·글은 이 기기(IndexedDB)에 잠깐 두고 앱을 열어요.
 *      앱이 열리면 꺼내서 지출 기록 창에 붙이고, 꺼낸 것은 바로 지워요. 서버로는 보내지 않아요.
 * 3.4: 기기에서 PDF를 만들 때 쓰는 도구(lib/)와 한글 글꼴(fonts/)은 처음 쓸 때 한 번 받아 따로 둬요.
 *      파일 이름에 버전이 있어 바뀌지 않으니, 시작 파일을 새 버전으로 바꿔도 다시 받지 않아요.
 */
var CACHE = 'jeokbarim-shell-3.4.0';
var ASSETS = 'jeokbarim-assets-1';
var FILES = ['./', 'shell.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/sc-spend.png', 'icons/sc-todo.png', 'icons/sc-memo.png', 'icons/sc-glance.png'];
var SCOPE = new URL('./', self.location.href).href;
var SHARE = SCOPE + 'share';
var SHARE_MAX = 5; // 한 번에 붙이는 파일 수 (기록 창과 같아요)

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return (k.indexOf('jeokbarim-shell-') === 0 && k !== CACHE) || (k.indexOf('jeokbarim-assets-') === 0 && k !== ASSETS); }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method === 'POST' && req.url.split(/[?#]/)[0] === SHARE) { e.respondWith(takeShare(req)); return; }
  if (req.method === 'GET' && req.url.indexOf(SCOPE) === 0 && /^(lib|fonts)\//.test(req.url.slice(SCOPE.length))) { e.respondWith(asset(req)); return; }
  if (req.method !== 'GET' || req.url.indexOf(SCOPE) !== 0) return; // 다른 주소(구글 서버·글꼴)는 그대로 보내요
  var nav = req.mode === 'navigate';
  if (!nav && /\/sw\.js$/.test(new URL(req.url).pathname)) return;
  // 앱 화면으로 가는 길(?add=spend 같은 바로가기 포함)은 모두 시작 페이지 하나로 열어요
  var key = nav ? SCOPE : req.url.split('#')[0];
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(nav ? new Request(SCOPE, { cache: 'no-cache', credentials: 'same-origin' }) : req).then(function (res) {
        if (res && res.ok && res.type === 'basic') return cache.put(key, res.clone()).then(function () { return res; }, function () { return res; });
        return res;
      });
      if (hit) { e.waitUntil(net.catch(function () { /* 다음에 다시 */ })); return hit; }
      return net;
    });
  }));
});

/* ───────── PDF 도구·글꼴 (3.4) ───────── 있으면 그것을, 없으면 받아서 넣어 둬요 */
function asset(req) {
  var key = req.url.split(/[?#]/)[0];
  return caches.open(ASSETS).then(function (c) {
    return c.match(key).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') return c.put(key, res.clone()).then(function () { return res; }, function () { return res; });
        return res;
      });
    });
  });
}

/* ───────── 공유로 받기 (3.3) ───────── */
function takeShare(req) {
  return req.formData().then(function (fd) {
    var all = fd.getAll('files').filter(function (f) { return f && typeof f === 'object' && f.size > 0; });
    var files = all.slice(0, SHARE_MAX);
    return Promise.all(files.map(function (f) {
      return new Response(f).arrayBuffer().then(function (buf) { return { name: String(f.name || ''), type: String(f.type || ''), size: f.size, data: buf }; });
    })).then(function (list) {
      return kvPut('share', { at: Date.now(), title: text(fd.get('title')), text: text(fd.get('text')), url: text(fd.get('url')), files: list, more: all.length - files.length });
    });
  }).catch(function () { /* 못 받았어도 앱은 열어요 */ }).then(function () {
    return Response.redirect(SCOPE + '?share=1', 303);
  });
}
function text(v) { return typeof v === 'string' ? v.slice(0, 4000) : ''; }
// 시작 파일(shell.js)과 같은 저장소: 이름 'jeokbarim', 칸 'kv'
function kvPut(k, v) {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('jeokbarim', 1);
    r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onerror = function () { rej(r.error); };
    r.onblocked = function () { rej(new Error('IndexedDB 막힘')); };
    r.onsuccess = function () {
      var d = r.result, tx;
      try { tx = d.transaction('kv', 'readwrite'); } catch (x) { d.close(); rej(x); return; }
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = function () { d.close(); res(true); };
      tx.onerror = tx.onabort = function () { d.close(); rej(tx.error); };
    };
  });
}
