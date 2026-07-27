// Рисование/аннотации поверх прикреплённого скрина во вложениях задач
(function () {
  const modal = document.getElementById('image-preview-modal');
  const modalBox = modal && modal.querySelector('.modal-image-preview');
  const img = document.getElementById('image-preview-img');
  const video = document.getElementById('image-preview-video');
  const copyBtn = document.getElementById('image-preview-copy');
  const drawBtn = document.getElementById('image-preview-draw');
  const canvas = document.getElementById('image-annotator-canvas');
  const toolbar = document.getElementById('image-annotator-toolbar');
  if (!modal || !img || !canvas || !toolbar || !drawBtn) return;

  const ctx = canvas.getContext('2d');
  const toolButtons = Array.from(toolbar.querySelectorAll('.image-annotator-tool[data-tool]'));
  const colorInput = document.getElementById('image-annotator-color');
  const widthInput = document.getElementById('image-annotator-width');
  const fontSizeInput = document.getElementById('image-annotator-fontsize');
  const undoBtn = document.getElementById('image-annotator-undo');
  const resetBtn = document.getElementById('image-annotator-reset');
  const cancelBtn = document.getElementById('image-annotator-cancel');
  const saveBtn = document.getElementById('image-annotator-save');
  const confirmModalEl = document.getElementById('confirm-modal');

  const KNOWN_ROUTES = ['/tasks-files/'];
  const DEFAULT_FONT_SIZE = 30;
  const TEXT_OUTLINE_SHADOW = '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff';

  let currentTool = 'brush';
  let ops = [];
  let currentOp = null;
  let pointerDown = false;
  let currentRoute = null;
  let currentSavedName = null;
  let textInputEl = null;
  let textInputPos = null;

  function parseRouteAndSavedName(src) {
    for (const route of KNOWN_ROUTES) {
      const idx = src.indexOf(route);
      if (idx === -1) continue;
      const rest = src.slice(idx + route.length).split('?')[0].split('#')[0];
      if (!rest) continue;
      return { route, savedName: decodeURIComponent(rest) };
    }
    return null;
  }

  function fitImageToScreen() {
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const isAnnotatorOpen = modalBox && modalBox.classList.contains('annotator-open');
    const maxW = Math.max(200, window.innerWidth - 48);
    const maxH = Math.max(200, window.innerHeight - (isAnnotatorOpen ? 120 : 48));

    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const dispW = Math.round(img.naturalWidth * scale);
    const dispH = Math.round(img.naturalHeight * scale);

    img.style.width = dispW + 'px';
    img.style.height = dispH + 'px';
  }

  function setupCanvasSize() {
    fitImageToScreen();
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.style.width = img.clientWidth + 'px';
    canvas.style.height = img.clientHeight + 'px';
  }

  function getScale() {
    const rect = canvas.getBoundingClientRect();
    return { x: canvas.width / rect.width, y: canvas.height / rect.height, rect };
  }

  function getPos(e) {
    const { x: scaleX, y: scaleY, rect } = getScale();
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function drawArrowHead(c, x1, y1, x2, y2, width) {
    const headLen = Math.max(10, width * 4);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    c.moveTo(x2, y2);
    c.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    c.stroke();
  }

  function drawOp(c, op) {
    c.save();
    c.strokeStyle = op.color;
    c.fillStyle = op.color;
    c.lineWidth = op.width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (op.type === 'brush') {
      c.beginPath();
      op.points.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
      c.stroke();
    } else if (op.type === 'rect') {
      c.strokeRect(Math.min(op.x1, op.x2), Math.min(op.y1, op.y2), Math.abs(op.x2 - op.x1), Math.abs(op.y2 - op.y1));
    } else if (op.type === 'arrow') {
      c.beginPath();
      c.moveTo(op.x1, op.y1);
      c.lineTo(op.x2, op.y2);
      c.stroke();
      drawArrowHead(c, op.x1, op.y1, op.x2, op.y2, op.width);
    } else if (op.type === 'text') {
      c.font = op.fontSize + 'px sans-serif';
      c.textBaseline = 'top';
      c.lineJoin = 'round';
      c.lineWidth = Math.max(2, op.fontSize / 10);
      c.strokeStyle = '#fff';
      c.fillStyle = '#000';
      c.strokeText(op.text, op.x, op.y);
      c.fillText(op.text, op.x, op.y);
    }
    c.restore();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ops.forEach(op => drawOp(ctx, op));
    if (currentOp) drawOp(ctx, currentOp);
  }

  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function hitTest(op, pos) {
    const tol = Math.max(6, (op.width || 1) * 2);
    if (op.type === 'brush') {
      for (let i = 1; i < op.points.length; i++) {
        if (distToSegment(pos, op.points[i - 1], op.points[i]) <= tol) return true;
      }
      return op.points.length === 1 && Math.hypot(pos.x - op.points[0].x, pos.y - op.points[0].y) <= tol;
    }
    if (op.type === 'rect') {
      const x1 = Math.min(op.x1, op.x2), x2 = Math.max(op.x1, op.x2);
      const y1 = Math.min(op.y1, op.y2), y2 = Math.max(op.y1, op.y2);
      const edges = [
        [{ x: x1, y: y1 }, { x: x2, y: y1 }],
        [{ x: x2, y: y1 }, { x: x2, y: y2 }],
        [{ x: x2, y: y2 }, { x: x1, y: y2 }],
        [{ x: x1, y: y2 }, { x: x1, y: y1 }],
      ];
      return edges.some(([a, b]) => distToSegment(pos, a, b) <= tol);
    }
    if (op.type === 'arrow') {
      return distToSegment(pos, { x: op.x1, y: op.y1 }, { x: op.x2, y: op.y2 }) <= tol;
    }
    if (op.type === 'text') {
      ctx.save();
      ctx.font = op.fontSize + 'px sans-serif';
      const w = ctx.measureText(op.text).width;
      ctx.restore();
      return pos.x >= op.x && pos.x <= op.x + w && pos.y >= op.y && pos.y <= op.y + op.fontSize * 1.3;
    }
    return false;
  }

  function eraseAt(pos) {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (hitTest(ops[i], pos)) {
        ops.splice(i, 1);
        redraw();
        return;
      }
    }
  }

  function commitTextInput() {
    if (!textInputEl) return;
    const input = textInputEl;
    const pos = textInputPos;
    const text = input.value;
    if (input.parentNode) input.parentNode.removeChild(input);
    textInputEl = null;
    textInputPos = null;
    if (text && text.trim()) {
      const screenFontSize = Number(input.dataset.fontSize) || DEFAULT_FONT_SIZE;
      const imageFontSize = screenFontSize * getScale().y;
      ops.push({ type: 'text', fontSize: imageFontSize, x: pos.x, y: pos.y, text });
      redraw();
    }
  }

  function discardTextInput() {
    if (!textInputEl) return;
    if (textInputEl.parentNode) textInputEl.parentNode.removeChild(textInputEl);
    textInputEl = null;
    textInputPos = null;
  }

  function openTextInput(pos, clientX, clientY) {
    const fontSize = Number(fontSizeInput.value) || DEFAULT_FONT_SIZE;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'image-annotator-text-input';
    input.dataset.fontSize = String(fontSize);
    input.style.left = clientX + 'px';
    input.style.top = clientY + 'px';
    input.style.fontSize = fontSize + 'px';
    input.style.lineHeight = fontSize + 'px';
    input.style.height = Math.round(fontSize * 1.5) + 'px';
    input.style.color = '#000';
    input.style.textShadow = TEXT_OUTLINE_SHADOW;
    document.body.appendChild(input);
    textInputEl = input;
    textInputPos = pos;
    input.focus();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitTextInput(); }
      else if (e.key === 'Escape') { e.preventDefault(); discardTextInput(); }
    });
    input.addEventListener('blur', () => commitTextInput());
  }

  function setTool(tool) {
    currentTool = tool;
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.style.cursor = tool === 'eraser' ? 'not-allowed' : 'crosshair';
  }
  toolButtons.forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));

  img.addEventListener('mousedown', (e) => e.preventDefault());
  img.addEventListener('dragstart', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pos = getPos(e);
    if (currentTool === 'eraser') {
      pointerDown = true;
      eraseAt(pos);
      return;
    }
    if (currentTool === 'text') {
      if (textInputEl) commitTextInput();
      e.preventDefault();
      openTextInput(pos, e.clientX, e.clientY);
      return;
    }
    pointerDown = true;
    const color = colorInput.value;
    const width = Number(widthInput.value) || 1;
    if (currentTool === 'brush') currentOp = { type: 'brush', color, width, points: [pos] };
    else currentOp = { type: currentTool, color, width, x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!pointerDown) return;
    const pos = getPos(e);
    if (currentTool === 'eraser') { eraseAt(pos); return; }
    if (!currentOp) return;
    if (currentOp.type === 'brush') currentOp.points.push(pos);
    else { currentOp.x2 = pos.x; currentOp.y2 = pos.y; }
    redraw();
  });

  window.addEventListener('mouseup', () => {
    if (!pointerDown) return;
    pointerDown = false;
    if (!currentOp) return;
    const degenerate = currentOp.type === 'brush'
      ? currentOp.points.length < 2
      : currentOp.x1 === currentOp.x2 && currentOp.y1 === currentOp.y2;
    if (!degenerate) ops.push(currentOp);
    currentOp = null;
    redraw();
  });

  function undoLast() {
    if (!ops.length) return;
    ops.pop();
    redraw();
  }
  undoBtn.addEventListener('click', undoLast);

  resetBtn.addEventListener('click', async () => {
    if (!ops.length) return;
    const ok = await confirmModal('Сбросить все несохранённые аннотации на этом скрине?');
    if (!ok) return;
    ops = [];
    redraw();
  });

  function enterDrawMode() {
    if (canvas.classList.contains('open')) return;
    const parsed = parseRouteAndSavedName(img.getAttribute('src') || '');
    if (!parsed) {
      alert('Не удалось определить исходный файл вложения — рисование недоступно.');
      return;
    }
    currentRoute = parsed.route;
    currentSavedName = parsed.savedName;
    const start = () => {
      ops = [];
      currentOp = null;
      if (modalBox) modalBox.classList.add('annotator-open');
      setupCanvasSize();
      canvas.classList.add('open');
      toolbar.classList.add('open');
      drawBtn.classList.add('active');
      setTool('brush');
      redraw();
    };
    if (img.complete && img.naturalWidth) start();
    else img.addEventListener('load', start, { once: true });
  }

  function exitDrawMode() {
    ops = [];
    currentOp = null;
    pointerDown = false;
    discardTextInput();
    canvas.classList.remove('open');
    toolbar.classList.remove('open');
    if (modalBox) modalBox.classList.remove('annotator-open');
    drawBtn.classList.remove('active');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    fitImageToScreen();
  }

  drawBtn.addEventListener('click', enterDrawMode);

  cancelBtn.addEventListener('click', async () => {
    if (ops.length) {
      const ok = await confirmModal('Есть несохранённые аннотации на скрине. Выйти без сохранения?');
      if (!ok) return;
    }
    exitDrawMode();
  });

  saveBtn.addEventListener('click', async () => {
    if (!ops.length) { exitDrawMode(); return; }
    saveBtn.disabled = true;
    const prevLabel = saveBtn.textContent;
    saveBtn.textContent = 'Сохранение…';
    try {
      const composite = document.createElement('canvas');
      composite.width = canvas.width;
      composite.height = canvas.height;
      const cctx = composite.getContext('2d');
      cctx.drawImage(img, 0, 0, composite.width, composite.height);
      ops.forEach(op => drawOp(cctx, op));
      const dataURL = composite.toDataURL('image/png');
      const res = await fetch('/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: currentRoute, savedName: currentSavedName, dataURL }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((result && result.error) || 'Не удалось сохранить');
      bustCache(currentRoute, currentSavedName);
      exitDrawMode();
    } catch (e) {
      alert('Ошибка сохранения аннотаций: ' + e.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = prevLabel;
    }
  });

  function bustCache(route, savedName) {
    const v = Date.now();
    const suffix = route + savedName;
    document.querySelectorAll('img').forEach((im) => {
      const src = im.getAttribute('src') || '';
      if (src.indexOf(suffix) === -1) return;
      im.setAttribute('src', src.split('?')[0] + '?v=' + v);
    });
  }

  function confirmModal(text) {
    if (window.Amogus && typeof window.Amogus.confirmModal === 'function') {
      return window.Amogus.confirmModal(text);
    }
    return Promise.resolve(confirm(text));
  }

  async function guardedClose(e) {
    if (!canvas.classList.contains('open')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (ops.length) {
      const ok = await confirmModal('Есть несохранённые аннотации на скрине. Закрыть без сохранения?');
      if (!ok) return;
    }
    exitDrawMode();
    modal.classList.remove('open');
    img.src = '';
  }

  document.addEventListener('click', (e) => {
    if (!canvas.classList.contains('open')) return;
    if (e.target !== modal) return;
    guardedClose(e);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target === textInputEl) return;
    if (confirmModalEl && confirmModalEl.classList.contains('open')) return;
    guardedClose(e);
  }, true);

  window.addEventListener('resize', () => {
    fitImageToScreen();
    if (canvas.classList.contains('open')) setupCanvasSize();
  });

  // Перелистывание вложений
  let previewList = [];
  let previewIdx = -1;

  function showPreviewItem(p) {
    if (!p) return;
    const isVideo = p.type === 'video';
    if (video) {
      video.pause();
      if (isVideo) {
        video.src = p.src;
      } else {
        video.removeAttribute('src');
        video.load();
      }
      video.style.display = isVideo ? '' : 'none';
    }
    img.style.display = isVideo ? 'none' : '';
    if (!isVideo) {
      const updateSize = () => {
        fitImageToScreen();
        if (canvas.classList.contains('open')) setupCanvasSize();
      };
      img.onload = updateSize;
      img.src = p.src;
      img.alt = p.alt || '';
      if (img.complete && img.naturalWidth) updateSize();
    } else {
      img.src = '';
      img.alt = '';
    }
    drawBtn.style.display = isVideo ? 'none' : '';
    if (copyBtn) copyBtn.style.display = isVideo ? 'none' : '';
  }

  function stepPreview(delta) {
    if (previewList.length <= 1) return;
    previewIdx = (previewIdx + delta + previewList.length) % previewList.length;
    showPreviewItem(previewList[previewIdx]);
  }

  window.Amogus = window.Amogus || {};
  window.Amogus.setPreviewList = function (list, idx) {
    previewList = Array.isArray(list) ? list : [];
    previewIdx = typeof idx === 'number' ? idx : -1;
  };
  window.Amogus.showPreviewItem = showPreviewItem;

  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('open')) return;
    if (canvas.classList.contains('open')) return;
    if (isTypingTarget()) return;
    if (video && video.style.display !== 'none') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepPreview(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepPreview(1); }
  });

  // Копирование в буфер обмена
  function flashCopied() {
    if (!copyBtn) return;
    const prevTitle = copyBtn.title;
    copyBtn.title = 'Скопировано!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.title = prevTitle;
      copyBtn.classList.remove('copied');
    }, 1500);
  }

  function imageSrcToPngBlob(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = im.naturalWidth || im.width;
        canvas.height = im.naturalHeight || im.height;
        if (!canvas.width || !canvas.height) { reject(new Error('нулевой размер изображения')); return; }
        canvas.getContext('2d').drawImage(im, 0, 0);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob вернул null')), 'image/png');
      };
      im.onerror = () => reject(new Error('не удалось загрузить изображение'));
      im.src = src;
    });
  }

  async function copyPreviewImage() {
    const src = img.getAttribute('src');
    if (!src) return;
    try {
      const pngBlob = await imageSrcToPngBlob(src);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      flashCopied();
    } catch (e) {
      alert('Не удалось скопировать изображение в буфер обмена: ' + e.message);
    }
  }

  if (copyBtn) copyBtn.addEventListener('click', copyPreviewImage);

  function isTypingTarget() {
    const active = document.activeElement;
    return !!(active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable));
  }

  const TOOL_HOTKEY_CODES = { KeyL: 'brush', KeyA: 'arrow', KeyS: 'rect', KeyT: 'text', KeyE: 'eraser' };
  const TOOL_HOTKEY_KEYS = {
    l: 'brush', 'д': 'brush',
    a: 'arrow', 'ф': 'arrow',
    s: 'rect', 'ы': 'rect',
    t: 'text', 'е': 'text',
    e: 'eraser', 'у': 'eraser',
  };
  document.addEventListener('keydown', (e) => {
    if (!canvas.classList.contains('open')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget()) return;
    const tool = TOOL_HOTKEY_CODES[e.code] || TOOL_HOTKEY_KEYS[e.key.toLowerCase()];
    if (!tool) return;
    e.preventDefault();
    setTool(tool);
  });

  document.addEventListener('keydown', (e) => {
    if (!canvas.classList.contains('open')) return;
    if (e.code !== 'KeyZ') return;
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    if (isTypingTarget()) return;
    e.preventDefault();
    undoLast();
  });

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'image-annotator-tooltip';
  document.body.appendChild(tooltipEl);
  let tooltipTimer = null;

  function hideTooltip() {
    clearTimeout(tooltipTimer);
    tooltipTimer = null;
    tooltipEl.classList.remove('open');
  }

  toolbar.querySelectorAll('[data-tooltip]').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      clearTimeout(tooltipTimer);
      tooltipTimer = setTimeout(() => {
        const rect = el.getBoundingClientRect();
        tooltipEl.textContent = el.dataset.tooltip;
        tooltipEl.style.left = (rect.left + rect.width / 2) + 'px';
        tooltipEl.style.top = (rect.bottom + 6) + 'px';
        tooltipEl.classList.add('open');
      }, 600);
    });
    el.addEventListener('mouseleave', hideTooltip);
    el.addEventListener('click', hideTooltip);
  });
})();
