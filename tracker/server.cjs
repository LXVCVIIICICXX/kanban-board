const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');

const config = require('./config.js');

const PORT = Number(process.env.TRACKER_PORT) || config.TRACKER_PORT || 5000;
const APP_PORT = config.APP_PORT || null;

// Настройка директорий
const TASKS_DIR = path.resolve(__dirname, '../.agents/tasks');
const TASKS_FILES_DIR = path.join(TASKS_DIR, config.ATTACHMENTS_FOLDER || 'Файлы');
const TASKS_FOLDERS = config.TASK_FOLDERS || ['Backlog', 'To do', 'Done'];

// Убедимся, что папки существуют
[TASKS_DIR, TASKS_FILES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
TASKS_FOLDERS.forEach(folder => {
  const dir = path.join(TASKS_DIR, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let appProcess = null;

// ===== SSE: live-обновление Kanban-доски =====
const sseClients = new Set();

function broadcastTasksChanged() {
  const payload = 'event: tasks-changed\ndata: {}\n\n';
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

let watchDebounceTimer = null;
function scheduleTasksBroadcast() {
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
  watchDebounceTimer = setTimeout(broadcastTasksChanged, 150);
}

function startWatchingTasks() {
  TASKS_FOLDERS.forEach(folder => {
    const dir = path.join(TASKS_DIR, folder);
    try {
      fs.watch(dir, () => scheduleTasksBroadcast());
    } catch (e) {
      console.error('Не удалось начать наблюдение за', dir, ':', e.message);
    }
  });
}

// Хелпер для JSON ответов
function jsonResp(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Чтение тела запроса
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

// Парсинг multipart/form-data
async function parseMultipart(buf, boundary) {
  const files = [];
  const fields = {};
  const bnd = Buffer.from('--' + boundary);
  let pos = 0;

  while (pos < buf.length) {
    const start = buf.indexOf(bnd, pos);
    if (start === -1) break;

    const next = buf.indexOf(bnd, start + bnd.length);
    if (next === -1) break;

    const part = buf.slice(start + bnd.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { pos = next; continue; }

    const header = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4, part.length - 2);

    const nameMatch = header.match(/name="([^"]+)"/);
    const fileMatch = header.match(/filename="([^"]+)"/);

    if (nameMatch) {
      if (fileMatch) {
        const origExt = path.extname(fileMatch[1]) || '';
        const safeName = crypto.randomBytes(8).toString('hex') + origExt;
        files.push({ field: nameMatch[1], originalName: fileMatch[1], savedName: safeName, data: body });
      } else {
        fields[nameMatch[1]] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

// Парсинг .md файла задачи с извлечением метаданных
function parseTaskFile(content) {
  const lines = content.split('\n');
  let title = '';
  let bodyStart = 0;
  if (lines.length > 0 && /^#\s+/.test(lines[0])) {
    title = lines[0].replace(/^#\s+/, '').trim();
    bodyStart = 1;
  }
  let id = '';
  let assignee = '';
  let dependencies = [];

  let idx = bodyStart;
  while (idx < lines.length) {
    const line = lines[idx].trim();
    if (!line.startsWith('<!--') || !line.endsWith('-->')) {
      break;
    }
    const inner = line.slice(4, -3).trim();
    const idMatch = inner.match(/^id:\s*([a-z0-9]+)$/i);
    const assMatch = inner.match(/^assignee:\s*(.+)$/i);
    const depMatch = inner.match(/^dependencies:\s*(.+)$/i);
    
    if (idMatch) {
      id = idMatch[1];
    } else if (assMatch) {
      assignee = assMatch[1].trim();
    } else if (depMatch) {
      dependencies = depMatch[1].split(',').map(d => d.trim()).filter(Boolean);
    }
    bodyStart = idx + 1;
    idx++;
  }

  const body = lines.slice(bodyStart).join('\n').replace(/^\n+/, '');
  return { title, id, assignee, dependencies, body };
}

function taskHeader(title, id, assignee, dependencies) {
  let header = '# ' + title + '\n';
  if (id) header += '<!-- id: ' + id + ' -->\n';
  if (assignee) header += '<!-- assignee: ' + assignee + ' -->\n';
  if (dependencies && dependencies.length) {
    header += '<!-- dependencies: ' + dependencies.join(', ') + ' -->\n';
  }
  header += '\n';
  return header;
}

function parseTaskSections(body) {
  const sections = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let match;
  const heads = [];
  while ((match = re.exec(body))) heads.push({ name: match[1], index: match.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].end;
    const stop = i + 1 < heads.length ? heads[i + 1].index : body.length;
    sections.push({ name: heads[i].name, content: body.slice(start, stop).replace(/^\n+/, '').replace(/\n+$/, '') });
  }
  return sections;
}

function sectionsToBody(sections) {
  return sections.map(s => '## ' + s.name + '\n' + (s.content || '...') + '\n').join('\n').replace(/\n+$/, '\n');
}

function getSectionContent(sections, name) {
  const s = sections.find(x => x.name === name);
  return s ? s.content : '';
}

function setSectionContent(sections, name, content, insertAfter) {
  const existing = sections.find(x => x.name === name);
  if (existing) { existing.content = content; return; }
  const afterIdx = insertAfter ? sections.findIndex(x => x.name === insertAfter) : -1;
  const entry = { name, content };
  if (afterIdx >= 0) sections.splice(afterIdx + 1, 0, entry);
  else sections.push(entry);
}

function removeSection(sections, name) {
  const i = sections.findIndex(x => x.name === name);
  if (i >= 0) sections.splice(i, 1);
}

function parseSubtasks(content) {
  const lines = String(content || '').split('\n');
  const items = [];
  lines.forEach(line => {
    const m = line.match(/^-\s*\[([ xX])\]\s*(.*)$/);
    if (m) items.push({ text: m[2].trim(), done: m[1].toLowerCase() === 'x' });
  });
  return items;
}

function subtasksToContent(items) {
  if (!items.length) return '- [ ] ...';
  return items.map(it => '- [' + (it.done ? 'x' : ' ') + '] ' + it.text).join('\n');
}

function mergeSubtasks(existingItems, newTexts) {
  const pool = existingItems.slice();
  return newTexts.map(text => {
    const idx = pool.findIndex(it => it.text === text);
    if (idx >= 0) { const it = pool[idx]; pool.splice(idx, 1); return { text, done: it.done }; }
    return { text, done: false };
  });
}

function parseAttachments(content) {
  const lines = String(content || '').split('\n');
  const items = [];
  lines.forEach(line => {
    const m = line.match(/^-\s*\[(.*?)\]\(\.\.\/Файлы\/(.*?)\)\s*$/);
    if (m) items.push({ originalName: m[1], savedName: m[2] });
  });
  return items;
}

function attachmentsToContent(items) {
  if (!items.length) return '';
  return items.map(a => '- [' + a.originalName + '](../' + (config.ATTACHMENTS_FOLDER || 'Файлы') + '/' + a.savedName + ')').join('\n');
}

// Загрузка всех задач для Kanban-доски
function getAllTasks() {
  const tasks = [];
  TASKS_FOLDERS.forEach(folder => {
    const dir = path.join(TASKS_DIR, folder);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      if (!f.endsWith('.md')) return;
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch (e) { return; }
      if (!stat.isFile()) return;
      const slug = f.slice(0, -3);
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch (e) { return; }
      const { title, id, assignee, dependencies } = parseTaskFile(content);
      tasks.push({ slug, folder, title: title || slug, id, assignee, dependencies, mtime: stat.mtimeMs });
    });
  });
  return tasks;
}

// Транслитерация для слаг-файла
const TASK_TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(title) {
  const transliterated = String(title || '').toLowerCase().split('').map(
    ch => (ch in TASK_TRANSLIT ? TASK_TRANSLIT[ch] : ch)
  ).join('');
  const slug = transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
}

function uniqueTaskSlug(baseSlug) {
  const firstFolder = TASKS_FOLDERS[0] || 'Backlog';
  const dir = path.join(TASKS_DIR, firstFolder);
  let slug = baseSlug;
  let n = 2;
  while (fs.existsSync(path.join(dir, slug + '.md'))) {
    slug = baseSlug + '-' + n;
    n += 1;
  }
  return slug;
}

function findTaskBySlug(slug) {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) return null;
  for (const folder of TASKS_FOLDERS) {
    const full = path.join(TASKS_DIR, folder, slug + '.md');
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return { folder, full };
    }
  }
  return null;
}

function generateTaskId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function collectExistingTaskIds() {
  const ids = new Set();
  TASKS_FOLDERS.forEach(folder => {
    const dir = path.join(TASKS_DIR, folder);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      if (!f.endsWith('.md')) return;
      try {
        const { id } = parseTaskFile(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (id) ids.add(id);
      } catch (e) {}
    });
  });
  return ids;
}

function uniqueTaskId() {
  const existing = collectExistingTaskIds();
  let id = generateTaskId();
  while (existing.has(id)) id = generateTaskId();
  return id;
}

function isAppPortActive() {
  if (!APP_PORT) return Promise.resolve(false);
  return new Promise((resolve) => {
    const net = require('net');
    const checkPort = (host) => {
      return new Promise((res) => {
        const client = new net.Socket();
        client.setTimeout(150);
        client.once('connect', () => {
          client.destroy();
          res(true);
        });
        client.once('error', () => {
          res(false);
        });
        client.once('timeout', () => {
          client.destroy();
          res(false);
        });
        client.connect(APP_PORT, host);
      });
    };
    checkPort('127.0.0.1').then(active => {
      if (active) return resolve(true);
      checkPort('::1').then(resolve);
    });
  });
}

// Роутинг статических файлов трекера
function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('File not found');
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// Обработчик запросов
async function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;
  const p = url.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ===== GET =====
  if (method === 'GET') {
    // SSE-поток live-обновлений доски
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write('retry: 3000\n\n');
      res.write(': connected\n\n');
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (e) {}
      }, 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }

    // Получить конфигурацию
    if (p === '/api/config') {
      return jsonResp(res, 200, {
        projectName: config.PROJECT_NAME || 'Project',
        port: PORT,
        folders: TASKS_FOLDERS,
        assignees: config.ASSIGNEES || ['Gemini', 'Claude', 'Human'],
        appPort: APP_PORT
      });
    }

    // Список задач
    if (p === '/api/tasks') {
      return jsonResp(res, 200, getAllTasks());
    }

    // Детали конкретной задачи
    const taskMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const slug = decodeURIComponent(taskMatch[1]);
      const found = findTaskBySlug(slug);
      if (!found) return jsonResp(res, 404, { error: 'Not found' });
      let content = '';
      try {
        content = fs.readFileSync(found.full, 'utf8');
      } catch (e) {
        return jsonResp(res, 500, { error: 'Read error' });
      }
      const { title, id, assignee, dependencies, body } = parseTaskFile(content);
      const sections = parseTaskSections(body);
      const goal = getSectionContent(sections, 'Контекст / Цель');
      const subtasks = parseSubtasks(getSectionContent(sections, 'Подзадачи'));
      const attachments = parseAttachments(getSectionContent(sections, 'Вложения'));
      const extraSections = sections.filter(s => !['Контекст / Цель', 'Подзадачи', 'Вложения'].includes(s.name));
      return jsonResp(res, 200, {
        slug, folder: found.folder, title: title || slug, id, assignee, dependencies, body,
        goal, subtasks, attachments, extraSections,
      });
    }

    // Статус внешнего приложения
    if (p === '/api/game/status') {
      const active = await isAppPortActive();
      return jsonResp(res, 200, { running: active, port: APP_PORT });
    }

    // Раздача файлов задач
    const fileMatch = p.match(/^\/tasks-files\/(.+)$/);
    if (fileMatch) {
      const name = path.basename(decodeURIComponent(fileMatch[1]));
      return serveStaticFile(res, path.join(TASKS_FILES_DIR, name));
    }

    // Статические файлы трекера
    let fileToServe = path.join(__dirname, p === '/' ? 'index.html' : p);
    if (fs.existsSync(fileToServe) && fs.statSync(fileToServe).isFile()) {
      return serveStaticFile(res, fileToServe);
    }

    res.writeHead(404);
    return res.end('Not found');
  }

  // ===== POST =====
  if (method === 'POST') {
    // Создание задачи
    if (p === '/api/tasks') {
      const buf = await readBody(req);
      let data;
      try {
        data = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        return jsonResp(res, 400, { error: 'Invalid JSON' });
      }
      const title = String(data.title || '').trim();
      if (!title) return jsonResp(res, 400, { error: 'Title is required' });
      const goal = String(data.goal || '').trim();
      const subtasks = Array.isArray(data.subtasks) ? data.subtasks.filter(s => String(s || '').trim()) : [];
      const attachments = Array.isArray(data.attachments)
        ? data.attachments.filter(a => a && a.originalName && a.savedName).map(a => ({ originalName: String(a.originalName), savedName: String(a.savedName) }))
        : [];
      const assignee = String(data.assignee || '').trim();
      const dependencies = Array.isArray(data.dependencies)
        ? data.dependencies.map(d => String(d).trim()).filter(Boolean)
        : [];
      const slug = uniqueTaskSlug(slugify(title));
      const firstFolder = TASKS_FOLDERS[0] || 'Backlog';
      const dir = path.join(TASKS_DIR, firstFolder);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const subtasksMd = subtasks.length
        ? subtasks.map(s => '- [ ] ' + String(s).trim()).join('\n')
        : '- [ ] ...';
      const attachmentsSection = attachments.length ? '## Вложения\n' + attachmentsToContent(attachments) + '\n\n' : '';
      const id = uniqueTaskId();
      const content = taskHeader(title, id, assignee, dependencies)
        + '## Контекст / Цель\n' + (goal || '...') + '\n\n'
        + '## Подзадачи\n' + subtasksMd + '\n\n'
        + attachmentsSection
        + '## Критерии готовности\n- ...\n\n'
        + '## Заметки\n(пока пусто)\n\n'
        + '## Итог\n(заполняется при переносе в Done)\n';
      fs.writeFileSync(path.join(dir, slug + '.md'), content, 'utf8');
      return jsonResp(res, 201, { slug, folder: firstFolder, title, id, assignee, dependencies, goal, subtasks: subtasks.map(s => ({ text: s, done: false })), attachments });
    }

    // Загрузка вложений
    if (p === '/api/tasks/upload') {
      const ct = req.headers['content-type'] || '';
      const bMatch = ct.match(/boundary=(.+)/);
      if (!bMatch) return jsonResp(res, 400, { error: 'No boundary' });
      const buf = await readBody(req);
      const { files } = await parseMultipart(buf, bMatch[1]);
      const saved = [];
      for (const f of files) {
        fs.writeFileSync(path.join(TASKS_FILES_DIR, f.savedName), f.data);
        saved.push({ originalName: f.originalName, savedName: f.savedName });
      }
      return jsonResp(res, 200, saved);
    }

    // Запуск внешнего приложения
    if (p === '/api/game/start') {
      if (!config.APP_START_CMD) {
        return jsonResp(res, 400, { error: 'App start command not configured' });
      }
      const active = await isAppPortActive();
      if (active) {
        return jsonResp(res, 200, { message: 'Already running', port: APP_PORT });
      }
      try {
        const parts = config.APP_START_CMD.split(' ');
        const cmd = parts[0];
        const args = parts.slice(1);
        appProcess = child_process.spawn(cmd, args, {
          cwd: path.resolve(__dirname, '..'),
          detached: true,
          stdio: 'ignore'
        });
        appProcess.unref();
        return jsonResp(res, 200, { message: 'Started', port: APP_PORT });
      } catch (e) {
        return jsonResp(res, 500, { error: 'Failed to start: ' + e.message });
      }
    }

    // Останов внешнего приложения
    if (p === '/api/game/stop') {
      if (appProcess) {
        try {
          process.kill(-appProcess.pid);
        } catch (e) {}
          appProcess = null;
      }
      if (config.APP_STOP_CMD) {
        try {
          child_process.execSync(config.APP_STOP_CMD);
        } catch (e) {}
      } else if (APP_PORT) {
        try {
          child_process.execSync(`kill -9 $(lsof -t -i:${APP_PORT}) 2>/dev/null || true`);
        } catch (e) {}
      }
      return jsonResp(res, 200, { message: 'Stopped' });
    }

    res.writeHead(404);
    return res.end('Not found');
  }

  // ===== PUT =====
  if (method === 'PUT') {
    // Сохранение задачи
    const taskEditMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskEditMatch) {
      const slug = decodeURIComponent(taskEditMatch[1]);
      const buf = await readBody(req);
      let data;
      try {
        data = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        return jsonResp(res, 400, { error: 'Invalid JSON' });
      }
      const found = findTaskBySlug(slug);
      if (!found) return jsonResp(res, 404, { error: 'Not found' });
      const title = String(data.title || '').trim();
      if (!title) return jsonResp(res, 400, { error: 'Title is required' });
      let content = '';
      try {
        content = fs.readFileSync(found.full, 'utf8');
      } catch (e) {
        return jsonResp(res, 500, { error: 'Read error' });
      }
      const parsed = parseTaskFile(content);
      const id = parsed.id;
      const body = parsed.body;
      const finalAssignee = data.assignee !== undefined ? String(data.assignee || '').trim() : parsed.assignee;
      const finalDeps = Array.isArray(data.dependencies) 
        ? data.dependencies.map(d => String(d).trim()).filter(Boolean)
        : parsed.dependencies;

      const sections = parseTaskSections(body);
      const existingSubtasks = parseSubtasks(getSectionContent(sections, 'Подзадачи'));
      const newSubtaskTexts = Array.isArray(data.subtasks) ? data.subtasks.map(s => String(s || '').trim()).filter(Boolean) : [];
      const mergedSubtasks = mergeSubtasks(existingSubtasks, newSubtaskTexts);
      const attachments = Array.isArray(data.attachments)
        ? data.attachments.filter(a => a && a.originalName && a.savedName).map(a => ({ originalName: String(a.originalName), savedName: String(a.savedName) }))
        : parseAttachments(getSectionContent(sections, 'Вложения'));

      setSectionContent(sections, 'Контекст / Цель', String(data.goal || '').trim() || '...');
      setSectionContent(sections, 'Подзадачи', subtasksToContent(mergedSubtasks), 'Контекст / Цель');
      if (attachments.length) {
        setSectionContent(sections, 'Вложения', attachmentsToContent(attachments), 'Подзадачи');
      } else {
        removeSection(sections, 'Вложения');
      }

      const newContent = taskHeader(title, id, finalAssignee, finalDeps) + sectionsToBody(sections);
      fs.writeFileSync(found.full, newContent, 'utf8');
      return jsonResp(res, 200, {
        slug, folder: found.folder, title, id, assignee: finalAssignee, dependencies: finalDeps,
        goal: getSectionContent(sections, 'Контекст / Цель'),
        subtasks: mergedSubtasks, attachments,
        extraSections: sections.filter(s => !['Контекст / Цель', 'Подзадачи', 'Вложения'].includes(s.name)),
      });
    }

    // Перемещение задачи (Kanban drag&drop)
    const taskMoveMatch = p.match(/^\/api\/tasks\/([^/]+)\/move$/);
    if (taskMoveMatch) {
      const slug = decodeURIComponent(taskMoveMatch[1]);
      const buf = await readBody(req);
      let data;
      try {
        data = JSON.parse(buf.toString('utf8'));
      } catch (e) {
        return jsonResp(res, 400, { error: 'Invalid JSON' });
      }
      const targetFolder = data.folder;
      if (!TASKS_FOLDERS.includes(targetFolder)) return jsonResp(res, 400, { error: 'Invalid folder' });
      const found = findTaskBySlug(slug);
      if (!found) return jsonResp(res, 404, { error: 'Not found' });
      const targetDir = path.join(TASKS_DIR, targetFolder);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, slug + '.md');
      if (found.folder !== targetFolder) fs.renameSync(found.full, targetPath);
      return jsonResp(res, 200, { slug, folder: targetFolder });
    }

    res.writeHead(404);
    return res.end('Not found');
  }

  res.writeHead(404);
  return res.end('Not found');
}

// Запуск HTTP сервера
const server = http.createServer((req, res) => {
  requestHandler(req, res).catch(err => {
    console.error('Unhandled request error:', err);
    try {
      jsonResp(res, 500, { error: 'Internal server error: ' + err.message });
    } catch (e) {}
  });
});

server.listen(PORT, () => {
  console.log(`Task Tracker is running at http://localhost:${PORT}`);
  console.log(`Tasks are saved in: ${TASKS_DIR}`);
  startWatchingTasks();
  console.log('Live-обновление доски (SSE) активно: слежу за', TASKS_DIR);
});
