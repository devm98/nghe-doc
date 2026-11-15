// Lưu sẵn toàn bộ ứng dụng để dùng được khi không có mạng.
// Bộ máy đọc (vendor/ort/*.wasm, ~10 MB) không lưu sẵn ở đây; nó được lưu khi người dùng tải giọng lần đầu.
const CACHE = 'nghe-doc-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'piper-worker.js',
  'vendor/ort/ort.wasm.min.js',
  'vendor/piper/piper_phonemize.js',
  'vendor/piper/piper_phonemize.wasm',
  'vendor/piper/piper_phonemize.data',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/mammoth.browser.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Chỉ xóa bản cũ của ứng dụng, KHÔNG xóa giọng đã tải về (nghe-doc-voices-*).
      .then((keys) => Promise.all(keys.filter((k) => /^nghe-doc-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Ưu tiên mạng để luôn có bản mới; mất mạng thì lấy bản đã lưu.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
  );
});
