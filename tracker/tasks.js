// Вкладка «Задачи»: kanban-доска по реальным план-файлам .agents/tasks/*
(function () {
  const root = document.getElementById('tab-tasks');
  if (!root) return;

  const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
  const VIDEO_EXT = /\.(mp4|webm|ogg|mov|mkv|avi|m4v)$/i;
  
  let tasks = [];
  let FOLDERS = [];
  let ASSIGNEES = [];
  let APP_PORT = null;
  let draggedSlug = null;
  let currentTask = null; // { slug, folder, title, goal, subtasks, attachments, extraSections }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function bodyId(folder) {
    return 'tasks-body-' + folder.replace(/\s+/g, '-');
  }
  function countId(folder) {
    return 'tasks-count-' + folder.replace(/\s+/g, '-');
  }

  // Загрузка конфигурации
  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const config = await res.json();
      
      FOLDERS = config.folders || ['Backlog', 'To do', 'Done'];
      ASSIGNEES = config.assignees || ['Gemini', 'Claude', 'Human'];
      APP_PORT = config.appPort || null;

      // Обновляем заголовок и логотип
      const pTitle = document.getElementById('page-title');
      if (pTitle) pTitle.textContent = config.projectName + ' — Задачи';
      const logoTitle = document.getElementById('project-logo-title');
      if (logoTitle) logoTitle.textContent = config.projectName + ' — Задачи';

      // Рендерим колонки
      const board = document.getElementById('tasks-board');
      if (board) {
        board.innerHTML = FOLDERS.map(folder => `
          <div class="tasks-column" data-folder="${escHtml(folder)}">
            <div class="tasks-column-header">
              <span class="tasks-column-title">${escHtml(folder)}</span>
              <span class="tasks-column-count" id="${countId(folder)}">0</span>
            </div>
            <div class="tasks-column-body" id="${bodyId(folder)}"></div>
          </div>
        `).join('');
      }

      // Заполняем списки исполнителей
      const createAssignee = document.getElementById('task-create-assignee');
      const editAssignee = document.getElementById('task-edit-assignee');
      const assigneeOptions = `<option value="">(Не назначен)</option>` + 
        ASSIGNEES.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`).join('');
      
      if (createAssignee) createAssignee.innerHTML = assigneeOptions;
      if (editAssignee) editAssignee.innerHTML = assigneeOptions;

      // Показываем/скрываем управление сервером
      const gameControl = document.querySelector('.game-control');
      if (gameControl) {
        if (APP_PORT) {
          gameControl.style.display = 'flex';
          checkGameStatus();
          setInterval(checkGameStatus, 3000);
        } else {
          gameControl.style.display = 'none';
        }
      }

      // Вешаем слушатели drop/dragover на динамические колонки
      FOLDERS.forEach(folder => {
        const body = document.getElementById(bodyId(folder));
        if (!body) return;
        body.addEventListener('dragover', (e) => {
          e.preventDefault();
          body.classList.add('drag-over');
        });
        body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
        body.addEventListener('drop', (e) => {
          e.preventDefault();
          body.classList.remove('drag-over');
          if (draggedSlug) moveTask(draggedSlug, folder);
        });
      });

    } catch (e) {
      console.error('Ошибка загрузки конфигурации:', e);
      // fallback
      FOLDERS = ['Backlog', 'To do', 'Done'];
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/tasks');
      tasks = await res.json();
      if (!Array.isArray(tasks)) tasks = [];
    } catch (e) {
      tasks = [];
    }
    render();
  }

  function render() {
    FOLDERS.forEach(folder => {
      const body = document.getElementById(bodyId(folder));
      const count = document.getElementById(countId(folder));
      if (!body) return;
      body.innerHTML = '';
      
      // Сортировка по дате изменения: новые сверху
      const list = tasks.filter(t => t.folder === folder)
        .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        
      if (count) count.textContent = String(list.length);
      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'tasks-empty';
        empty.textContent = 'Нет задач';
        body.appendChild(empty);
      } else {
        list.forEach(task => body.appendChild(createCard(task)));
      }
    });
  }

  function copyValue(task) {
    return (task && task.id) ? task.id : (task && task.title) || '';
  }

  function copyToClipboard(text, btn) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (window.Amogus && window.Amogus.flashSuccess) {
          window.Amogus.flashSuccess(btn);
        }
      }).catch(() => {});
    }
  }

  // Бейджи исполнителей
  function assigneeClass(assignee) {
    const key = String(assignee || '').trim().toLowerCase();
    if (key === 'claude') return 'task-badge-assignee--claude';
    if (key === 'gemini') return 'task-badge-assignee--gemini';
    if (key === 'both') return 'task-badge-assignee--both';
    if (key === 'human') return 'task-badge-assignee--human';
    return '';
  }

  function isTaskBlocked(task) {
    if (!task.dependencies || !task.dependencies.length) return false;
    for (const depId of task.dependencies) {
      const depTask = tasks.find(t => t.id === depId);
      if (depTask && depTask.folder !== 'Done') {
        return true;
      }
    }
    return false;
  }

  function createCard(task) {
    const card = document.createElement('div');
    card.className = 'task-card';
    card.draggable = true;
    card.dataset.slug = task.slug;

    const isBlocked = isTaskBlocked(task);
    if (isBlocked) card.classList.add('blocked');

    let metaHtml = '<div class="task-card-meta">';
    if (task.assignee) {
      metaHtml += `<span class="task-badge task-badge-assignee ${assigneeClass(task.assignee)}">👤 ${escHtml(task.assignee)}</span>`;
    }
    if (isBlocked) {
      metaHtml += `<span class="task-badge task-badge-blocked">🔒 Блок</span>`;
    } else if (task.dependencies && task.dependencies.length) {
      metaHtml += `<span class="task-badge task-badge-ready">🔓 Ready</span>`;
    }
    metaHtml += '</div>';

    card.innerHTML = `<div class="task-card-title">${escHtml(task.title)}</div>`
      + metaHtml
      + `<button type="button" class="task-card-copy" title="Копировать ID задачи">⧉</button>`;

    const copyBtn = card.querySelector('.task-card-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(copyValue(task), copyBtn);
      });
      copyBtn.addEventListener('dragstart', (e) => e.preventDefault());
    }

    card.addEventListener('dragstart', (e) => {
      draggedSlug = task.slug;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedSlug = null;
    });
    card.addEventListener('click', () => openView(task));

    return card;
  }

  async function moveTask(slug, targetFolder) {
    const task = tasks.find(t => t.slug === slug);
    if (!task || task.folder === targetFolder) return;
    const prevFolder = task.folder;
    task.folder = targetFolder; // оптимистично
    render();
    try {
      const res = await fetch('/api/tasks/' + encodeURIComponent(slug) + '/move', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: targetFolder }),
      });
      if (!res.ok) throw new Error('move failed');
    } catch (e) {
      task.folder = prevFolder; // откат при ошибке
      render();
    }
  }

  // Контроллер dropzone-вложений
  function createAttachmentsController(dropzoneEl, fileInputEl, boxEl, errorEl, modalEl) {
    let list = [];

    function render() {
      boxEl.innerHTML = list.map(a => attachmentHtml(a, true)).join('');
    }

    function showError(msg) {
      if (!errorEl) return;
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }

    async function uploadFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const formData = new FormData();
      files.forEach(f => formData.append('file', f, f.name));
      const res = await fetch('/api/tasks/upload', { method: 'POST', body: formData });
      const saved = await res.json();
      if (!res.ok) throw new Error((saved && saved.error) || 'Ошибка загрузки файла');
      list = list.concat(saved);
      render();
    }

    if (dropzoneEl) {
      dropzoneEl.addEventListener('click', () => fileInputEl.click());
      dropzoneEl.addEventListener('dragover', (e) => { e.preventDefault(); dropzoneEl.classList.add('drag-over'); });
      dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('drag-over'));
      dropzoneEl.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzoneEl.classList.remove('drag-over');
        uploadFiles(e.dataTransfer.files).catch(e2 => showError(e2.message));
      });
    }
    if (fileInputEl) {
      fileInputEl.addEventListener('change', () => {
        uploadFiles(fileInputEl.files).catch(e2 => showError(e2.message));
        fileInputEl.value = '';
      });
    }
    if (boxEl) {
      boxEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.task-attachment-remove');
        if (!btn) return;
        list = list.filter(a => a.savedName !== btn.dataset.saved);
        render();
      });
    }

    if (modalEl) {
      modalEl.addEventListener('paste', (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const imageFiles = [];
        for (const item of items) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) imageFiles.push(file);
          }
        }
        if (imageFiles.length) {
          e.preventDefault();
          uploadFiles(imageFiles).catch(e2 => showError(e2.message));
        }
      });
    }

    return {
      get: () => list,
      set: (items) => { list = (items || []).slice(); render(); },
    };
  }

  function attachmentHtml(a, removable) {
    const url = '/tasks-files/' + encodeURIComponent(a.savedName);
    let preview;
    if (IMG_EXT.test(a.originalName)) {
      preview = `<img class="task-attachment-img" src="${url}" alt="${escHtml(a.originalName)}" data-url="${url}" data-alt="${escHtml(a.originalName)}">`;
    } else if (VIDEO_EXT.test(a.originalName)) {
      preview = `<video class="task-attachment-video" src="${url}#t=0.1" muted preload="metadata" data-url="${url}" data-alt="${escHtml(a.originalName)}" title="Просмотреть видео"></video>`;
    } else {
      preview = `<div class="media-icon" title="${escHtml(a.originalName)}">&#128196;<span style="display:none">${escHtml(a.originalName)}</span></div>`;
    }
    const removeBtn = removable 
      ? `<button type="button" class="media-remove task-attachment-remove" data-saved="${escHtml(a.savedName)}" title="Удалить вложение">✕</button>` 
      : '';
    const wrap = !IMG_EXT.test(a.originalName) && !VIDEO_EXT.test(a.originalName)
      ? `<a href="${url}" target="_blank" style="display: block; width: 100%; height: 100%; text-decoration: none; color: inherit;">${preview}</a>`
      : preview;
    return `<div class="media-thumb task-attachment" data-saved="${escHtml(a.savedName)}">${wrap}${removeBtn}</div>`;
  }

  // --- Предпросмотр изображения-вложения ---
  const imagePreviewModal = document.getElementById('image-preview-modal');
  const imagePreviewImg = document.getElementById('image-preview-img');
  const imagePreviewClose = document.getElementById('image-preview-close');

  function openImagePreview(src, alt) {
    if (!imagePreviewModal) return;
    if (!imagePreviewImg.src || imagePreviewImg.src !== src) {
      imagePreviewImg.src = src;
      imagePreviewImg.alt = alt || '';
    }
    imagePreviewModal.classList.add('open');
  }

  function closeImagePreview() {
    if (imagePreviewModal) imagePreviewModal.classList.remove('open');
    imagePreviewImg.src = '';
    const video = document.getElementById('image-preview-video');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  document.addEventListener('click', (e) => {
    const thumb = e.target.closest('.task-attachment-img, .task-attachment-video');
    if (!thumb) return;
    const container = thumb.closest('.media-grid, .task-view-section-body') || document;
    const items = Array.from(container.querySelectorAll('.task-attachment-img, .task-attachment-video')).map(el => {
      const isVideo = el.classList.contains('task-attachment-video');
      return {
        type: isVideo ? 'video' : 'image',
        src: el.dataset.url,
        alt: el.dataset.alt || ''
      };
    });
    const clickedSrc = thumb.dataset.url;
    const idx = items.findIndex(item => item.src === clickedSrc);
    const targetIdx = idx !== -1 ? idx : 0;

    if (window.Amogus && typeof window.Amogus.setPreviewList === 'function') {
      window.Amogus.setPreviewList(items, targetIdx);
      if (typeof window.Amogus.showPreviewItem === 'function' && items.length > 0) {
        window.Amogus.showPreviewItem(items[targetIdx]);
      }
    }
    openImagePreview(thumb.dataset.url, thumb.dataset.alt);
  });

  if (imagePreviewClose) imagePreviewClose.addEventListener('click', closeImagePreview);
  if (imagePreviewModal) {
    imagePreviewModal.addEventListener('click', (e) => { if (e.target === imagePreviewModal) closeImagePreview(); });
  }

  // --- Модалка просмотра задачи ---
  const viewModal = document.getElementById('task-view-modal');
  const viewTitle = document.getElementById('task-view-title');
  const viewId = document.getElementById('task-view-id');
  const viewCopy = document.getElementById('task-view-copy');
  const viewBody = document.getElementById('task-view-body');
  const viewClose = document.getElementById('task-view-close');
  const viewEditBtn = document.getElementById('task-view-edit');

  window.Amogus.jumpToTask = function(id) {
    const task = tasks.find(t => t.id === id);
    if (task) {
      openView(task);
      const card = document.querySelector(`.task-card[data-slug="${task.slug}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.outline = '2px solid #3b82f6';
        setTimeout(() => card.style.outline = '', 2000);
      }
    } else {
      alert('Задача с ID ' + id + ' не найдена.');
    }
  };

  function renderView(data) {
    if (viewId) viewId.textContent = data.id || '';
    
    // Рендеринг подзадач
    const subtasksHtml = (data.subtasks || []).length
      ? '<ul class="task-view-subtasks">' + data.subtasks.map(s =>
          `<li class="${s.done ? 'done' : ''}"><span>${s.done ? '☑' : '☐'}</span><span>${escHtml(s.text)}</span></li>`
        ).join('') + '</ul>'
      : '<div class="task-view-section-body">(нет подзадач)</div>';

    // Рендеринг вложений
    const attachmentsHtml = (data.attachments || []).length
      ? '<div class="task-attachments">' + data.attachments.map(a => attachmentHtml(a, false)).join('') + '</div>'
      : '';

    // Рендеринг целей и заметок с помощью marked + DOMPurify (если доступны)
    const renderMarkdown = (text) => {
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(text || ''));
      }
      return escHtml(text || '');
    };

    const extraHtml = (data.extraSections || []).map(s =>
      `<div class="task-view-section"><div class="task-view-section-title">${escHtml(s.name)}</div>` +
      `<div class="task-view-section-body">${renderMarkdown(s.content)}</div></div>`
    ).join('');

    let metaDetailsHtml = '';
    if (data.assignee || (data.dependencies && data.dependencies.length)) {
      metaDetailsHtml += '<div class="task-view-meta-panel" style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #475569; background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0;">';
      if (data.assignee) {
        metaDetailsHtml += `<div><strong>Исполнитель:</strong> <span class="task-badge task-badge-assignee ${assigneeClass(data.assignee)}" style="font-size: 11px;">👤 ${escHtml(data.assignee)}</span></div>`;
      }
      if (data.dependencies && data.dependencies.length) {
        const depBadges = data.dependencies.map(d => {
          const t = tasks.find(x => x.id === d);
          const label = t ? `${t.title} (${d})` : d;
          return `<span class="task-badge task-badge-ready" style="cursor: pointer; font-size: 11px; margin-right: 4px;" onclick="window.Amogus.jumpToTask('${d}')" title="Открыть зависимую задачу">🔗 ${escHtml(label)}</span>`;
        }).join(' ');
        metaDetailsHtml += `<div><strong>Зависит от:</strong> ${depBadges}</div>`;
      }
      metaDetailsHtml += '</div>';
    }

    viewBody.innerHTML = metaDetailsHtml + `
      <div class="task-view-section">
        <div class="task-view-section-title">Описание</div>
        <div class="task-view-section-body">${renderMarkdown(data.goal || '')}</div>
      </div>
      <div class="task-view-section">
        <div class="task-view-section-title">Подзадачи</div>
        ${subtasksHtml}
      </div>
      ${attachmentsHtml ? `<div class="task-view-section"><div class="task-view-section-title">Вложения</div>${attachmentsHtml}</div>` : ''}
      ${extraHtml}
    `;
  }

  async function openView(task) {
    viewTitle.textContent = task.title;
    viewBody.innerHTML = 'Загрузка…';
    viewModal.classList.add('open');
    try {
      const res = await fetch('/api/tasks/' + encodeURIComponent(task.slug));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка загрузки');
      currentTask = data;
      renderView(data);
    } catch (e) {
      currentTask = null;
      viewBody.textContent = 'Ошибка загрузки: ' + e.message;
    }
  }

  function closeView() {
    viewModal.classList.remove('open');
  }

  if (viewClose) viewClose.addEventListener('click', closeView);
  if (viewCopy) viewCopy.addEventListener('click', () => { if (currentTask) copyToClipboard(copyValue(currentTask), viewCopy); });
  if (viewEditBtn) viewEditBtn.addEventListener('click', () => { if (currentTask) openEdit(currentTask); });
  if (viewModal) {
    viewModal.addEventListener('click', (e) => { if (e.target === viewModal) closeView(); });
  }

  // --- Модалка создания задачи (всегда в первую колонку) ---
  const createBtn = document.getElementById('task-create-btn');
  const createModal = document.getElementById('task-create-modal');
  const createTitle = document.getElementById('task-create-title');
  const createGoal = document.getElementById('task-create-goal');
  const createSubtasks = document.getElementById('task-create-subtasks');
  const createError = document.getElementById('task-create-error');
  const createCancel = document.getElementById('task-create-cancel');
  const createSave = document.getElementById('task-create-save');
  const createAttachments = createAttachmentsController(
    document.getElementById('task-create-dropzone'),
    document.getElementById('task-create-file-input'),
    document.getElementById('task-create-attachments'),
    createError,
    createModal
  );

  const createAssignee = document.getElementById('task-create-assignee');
  const createDependencies = document.getElementById('task-create-dependencies');

  function openCreate() {
    createTitle.value = '';
    createGoal.value = '';
    createSubtasks.value = '';
    if (createAssignee) createAssignee.value = '';
    if (createDependencies) createDependencies.value = '';
    createAttachments.set([]);
    createError.style.display = 'none';
    createModal.classList.add('open');
    createTitle.focus();
    autoResizeTextarea(createGoal);
    autoResizeTextarea(createSubtasks);
  }

  function hasCreateDirtyData() {
    return !!(
      createTitle.value.trim() ||
      createGoal.value.trim() ||
      createSubtasks.value.trim() ||
      (createAssignee && createAssignee.value) ||
      (createDependencies && createDependencies.value.trim()) ||
      createAttachments.get().length
    );
  }

  function closeCreateForce() {
    createModal.classList.remove('open');
  }

  async function closeCreate() {
    if (hasCreateDirtyData()) {
      const ok = await window.Amogus.confirmModal('Закрыть без сохранения? Введённые данные будут потеряны.');
      if (!ok) return;
    }
    closeCreateForce();
  }

  async function saveCreate() {
    const title = createTitle.value.trim();
    if (!title) {
      createError.textContent = 'Укажите название задачи';
      createError.style.display = 'block';
      createTitle.focus();
      return;
    }
    const subtasks = createSubtasks.value.split('\n').map(s => s.trim()).filter(Boolean);
    const assignee = createAssignee ? createAssignee.value : '';
    const dependencies = createDependencies 
      ? createDependencies.value.split(',').map(d => d.trim()).filter(Boolean)
      : [];

    createSave.disabled = true;
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          title, 
          goal: createGoal.value.trim(), 
          subtasks, 
          attachments: createAttachments.get(),
          assignee,
          dependencies
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка создания');
      closeCreateForce();
      await load();
    } catch (e) {
      createError.textContent = 'Ошибка создания: ' + e.message;
      createError.style.display = 'block';
    } finally {
      createSave.disabled = false;
    }
  }

  if (createBtn) createBtn.addEventListener('click', openCreate);
  if (createCancel) createCancel.addEventListener('click', closeCreate);
  if (createSave) createSave.addEventListener('click', saveCreate);
  if (createModal) {
    createModal.addEventListener('click', (e) => { if (e.target === createModal) closeCreate(); });
  }

  // --- Модалка редактирования ---
  const editModal = document.getElementById('task-edit-modal');
  const editIdEl = document.getElementById('task-edit-id');
  const editCopy = document.getElementById('task-edit-copy');
  const editTitle = document.getElementById('task-edit-title');
  const editGoal = document.getElementById('task-edit-goal');
  const editSubtasks = document.getElementById('task-edit-subtasks');
  const editError = document.getElementById('task-edit-error');
  const editCancel = document.getElementById('task-edit-cancel');
  const editSave = document.getElementById('task-edit-save');
  const editAttachments = createAttachmentsController(
    document.getElementById('task-edit-dropzone'),
    document.getElementById('task-edit-file-input'),
    document.getElementById('task-edit-attachments'),
    editError,
    editModal
  );

  const editAssignee = document.getElementById('task-edit-assignee');
  const editDependencies = document.getElementById('task-edit-dependencies');

  let editSlug = null;
  let editTask = null;
  let editOriginal = null;

  function openEdit(task) {
    editSlug = task.slug;
    editTask = task;
    if (editIdEl) editIdEl.textContent = task.id || '';
    editTitle.value = task.title || '';
    editGoal.value = task.goal || '';
    editSubtasks.value = (task.subtasks || []).map(s => s.text).join('\n');
    if (editAssignee) editAssignee.value = task.assignee || '';
    if (editDependencies) editDependencies.value = (task.dependencies || []).join(', ');
    editAttachments.set(task.attachments || []);
    editError.style.display = 'none';
    editOriginal = {
      title: editTitle.value,
      goal: editGoal.value,
      subtasks: editSubtasks.value,
      assignee: editAssignee ? editAssignee.value : '',
      dependencies: editDependencies ? editDependencies.value : '',
      attachments: editAttachments.get().map(a => a.savedName),
    };
    closeView();
    editModal.classList.add('open');
    editTitle.focus();
    setTimeout(() => {
      autoResizeTextarea(editGoal);
      autoResizeTextarea(editSubtasks);
    }, 0);
  }

  function hasEditDirtyData() {
    if (!editOriginal) return false;
    if (editTitle.value !== editOriginal.title) return true;
    if (editGoal.value !== editOriginal.goal) return true;
    if (editSubtasks.value !== editOriginal.subtasks) return true;
    if (editAssignee && editAssignee.value !== editOriginal.assignee) return true;
    if (editDependencies && editDependencies.value.trim() !== editOriginal.dependencies) return true;
    const currentAttachments = editAttachments.get().map(a => a.savedName);
    if (currentAttachments.length !== editOriginal.attachments.length) return true;
    return currentAttachments.some((saved, i) => saved !== editOriginal.attachments[i]);
  }

  function closeEditForce() {
    editModal.classList.remove('open');
  }

  async function closeEdit() {
    if (hasEditDirtyData()) {
      const ok = await window.Amogus.confirmModal('Закрыть без сохранения? Введённые данные будут потеряны.');
      if (!ok) return;
    }
    closeEditForce();
  }

  async function saveEdit() {
    const title = editTitle.value.trim();
    if (!title) {
      editError.textContent = 'Укажите название задачи';
      editError.style.display = 'block';
      editTitle.focus();
      return;
    }
    const subtasks = editSubtasks.value.split('\n').map(s => s.trim()).filter(Boolean);
    const assignee = editAssignee ? editAssignee.value : '';
    const dependencies = editDependencies 
      ? editDependencies.value.split(',').map(d => d.trim()).filter(Boolean)
      : [];

    editSave.disabled = true;
    try {
      const res = await fetch('/api/tasks/' + encodeURIComponent(editSlug), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          title, 
          goal: editGoal.value.trim(), 
          subtasks, 
          attachments: editAttachments.get(),
          assignee,
          dependencies
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сохранения');
      closeEditForce();
      const task = tasks.find(t => t.slug === editSlug);
      if (task) {
        task.title = data.title;
        task.assignee = data.assignee;
        task.dependencies = data.dependencies;
      }
      render();
      currentTask = data;
      openViewFromData(data);
    } catch (e) {
      editError.textContent = 'Ошибка сохранения: ' + e.message;
      editError.style.display = 'block';
    } finally {
      editSave.disabled = false;
    }
  }

  function openViewFromData(data) {
    viewTitle.textContent = data.title;
    renderView(data);
    viewModal.classList.add('open');
  }

  if (editCancel) editCancel.addEventListener('click', closeEdit);
  if (editCopy) editCopy.addEventListener('click', () => { if (editTask) copyToClipboard(copyValue(editTask), editCopy); });
  if (editSave) editSave.addEventListener('click', saveEdit);
  if (editModal) {
    editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEdit(); });
  }

  // --- Закрытие по Escape ---
  const confirmModalEl = document.getElementById('confirm-modal');
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (confirmModalEl && confirmModalEl.classList.contains('open')) return;
    if (viewModal && viewModal.classList.contains('open')) closeView();
    if (createModal && createModal.classList.contains('open')) { e.stopImmediatePropagation(); closeCreate(); }
    if (editModal && editModal.classList.contains('open')) { e.stopImmediatePropagation(); closeEdit(); }
  });

  // --- Управление сервером разработки проекта ---
  const gameStatusDot = document.getElementById('game-status-dot');
  const gameStatusText = document.getElementById('game-status-text');
  const gameControlBtn = document.getElementById('game-control-btn');

  let isPolling = false;

  async function checkGameStatus() {
    if (isPolling || !APP_PORT) return;
    isPolling = true;
    try {
      const res = await fetch('/api/game/status');
      const data = await res.json();
      updateGameUI(data.running, data.port);
    } catch (e) {
      updateGameUI(false, APP_PORT);
    } finally {
      isPolling = false;
    }
  }

  function updateGameUI(running, port) {
    if (running) {
      gameStatusDot.className = 'game-status-indicator running';
      gameStatusText.innerHTML = `Сервер запущен на <a href="http://localhost:${port}" target="_blank" style="color: #2563eb; text-decoration: underline;">порту ${port}</a>`;
      gameControlBtn.textContent = 'Остановить сервер';
      gameControlBtn.className = 'btn btn-cancel';
      gameControlBtn.onclick = stopGame;
    } else {
      gameStatusDot.className = 'game-status-indicator stopped';
      gameStatusText.textContent = 'Сервер остановлен';
      gameControlBtn.textContent = 'Запустить сервер';
      gameControlBtn.className = 'btn btn-save';
      gameControlBtn.onclick = startGame;
    }
  }

  async function startGame() {
    gameControlBtn.disabled = true;
    gameStatusText.textContent = 'Запуск...';
    try {
      await fetch('/api/game/start', { method: 'POST' });
      setTimeout(checkGameStatus, 1000);
    } catch (e) {
      alert('Ошибка при старте: ' + e.message);
    } finally {
      gameControlBtn.disabled = false;
    }
  }

  async function stopGame() {
    if (!await window.Amogus.confirmModal('Вы уверены, что хотите остановить сервер разработки?')) return;
    gameControlBtn.disabled = true;
    gameStatusText.textContent = 'Остановка...';
    try {
      await fetch('/api/game/stop', { method: 'POST' });
      setTimeout(checkGameStatus, 500);
    } catch (e) {
      alert('Ошибка при останове: ' + e.message);
    } finally {
      gameControlBtn.disabled = false;
    }
  }

  function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  [createGoal, createSubtasks, editGoal, editSubtasks].forEach(textarea => {
    if (textarea) {
      textarea.addEventListener('input', () => autoResizeTextarea(textarea));
    }
  });

  // Инициализация
  async function init() {
    await loadConfig();
    await load();
  }

  init();

  // Live-обновление доски через SSE
  (function subscribeLiveUpdates() {
    if (typeof EventSource === 'undefined') return;
    let reloadTimer = null;
    function scheduleReload() {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 120);
    }
    try {
      const es = new EventSource('/api/events');
      es.addEventListener('tasks-changed', scheduleReload);
    } catch (e) {
      // EventSource недоступен — остаёмся на разовой загрузке
    }
  })();
})();
