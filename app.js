(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const synth = window.speechSynthesis;

  const SPEEDS = [
    { label: 'Rất chậm', rate: 0.6 },
    { label: 'Chậm', rate: 0.8 },
    { label: 'Vừa', rate: 1 },
    { label: 'Nhanh', rate: 1.25 },
    { label: 'Rất nhanh', rate: 1.5 }
  ];
  const SAMPLE = {
    vi: 'Xin chào, tôi sẽ đọc tài liệu cho bạn nghe.',
    en: 'Hello, I will read this document for you.'
  };
  const PAGE_CHARS = 1800; // cỡ một "trang" với Word / văn bản dán
  const MAX_SENTENCE = 240;

  // Một giây âm thanh im lặng: phát trong lúc người dùng bấm để iPhone cho phép phát tiếng về sau.
  const SILENCE = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

  // ---------- Lưu trữ ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* đầy bộ nhớ */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* bỏ qua */ } }
  };
  const settings = Object.assign({ rate: 1, fontSize: 22, theme: 'light', voices: {} }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((res, rej) => {
        const r = indexedDB.open('nghe-doc', 2);
        r.onupgradeneeded = () => {
          const names = r.result.objectStoreNames;
          if (!names.contains('docs')) r.result.createObjectStore('docs', { keyPath: 'id' });
          // Tệp PDF gốc của bản scan, để nhận dạng chữ dần từng trang.
          if (!names.contains('files')) r.result.createObjectStore('files');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return dbPromise;
  }
  async function idb(mode, fn, storeName) {
    const d = await db();
    const name = storeName || 'docs';
    return new Promise((res, rej) => {
      const tx = d.transaction(name, mode);
      const rq = fn(tx.objectStore(name));
      tx.oncomplete = () => res(rq && rq.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  }

  // ---------- Trạng thái ----------
  let doc = null;
  const st = { pi: 0, si: 0, sentences: [], playing: false };
  let voices = [];
  let token = 0;
  let utter = null; // giữ tham chiếu để trình duyệt không thu hồi giữa chừng

  // ---------- Tiện ích giao diện ----------
  function showView(name) {
    $('#home').hidden = name !== 'home';
    $('#reader').hidden = name !== 'reader';
    window.scrollTo(0, 0);
  }
  function openSheet(id) { $(id).hidden = false; }
  function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; }); }
  function message(text) { $('#msgText').textContent = text; openSheet('#sheetMsg'); }
  function loading(text, onCancel) {
    $('#loading').hidden = !text;
    if (text) $('#loadingText').textContent = text;
    const cancel = $('#btnLoadingCancel');
    cancel.hidden = !(text && onCancel);
    cancel.onclick = onCancel ? () => { loading(''); onCancel(); } : null;
  }
  // Hỏi Có / Không bằng hộp chữ to (thay cho confirm() chữ nhỏ của trình duyệt).
  function ask(text, yes, no) {
    return new Promise((resolve) => {
      $('#askText').textContent = text;
      $('#askYes').textContent = yes;
      $('#askNo').textContent = no;
      const done = (v) => { $('#sheetAsk').hidden = true; resolve(v); };
      $('#askYes').onclick = () => done(true);
      $('#askNo').onclick = () => done(false);
      $('#sheetAsk').onclick = (e) => { if (e.target === $('#sheetAsk')) done(false); };
      openSheet('#sheetAsk');
    });
  }
  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }
  function applyLook() {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty('--read-size', settings.fontSize + 'px');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = settings.theme === 'dark' ? '#101317' : '#0b5cad';
  }

  // ---------- Đọc tệp ----------
  function userError(msg) { const e = new Error(msg); e.userMsg = msg; return e; }

  function readFile(file, as) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      if (as === 'text') fr.readAsText(file); else fr.readAsArrayBuffer(file);
    });
  }
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res;
        s.onerror = () => { delete loaded[src]; rej(new Error('Không tải được ' + src)); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  // Ghép các mảnh chữ của pdf.js thành đoạn văn; khoảng cách dọc lớn = xuống đoạn.
  function pdfItemsToText(items) {
    let out = '', lastY = null, lastH = 0;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform[5];
      const h = it.height || lastH;
      if (lastY !== null && Math.abs(y - lastY) > Math.max(h, lastH, 1) * 1.8) out += '\n\n';
      out += it.str;
      if (it.hasEOL) out += '\n';
      if (it.str.trim()) { lastY = y; lastH = h || lastH; }
    }
    return out.replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/(\p{Ll})-\n(\p{Ll})/gu, '$1$2')
      .replace(/\n{2,}/g, '\u0001')
      .replace(/\n/g, ' ')
      .replace(/\u0001/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  async function pdfjs() {
    await loadScript('vendor/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    return window.pdfjsLib;
  }

  // Bản scan: lớp chữ trống, hoặc do máy nhận dạng sai mất dấu tiếng Việt ("Quy lu~t", "Hanh d9ng").
  // Từ tiếng Việt thường gặp khi bị mất dấu (đã bỏ các từ trùng với tiếng Anh / Tây Ban Nha / Pháp như the, de, la, con).
  const VI_PLAIN = new Set(('va cua cac nhung duoc trong khong nguoi mot co cho nay voi thi nhu phai biet ' +
    'hanh tam song gia dinh cong viec theo den ra vao tri tue quy nguyen tac luat sinh hoc ' +
    'nhan minh cung toi chung dang lam viet nam ve tren duoi khi neu sao').split(' '));
  function needsOcr(samplePages, info) {
    const text = samplePages.join(' ');
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 40 * samplePages.length) return true; // gần như không có chữ
    const viMarks = (text.match(/[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹàáãèéìíòóõùúýĩũÀÁÃÈÉÌÍÒÓÕÙÚÝĨŨ]/g) || []).length;
    if (viMarks / letters > 0.01) return false; // tiếng Việt có dấu đầy đủ
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    const plainVi = words.filter((w) => VI_PLAIN.has(w)).length;
    if (words.length && plainVi / words.length > 0.12) return true; // tiếng Việt bị mất dấu
    return /paper capture|scan/i.test(((info && (info.Producer || '')) + ' ' + ((info && info.Creator) || '')));
  }

  async function extractPdf(file) {
    const lib = await pdfjs();
    const pdf = await lib.getDocument({ data: await readFile(file) }).promise;
    const pages = [];
    let info = null;
    try { info = (await pdf.getMetadata()).info; } catch (e) { /* không có */ }
    for (let i = 1; i <= pdf.numPages; i++) {
      loading('Đang mở trang ' + i + ' / ' + pdf.numPages + '…');
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      pages.push(pdfItemsToText(tc.items));
      page.cleanup();
      // Xem vài trang đầu là biết có phải bản scan cần nhận dạng lại hay không.
      if (i === Math.min(5, pdf.numPages) && needsOcr(pages, info)) {
        const n = pdf.numPages;
        pdf.destroy();
        return { ocr: true, pages: new Array(n).fill(null) };
      }
    }
    pdf.destroy();
    return { ocr: false, pages: pages };
  }

  async function extractDocx(file) {
    await loadScript('vendor/mammoth.browser.min.js');
    const r = await window.mammoth.extractRawText({ arrayBuffer: await readFile(file) });
    return r.value;
  }

  // Word / văn bản không có trang thật: tự chia thành các trang vừa đọc.
  function paginate(text) {
    const paras = text.replace(/\r/g, '').split(/\n+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const pages = [];
    let cur = [], len = 0;
    for (const p of paras) {
      if (len && len + p.length > PAGE_CHARS) { pages.push(cur.join('\n\n')); cur = []; len = 0; }
      cur.push(p); len += p.length;
    }
    if (cur.length) pages.push(cur.join('\n\n'));
    return pages;
  }

  function detectLang(pages) {
    const sample = pages.join(' ').slice(0, 6000);
    const letters = (sample.match(/\p{L}/gu) || []).length || 1;
    const vi = (sample.match(/[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹàáãèéìíòóõùúýĩũÀÁÃÈÉÌÍÒÓÕÙÚÝĨŨ]/g) || []).length;
    return vi / letters > 0.02 ? 'vi' : 'en';
  }

  async function openFile(file) {
    const name = file.name || 'Tài liệu';
    const ext = (name.match(/\.([^.]+)$/) || [])[1];
    const kind = (ext || '').toLowerCase();
    const type = file.type || '';
    loading('Đang mở tài liệu…');
    try {
      let pages;
      if (kind === 'pdf' || type === 'application/pdf') {
        const r = await extractPdf(file);
        if (r.ocr) { await addScannedDoc(name.replace(/\.[^.]+$/, ''), file, r.pages.length); return; }
        pages = r.pages;
      } else if (kind === 'docx') pages = paginate(await extractDocx(file));
      else if (kind === 'doc') throw userError('Tệp Word đời cũ (.doc) chưa đọc được. Hãy nhờ người lưu lại thành .docx hoặc PDF rồi mở lại.');
      else if (kind === 'txt' || type.indexOf('text/') === 0) pages = paginate(await readFile(file, 'text'));
      else throw userError('Loại tệp này chưa hỗ trợ. Hãy chọn tệp PDF, Word (.docx) hoặc văn bản (.txt).');
      if (!pages.some((p) => p.trim())) {
        throw userError('Không tìm thấy chữ trong tài liệu này. Có thể đây là bản chụp ảnh (scan) nên máy chưa đọc được.');
      }
      await addDoc(name.replace(/\.[^.]+$/, ''), pages);
    } catch (e) {
      console.error(e);
      message(e.userMsg || 'Không mở được tài liệu này. Xin thử lại với tệp khác.');
    } finally {
      loading('');
    }
  }

  async function addDoc(name, pages) {
    const d = { id: Date.now().toString(36), name: name, pages: pages, lang: detectLang(pages), openedAt: Date.now() };
    try { await idb('readwrite', (s) => s.put(d)); } catch (e) { console.warn('Không lưu được tài liệu', e); }
    openDoc(d);
  }

  async function addScannedDoc(name, file, numPages) {
    const d = { id: Date.now().toString(36), name: name, pages: new Array(numPages).fill(null), lang: 'vi', ocr: true, openedAt: Date.now() };
    try {
      await idb('readwrite', (s) => s.put(file, d.id), 'files');
      await idb('readwrite', (s) => s.put(d));
    } catch (e) {
      console.warn('Không lưu được tài liệu', e);
      ocr.memFiles[d.id] = file; // vẫn đọc được trong lần mở này
    }
    openDoc(d);
    toast('Đây là bản scan. Máy sẽ nhận dạng chữ từng trang khi đọc.');
  }

  // ---------- Nhận dạng chữ tiếng Việt cho bản scan (Tesseract, chạy trong máy) ----------
  const ocr = { worker: null, pdf: null, pdfId: null, queue: Promise.resolve(), pending: new Map(), memFiles: {} };

  function ocrWorker() {
    if (!ocr.worker) {
      ocr.worker = loadScript('vendor/tesseract/tesseract.min.js').then(() => window.Tesseract.createWorker('vie', 1, {
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract/core',
        langPath: 'vendor/tesseract/lang',
        workerBlobURL: false,
        // Không dùng IndexedDB của Tesseract: nếu bị khóa nó treo mãi. Tệp dữ liệu đã được service worker lưu sẵn.
        cacheMethod: 'none'
      }));
      ocr.worker.catch(() => { ocr.worker = null; });
    }
    return ocr.worker;
  }
  function resetOcrWorker() {
    const w = ocr.worker;
    ocr.worker = null;
    if (w) w.then((x) => x.terminate()).catch(() => {});
  }
  function withTimeout(promise, ms) {
    let t;
    return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })])
      .finally(() => clearTimeout(t));
  }

  async function ocrPdf(d) {
    if (ocr.pdfId !== d.id) {
      if (ocr.pdf) { ocr.pdf.destroy(); ocr.pdf = null; ocr.pdfId = null; }
      const file = ocr.memFiles[d.id] || await idb('readonly', (s) => s.get(d.id), 'files');
      if (!file) throw userError('Không còn tệp gốc của tài liệu này. Hãy mở lại tệp PDF.');
      const lib = await pdfjs();
      ocr.pdf = await lib.getDocument({ data: await readFile(file) }).promise;
      ocr.pdfId = d.id;
    }
    return ocr.pdf;
  }

  // Ghép các dòng chữ nhận dạng được: dòng nối tiếp câu thì nối lại, dòng mới (mục, tiêu đề) thì tách đoạn.
  function cleanOcr(text) {
    // Ký tự rác hay gặp khi máy đọc vết bút, khung, gạch chân trên bản scan.
    const lines = text.replace(/\r/g, '').replace(/[|`ˆ¬~_\\{}[\]]/g, ' ').replace(/\s*(>>|<<|»|«)\s*/g, ', ').split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim()
        .replace(/^[^\p{L}\p{N}“"'(]+/u, '') // ký hiệu đầu dòng: -, +, •, ➔ …
        .replace(/^[A-Za-z] (?=\p{Lu})/u, '') // một chữ cái lẻ trước tiêu đề (mũi tên bị đọc thành chữ)
        .replace(/([.!?:;])(\s+\S{1,2}){1,3}$/u, '$1') // mẩu rác ngắn sau dấu câu cuối dòng: ". c hư", ". w—"
        .replace(/(\s+([^\p{L}\p{N}\s]{1,3}|[A-Za-z]))+$/u, '') // ký hiệu / chữ cái lẻ cuối dòng
        .replace(/([,.:;!?])(?=\p{L})/gu, '$1 ').replace(/\s+([,.:;!?])/g, '$1') // khoảng trắng quanh dấu câu (giữ nguyên 1.3)
        .replace(/\s{2,}/g, ' ')
        .trim())
      .map((l) => (/\p{L}/u.test(l) ? l : '')); // bỏ dòng chỉ có số trang / ký hiệu
    const paras = [];
    let cur = '';
    for (const l of lines) {
      if (!l) { if (cur) { paras.push(cur); cur = ''; } continue; }
      if (cur && !/[.!?:;…]$/.test(cur) && /^\p{Ll}/u.test(l)) cur = cur.replace(/-$/, '') + (/-$/.test(cur) ? '' : ' ') + l;
      else { if (cur) paras.push(cur); cur = l; }
    }
    if (cur) paras.push(cur);
    return paras.join('\n\n');
  }

  // Nhận dạng một trang (lần lượt từng trang một), lưu kết quả để lần sau không phải làm lại.
  function ocrPage(d, i) {
    if (d.pages[i] != null) return Promise.resolve(d.pages[i]);
    const key = d.id + ':' + i;
    if (ocr.pending.has(key)) return ocr.pending.get(key);
    const p = ocr.queue.catch(() => {}).then(async () => {
      if (d.pages[i] != null) return d.pages[i];
      const pdf = await ocrPdf(d);
      const page = await pdf.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      // ~1200px bề ngang: thử trên bản scan thật cho chữ đúng nhất; to hơn lại sai nhiều hơn và chậm hơn.
      const vp = page.getViewport({ scale: Math.min(2.2, Math.max(1.5, 1200 / base.width)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      page.cleanup();
      let r;
      try {
        // Điện thoại yếu có thể mất cả chục giây một trang; quá 2 phút thì coi là lỗi để không treo mãi.
        r = await withTimeout(ocrWorker().then((w) => w.recognize(canvas)), 120000);
      } catch (e) {
        resetOcrWorker();
        throw e;
      } finally {
        canvas.width = canvas.height = 0;
      }
      d.pages[i] = cleanOcr(r.data.text);
      idb('readwrite', (s) => s.put(d)).catch(() => {});
      return d.pages[i];
    });
    ocr.queue = p;
    ocr.pending.set(key, p);
    const done = () => ocr.pending.delete(key);
    p.then(done, done);
    return p;
  }

  // ---------- Thư viện ----------
  async function renderLibrary() {
    let docs = [];
    try { docs = (await idb('readonly', (s) => s.getAll())) || []; } catch (e) { console.warn(e); }
    docs.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    const list = $('#docList');
    list.innerHTML = '';
    $('#library').hidden = !docs.length;
    docs.forEach((d) => {
      const pos = store.get('pos:' + d.id, { pi: 0 });
      const row = document.createElement('div');
      row.className = 'doc';
      const open = document.createElement('button');
      open.className = 'btn open';
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = d.name;
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = 'Đang ở trang ' + (pos.pi + 1) + ' / ' + d.pages.length + ' — bấm để nghe tiếp';
      open.append(nm, meta);
      open.onclick = () => openDoc(d);
      const del = document.createElement('button');
      del.className = 'btn del'; del.textContent = 'Xóa';
      del.setAttribute('aria-label', 'Xóa ' + d.name);
      del.onclick = async () => {
        if (!confirm('Xóa tài liệu “' + d.name + '” khỏi danh sách?')) return;
        await idb('readwrite', (s) => s.delete(d.id));
        idb('readwrite', (s) => s.delete(d.id), 'files').catch(() => {});
        store.del('pos:' + d.id);
        renderLibrary();
      };
      row.append(open, del);
      list.appendChild(row);
    });
  }

  // ---------- Màn hình đọc ----------
  function openDoc(d) {
    doc = d;
    doc.openedAt = Date.now();
    idb('readwrite', (s) => s.put(doc)).catch(() => {});
    const pos = store.get('pos:' + d.id, { pi: 0, si: 0 });
    st.pi = Math.min(pos.pi || 0, d.pages.length - 1);
    st.si = pos.si || 0;
    $('#docTitle').textContent = d.name;
    showView('reader');
    renderPage(true);
  }

  function splitSentences(text) {
    let parts = [];
    if (window.Intl && Intl.Segmenter) {
      const seg = new Intl.Segmenter(doc ? doc.lang : 'vi', { granularity: 'sentence' });
      for (const s of seg.segment(text)) parts.push(s.segment);
    } else {
      parts = text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [text];
    }
    const out = [];
    for (let p of parts) {
      p = p.trim();
      // Câu quá dài: cắt ở dấu phẩy gần nhất để máy đọc không bị ngắt giữa chừng.
      while (p.length > MAX_SENTENCE) {
        let cut = Math.max(p.lastIndexOf(', ', MAX_SENTENCE), p.lastIndexOf('; ', MAX_SENTENCE), p.lastIndexOf(': ', MAX_SENTENCE));
        if (cut < 60) cut = p.lastIndexOf(' ', MAX_SENTENCE);
        cut = cut < 60 ? MAX_SENTENCE : cut + 1;
        out.push(p.slice(0, cut).trim());
        p = p.slice(cut).trim();
      }
      if (p) out.push(p);
    }
    return out;
  }

  function renderPage(keepSentence) {
    const el = $('#text');
    const raw = doc.pages[st.pi];
    const text = raw || '';
    el.innerHTML = '';
    st.sentences = [];
    st.waiting = false;
    if (!keepSentence) st.si = 0;
    if (raw == null && doc.ocr) {
      // Trang scan chưa nhận dạng: làm ngay, xong thì hiện chữ (và đọc tiếp nếu đang đọc).
      st.waiting = true;
      const box = document.createElement('div');
      box.className = 'empty ocr-wait';
      const spin = document.createElement('div');
      spin.className = 'spinner';
      const p = document.createElement('p');
      p.textContent = 'Đang nhận dạng chữ trang ' + (st.pi + 1) + '…\nMỗi trang mất vài giây, chỉ làm một lần.';
      box.append(spin, p);
      el.appendChild(box);
      const d = doc, pi = st.pi, si = st.si;
      ocrPage(d, pi).then(() => {
        if (doc !== d || st.pi !== pi) return;
        st.si = si;
        renderPage(true);
        if (st.playing) speakCurrent();
      }, (e) => {
        console.warn('Nhận dạng chữ lỗi', e);
        if (doc !== d || st.pi !== pi) return;
        st.waiting = false;
        p.textContent = e.userMsg || 'Chưa nhận dạng được chữ trang này. Hãy thử lại sau.';
        spin.remove();
        if (st.playing) { stop(); toast('Chưa đọc được trang này.'); }
      });
    } else if (!text.trim()) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'Trang này không có chữ để đọc (có thể là hình ảnh).';
      el.appendChild(p);
    } else {
      text.split('\n\n').forEach((para) => {
        const p = document.createElement('p');
        splitSentences(para).forEach((s) => {
          const span = document.createElement('span');
          span.className = 's';
          span.dataset.i = st.sentences.length;
          span.textContent = s + ' ';
          st.sentences.push(s);
          p.appendChild(span);
        });
        el.appendChild(p);
      });
    }
    if (!st.waiting && st.si >= st.sentences.length) st.si = 0;
    const n = doc.pages.length;
    $('#pageLabel').textContent = 'Trang ' + (st.pi + 1) + ' / ' + n;
    $('#progressFill').style.width = ((st.pi + 1) / n * 100) + '%';
    $('#btnPrevPage').disabled = st.pi === 0;
    $('#btnNextPage').disabled = st.pi >= n - 1;
    el.scrollTop = 0;
    highlight();
    savePos();
    // Bản scan: nhận dạng sẵn trang kế tiếp trong lúc đang đọc trang này.
    if (doc.ocr && !st.waiting && st.pi + 1 < n && doc.pages[st.pi + 1] == null) ocrPage(doc, st.pi + 1).catch(() => {});
  }

  function highlight() {
    const el = $('#text');
    const prev = el.querySelector('.s.on');
    if (prev) prev.classList.remove('on');
    const cur = el.querySelector('.s[data-i="' + st.si + '"]');
    if (!cur) return;
    cur.classList.add('on');
    try { cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { cur.scrollIntoView(); }
  }

  function savePos() { if (doc) store.set('pos:' + doc.id, { pi: st.pi, si: st.si }); }

  function goPage(n) {
    if (!doc || n < 0 || n >= doc.pages.length) return;
    st.pi = n;
    renderPage(false);
    if (st.playing) speakCurrent();
    mediaSession(st.playing);
  }

  // ---------- Giọng đọc ----------
  function loadVoices() {
    if (!synth) return;
    const v = synth.getVoices();
    if (v && v.length) {
      voices = v.slice();
      if (!$('#sheetSettings').hidden) renderVoices();
    }
  }
  // Giọng hiệu ứng vui của macOS, không hợp để đọc tài liệu.
  const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Fred|Good News|Jester|Junior|Kathy|Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/;
  const voiceLang = (v) => (v.lang || '').replace('_', '-').toLowerCase();
  function voicesFor(lang) {
    return voices.filter((v) => voiceLang(v).indexOf(lang) === 0 && !NOVELTY.test(v.name))
      .sort((a, b) => (b.localService ? 1 : 0) - (a.localService ? 1 : 0) || a.name.localeCompare(b.name));
  }
  // ---------- Giọng tải về (Piper): tải một lần, chạy ngay trong máy, không cần mạng ----------
  // Cao độ đã đo: Mai ~235 Hz, Thu ~203 Hz, Lan ~250 Hz (nữ); Nam ~128 Hz, Hùng ~125 Hz (nam).
  const VIVOS = 'vi/vi_VN/vivos/x_low/vi_VN-vivos-x_low';
  const PIPER_VOICES = {
    vi: [
      { id: 'mai', name: 'Mai', note: 'Giọng nữ, rõ nhất', model: 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium', mb: 63 },
      { id: 'thu', name: 'Thu', note: 'Giọng nữ, trầm hơn', model: 'vi/vi_VN/25hours_single/low/vi_VN-25hours_single-low', mb: 63 },
      { id: 'nam', name: 'Nam', note: 'Giọng nam', model: VIVOS, speaker: 38, mb: 28 },
      { id: 'hung', name: 'Hùng', note: 'Giọng nam trầm', model: VIVOS, speaker: 56, mb: 28 },
      { id: 'lan', name: 'Lan', note: 'Giọng nữ', model: VIVOS, speaker: 40, mb: 28 }
    ]
  };
  const RECOMMENDED = { vi: 'mai' };
  const ENGINE_MB = 12; // bộ máy đọc, chỉ tải lần đầu
  const PIPER_HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
  const VOICE_CACHE = 'nghe-doc-voices-v1'; // phải khớp với piper-worker.js
  const piperFor = (lang) => PIPER_VOICES[lang] || [];
  const piperStored = new Set(); // các mô hình đã tải về máy
  let piperOffUntil = 0; // giọng tải về bị lỗi: tạm dùng giọng của máy một lúc

  async function refreshStored() {
    if (!window.caches) return;
    try {
      const c = await caches.open(VOICE_CACHE);
      const models = [...new Set(Object.values(PIPER_VOICES).flat().map((v) => v.model))];
      await Promise.all(models.map(async (m) => {
        if (await c.match(PIPER_HF + m + '.onnx')) piperStored.add(m); else piperStored.delete(m);
      }));
    } catch (e) { /* bộ nhớ bị chặn */ }
  }

  let worker = null;
  let jobId = 0;
  const jobs = new Map();
  function piperWorker() {
    if (!worker) {
      worker = new Worker('piper-worker.js');
      worker.onmessage = (e) => {
        const m = e.data;
        const j = jobs.get(m.id);
        if (!j) return;
        if (m.type === 'progress') { if (j.onProgress) j.onProgress(m.loaded, m.total); return; }
        jobs.delete(m.id);
        if (m.type === 'error') j.reject(new Error(m.message)); else j.resolve(m.wav);
      };
      worker.onerror = (e) => { console.warn('Bộ đọc lỗi', e); resetWorker(new Error('worker')); };
    }
    return worker;
  }
  function resetWorker(err) {
    if (worker) worker.terminate();
    worker = null;
    jobs.forEach((j) => j.reject(err));
    jobs.clear();
    clearClips();
  }
  function piperCall(msg, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++jobId;
      jobs.set(id, { resolve, reject, onProgress });
      piperWorker().postMessage(Object.assign({ id }, msg));
    });
  }

  const clips = new Map(); // khóa → Promise<địa chỉ blob wav>
  function clearClips() {
    clips.forEach((p) => p.then((u) => URL.revokeObjectURL(u), () => {}));
    clips.clear();
  }
  function piperClip(text, v, urgent) {
    const key = [v.model, v.speaker || 0, settings.rate, text].join('|');
    if (clips.has(key)) return clips.get(key);
    const p = piperCall({ type: 'speak', model: v.model, speaker: v.speaker || 0, text: text, rate: settings.rate, urgent: !!urgent })
      .then((wav) => URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
    p.catch(() => clips.delete(key));
    clips.set(key, p);
    while (clips.size > 40) { // giữ bộ nhớ gọn
      const oldest = clips.keys().next().value;
      clips.get(oldest).then((u) => URL.revokeObjectURL(u), () => {});
      clips.delete(oldest);
    }
    return p;
  }

  function downloadMb(v) { return v.mb + (piperStored.size ? 0 : ENGINE_MB); }

  async function downloadVoice(v) {
    const ok = await ask('Tải giọng “' + v.name + '” về máy?\n\nCần khoảng ' + downloadMb(v) +
      ' MB, chỉ tải một lần, sau đó đọc được cả khi không có mạng. Nên dùng Wi‑Fi.', 'Tải về', 'Để sau');
    if (!ok) return false;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* không bắt buộc */ }
    let canceled = false;
    loading('Đang tải giọng “' + v.name + '”…', () => { canceled = true; resetWorker(new Error('canceled')); });
    try {
      await piperCall({ type: 'load', model: v.model }, (loaded, total) => {
        $('#loadingText').textContent = 'Đang tải giọng “' + v.name + '”… ' +
          (total ? Math.floor(loaded * 100 / total) + '%' : Math.round(loaded / 1e6) + ' MB');
      });
      piperStored.add(v.model);
      return true;
    } catch (e) {
      console.warn('Tải giọng lỗi', e);
      if (!canceled) message('Chưa tải được giọng đọc. Hãy kiểm tra mạng rồi thử lại.');
      return false;
    } finally {
      loading('');
    }
  }

  async function removeVoices() {
    const ok = await ask('Xóa các giọng đã tải về để lấy lại bộ nhớ? Khi cần có thể tải lại.', 'Xóa', 'Không');
    if (!ok) return;
    resetWorker(new Error('removed'));
    try { await caches.delete(VOICE_CACHE); } catch (e) { /* bỏ qua */ }
    piperStored.clear();
    renderVoices();
    toast('Đã xóa các giọng tải về.');
  }

  // ---------- Chọn giọng ----------
  function deviceVoice() {
    const lang = doc ? doc.lang : 'vi';
    const list = voicesFor(lang);
    return list.find((v) => v.voiceURI === settings.voices[lang]) || list.find((v) => v.default) || list[0] || null;
  }
  // Giọng đang dùng: { piper: true, ... } (giọng tải về), một giọng có sẵn trong máy, hoặc null nếu chưa có giọng nào.
  function currentVoice() {
    const lang = doc ? doc.lang : 'vi';
    const saved = settings.voices[lang] || '';
    const usable = piperFor(lang).filter((v) => piperStored.has(v.model));
    if (Date.now() >= piperOffUntil) {
      const chosen = usable.find((v) => 'piper:' + v.id === saved);
      if (chosen) return Object.assign({ piper: true }, chosen);
      if (!voicesFor(lang).some((v) => v.voiceURI === saved) && usable.length) return Object.assign({ piper: true }, usable[0]);
    }
    return deviceVoice();
  }

  function voiceButton(title, subText, on, onPick) {
    const b = document.createElement('button');
    b.className = 'btn voice' + (on ? ' on' : '');
    const left = document.createElement('span');
    left.textContent = title;
    const sub = document.createElement('small');
    sub.textContent = subText;
    left.appendChild(sub);
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = on ? '✓ Đang dùng' : 'Chọn';
    b.append(left, tick);
    b.onclick = onPick;
    return b;
  }
  function groupTitle(text) {
    const h = document.createElement('p');
    h.className = 'voice-group';
    h.textContent = text;
    return h;
  }

  function renderVoices() {
    const lang = doc ? doc.lang : 'vi';
    const list = voicesFor(lang);
    const piperList = piperFor(lang);
    const box = $('#voiceList');
    const note = $('#voiceNote');
    box.innerHTML = '';
    note.hidden = list.length > 0 || piperList.length > 0;
    if (!note.hidden) note.textContent = 'Máy này chưa có giọng đọc cho ngôn ngữ này.';
    const cur = currentVoice();
    const choose = (key) => {
      settings.voices[lang] = key;
      saveSettings();
      piperOffUntil = 0;
      renderVoices();
      if (st.playing) speakCurrent(); else speakSample();
    };
    if (piperList.length) {
      box.appendChild(groupTitle('Giọng tiếng Việt tải về — đọc được khi không có mạng'));
      piperList.forEach((v) => {
        const stored = piperStored.has(v.model);
        const on = !!(cur && cur.piper && cur.id === v.id);
        box.appendChild(voiceButton(v.name, v.note + (stored ? ' · đã tải' : ' · cần tải ' + downloadMb(v) + ' MB'), on, async () => {
          unlockAudio();
          if (!stored && !(await downloadVoice(v))) return;
          choose('piper:' + v.id);
        }));
      });
      if (list.length) box.appendChild(groupTitle('Giọng có sẵn trong máy'));
    }
    list.forEach((v) => {
      const on = !!(cur && !cur.piper && cur.voiceURI === v.voiceURI);
      box.appendChild(voiceButton(
        v.name.replace(/\s*\(.*$/, '').trim(),
        v.lang.replace('_', '-') + (v.localService ? ' · có sẵn trong máy' : ' · cần có mạng'),
        on, () => choose(v.voiceURI)));
    });
    if (piperStored.size) {
      const del = document.createElement('button');
      del.className = 'btn small ghost';
      del.textContent = 'Xóa các giọng đã tải về';
      del.onclick = removeVoices;
      box.appendChild(del);
    }
  }

  function makeUtterance(text) {
    const u = new SpeechSynthesisUtterance(text);
    const v = deviceVoice();
    if (v) { u.voice = v; u.lang = v.lang.replace('_', '-'); }
    else u.lang = doc && doc.lang === 'en' ? 'en-US' : 'vi-VN';
    u.rate = settings.rate;
    return u;
  }

  // ---------- Phát âm thanh của giọng tải về ----------
  const audio = new Audio();
  audio.preload = 'auto';
  let audioUnlocked = false;
  // Phải gọi trong lúc người dùng đang bấm nút, nếu không iPhone sẽ chặn tiếng về sau.
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    audio.src = SILENCE;
    audio.play().catch(() => { audioUnlocked = false; });
  }

  // Lần đầu nạp giọng mất vài giây: báo cho người dùng biết máy đang làm việc.
  function slowNotice(promise) {
    const t = setTimeout(() => toast('Đang chuẩn bị giọng đọc…'), 900);
    promise.then(() => clearTimeout(t), () => clearTimeout(t));
    return promise;
  }

  function piperFailed(v, e) {
    console.warn('Giọng tải về lỗi', e);
    refreshStored();
    piperOffUntil = Date.now() + 60000;
    if (deviceVoice()) { toast('Giọng “' + v.name + '” đang lỗi. Tạm dùng giọng có sẵn trong máy.'); return true; }
    stop();
    message('Chưa đọc được bằng giọng “' + v.name + '”. Hãy vào “Giọng & Chữ” để tải lại giọng.');
    return false;
  }

  async function speakPiper(v, mine) {
    const text = st.sentences[st.si];
    let src;
    try {
      src = await slowNotice(piperClip(text, v, true));
    } catch (e) {
      if (mine !== token || !st.playing) return;
      if (piperFailed(v, e)) speakCurrent();
      return;
    }
    if (mine !== token || !st.playing) return;
    // Chuẩn bị trước 2 câu kế tiếp để đọc liền mạch.
    for (let i = 1; i <= 2; i++) {
      const s = st.sentences[st.si + i];
      if (s && /[\p{L}\p{N}]/u.test(s)) piperClip(s, v).catch(() => {});
    }
    audio.onended = () => {
      if (mine !== token || !st.playing) return;
      st.si++;
      speakCurrent();
    };
    audio.onerror = () => {
      if (mine !== token || !st.playing) return;
      if (piperFailed(v, audio.error)) speakCurrent();
    };
    audio.src = src;
    audio.play().catch((e) => {
      if (mine !== token) return;
      console.warn('Không phát được', e);
      stop();
      toast('Hãy bấm nút ĐỌC để bắt đầu.');
    });
  }

  function hush() {
    token++;
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
    audio.onended = audio.onerror = null;
    if (!audio.paused) audio.pause();
  }
  function isSounding() {
    return (!audio.paused && !audio.ended) || !!(synth && (synth.speaking || synth.pending));
  }
  async function speakSample() {
    hush();
    const mine = token;
    const text = SAMPLE[doc ? doc.lang : 'vi'];
    const v = currentVoice();
    if (v && v.piper) {
      unlockAudio();
      try {
        const src = await slowNotice(piperClip(text, v, true));
        if (mine !== token) return;
        audio.src = src;
        audio.play().catch(() => {});
      } catch (e) { if (mine === token) piperFailed(v, e); }
      return;
    }
    if (!synth || !v) return;
    utter = makeUtterance(text);
    synth.speak(utter);
  }

  // Chưa có giọng nào cho ngôn ngữ này: mời tải giọng gợi ý rồi đọc luôn.
  async function offerVoice() {
    const lang = doc ? doc.lang : 'vi';
    const v = piperFor(lang).find((x) => x.id === RECOMMENDED[lang]);
    if (!v) {
      message('Máy này chưa có giọng đọc cho ngôn ngữ này. Hãy thử mở bằng Chrome (Android) hoặc Safari (iPhone).');
      return;
    }
    if (!(await downloadVoice(v))) return;
    settings.voices[lang] = 'piper:' + v.id;
    saveSettings();
    play();
  }

  // ---------- Phát / dừng ----------
  let wakeLock = null;
  async function keepScreenOn(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        const w = wakeLock; wakeLock = null; await w.release();
      }
    } catch (e) { /* không bắt buộc */ }
  }

  function setPlaying(on) {
    st.playing = on;
    $('#btnPlay').classList.toggle('playing', on);
    $('#icoPlay').toggleAttribute('hidden', on); // SVG không có thuộc tính .hidden
    $('#icoPause').toggleAttribute('hidden', !on);
    $('#playLabel').textContent = on ? 'DỪNG' : 'ĐỌC';
    keepScreenOn(on);
    mediaSession(on);
  }

  function stop() {
    hush();
    setPlaying(false);
    savePos();
  }

  function speakCurrent() {
    const v = currentVoice();
    if (!v || (!v.piper && !synth)) {
      stop();
      offerVoice();
      return;
    }
    hush();
    if (st.waiting) return; // trang scan đang được nhận dạng; xong sẽ tự đọc tiếp
    const mine = token;
    // Bỏ qua các "câu" chỉ có ký hiệu, không có chữ hay số.
    while (st.si < st.sentences.length && !/[\p{L}\p{N}]/u.test(st.sentences[st.si])) st.si++;
    if (st.si >= st.sentences.length) { nextPageAuto(); return; }
    highlight();
    savePos();
    if (v.piper) { speakPiper(v, mine); return; }
    const u = makeUtterance(st.sentences[st.si]);
    u.onend = () => {
      if (mine !== token || !st.playing) return;
      st.si++;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (mine !== token || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Lỗi đọc', e.error);
      stop();
      if (e.error === 'not-allowed') toast('Hãy bấm nút ĐỌC để bắt đầu.');
      else toast('Máy chưa đọc được câu này. Thử chọn giọng khác.');
    };
    utter = u;
    if (synth.paused) synth.resume();
    synth.speak(u);
  }

  // Nút điều khiển trên màn hình khóa / tai nghe.
  function mediaSession(on) {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.playbackState = on ? 'playing' : 'paused';
    if (on && doc && window.MediaMetadata) {
      ms.metadata = new MediaMetadata({
        title: doc.name, artist: 'Nghe Đọc · Trang ' + (st.pi + 1),
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
    }
  }
  if (navigator.mediaSession) {
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) { /* không hỗ trợ */ } };
    set('play', () => { if (doc && !st.playing) play(); });
    set('pause', () => { if (st.playing) stop(); });
    set('nexttrack', () => step(1));
    set('previoustrack', () => step(-1));
  }

  function nextPageAuto() {
    let n = st.pi + 1;
    // Bỏ qua trang không có chữ (trang scan chưa nhận dạng thì giữ lại để nhận dạng).
    while (n < doc.pages.length && doc.pages[n] != null && !doc.pages[n].trim()) n++;
    if (n >= doc.pages.length) {
      stop();
      st.si = 0; highlight(); savePos();
      toast('Đã đọc hết tài liệu.');
      return;
    }
    st.pi = n;
    renderPage(false);
    speakCurrent();
  }

  function play() { unlockAudio(); setPlaying(true); speakCurrent(); }

  function step(d) {
    if (!doc) return;
    const next = st.si + d;
    if (next < 0) { st.si = 0; }
    else if (next >= st.sentences.length) {
      if (st.pi < doc.pages.length - 1) { goPage(st.pi + 1); return; }
      return;
    } else st.si = next;
    highlight(); savePos();
    if (st.playing) speakCurrent();
  }

  // ---------- Cài đặt ----------
  function renderSettings() {
    const box = $('#speedList');
    box.innerHTML = '';
    SPEEDS.forEach((sp) => {
      const b = document.createElement('button');
      b.className = 'btn' + (sp.rate === settings.rate ? ' on' : '');
      b.textContent = sp.label;
      b.onclick = () => {
        settings.rate = sp.rate; saveSettings(); renderSettings();
        if (st.playing) speakCurrent(); else speakSample();
      };
      box.appendChild(b);
    });
    document.querySelectorAll('#themeList .btn').forEach((b) => b.classList.toggle('on', b.dataset.theme === settings.theme));
    document.querySelectorAll('#langList .btn').forEach((b) => b.classList.toggle('on', !!doc && b.dataset.lang === doc.lang));
    renderVoices();
  }

  // ---------- Gắn sự kiện ----------
  function bind() {
    $('#btnOpen').onclick = () => $('#file').click();
    $('#file').onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) openFile(f);
    };

    $('#btnPaste').onclick = () => { $('#pasteArea').value = ''; openSheet('#sheetPaste'); };
    $('#btnClipboard').onclick = async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (t) $('#pasteArea').value = t; else toast('Bộ nhớ tạm đang trống.');
      } catch (e) { toast('Hãy nhấn giữ vào ô bên dưới rồi chọn “Dán”.'); }
    };
    $('#btnPasteGo').onclick = () => {
      const t = $('#pasteArea').value.trim();
      if (!t) { toast('Chưa có văn bản để đọc.'); return; }
      closeSheets();
      const title = t.replace(/\s+/g, ' ').slice(0, 40) + (t.length > 40 ? '…' : '');
      addDoc(title, paginate(t));
    };

    $('#btnBack').onclick = () => { stop(); doc = null; showView('home'); renderLibrary(); };
    $('#btnPlay').onclick = () => (st.playing ? stop() : play());
    $('#btnPrev').onclick = () => step(-1);
    $('#btnNext').onclick = () => step(1);
    $('#btnPrevPage').onclick = () => goPage(st.pi - 1);
    $('#btnNextPage').onclick = () => goPage(st.pi + 1);

    $('#text').onclick = (e) => {
      const span = e.target.closest ? e.target.closest('.s') : null;
      if (!span) return;
      st.si = +span.dataset.i;
      play();
    };

    $('#btnPageJump').onclick = () => {
      const n = doc.pages.length;
      $('#jumpInfo').textContent = 'Tài liệu có ' + n + ' trang. Nhập số trang muốn nghe:';
      const inp = $('#jumpInput');
      inp.max = n; inp.value = st.pi + 1;
      openSheet('#sheetJump');
      inp.select();
    };
    const jump = () => {
      const n = parseInt($('#jumpInput').value, 10);
      if (!n || n < 1 || n > doc.pages.length) { toast('Số trang phải từ 1 đến ' + doc.pages.length + '.'); return; }
      closeSheets();
      goPage(n - 1);
    };
    $('#btnJumpGo').onclick = jump;
    $('#jumpInput').onkeydown = (e) => { if (e.key === 'Enter') jump(); };

    $('#btnSettings').onclick = () => { renderSettings(); openSheet('#sheetSettings'); };
    $('#btnFontUp').onclick = () => { settings.fontSize = Math.min(44, settings.fontSize + 3); saveSettings(); applyLook(); highlight(); };
    $('#btnFontDown').onclick = () => { settings.fontSize = Math.max(16, settings.fontSize - 3); saveSettings(); applyLook(); highlight(); };
    document.querySelectorAll('#themeList .btn').forEach((b) => {
      b.onclick = () => { settings.theme = b.dataset.theme; saveSettings(); applyLook(); renderSettings(); };
    });
    document.querySelectorAll('#langList .btn').forEach((b) => {
      b.onclick = () => {
        if (!doc || doc.lang === b.dataset.lang) return;
        const was = st.playing;
        stop();
        doc.lang = b.dataset.lang;
        idb('readwrite', (s) => s.put(doc)).catch(() => {});
        renderPage(false);
        renderSettings();
        if (was) play();
      };
    });

    document.querySelectorAll('.sheet').forEach((sheet) => {
      sheet.addEventListener('click', (e) => {
        if (e.target === sheet || e.target.closest('[data-close]')) {
          sheet.hidden = true;
          if (!st.playing) hush(); // tắt câu nghe thử
        }
      });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !st.playing) return;
      keepScreenOn(true);
      // Điện thoại có thể ngắt tiếng khi tắt màn hình: quay lại thì đọc tiếp câu đang dở.
      setTimeout(() => { if (st.playing && !isSounding()) speakCurrent(); }, 400);
    });
    window.addEventListener('pagehide', () => { if (synth) synth.cancel(); audio.pause(); });

    // Cài đặt như ứng dụng
    let installEvt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); installEvt = e; $('#btnInstall').hidden = false;
    });
    $('#btnInstall').onclick = () => { if (installEvt) { installEvt.prompt(); installEvt = null; $('#btnInstall').hidden = true; } };
    const standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && !standalone) $('#iosHint').hidden = false;
  }

  // ---------- Khởi động ----------
  applyLook();
  bind();
  renderLibrary();
  refreshStored().then(() => { if (!$('#sheetSettings').hidden) renderVoices(); });
  if (synth) {
    loadVoices();
    synth.onvoiceschanged = loadVoices;
    // iOS đôi khi không báo sự kiện voiceschanged: hỏi lại vài lần.
    let tries = 0;
    const poll = setInterval(() => { loadVoices(); if (voices.length || ++tries > 10) clearInterval(poll); }, 300);
    synth.cancel();
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }

  window.ngheDoc = { openFile: openFile };
})();
