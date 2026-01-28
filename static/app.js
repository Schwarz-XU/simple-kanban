const COLUMNS = ['todo', 'doing', 'done'];

const FILTERS_KEY = 'kanban.filters.v1';

function loadFilters(){
  const raw = localStorage.getItem(FILTERS_KEY);
  if(!raw){
    return { statuses: {todo:true, doing:true, done:true}, tags: [] };
  }
  try {
    const f = JSON.parse(raw);
    return {
      statuses: { todo: !!f?.statuses?.todo, doing: !!f?.statuses?.doing, done: !!f?.statuses?.done },
      tags: Array.isArray(f?.tags) ? f.tags : []
    };
  } catch {
    return { statuses: {todo:true, doing:true, done:true}, tags: [] };
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
}

async function api(path, opts={}){
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok){ throw new Error(data.error || `HTTP ${res.status}`); }
  return data;
}

function getBoardId(){
  const v = localStorage.getItem('kanban.boardId');
  return v ? parseInt(v, 10) : null;
}

function setBoardId(id){
  localStorage.setItem('kanban.boardId', String(id));
}

async function loadTags(){
  const data = await api('/api/tags');
  return data.tags || [];
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

function renderTags(container, tags){
  container.innerHTML = '';
  (tags || []).forEach((t)=>{
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    const dot = document.createElement('span');
    dot.className = 'tag-dot';
    if(t.color){ dot.style.background = t.color; }
    const name = document.createElement('span');
    name.textContent = t.name;
    pill.appendChild(dot);
    pill.appendChild(name);
    container.appendChild(pill);
  });
}

function renderChecklist(container, items){
  container.innerHTML = '';
  const list = (items || []);
  if(!list.length) return;

  // Keep it compact on cards: show up to 6 items.
  const shown = list.slice(0, 6);
  shown.forEach((it)=>{
    const row = document.createElement('label');
    row.className = 'check-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!it.done;
    cb.dataset.itemId = String(it.id);

    const text = document.createElement('span');
    text.className = 'check-text' + (it.done ? ' done' : '');
    text.textContent = it.text;

    row.appendChild(cb);
    row.appendChild(text);
    container.appendChild(row);

    cb.addEventListener('change', async ()=>{
      await api(`/api/checklist/${it.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: cb.checked })
      });
      await refresh();
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

function taskEl(task){
  const tpl = qs('#taskTemplate');
  const el = tpl.content.firstElementChild.cloneNode(true);
  el.dataset.id = task.id;
  el.dataset.status = task.status;
  el.dataset.position = task.position;
  qs('.task-title', el).textContent = task.title;
  renderTags(qs('.task-tags', el), task.tags || []);
  qs('.task-desc', el).textContent = task.description || '';
  renderChecklist(qs('.task-checklist', el), task.checklist || []);

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
      if(!FILTERS.statuses.todo && !FILTERS.statuses.doing && !FILTERS.statuses.done){
        FILTERS.statuses[st] = true;
      }
      saveFilters(FILTERS);
      await refresh();
    });
  });

  qs('#btnClearFilters').addEventListener('click', async ()=>{
    FILTERS = { statuses: {todo:true, doing:true, done:true}, tags: [] };
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
