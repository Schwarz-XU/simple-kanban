const COLUMNS = ['backlog', 'todo', 'doing', 'done'];

const FILTERS_KEY = 'kanban.filters.v1';
const ACTIVITY_KEY = 'kanban.activity.v1';
const ACTIVITY_MAX = 200;

function nowStamp(){
  const d = new Date();
  const pad = (n)=> String(n).padStart(2,'0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loadActivity(){
  const raw = localStorage.getItem(ACTIVITY_KEY);
  if(!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-ACTIVITY_MAX) : [];
  } catch {
    return [];
  }
}

function saveActivity(lines){
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(lines.slice(-ACTIVITY_MAX)));
}

let ACTIVITY = loadActivity();

function formatAny(x){
  if(x === undefined) return '';
  if(x === null) return 'null';
  if(typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

function addLog(level, ...parts){
  const line = `[${nowStamp()}] ${level.toUpperCase()}: ` + parts.map(formatAny).filter(Boolean).join(' ');
  ACTIVITY.push(line);
  if(ACTIVITY.length > ACTIVITY_MAX) ACTIVITY = ACTIVITY.slice(-ACTIVITY_MAX);
  saveActivity(ACTIVITY);
  renderActivity();
}

function renderActivity(){
  const el = qs('#activityLog');
  if(!el) return;
  el.textContent = ACTIVITY.join('\n');
  // auto-scroll to bottom
  el.scrollTop = el.scrollHeight;
}

function hookConsole(){
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args)=>{ orig.log(...args); addLog('log', ...args); };
  console.warn = (...args)=>{ orig.warn(...args); addLog('warn', ...args); };
  console.error = (...args)=>{ orig.error(...args); addLog('error', ...args); };
}

function loadFilters(){
  const raw = localStorage.getItem(FILTERS_KEY);
  if(!raw){
    return { statuses: {backlog:true, todo:true, doing:true, done:true}, tags: [] };
  }
  try {
    const f = JSON.parse(raw);
    return {
      statuses: {
        backlog: !!f?.statuses?.backlog,
        todo: !!f?.statuses?.todo,
        doing: !!f?.statuses?.doing,
        done: !!f?.statuses?.done,
      },
      tags: Array.isArray(f?.tags) ? f.tags : []
    };
  } catch {
    return { statuses: {backlog:true, todo:true, doing:true, done:true}, tags: [] };
  }
}

function saveFilters(filters){
  localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
}

let FILTERS = loadFilters();

function qs(sel, el=document){ return el.querySelector(sel); }
function qsa(sel, el=document){ return [...el.querySelectorAll(sel)]; }

function toast(msg){
  const t = qs('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>{ t.hidden = true; }, 2200);
  addLog('ui', msg);
}

async function api(path, opts={}){
  const method = (opts.method || 'GET').toUpperCase();
  addLog('net', `${method} ${path}`);
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok){
    addLog('error', `${method} ${path} -> HTTP ${res.status}`, data.error || data);
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function getBoardId(){
  const v = localStorage.getItem('kanban.boardId');
  return v ? parseInt(v, 10) : null;
}

function setBoardId(id){
  localStorage.setItem('kanban.boardId', String(id));
}

function reconcileSelectedTags(availableTags){
  const available = new Set((availableTags || []).map(t => t.name));
  const before = FILTERS.tags || [];
  const after = before.filter(t => available.has(t));
  if(after.length !== before.length){
    FILTERS.tags = after;
    saveFilters(FILTERS);
    addLog('ui', `Pruned stale tag filters: ${before.filter(t=>!available.has(t)).join(', ')}`);
  }
}

async function loadTags(){
  const bid = getBoardId();
  const q = bid ? `?board_id=${encodeURIComponent(String(bid))}` : '';
  const data = await api(`/api/tags${q}`);
  const tags = data.tags || [];
  reconcileSelectedTags(tags);
  return tags;
}

function closeTagDropdown(){
  const dd = qs('#tagDropdown');
  if(dd) dd.hidden = true;
}

function applyFiltersToUI(){
  // status chips
  qsa('[data-status-filter]').forEach((btn)=>{
    const st = btn.dataset.statusFilter;
    const on = !!FILTERS.statuses[st];
    btn.classList.toggle('active', on);
  });

  // show/hide columns based on status toggles
  qsa('.column').forEach((col)=>{
    const st = col.dataset.status;
    col.style.display = FILTERS.statuses[st] ? '' : 'none';
  });

  // tag dropdown checkboxes
  qsa('#tagOptions input[type="checkbox"]').forEach((cb)=>{
    cb.checked = FILTERS.tags.includes(cb.value);
  });
}

function taskMatchesFilters(task){
  if(!FILTERS.statuses[task.status]) return false;
  if(!FILTERS.tags.length) return true;
  const taskTags = (task.tags || []).map(t => t.name);
  // ANY-of selected tags
  return FILTERS.tags.some(t => taskTags.includes(t));
}

async function loadBoards(){
  const data = await api('/api/boards');
  const sel = qs('#boardSelect');
  sel.innerHTML = '';

  const boards = data.boards || [];
  boards.forEach((b)=>{
    const opt = document.createElement('option');
    opt.value = String(b.id);
    opt.textContent = b.name;
    sel.appendChild(opt);
  });

  let bid = getBoardId();
  if(!bid && boards.length){ bid = boards[0].id; }
  // If stored board id no longer exists, fall back.
  if(bid && !boards.some(b => b.id === bid)){
    bid = boards.length ? boards[0].id : null;
  }
  if(bid){
    sel.value = String(bid);
    setBoardId(bid);
  }

  sel.addEventListener('change', async ()=>{
    const id = parseInt(sel.value, 10);
    setBoardId(id);
    await refresh();
    toast('Switched board');
  });

  // Enable/disable delete button depending on how many boards exist.
  const delBtn = qs('#btnDeleteBoard');
  if(delBtn){
    delBtn.disabled = boards.length <= 1;
    delBtn.title = delBtn.disabled ? 'Cannot delete the last board' : '';
  }
}

function toggleTagFilter(tagName){
  const set = new Set(FILTERS.tags || []);
  if(set.has(tagName)) set.delete(tagName);
  else set.add(tagName);
  FILTERS.tags = [...set];
  saveFilters(FILTERS);
}

function renderTags(container, tags){
  container.innerHTML = '';
  (tags || []).forEach((t)=>{
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.title = 'Click to filter';

    // Show selected state
    if(FILTERS.tags?.includes(t.name)){
      pill.classList.add('active');
    }

    const dot = document.createElement('span');
    dot.className = 'tag-dot';
    if(t.color){ dot.style.background = t.color; }

    const name = document.createElement('span');
    name.textContent = t.name;

    pill.appendChild(dot);
    pill.appendChild(name);
    container.appendChild(pill);

    pill.addEventListener('click', async (e)=>{
      e.stopPropagation();
      toggleTagFilter(t.name);
      applyFiltersToUI();
      await refresh();
      toast(`Filter: ${FILTERS.tags.length ? FILTERS.tags.join(', ') : 'none'}`);
    });
  });
}

function renderChecklist(container, items){
  container.innerHTML = '';
  const list = (items || []);
  if(!list.length) return;

  // Keep it compact on cards: show up to 6 items.
  const shown = list.slice(0, 6);
  shown.forEach((it)=>{
    const row = document.createElement('div');
    row.className = 'check-item';

    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'check-box';
    box.textContent = it.done ? '[x]' : '[ ]';
    box.setAttribute('aria-label', it.done ? 'Mark unchecked' : 'Mark checked');

    const text = document.createElement('span');
    text.className = 'check-text' + (it.done ? ' done' : '');
    text.textContent = it.text;

    row.appendChild(box);
    row.appendChild(text);
    container.appendChild(row);

    // Click: toggle done
    const toggleDone = async ()=>{
      await api(`/api/checklist/${it.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: !it.done })
      });
      await refresh();
    };

    // Double-click text: edit item text (save-on-blur)
    text.addEventListener('dblclick', ()=>{
      startInlineInput(text, it.text, {
        onSave: async (next)=>{
          const t = (next || '').trim();
          if(!t) return;
          await api(`/api/checklist/${it.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ text: t })
          });
          await refresh();
          toast('Checklist item updated');
        }
      });
    });

    box.addEventListener('click', toggleDone);
    text.addEventListener('click', (e)=>{
      // Avoid toggling when finishing an edit.
      if(e.target?.classList?.contains('inline-edit')) return;
      // Single click toggles; double click edits.
      if(e.detail === 2) return;
      toggleDone();
    });
  });

  if(list.length > shown.length){
    const more = document.createElement('div');
    more.style.color = 'var(--muted)';
    more.style.fontSize = '12px';
    more.textContent = `+${list.length - shown.length} more…`;
    container.appendChild(more);
  }
}

function startInlineInput(spanEl, initialValue, { multiline=false, placeholder='', onSave }={}){
  const parent = spanEl.parentElement;
  if(!parent) return;

  // Avoid nesting edits.
  if(parent.querySelector('.inline-edit')) return;

  const input = document.createElement(multiline ? 'textarea' : 'input');
  input.className = 'inline-edit';
  input.value = initialValue ?? '';
  if(placeholder) input.placeholder = placeholder;
  if(multiline){
    input.rows = Math.max(2, Math.min(6, (String(input.value).split('\n').length || 2)));
  }

  const finish = async (commit)=>{
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('keydown', onKey);

    if(!commit){
      parent.replaceChild(spanEl, input);
      return;
    }

    const next = input.value;
    parent.replaceChild(spanEl, input);
    if(typeof onSave === 'function'){
      await onSave(next);
    }
  };

  const onBlur = ()=>{ finish(true).catch((e)=>{ console.error(e); toast(e.message); }); };
  const onKey = (e)=>{
    if(e.key === 'Escape'){
      e.preventDefault();
      finish(false);
    }
    if(!multiline && e.key === 'Enter'){
      e.preventDefault();
      finish(true).catch((err)=>{ console.error(err); toast(err.message); });
    }
    if(multiline && e.key === 'Enter' && (e.ctrlKey || e.metaKey)){
      e.preventDefault();
      finish(true).catch((err)=>{ console.error(err); toast(err.message); });
    }
  };

  parent.replaceChild(input, spanEl);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKey);
  input.focus();
  input.select();
}

function taskEl(task){
  const tpl = qs('#taskTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = task.id;
  el.dataset.status = task.status;
  el.dataset.position = task.position;

  const titleEl = qs('.task-title', el);
  titleEl.textContent = task.title;

  const tagsEl = qs('.task-tags', el);
  renderTags(tagsEl, task.tags || []);

  const descEl = qs('.task-desc', el);
  descEl.textContent = task.description || '';

  renderChecklist(qs('.task-checklist', el), task.checklist || []);

  // Inline editing (double-click)
  titleEl.addEventListener('dblclick', ()=>{
    startInlineInput(titleEl, task.title, {
      onSave: async (next)=>{
        const t = (next || '').trim();
        if(!t) return;
        await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) });
        await refresh();
        toast('Title updated');
      }
    });
  });

  descEl.addEventListener('dblclick', ()=>{
    startInlineInput(descEl, task.description || '', {
      multiline: true,
      placeholder: 'Description…',
      onSave: async (next)=>{
        await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ description: next ?? '' }) });
        await refresh();
        toast('Description updated');
      }
    });
  });

  tagsEl.addEventListener('dblclick', async ()=>{
    const existing = (task.tags || []).map(t => t.name).join(', ');
    const tagsRaw = prompt('Tags (comma separated)', existing);
    if(tagsRaw === null) return;
    const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
    await api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ tags }) });
    await refresh();
    toast('Tags updated');
  });

  el.addEventListener('dragstart', (e)=>{
    el.classList.add('dragging');
    // Cross-browser: explicitly mark as a move operation.
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(task.id));
  });
  el.addEventListener('dragend', ()=> el.classList.remove('dragging'));

  qs('button.edit', el).addEventListener('click', async ()=>{
    const title = prompt('Title', task.title);
    if(title === null) return;
    const desc = prompt('Description', task.description || '');
    if(desc === null) return;
    const existingTags = (task.tags || []).map(t => t.name).join(', ');
    const tagsRaw = prompt('Tags (comma separated)', existingTags);
    if(tagsRaw === null) return;
    const tags = tagsRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    await api(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, description: desc, tags })
    });
    await refresh();
    toast('Updated');
  });

  qs('button.checklist', el).addEventListener('click', async ()=>{
    const text = prompt('New checklist item');
    if(text === null) return;
    const trimmed = text.trim();
    if(!trimmed) return;
    await api(`/api/tasks/${task.id}/checklist`, {
      method: 'POST',
      body: JSON.stringify({ text: trimmed })
    });
    await refresh();
    toast('Checklist item added');
  });

  qs('button.delete', el).addEventListener('click', async ()=>{
    if(!confirm('Delete this task?')) return;
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    await refresh();
    toast('Deleted');
  });

  return el;
}

function computePosition(dropzone, insertIndex){
  const items = qsa('.task', dropzone);
  if(items.length === 0){
    return 1000.0;
  }
  if(insertIndex <= 0){
    const first = parseFloat(items[0].dataset.position);
    return first - 1000.0;
  }
  if(insertIndex >= items.length){
    const last = parseFloat(items[items.length-1].dataset.position);
    return last + 1000.0;
  }
  const prev = parseFloat(items[insertIndex-1].dataset.position);
  const next = parseFloat(items[insertIndex].dataset.position);
  return (prev + next) / 2.0;
}

function setupDnD(){
  qsa('.dropzone').forEach((dz)=>{
    dz.addEventListener('dragenter', (e)=>{
      // Some browsers require dragenter to be cancelled to allow drop.
      e.preventDefault();
      if(e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });

    dz.addEventListener('dragover', (e)=>{
      e.preventDefault();
      // Cross-browser hint.
      if(e.dataTransfer) e.dataTransfer.dropEffect = 'move';

      const dragging = qs('.task.dragging');
      if(!dragging) return;

      // Windows Chrome/Edge can be finicky if you move the *dragging element*
      // across containers during dragover. Only reorder within the same column.
      if(dragging.parentElement !== dz) return;

      const after = [...dz.querySelectorAll('.task:not(.dragging)')].find((t)=>{
        const r = t.getBoundingClientRect();
        return e.clientY < r.top + r.height/2;
      });
      if(after){ dz.insertBefore(dragging, after); }
      else { dz.appendChild(dragging); }
    });

    dz.addEventListener('drop', async (e)=>{
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');

      // When dragging across columns, some browsers won't reliably keep the
      // element inside the target dropzone during drag. Find it globally.
      const el = qs(`.task[data-id="${id}"]`);
      if(!el) return;

      // Ensure the element is in the dropzone we dropped onto.
      // (Do this only on drop to maximize cross-browser compatibility.)
      if(el.parentElement !== dz){ dz.appendChild(el); }

      const status = dz.dataset.status;
      const items = qsa('.task', dz);
      const idx = items.findIndex(x => x.dataset.id === String(id));
      const position = computePosition(dz, idx);

      await api(`/api/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, position })
      });

      el.dataset.status = status;
      el.dataset.position = String(position);

      updateCounts();
      toast('Moved');
    });
  });
}

function updateCounts(){
  COLUMNS.forEach((c)=>{
    const dz = qs(`.dropzone[data-status="${c}"]`);
    const count = dz ? dz.querySelectorAll('.task').length : 0;
    const badge = qs(`#count-${c}`);
    if(badge) badge.textContent = String(count);
  });
}

async function refresh(){
  const bid = getBoardId();
  const q = bid ? `?board_id=${encodeURIComponent(String(bid))}` : '';
  const data = await api(`/api/tasks${q}`);

  COLUMNS.forEach((c)=>{
    const dz = qs(`.dropzone[data-status="${c}"]`);
    dz.innerHTML = '';
  });

  (data.tasks || []).forEach((t)=>{
    if(!taskMatchesFilters(t)) return;
    const dz = qs(`.dropzone[data-status="${t.status}"]`);
    if(dz) dz.appendChild(taskEl(t));
  });

  applyFiltersToUI();
  updateCounts();
}

async function addTask(){
  const title = prompt('Task title');
  if(title === null) return;
  const description = prompt('Description (optional)') ?? '';
  const tagsRaw = prompt('Tags (comma separated)', '') ?? '';
  const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const bid = getBoardId();
  await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title, description, tags, board_id: bid })
  });
  await refresh();
  toast('Added');
}

async function newBoard(){
  const name = prompt('New board name');
  if(name === null) return;
  const data = await api('/api/boards', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  await loadBoards();
  if(data.board?.id){
    setBoardId(data.board.id);
    qs('#boardSelect').value = String(data.board.id);
  }
  await refresh();
  toast('Board created');
}

window.addEventListener('DOMContentLoaded', async ()=>{
  // Activity console
  hookConsole();
  renderActivity();
  qs('#btnConsoleClear').addEventListener('click', ()=>{
    ACTIVITY = [];
    saveActivity(ACTIVITY);
    renderActivity();
    toast('Console cleared');
  });

  setupDnD();
  qs('#btnAdd').addEventListener('click', addTask);
  qs('#btnRefresh').addEventListener('click', refresh);
  qs('#btnNewBoard').addEventListener('click', newBoard);

  qs('#btnDeleteBoard').addEventListener('click', async ()=>{
    const bid = getBoardId();
    const sel = qs('#boardSelect');
    const name = sel?.selectedOptions?.[0]?.textContent || 'this board';
    if(!bid){ toast('No board selected'); return; }

    if(!confirm(`Delete board "${name}" and ALL its tasks? This cannot be undone.`)) return;
    const typed = prompt('Type DELETE to confirm');
    if(typed !== 'DELETE'){
      toast('Cancelled');
      return;
    }

    await api(`/api/boards/${bid}`, { method: 'DELETE' });
    // Reload boards + refresh UI
    await loadBoards();
    await refresh();
    toast('Board deleted');
  });

  // status filter chips
  qsa('[data-status-filter]').forEach((btn)=>{
    btn.addEventListener('click', async ()=>{
      const st = btn.dataset.statusFilter;
      FILTERS.statuses[st] = !FILTERS.statuses[st];
      // prevent turning off all columns
      if(!FILTERS.statuses.backlog && !FILTERS.statuses.todo && !FILTERS.statuses.doing && !FILTERS.statuses.done){
        FILTERS.statuses[st] = true;
      }
      saveFilters(FILTERS);
      await refresh();
    });
  });

  qs('#btnClearFilters').addEventListener('click', async ()=>{
    FILTERS = { statuses: {backlog:true, todo:true, doing:true, done:true}, tags: [] };
    saveFilters(FILTERS);
    closeTagDropdown();
    await refresh();
    toast('Filters cleared');
  });

  // tag dropdown
  qs('#btnTagFilter').addEventListener('click', async (e)=>{
    e.stopPropagation();
    const dd = qs('#tagDropdown');
    dd.hidden = !dd.hidden;
  });

  document.addEventListener('click', (e)=>{
    const dd = qs('#tagDropdown');
    const btn = qs('#btnTagFilter');
    if(!dd || dd.hidden) return;
    if(dd.contains(e.target) || btn.contains(e.target)) return;
    closeTagDropdown();
  });

  try {
    await loadBoards();

    // populate tags list
    const tags = await loadTags();
    const optWrap = qs('#tagOptions');
    optWrap.innerHTML = '';
    tags.forEach((t)=>{
      const row = document.createElement('label');
      row.className = 'dropdown-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = t.name;
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = t.color;
      const name = document.createElement('span');
      name.textContent = t.name;
      row.appendChild(cb);
      row.appendChild(dot);
      row.appendChild(name);
      optWrap.appendChild(row);

      cb.addEventListener('change', async ()=>{
        const selected = new Set(FILTERS.tags);
        if(cb.checked) selected.add(cb.value);
        else selected.delete(cb.value);
        FILTERS.tags = [...selected];
        saveFilters(FILTERS);
        await refresh();
      });
    });

    applyFiltersToUI();
    await refresh();
  } catch (e) {
    console.error(e);
    toast(e.message);
  }
});
