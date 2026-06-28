/* Tasks — Supabase edition. The browser talks straight to Supabase (Postgres +
   Auth + Realtime); Row Level Security enforces access. UI is unchanged. */
'use strict';

let sb = null;     // Supabase client
let uid = null;    // current user's uuid
let realtimeChannel = null;

const state = {
  user: null,
  projects: [],
  tasks: [],
  labels: [],
  groups: [],
  role: null,
  view: { type: 'today' },
  composer: null,
  editingTaskId: null,
  modal: null,
  drawerOpen: false,
  authView: 'pick',   // 'pick' (role buttons) | 'pin' (numeric PIN) | 'email' (classic form)
  authRole: null,     // which role's PIN screen we're on ('management' | 'staff')
  authMode: 'login',  // within the 'email' view: 'login' | 'register'
  authError: '',
};

const COLORS = ['#dc4c3e', '#eb8909', '#f9d71c', '#7ecc49', '#299438', '#6accbc', '#158fad', '#246fe0', '#884dff', '#eb96eb', '#808080'];
const ASSIGNEES = ['Adrian', 'Tai Kee', 'Rievan', 'Ferdi'];

// The two shared team logins. Tapping a button just pre-fills the email; the user
// types that account's PIN (= its Supabase password). Emails are NOT secret — the
// PIN is the only secret, and it's never stored in the app, only typed each time.
const ROLE_LOGINS = {
  management: { label: 'AW Management', email: 'awmanagement@aterawater.com', emoji: '🛠️', desc: 'All lists' },
  staff:      { label: 'AW Staff',      email: 'awstaff@aterawater.com',     emoji: '👤', desc: 'BD lists only' },
};

/* ---------------- Data layer (Supabase) ---------------- */
function chk(res) { if (res.error) throw new Error(res.error.message); return res.data; }

async function loadState() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { state.user = null; return; }
  uid = session.user.id;

  const [profiles, projects, members, sections, tasks, labels, taskLabels] = await Promise.all([
    sb.from('profiles').select('*'),
    sb.from('projects').select('*').order('is_inbox', { ascending: false }).order('position').order('id'),
    sb.from('project_members').select('*'),
    sb.from('sections').select('*').order('position').order('id'),
    sb.from('tasks').select('*').order('position').order('id'),
    sb.from('labels').select('*').order('name'),
    sb.from('task_labels').select('*'),
  ]).then((rs) => rs.map(chk));

  const profById = Object.fromEntries(profiles.map((p) => [p.id, p]));
  state.projects = projects.map((p) => {
    const memberList = [
      { ...(profById[p.owner_id] || { id: p.owner_id, name: 'Owner', email: '' }), role: 'owner' },
      ...members.filter((m) => m.project_id === p.id)
        .map((m) => ({ ...(profById[m.user_id] || { id: m.user_id, name: 'Member', email: '' }), role: m.role })),
    ];
    return { ...p, is_owner: p.owner_id === uid, sections: sections.filter((s) => s.project_id === p.id), members: memberList };
  });
  state.tasks = tasks.map((t) => ({ ...t, label_ids: taskLabels.filter((x) => x.task_id === t.id).map((x) => x.label_id) }));
  state.labels = labels;
  // Tolerant: if the project_groups migration hasn't run yet, just show no headings (don't break the app).
  const gr = await sb.from('project_groups').select('*').order('position').order('id');
  state.groups = gr.error ? [] : gr.data;
  // Team role (management / staff). Null = not a team member yet (pre-migration / solo).
  const rr = await sb.from('team_members').select('role').eq('user_id', uid).maybeSingle();
  state.role = (!rr || rr.error) ? null : (rr.data ? rr.data.role : null);
  const me = profById[uid] || { name: session.user.user_metadata?.name || session.user.email, email: session.user.email };
  state.user = { id: uid, name: me.name, email: me.email };
}

async function setTaskLabels(taskId, labelIds) {
  chk(await sb.from('task_labels').delete().eq('task_id', taskId));
  if (labelIds && labelIds.length) {
    chk(await sb.from('task_labels').insert(labelIds.map((label_id) => ({ task_id: taskId, label_id }))));
  }
}
const nextPos = (projectId) => {
  const ps = state.tasks.filter((t) => t.project_id === projectId).map((t) => t.position);
  return (ps.length ? Math.max(...ps) : 0) + 1;
};

function subscribeRealtime() {
  if (realtimeChannel) return;
  let ch = sb.channel('db-changes');
  ['tasks', 'projects', 'project_members', 'sections', 'labels', 'task_labels', 'project_groups'].forEach((table) => {
    ch = ch.on('postgres_changes', { event: '*', schema: 'tasks_app', table }, () => scheduleReload());
  });
  realtimeChannel = ch.subscribe();
}
function unsubscribeRealtime() {
  if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
}
let reloadTimer;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(reloadAndRender, 250); }

/* ---------------- Helpers ---------------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const byId = (id) => state.projects.find((p) => p.id === id);
const labelById = (id) => state.labels.find((l) => l.id === id);
const groupById = (id) => (state.groups || []).find((g) => g.id === id);
const inbox = () => state.projects.find((p) => p.is_inbox);

function localISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const todayStr = () => localISO(new Date());

function fmtDue(due) {
  if (!due) return null;
  const t = new Date(todayStr() + 'T00:00:00');
  const d = new Date(due + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  let label, cls = '';
  if (diff < 0) { cls = 'overdue'; label = diff === -1 ? 'Yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  else if (diff === 0) { cls = 'today'; label = 'Today'; }
  else if (diff === 1) { label = 'Tomorrow'; }
  else if (diff < 7) { label = d.toLocaleDateString(undefined, { weekday: 'long' }); }
  else { label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  return { label, cls, diff };
}

function effectiveTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  document.documentElement.dataset.theme = next;
  render();
}

let toastTimer;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

/* ---------------- Root render ---------------- */
const root = document.getElementById('app');

function render() {
  if (!state.user) return renderAuth();
  root.innerHTML = `
    <div class="app-grid ${state.drawerOpen ? 'drawer-open' : ''}">
      ${renderSidebar()}
      <main class="main">
        ${renderTopbar()}
        <div class="main-inner">${renderMain()}</div>
      </main>
      <div class="drawer-overlay" data-action="close-drawer"></div>
    </div>
    ${state.modal ? renderModal() : ''}
  `;
}

function renderConfigError() {
  root.innerHTML = `
    <div class="auth-wrap"><div class="auth-card">
      <h1>✅ Tasks</h1>
      <div class="sub">Almost there — connect your Supabase project</div>
      <p style="color:var(--muted);font-size:13px;line-height:1.6">
        Open <code>public/config.js</code> and paste your project <b>URL</b> and <b>anon public key</b>
        (Supabase Dashboard → Project Settings → API), then reload. See <code>SUPABASE_SETUP.md</code>.
      </p>
    </div></div>`;
}

/* ---------------- Auth ---------------- */
function renderAuth() {
  if (state.authView === 'email') return renderAuthEmail();
  if (state.authView === 'pin') return renderAuthPin();
  return renderAuthPick();
}

// Default screen: choose which shared login you are.
function renderAuthPick() {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>✅ Atera Tasks</h1>
        <div class="sub">Who's logging in?</div>
        <div class="role-pick">
          ${['management', 'staff'].map((r) => {
            const role = ROLE_LOGINS[r];
            return `<button class="role-btn role-${r}" data-action="auth-pick-role" data-role="${r}">
                      <span class="role-emoji">${role.emoji}</span>
                      <span class="role-text"><span class="role-name">${role.label}</span><span class="role-desc">${role.desc}</span></span>
                      <span class="role-go">→</span>
                    </button>`;
          }).join('')}
        </div>
        ${state.authError ? `<div class="auth-error">${esc(state.authError)}</div>` : ''}
        <div class="auth-toggle"><button data-action="auth-email-mode">Other login</button></div>
      </div>
    </div>`;
}

// PIN pad for the chosen role. The hidden email + typed PIN go through the normal
// login submit handler (signInWithPassword). The on-screen keypad is the only input,
// so the PIN is always numeric and behaves the same on phone and desktop.
function renderAuthPin() {
  const role = ROLE_LOGINS[state.authRole];
  if (!role) { state.authView = 'pick'; return renderAuthPick(); }
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card pin-card">
        <button class="pin-back" data-action="auth-pick-back">← back</button>
        <h1>${role.emoji} ${role.label}</h1>
        <div class="sub">Enter your PIN</div>
        <form data-action="auth-submit" class="pin-form" autocomplete="off">
          <input type="hidden" name="email" value="${role.email}" />
          <input id="pinField" name="password" type="password" inputmode="numeric"
                 autocomplete="off" readonly class="pin-input" placeholder="••••••" />
          <div class="keypad">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="key" data-action="pin-key" data-key="${n}">${n}</button>`).join('')}
            <button type="button" class="key key-sub" data-action="pin-del">⌫</button>
            <button type="button" class="key" data-action="pin-key" data-key="0">0</button>
            <button type="submit" class="key key-go">→</button>
          </div>
        </form>
        ${state.authError ? `<div class="auth-error">${esc(state.authError)}</div>` : ''}
      </div>
    </div>`;
}

// Classic email/password — kept for Adrian's personal account and account setup.
function renderAuthEmail() {
  const isLogin = state.authMode === 'login';
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <button class="pin-back" data-action="auth-pick-back">← back</button>
        <h1>✅ Tasks</h1>
        <div class="sub">${isLogin ? 'Log in with email' : 'Create an account'}</div>
        <form data-action="auth-submit">
          ${isLogin ? '' : '<label>Name</label><input name="name" autocomplete="name" required />'}
          <label>Email</label>
          <input name="email" type="email" autocomplete="email" required />
          <label>Password</label>
          <input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required minlength="6" />
          <button class="primary" type="submit">${isLogin ? 'Log in' : 'Sign up'}</button>
        </form>
        ${state.authError ? `<div class="auth-error">${esc(state.authError)}</div>` : ''}
        <div class="auth-toggle">
          ${isLogin ? "Don't have an account?" : 'Already have an account?'}
          <button data-action="auth-toggle">${isLogin ? 'Sign up' : 'Log in'}</button>
        </div>
      </div>
    </div>`;
}

/* ---------------- Sidebar ---------------- */
const activeCount = (projectId) => state.tasks.filter((t) => t.project_id === projectId && !t.completed).length;
const todayCount = () => state.tasks.filter((t) => !t.completed && t.due_date && t.due_date <= todayStr()).length;
const labelCount = (labelId) => state.tasks.filter((t) => !t.completed && (t.label_ids || []).includes(labelId)).length;

function renderSidebar() {
  const visible = state.projects.filter((p) => !p.is_inbox);
  const isMgmt = state.role !== 'staff'; // management or not-yet-mapped = full heading controls; only 'staff' is restricted
  const ib = inbox();
  const v = state.view;
  const tc = todayCount();
  const dark = effectiveTheme() === 'dark';
  const groupsSorted = (state.groups || []).slice().sort((a, b) => (a.position - b.position) || (a.id - b.id));
  const projItem = (p) => `
    <button class="nav-item ${v.type === 'project' && v.projectId === p.id ? 'active' : ''}" data-action="select-project" data-id="${p.id}">
      <span class="dot" style="background:${esc(p.color)}"></span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
      ${p.members.length > 1 ? '<span class="shared-badge">👥</span>' : ''}
      ${activeCount(p.id) ? `<span class="count">${activeCount(p.id)}</span>` : ''}
    </button>`;

  return `
    <aside class="sidebar">
      <div class="me">
        <div class="avatar">${esc(initials(state.user.name))}</div>
        <div class="name">${esc(state.user.name)}</div>
        <button class="icon-btn" data-action="sync" title="Sync now">⟳</button>
        <button class="icon-btn" data-action="toggle-theme" title="Toggle theme">${dark ? '☀️' : '🌙'}</button>
        <button class="icon-btn" data-action="logout" title="Log out">⏻</button>
      </div>

      <button class="nav-item ${v.type === 'today' ? 'active' : ''}" data-action="view-today">
        <span class="ico">📅</span> Today ${tc ? `<span class="count">${tc}</span>` : ''}
      </button>
      <button class="nav-item ${v.type === 'upcoming' ? 'active' : ''}" data-action="view-upcoming">
        <span class="ico">🗓️</span> Upcoming
      </button>
      ${ib ? `<button class="nav-item ${v.type === 'project' && v.projectId === ib.id ? 'active' : ''}" data-action="select-project" data-id="${ib.id}">
        <span class="ico">📥</span> Inbox ${activeCount(ib.id) ? `<span class="count">${activeCount(ib.id)}</span>` : ''}
      </button>` : ''}

      <div class="nav-section"><span>My Projects</span><button data-action="new-project" title="Add list">+</button></div>
      ${visible.filter((p) => !p.group_id).map(projItem).join('')}

      ${groupsSorted.map((g) => `
        <div class="nav-section">
          <span ${isMgmt ? `data-action="rename-group" data-id="${g.id}" title="Rename heading" style="cursor:pointer;` : 'style="'}flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</span>
          <span style="display:flex;gap:2px;flex-shrink:0">
            <button data-action="new-project" data-group="${g.id}" title="Add list">+</button>
            ${isMgmt ? `<button data-action="delete-group" data-id="${g.id}" title="Delete heading" style="font-size:13px">🗑</button>` : ''}
          </span>
        </div>
        ${visible.filter((p) => p.group_id === g.id).map(projItem).join('') || '<div style="color:var(--muted);padding:2px 10px 6px;font-size:12px">No lists yet — tap +</div>'}
      `).join('')}
      ${isMgmt ? '<button class="nav-item" data-action="new-group" style="color:var(--muted);margin-top:2px"><span class="ico">＋</span> Add heading</button>' : ''}

      <div class="nav-section"><span>Labels</span><button data-action="new-label" title="Add label">+</button></div>
      ${state.labels.map((l) => `
        <button class="nav-item ${v.type === 'label' && v.labelId === l.id ? 'active' : ''}" data-action="select-label" data-id="${l.id}">
          <span class="ico" style="color:${esc(l.color)}">🏷</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.name)}</span>
          ${labelCount(l.id) ? `<span class="count">${labelCount(l.id)}</span>` : ''}
        </button>`).join('') || '<div style="color:var(--muted);padding:4px 10px;font-size:13px">No labels yet</div>'}
    </aside>`;
}

/* ---------------- Top bar (mobile) ---------------- */
function viewTitle() {
  const v = state.view;
  if (v.type === 'today') return 'Today';
  if (v.type === 'upcoming') return 'Upcoming';
  if (v.type === 'label') { const l = labelById(v.labelId); return l ? `🏷 ${l.name}` : 'Label'; }
  if (v.type === 'project') { const p = byId(v.projectId); return p ? (p.is_inbox ? '📥 Inbox' : p.name) : 'Project'; }
  return 'Tasks';
}
function renderTopbar() {
  return `
    <header class="topbar">
      <button class="hamburger" data-action="toggle-drawer" aria-label="Menu">☰</button>
      <div class="top-title">${esc(viewTitle())}</div>
      <button class="top-add" data-action="sync" title="Sync" aria-label="Sync">⟳</button>
      <button class="top-add" data-action="topbar-add" aria-label="Add task">+</button>
    </header>`;
}

/* ---------------- Main views ---------------- */
function renderMain() {
  if (state.view.type === 'today') return renderTodayView();
  if (state.view.type === 'upcoming') return renderUpcomingView();
  if (state.view.type === 'label') return renderLabelView();
  if (state.view.type === 'project') return renderProjectView();
  return '';
}

function taskSort(a, b) {
  if (a.due_date && b.due_date && a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
  if (a.due_date && !b.due_date) return -1;
  if (!a.due_date && b.due_date) return 1;
  return a.position - b.position;
}

function renderTodayView() {
  const tasks = state.tasks.filter((t) => !t.completed && t.due_date && t.due_date <= todayStr()).sort(taskSort);
  return `
    <div class="page-head"><h2>Today</h2></div>
    <div class="page-sub">${tasks.length} task${tasks.length === 1 ? '' : 's'}</div>
    ${tasks.length ? tasks.map((t) => renderTaskOrEditor(t, { showProject: true })).join('')
      : `<div class="empty"><div class="big">🎉</div>Nothing due today. Enjoy!</div>`}
    ${renderComposerSlot({ projectId: inbox().id, due: todayStr() })}
  `;
}

function renderUpcomingView() {
  const tasks = state.tasks
    .filter((t) => !t.completed && t.due_date && t.due_date > todayStr())
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : taskSort(a, b)));
  const groups = {};
  tasks.forEach((t) => { (groups[t.due_date] ||= []).push(t); });
  const dates = Object.keys(groups).sort();
  return `
    <div class="page-head"><h2>Upcoming</h2></div>
    ${dates.length ? dates.map((d) => {
      const f = fmtDue(d);
      return `<div class="section-title">${esc(f.label)} <span class="count">· ${new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>
        ${groups[d].map((t) => renderTaskOrEditor(t, { showProject: true })).join('')}`;
    }).join('') : `<div class="empty"><div class="big">🌤️</div>Nothing scheduled ahead.</div>`}
    ${renderComposerSlot({ projectId: inbox().id, due: '' })}
  `;
}

function renderLabelView() {
  const l = labelById(state.view.labelId);
  if (!l) { state.view = { type: 'today' }; return renderMain(); }
  const tasks = state.tasks.filter((t) => !t.completed && (t.label_ids || []).includes(l.id)).sort(taskSort);
  return `
    <div class="page-head">
      <span class="head-color" style="background:${esc(l.color)}"></span>
      <h2>${esc(l.name)}</h2>
      <span class="spacer"></span>
      <button class="btn-light" data-action="delete-label" data-id="${l.id}">🗑 Delete label</button>
    </div>
    <div class="page-sub">${tasks.length} task${tasks.length === 1 ? '' : 's'} with this label</div>
    ${tasks.length ? tasks.map((t) => renderTaskOrEditor(t, { showProject: true })).join('')
      : `<div class="empty"><div class="big">🏷</div>No tasks with this label yet.</div>`}
    ${renderComposerSlot({ projectId: inbox().id, due: '', labelIds: [l.id] })}
  `;
}

function renderProjectView() {
  const p = byId(state.view.projectId);
  if (!p) { state.view = { type: 'today' }; return renderMain(); }
  const canEdit = state.role !== 'staff' || p.is_owner;
  const all = state.tasks.filter((t) => t.project_id === p.id);
  const active = all.filter((t) => !t.completed);
  const done = all.filter((t) => t.completed);

  const renderGroup = (sectionId) => {
    const items = active.filter((t) => (t.section_id || null) === sectionId).sort(taskSort);
    return items.map((t) => renderTaskOrEditor(t, { showProject: false })).join('')
      + renderComposerSlot({ projectId: p.id, sectionId: sectionId, due: '' });
  };

  const memberAvatars = p.members.slice(0, 4).map((m) => `<div class="avatar" title="${esc(m.name)} (${esc(m.email)})">${esc(initials(m.name))}</div>`).join('');

  let body = renderGroup(null);
  for (const s of p.sections) {
    body += `<div class="section-title">${esc(s.name)} <span class="count">${active.filter((t) => t.section_id === s.id).length}</span>
      <button class="icon-btn" data-action="delete-section" data-id="${s.id}" title="Delete section" style="margin-left:auto">🗑</button></div>`;
    body += renderGroup(s.id);
  }

  return `
    <div class="page-head">
      ${p.is_inbox ? '<span style="font-size:20px">📥</span>' : `<span class="head-color" style="background:${esc(p.color)}"></span>`}
      <h2>${esc(p.name)}</h2>
      <span class="spacer"></span>
      ${!p.is_inbox && canEdit ? `<select class="btn-light" data-action="move-project-group" data-id="${p.id}" title="Move to heading">
        <option value="">My Projects</option>
        ${(state.groups || []).map((g) => `<option value="${g.id}" ${p.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select>` : ''}
      ${!p.is_inbox && canEdit ? `<button class="btn-light" data-action="add-section" data-id="${p.id}">＃ Section</button>` : ''}
      ${!p.is_inbox && canEdit ? `<button class="btn-light" data-action="delete-project" data-id="${p.id}">🗑 Delete</button>` : ''}
    </div>
    <div class="page-sub">${active.length} active${done.length ? ` · ${done.length} completed` : ''}</div>
    ${body}
    ${done.length ? `<div class="section-title" style="margin-top:30px;color:var(--muted)">Completed</div>
      ${done.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')).map((t) => renderTaskOrEditor(t, { showProject: false })).join('')}` : ''}
  `;
}

/* ---------------- Task rendering ---------------- */
function renderTaskOrEditor(t, opts) {
  if (state.editingTaskId === t.id) return renderEditor(t);
  const due = fmtDue(t.due_date);
  const proj = byId(t.project_id);
  const assignee = t.assigned_to || null;
  const labels = (t.label_ids || []).map(labelById).filter(Boolean);
  return `
    <div class="task ${t.completed ? 'completed' : ''}" data-task="${t.id}">
      <div class="swipe-hint left">✓ Done</div>
      <div class="swipe-hint right">Delete</div>
      <div class="task-inner">
        <div class="check ${t.completed ? 'done' : ''}" data-action="task-toggle" data-id="${t.id}"></div>
        <div class="task-body" data-action="task-edit" data-id="${t.id}">
          <div class="task-content">${esc(t.content)}</div>
          ${t.description ? `<div class="task-desc">${esc(t.description)}</div>` : ''}
          <div class="task-meta">
            ${due ? `<span class="meta-due ${due.cls}">📅 ${esc(due.label)}</span>` : ''}
            ${opts.showProject && proj ? `<span class="chip"><span class="dot" style="background:${esc(proj.is_inbox ? '#246fe0' : proj.color)}"></span>${esc(proj.name)}</span>` : ''}
            ${labels.map((l) => `<span class="chip label-chip"><span class="dot" style="background:${esc(l.color)}"></span>${esc(l.name)}</span>`).join('')}
            ${assignee ? `<span class="chip">👤 ${esc(assignee)}</span>` : ''}
          </div>
        </div>
        <div class="task-actions">
          <button data-action="task-edit" data-id="${t.id}" title="Edit">✏️</button>
          <button data-action="task-delete" data-id="${t.id}" title="Delete">🗑</button>
        </div>
      </div>
    </div>`;
}

const projectOptions = (sel) => state.projects.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.is_inbox ? 'Inbox' : p.name)}</option>`).join('');
const assigneeOptions = (sel) => `<select class="e-assignee"><option value="">Unassigned</option>${ASSIGNEES.map((n) => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
function labelChips(selectedIds) {
  if (!state.labels.length) return '<span class="hint">Create labels in the sidebar to tag tasks</span>';
  const sel = new Set(selectedIds || []);
  return state.labels.map((l) => {
    const on = sel.has(l.id);
    return `<span class="lchip ${on ? 'sel' : ''}" data-action="toggle-label-chip" data-id="${l.id}" data-color="${esc(l.color)}" style="${on ? `background:${esc(l.color)}` : ''}">
      <span class="dot" style="background:${esc(l.color)}"></span>${esc(l.name)}</span>`;
  }).join('');
}

function renderEditor(t) {
  return `
    <div class="composer" data-editor="${t.id}">
      <input class="c-content e-content" value="${esc(t.content)}" />
      <textarea class="c-desc e-desc" placeholder="Description">${esc(t.description)}</textarea>
      <div class="composer-controls">
        <input type="date" class="e-due" value="${esc(t.due_date || '')}" />
        <select class="e-project">${projectOptions(t.project_id)}</select>
        ${assigneeOptions(t.assigned_to)}
      </div>
      <div class="label-row">${labelChips(t.label_ids)}</div>
      <div class="composer-actions">
        <button class="btn cancel" data-action="editor-cancel">Cancel</button>
        <button class="btn save" data-action="editor-save" data-id="${t.id}">Save</button>
      </div>
    </div>`;
}

function renderComposerSlot(ctx) {
  const c = state.composer;
  const match = c && c.projectId === ctx.projectId && (c.sectionId || null) === (ctx.sectionId || null);
  if (match) {
    // Minimal by default: just the task name + Add task. Date / assignee / notes
    // stay hidden inside .composer-details until the user taps "Add details".
    return `
      <div class="composer" data-composer="1">
        <input class="c-content" placeholder="Task name" autofocus />
        <div class="composer-details" data-details hidden>
          <textarea class="c-desc" placeholder="Description"></textarea>
          <div class="composer-controls">
            <input type="date" class="c-due" value="${esc(c.due || '')}" />
            ${state.view.type !== 'project' ? `<select class="c-project">${projectOptions(ctx.projectId)}</select>` : ''}
            ${assigneeOptions('')}
          </div>
          <div class="label-row">${labelChips(c.labelIds)}</div>
        </div>
        <button type="button" class="composer-more" data-action="composer-details">＋ Add date, assignee &amp; notes</button>
        <div class="composer-actions">
          <button class="btn cancel" data-action="composer-cancel">Cancel</button>
          <button class="btn save" data-action="composer-save">Add task</button>
        </div>
      </div>`;
  }
  return `<button class="add-task-btn" data-action="add-task-open" data-project="${ctx.projectId}" data-section="${ctx.sectionId || ''}" data-due="${ctx.due || ''}" data-labels="${(ctx.labelIds || []).join(',')}">
      <span class="plus">+</span> Add task
    </button>`;
}

/* ---------------- Modals ---------------- */
function renderModal() {
  const m = state.modal;
  if (m.type === 'project' || m.type === 'label') {
    const isLabel = m.type === 'label';
    return `
      <div class="modal-bg" data-action="modal-bg">
        <div class="modal" data-stop="1">
          <h3>New ${isLabel ? 'label' : 'list'}</h3>
          <label>Name</label>
          <input class="m-name" placeholder="${isLabel ? 'e.g. Errands' : 'e.g. Leads'}" autofocus />
          ${isLabel ? '' : `<label>Heading</label>
          <select class="m-group">
            <option value="">My Projects</option>
            ${(state.groups || []).map((g) => `<option value="${g.id}" ${state.modal.groupId === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
          </select>`}
          <label>Color</label>
          <div class="colors">${COLORS.map((c, i) => `<span class="swatch ${i === 0 ? 'sel' : ''}" data-action="modal-color" data-color="${c}" style="background:${c}"></span>`).join('')}</div>
          <div class="modal-actions">
            <button class="btn cancel" data-action="modal-cancel">Cancel</button>
            <button class="btn save" data-action="${isLabel ? 'modal-create-label' : 'modal-create-project'}">Create</button>
          </div>
        </div>
      </div>`;
  }
  if (m.type === 'share') {
    const p = byId(m.projectId);
    if (!p) { state.modal = null; return ''; }
    return `
      <div class="modal-bg" data-action="modal-bg">
        <div class="modal" data-stop="1">
          <h3>Share “${esc(p.name)}”</h3>
          <p style="color:var(--muted);font-size:13px;margin-bottom:6px">Add people by the email they signed up with. They'll see this project under “Shared with me”.</p>
          <div style="display:flex;gap:8px">
            <input class="m-email" type="email" placeholder="name@email.com" style="flex:1" />
            <button class="btn save" data-action="share-submit" data-id="${p.id}">Invite</button>
          </div>
          <div style="margin-top:16px">
            ${p.members.map((mem) => `
              <div class="member-row">
                <div class="avatar">${esc(initials(mem.name))}</div>
                <div><div>${esc(mem.name)}</div><div class="email">${esc(mem.email)}</div></div>
                <div class="role ${mem.role}">${mem.role === 'owner' ? 'Owner' : 'Member'}</div>
                ${mem.role !== 'owner' && p.is_owner ? `<button class="icon-btn" data-action="share-remove" data-project="${p.id}" data-user="${mem.id}" title="Remove">✕</button>` : ''}
              </div>`).join('')}
          </div>
          <div class="modal-actions"><button class="btn cancel" data-action="modal-cancel">Done</button></div>
        </div>
      </div>`;
  }
  return '';
}

/* ---------------- Event handling ---------------- */
async function reloadAndRender() {
  try { await loadState(); render(); }
  catch (e) { toast(e.message); }
}
const gatherLabelIds = (box) => [...box.querySelectorAll('.lchip.sel')].map((c) => Number(c.dataset.id));

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-action="auth-submit"]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  state.authError = '';
  try {
    if (state.authMode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
      if (error) throw new Error(error.message);
    } else {
      const { data, error } = await sb.auth.signUp({ email: fd.get('email'), password: fd.get('password'), options: { data: { name: fd.get('name') } } });
      if (error) throw new Error(error.message);
      if (!data.session) { state.authMode = 'login'; state.authError = 'Account created — check your email to confirm, then log in.'; return renderAuth(); }
    }
    await loadState();
    subscribeRealtime();
    render();
  } catch (err) {
    let msg = err.message;
    if (state.authView === 'pin') {
      if (/invalid login credentials/i.test(msg)) msg = 'Incorrect PIN — try again.';
      else if (/api key|jwt/i.test(msg)) msg = 'Login config error — tell Adrian.';
    }
    state.authError = msg;
    renderAuth();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (e.target.classList.contains('c-content') && !e.target.classList.contains('e-content')) {
    e.preventDefault(); document.querySelector('[data-action="composer-save"]')?.click();
  } else if (e.target.classList.contains('e-content')) {
    e.preventDefault(); e.target.closest('[data-editor]')?.querySelector('[data-action="editor-save"]')?.click();
  } else if (e.target.classList.contains('m-email')) {
    e.preventDefault(); document.querySelector('[data-action="share-submit"]')?.click();
  } else if (e.target.classList.contains('m-name')) {
    e.preventDefault(); document.querySelector('[data-action="modal-create-project"], [data-action="modal-create-label"]')?.click();
  }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = Number(el.dataset.id);

  try {
    switch (action) {
      case 'auth-toggle':
        state.authMode = state.authMode === 'login' ? 'register' : 'login';
        state.authError = '';
        return renderAuth();

      case 'auth-pick-role':
        state.authRole = el.dataset.role;
        state.authView = 'pin';
        state.authMode = 'login';
        state.authError = '';
        return renderAuth();

      case 'auth-pick-back':
        state.authView = 'pick'; state.authRole = null; state.authError = '';
        return renderAuth();

      case 'auth-email-mode':
        state.authView = 'email'; state.authMode = 'login'; state.authError = '';
        return renderAuth();

      case 'pin-key': {
        const f = document.getElementById('pinField');
        if (f && f.value.length < 12) f.value += el.dataset.key;
        return;
      }
      case 'pin-del': {
        const f = document.getElementById('pinField');
        if (f) f.value = f.value.slice(0, -1);
        return;
      }

      case 'logout':
        unsubscribeRealtime();
        await sb.auth.signOut();
        state.user = null; state.view = { type: 'today' }; state.drawerOpen = false;
        state.authView = 'pick'; state.authRole = null; state.authError = '';
        return render();

      case 'toggle-theme': return toggleTheme();
      case 'toggle-drawer': state.drawerOpen = !state.drawerOpen; return render();
      case 'close-drawer': state.drawerOpen = false; return render();

      case 'view-today': state.view = { type: 'today' }; state.composer = null; state.editingTaskId = null; state.drawerOpen = false; return render();
      case 'view-upcoming': state.view = { type: 'upcoming' }; state.composer = null; state.editingTaskId = null; state.drawerOpen = false; return render();
      case 'select-project': state.view = { type: 'project', projectId: id }; state.composer = null; state.editingTaskId = null; state.drawerOpen = false; return render();
      case 'select-label': state.view = { type: 'label', labelId: id }; state.composer = null; state.editingTaskId = null; state.drawerOpen = false; return render();

      case 'topbar-add': {
        const v = state.view;
        if (v.type === 'project') state.composer = { projectId: v.projectId, sectionId: null, due: '' };
        else if (v.type === 'label') state.composer = { projectId: inbox().id, sectionId: null, due: '', labelIds: [v.labelId] };
        else state.composer = { projectId: inbox().id, sectionId: null, due: v.type === 'today' ? todayStr() : '' };
        state.editingTaskId = null;
        return render();
      }

      case 'new-project': state.modal = { type: 'project', color: COLORS[0], groupId: el.dataset.group ? Number(el.dataset.group) : null }; return render();
      case 'new-label': state.modal = { type: 'label', color: COLORS[0] }; return render();
      case 'modal-cancel': case 'modal-bg':
        if (action === 'modal-bg' && e.target.closest('[data-stop]')) return;
        state.modal = null; return render();
      case 'modal-color':
        state.modal.color = el.dataset.color;
        document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('sel', s.dataset.color === el.dataset.color));
        return;
      case 'modal-create-project': {
        const name = document.querySelector('.m-name').value.trim();
        if (!name) return toast('Give the list a name');
        const groupSel = document.querySelector('.m-group');
        const group_id = groupSel ? (groupSel.value ? Number(groupSel.value) : null) : (state.modal.groupId || null);
        const ps = state.projects.filter((p) => p.is_owner && !p.is_inbox).map((p) => p.position);
        const p = chk(await sb.from('projects').insert({ owner_id: uid, name, color: state.modal.color, group_id, position: (ps.length ? Math.max(...ps) : 0) + 1 }).select().single());
        state.modal = null; await loadState();
        state.view = { type: 'project', projectId: p.id };
        return render();
      }
      case 'new-group': {
        const name = prompt('Heading name:');
        if (!name || !name.trim()) return;
        const gs = (state.groups || []).map((g) => g.position);
        chk(await sb.from('project_groups').insert({ owner_id: uid, name: name.trim(), position: (gs.length ? Math.max(...gs) : 0) + 1 }));
        return reloadAndRender();
      }
      case 'rename-group': {
        const g = groupById(id);
        const name = prompt('Rename heading:', g ? g.name : '');
        if (!name || !name.trim()) return;
        chk(await sb.from('project_groups').update({ name: name.trim() }).eq('id', id));
        return reloadAndRender();
      }
      case 'delete-group': {
        if (!confirm('Delete this heading? Its lists move back to "My Projects" — nothing is deleted.')) return;
        chk(await sb.from('project_groups').delete().eq('id', id));
        return reloadAndRender();
      }
      case 'modal-create-label': {
        const name = document.querySelector('.m-name').value.trim();
        if (!name) return toast('Give the label a name');
        const l = chk(await sb.from('labels').insert({ owner_id: uid, name, color: state.modal.color }).select().single());
        state.modal = null; await loadState();
        state.view = { type: 'label', labelId: l.id };
        return render();
      }

      case 'delete-label': {
        if (!confirm('Delete this label? It will be removed from any tasks (the tasks stay).')) return;
        chk(await sb.from('labels').delete().eq('id', id));
        state.view = { type: 'today' }; return reloadAndRender();
      }

      case 'share-open': state.modal = { type: 'share', projectId: id }; return render();
      case 'share-submit': {
        const email = document.querySelector('.m-email').value.trim().toLowerCase();
        if (!email) return toast('Enter an email');
        const prof = chk(await sb.from('profiles').select('id').eq('email', email).maybeSingle());
        if (!prof) return toast('No user with that email — they need to sign up first');
        if (prof.id === uid) return toast('You already own this project');
        const r = await sb.from('project_members').insert({ project_id: id, user_id: prof.id, role: 'member' });
        if (r.error && !/duplicate|unique/i.test(r.error.message)) throw new Error(r.error.message);
        await loadState(); toast('Invited!'); return render();
      }
      case 'share-remove': {
        chk(await sb.from('project_members').delete().eq('project_id', Number(el.dataset.project)).eq('user_id', el.dataset.user));
        await loadState(); return render();
      }

      case 'delete-project': {
        const p = byId(id);
        if (!confirm(p.is_owner ? `Delete “${p.name}” and all its tasks?` : `Leave “${p.name}”?`)) return;
        if (p.is_owner) chk(await sb.from('projects').delete().eq('id', id));
        else chk(await sb.from('project_members').delete().eq('project_id', id).eq('user_id', uid));
        state.view = { type: 'today' }; return reloadAndRender();
      }
      case 'add-section': {
        const name = prompt('Section name:');
        if (!name || !name.trim()) return;
        const ss = state.projects.find((p) => p.id === id)?.sections.map((s) => s.position) || [];
        chk(await sb.from('sections').insert({ project_id: id, name: name.trim(), position: (ss.length ? Math.max(...ss) : 0) + 1 }));
        return reloadAndRender();
      }
      case 'delete-section': {
        if (!confirm('Delete this section? Tasks inside it will move to the project root.')) return;
        chk(await sb.from('tasks').update({ section_id: null }).eq('section_id', id));
        chk(await sb.from('sections').delete().eq('id', id));
        return reloadAndRender();
      }

      case 'add-task-open':
        state.editingTaskId = null;
        state.composer = {
          projectId: Number(el.dataset.project),
          sectionId: el.dataset.section ? Number(el.dataset.section) : null,
          due: el.dataset.due || '',
          labelIds: el.dataset.labels ? el.dataset.labels.split(',').filter(Boolean).map(Number) : [],
        };
        return render();
      case 'composer-details': {
        const box = el.closest('[data-composer]');
        if (box) {
          box.querySelector('[data-details]')?.removeAttribute('hidden');
          el.remove(); // drop the "Add details" toggle once expanded
          box.querySelector('.c-desc')?.focus();
        }
        return; // no re-render — keeps the half-typed task name intact
      }
      case 'composer-cancel': state.composer = null; return render();
      case 'composer-save': {
        const box = el.closest('[data-composer]');
        const content = box.querySelector('.c-content').value.trim();
        if (!content) return toast('Task name is required');
        const projSel = box.querySelector('.c-project');
        const assignee = box.querySelector('.e-assignee');
        const projectId = projSel ? Number(projSel.value) : state.composer.projectId;
        const t = chk(await sb.from('tasks').insert({
          project_id: projectId,
          section_id: state.composer.sectionId,
          content,
          description: box.querySelector('.c-desc').value.trim(),
          due_date: box.querySelector('.c-due').value || null,
          assigned_to: assignee && assignee.value ? assignee.value : null,
          position: nextPos(projectId),
        }).select().single());
        await setTaskLabels(t.id, gatherLabelIds(box));
        await loadState();
        return render(); // keep composer open for rapid entry
      }

      case 'toggle-label-chip':
        el.classList.toggle('sel');
        el.style.background = el.classList.contains('sel') ? el.dataset.color : '';
        return;

      case 'task-toggle': {
        const t = state.tasks.find((x) => x.id === id);
        chk(await sb.from('tasks').update({ completed: !t.completed, completed_at: !t.completed ? new Date().toISOString() : null }).eq('id', id));
        return reloadAndRender();
      }
      case 'sync': {
        await reloadAndRender();
        toast('Synced ✓');
        return;
      }
      case 'task-edit': state.composer = null; state.editingTaskId = id; return render();
      case 'editor-cancel': state.editingTaskId = null; return render();
      case 'editor-save': {
        const box = el.closest('[data-editor]');
        const content = box.querySelector('.e-content').value.trim();
        if (!content) return toast('Task name is required');
        const assignee = box.querySelector('.e-assignee');
        chk(await sb.from('tasks').update({
          content,
          description: box.querySelector('.e-desc').value.trim(),
          due_date: box.querySelector('.e-due').value || null,
          project_id: Number(box.querySelector('.e-project').value),
          assigned_to: assignee && assignee.value ? assignee.value : null,
        }).eq('id', id));
        await setTaskLabels(id, gatherLabelIds(box));
        state.editingTaskId = null;
        return reloadAndRender();
      }
      case 'task-delete':
        chk(await sb.from('tasks').delete().eq('id', id));
        return reloadAndRender();
    }
  } catch (err) { toast(err.message); }
});

/* ---------------- Move a list to a different heading (select change) ---------------- */
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-action="move-project-group"]');
  if (!el) return;
  try {
    chk(await sb.from('projects').update({ group_id: el.value ? Number(el.value) : null }).eq('id', Number(el.dataset.id)));
    await reloadAndRender();
  } catch (err) { toast(err.message); }
});

/* ---------------- Swipe gestures (touch) ---------------- */
let swp = null;
document.addEventListener('touchstart', (e) => {
  const inner = e.target.closest('.task-inner');
  if (!inner || e.touches.length !== 1) { swp = null; return; }
  swp = { inner, task: inner.closest('.task'), x0: e.touches[0].clientX, y0: e.touches[0].clientY, dx: 0, decided: false, horizontal: false };
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!swp) return;
  const dx = e.touches[0].clientX - swp.x0;
  const dy = e.touches[0].clientY - swp.y0;
  if (!swp.decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { swp.decided = true; swp.horizontal = Math.abs(dx) > Math.abs(dy); }
  if (swp.decided && swp.horizontal) {
    e.preventDefault();
    swp.dx = dx;
    swp.inner.style.transition = 'none';
    swp.inner.style.transform = `translateX(${dx}px)`;
    swp.task.classList.toggle('swipe-right', dx > 0);
    swp.task.classList.toggle('swipe-left', dx < 0);
  }
}, { passive: false });

document.addEventListener('touchend', async () => {
  if (!swp || !swp.horizontal) { swp = null; return; }
  const { inner, task, dx } = swp;
  const id = Number(task.dataset.task);
  swp = null;
  inner.style.transition = 'transform .2s ease';
  const TH = 80;
  try {
    if (dx > TH) {
      inner.style.transform = 'translateX(110%)';
      const t = state.tasks.find((x) => x.id === id);
      chk(await sb.from('tasks').update({ completed: !t.completed, completed_at: !t.completed ? new Date().toISOString() : null }).eq('id', id));
      await reloadAndRender();
    } else if (dx < -TH) {
      inner.style.transform = 'translateX(-110%)';
      chk(await sb.from('tasks').delete().eq('id', id));
      await reloadAndRender();
    } else {
      inner.style.transform = '';
      task.classList.remove('swipe-left', 'swipe-right');
    }
  } catch (err) { toast(err.message); render(); }
});

/* ---------------- Boot ---------------- */
(async function init() {
  applyTheme();
  if (!window.CONFIG || !CONFIG.url || CONFIG.url.includes('YOUR_')) return renderConfigError();
  // This app lives in its own `tasks_app` schema (shares the Supabase project
  // with the Deals App / site-visit app, but never touches their `public` tables).
  // `tasks_app` must be added under Project Settings → API → Exposed schemas.
  //
  // IMPORTANT: this app is served from the SAME origin as the Site Visits / Deals
  // apps (all under adrianyeo77-coder.github.io) and uses the SAME Supabase project.
  // supabase-js defaults its session storage key to `sb-<project-ref>-auth-token`,
  // so without a distinct storageKey ALL those apps would share one login slot and
  // clobber each other's session (logging into one logs the others out / invalidates
  // their refresh token). A unique storageKey isolates this app's login completely.
  sb = window.supabase.createClient(CONFIG.url, CONFIG.anonKey, {
    db: { schema: 'tasks_app' },
    auth: {
      storageKey: 'atera-tasks-auth',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { state.user = null; state.authView = 'pick'; state.authRole = null; render(); }
  });
  try { await loadState(); } catch (e) { console.error(e); state.user = null; }
  if (state.user) subscribeRealtime();
  render();
})();
