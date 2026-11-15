/* Bộ đọc Piper chạy nền: phiên âm tiếng Việt (espeak-ng) rồi tạo giọng bằng mô hình ONNX.
 *
 * Tin nhắn nhận vào:
 *   { type: 'load',  id, model }                       tải và nạp giọng (có báo tiến độ)
 *   { type: 'speak', id, model, speaker, text, rate, urgent }  trả về tệp WAV
 * Tin nhắn gửi ra:
 *   { type: 'progress', id, loaded, total }
 *   { type: 'done', id, wav? }   |   { type: 'error', id, message }
 */
/* global ort, createPiperPhonemize */
importScripts('vendor/ort/ort.wasm.min.js', 'vendor/piper/piper_phonemize.js');

ort.env.wasm.numThreads = 1; // GitHub Pages không bật được đa luồng (cần cross-origin isolation)
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('vendor/ort/', self.location.href).href;

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const CACHE = 'nghe-doc-voices-v1';

// ---------- Tải tệp, lưu vào bộ nhớ của trình duyệt ----------
async function getFile(url, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  const total = +res.headers.get('Content-Length') || 0;
  const parts = [];
  let loaded = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const buf = new Uint8Array(loaded);
  let p = 0;
  for (const part of parts) { buf.set(part, p); p += part.length; }
  await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
  return buf;
}

// ---------- Phiên âm ----------
let phonPromise = null;
function phonAssets() {
  if (!phonPromise) {
    phonPromise = Promise.all([
      fetch('vendor/piper/piper_phonemize.wasm').then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)),
      fetch('vendor/piper/piper_phonemize.data').then((r) => r.arrayBuffer())
    ]).then(([module, data]) => ({ module, data }));
    phonPromise.catch(() => { phonPromise = null; });
  }
  return phonPromise;
}

// Trả về danh sách âm vị (chuỗi IPA). Mã số được tính sau theo bảng riêng của từng giọng,
// vì bảng mặc định của bộ phiên âm không khớp với các giọng tiếng Việt.
async function phonemize(text, espeakVoice) {
  const assets = await phonAssets();
  const phonemes = [];
  const errors = [];
  const mod = await createPiperPhonemize({
    print: (line) => {
      try { phonemes.push(...JSON.parse(line).phonemes); } catch (e) { /* dòng không phải JSON */ }
    },
    printErr: (m) => errors.push(m),
    locateFile: (u) => 'vendor/piper/' + u,
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(assets.module, imports).then((inst) => done(inst));
      return {};
    },
    getPreloadedPackage: () => assets.data.slice(0)
  });
  mod.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text: text }]), '--espeak_data', '/espeak-ng-data']);
  if (!phonemes.length) throw new Error('Không phiên âm được: ' + errors.join(' '));
  return phonemes;
}

// Cách Piper ghép mã: ^ _ (âm vị _)... $
function toIds(phonemes, map) {
  const pad = map._[0];
  const ids = [map['^'][0], pad];
  for (const ph of phonemes) {
    const m = map[ph];
    if (!m) continue; // ký hiệu giọng này không có
    for (const id of m) ids.push(id, pad);
  }
  ids.push(map.$[0]);
  return ids;
}

// ---------- Mô hình giọng ----------
let current = null; // { model, promise } — chỉ giữ một giọng trong bộ nhớ cho nhẹ máy
function loadVoice(model, onProgress) {
  if (current && current.model === model) return current.promise;
  const old = current;
  const promise = (async () => {
    if (old) { try { (await old.promise).session.release(); } catch (e) { /* bỏ qua */ } }
    const config = JSON.parse(new TextDecoder().decode(await getFile(HF + model + '.onnx.json')));
    const bytes = await getFile(HF + model + '.onnx', onProgress);
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    return { config, session };
  })();
  current = { model, promise };
  promise.catch(() => { if (current && current.promise === promise) current = null; });
  return promise;
}

function toWav(pcm, sampleRate) {
  const n = pcm.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0, p = 44; i < n; i++, p += 2) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return view.buffer;
}

async function speak(job) {
  const { config, session } = await loadVoice(job.model);
  const ids = toIds(await phonemize(job.text, (config.espeak && config.espeak.voice) || 'vi'), config.phoneme_id_map);
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([
      inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (job.rate || 1), inf.noise_w ?? 0.8
    ]), [3])
  };
  if ((config.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(job.speaker || 0)]), [1]);
  const out = await session.run(feeds);
  return toWav(out.output.data, config.audio.sample_rate);
}

// ---------- Hàng đợi: mỗi lúc chỉ tạo một câu; câu đang cần đọc được ưu tiên ----------
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const wav = await speak(job);
      self.postMessage({ type: 'done', id: job.id, wav }, [wav]);
    } catch (e) {
      self.postMessage({ type: 'error', id: job.id, message: String((e && e.message) || e) });
    }
  }
  busy = false;
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    loadVoice(msg.model, (loaded, total) => self.postMessage({ type: 'progress', id: msg.id, loaded, total }))
      .then(() => phonAssets())
      .then(() => self.postMessage({ type: 'done', id: msg.id }))
      .catch((err) => self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) }));
  } else if (msg.type === 'speak') {
    if (msg.urgent) queue.unshift(msg); else queue.push(msg);
    pump();
  }
};
