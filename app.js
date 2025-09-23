// Barn Strong v2.2 (optimized base) — minimal core with clean seams
// Helpers
const qs = s => document.querySelector(s);
const qsa = s => [...document.querySelectorAll(s)];
const ls = { get(k,f){ try{return JSON.parse(localStorage.getItem(k)) ?? f}catch{return f} }, set(k,v){ localStorage.setItem(k, JSON.stringify(v)) }, rm(k){ localStorage.removeItem(k) } };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

// Theme install banner (kept, no analytics yet)
let deferredPrompt; const installBtn = () => qs('#installBtn');
window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt = e; installBtn() && (installBtn().hidden=false); });
qsa('#installBtn').forEach(btn=> btn.addEventListener('click', async()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; btn.hidden=true; }));

// Firebase init (compat, kept simple)
let app, auth, db;
async function initFirebase(){
  const cfg = window.__FIREBASE_CONFIG__ || {};
  if(!cfg.apiKey){ console.warn('No Firebase config. Running in local demo mode.'); return; }
  app = firebase.initializeApp(cfg);
  auth = firebase.auth();
  db = firebase.firestore();
  try{ await db.enablePersistence({synchronizeTabs:true}); }catch(e){ console.warn('persistence', e); }
}

// State
const state = { user:null, profile:null, sessionsMap:{}, logs:[], exercises:[], program:[], unsub:[] };

// Router
const routes = {};
function route(path, fn){ routes[path]=fn; }
function go(path){ location.hash = path; }
window.addEventListener('hashchange', render);
function page(title, body){
  const root = qs('#root'); root.innerHTML='';
  const card = document.createElement('section'); card.className='card';
  card.innerHTML = `<div class="section-head"><h2>${title}</h2></div>`;
  if(typeof body==='string'){ const d=document.createElement('div'); d.innerHTML=body; card.appendChild(d); }
  else if(body instanceof HTMLElement){ card.appendChild(body); }
  else if(Array.isArray(body)){ body.forEach(x=>card.appendChild(x)); }
  root.appendChild(card);
}

// ---- v2.3: lightweight analytics + helpers ----
function logEvent(name, data = {}) {
  if (!db || !state.user) return; // still no-op if running local demo
  const ref = db.collection('events').doc(state.user.uid).collection('app').doc();
  ref.set({
    name,
    ...data,
    ts: firebase.firestore.FieldValue.serverTimestamp()
  }).catch(()=>{});
}

// v2.3: network banner
function setNetBanner(){
  const b = document.getElementById('netBanner');
  if(!b) return;
  const online = navigator.onLine;
  b.textContent = online ? 'Online — changes sync automatically' : 'Offline — changes will sync when back online';
  b.style.background = online ? '#1e3a1e' : '#5a1a1a';
  b.hidden = false;
}
window.addEventListener('online', setNetBanner);
window.addEventListener('offline', setNetBanner);

// Pages
function Login(){
  const wrap = document.createElement('div');
  wrap.className='login-wrap card';
  wrap.innerHTML = `
    <img class="brand-logo" src="assets/mascot.svg" alt="Barn Strong"/>
    <h2>Welcome to Barn Strong</h2>
    <p class="muted">Log in to start training.</p>
    <div class="grid">
      <label>Email<input id="email" type="email" placeholder="you@barnstrong.fit"/></label>
      <label>Password<input id="pass" type="password" placeholder="••••••••"/></label>
      <button id="loginBtn" class="btn">Log In</button>
      <button id="signupBtn" class="btn ghost">Create Account</button>
      <button id="resetBtn" class="btn ghost">Forgot Password</button>
    </div>
    <div class="divider"></div>
    <p class="muted small">Tip: without Firebase config this runs locally for demo.</p>
  `;
  wrap.querySelector('#loginBtn').addEventListener('click', async()=>{
    const email = wrap.querySelector('#email').value.trim();
    const pass = wrap.querySelector('#pass').value.trim();
    if(auth){
      try{ await auth.signInWithEmailAndPassword(email, pass); }catch(e){ alert(e.message); }
    }else{
      state.user = { uid:'local', email };
      state.profile = ls.get('bs_profile', { username: email.split('@')[0], goal:'', trainerCode:'BARN'});
      ensureLocalExercises();
      // v2.3: seed a full exercise library for first-time cloud users
async function ensureExercises(){
  if(!db || !state.user) return;
  try{
    const snap = await db.collection('users').doc(state.user.uid).collection('exercises').limit(1).get();
    if(snap.empty){
      const batch = db.batch();
      const ref = db.collection('users').doc(state.user.uid).collection('exercises');
      DEFAULT_EXERCISES.forEach(name=>{
        const id = slug(name);
        batch.set(ref.doc(id), { name });
      });
      await batch.commit();
    }
  }catch(e){ console.warn('ensureExercises error', e); }
}

      go('/dashboard');
    }
  });
  wrap.querySelector('#signupBtn').addEventListener('click', async()=>{
    if(!auth) return alert('Connect Firebase to enable signup.');
    const email = wrap.querySelector('#email').value.trim(); const pass = wrap.querySelector('#pass').value.trim();
    try{ await auth.createUserWithEmailAndPassword(email, pass); alert('Account created! Verify your email.'); }catch(e){ alert(e.message); }
  });
  wrap.querySelector('#resetBtn').addEventListener('click', async()=>{
    if(!auth) return alert('Connect Firebase to enable reset.');
    const email = wrap.querySelector('#email').value.trim();
    try{ await auth.sendPasswordResetEmail(email); alert('Reset email sent!'); }catch(e){ alert(e.message); }
  });
  qs('#root').innerHTML=''; qs('#root').appendChild(wrap);
}

function Dashboard(){
  const totalSessions = new Set(state.logs.map(h=>h.date)).size;
  const streak = calcStreak(state.logs);
  const next = findNextSession(state.sessionsMap || {});
  const { adherence7, adherence30 } = calcAdherence(state.sessionsMap || {}, state.logs || []);
  const { prCount } = detectPRs(state.logs || []);
  const volume7 = rollingVolume(state.logs || [], 7);

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="kpi">
      <div class="tile"><div class="title">Sessions Completed</div><div class="value">${totalSessions}</div></div>
      <div class="tile"><div class="title">Current Streak</div><div class="value">${streak} days</div></div>
      <div class="tile"><div class="title">Next Session</div><div>${ next ? (next.date+' — '+next.title) : 'No upcoming' }</div></div>
      <div class="tile"><div class="title">Adherence (7d)</div><div class="value">${adherence7}%</div></div>
      <div class="tile"><div class="title">Adherence (30d)</div><div class="value">${adherence30}%</div></div>
      <div class="tile"><div class="title">PRs Found</div><div class="value">${prCount}</div></div>
      <div class="tile"><div class="title">Volume (7d)</div><div class="value">${volume7}</div></div>
    </div>
    <div class="divider"></div>
    <div class="chips">
      <a class="chip" href="#/today">Today’s Session</a>
      <a class="chip" href="#/calendar">Calendar</a>
      <a class="chip" href="#/variations">Variation Record</a>
      <a class="chip" href="#/program">Program View</a>
      <a class="chip" href="#/exercises">Exercise Library</a>
      <a class="chip" href="#/coach">Coach Portal</a>
    </div>
  `;
  page('Dashboard', el);
}

// helpers used above
function calcStreak(logs){
  const days = new Set((logs||[]).map(h=>h.date));
  let streak=0; const today = new Date();
  while(true){ const d=new Date(today); d.setDate(today.getDate()-streak); const key=d.toISOString().slice(0,10); if(days.has(key)) streak++; else break; }
  return streak;
}
function calcAdherence(sessionsMap, logs){
  function addDays(iso, delta){ const d = new Date(iso); d.setDate(d.getDate()+delta); return d.toISOString().slice(0,10); }
  const today = new Date().toISOString().slice(0,10);
  function within(days){
    const set = new Set((logs||[]).filter(h=> h.date >= addDays(today, -days)).map(h=>h.date));
    let scheduled = 0, completed = 0;
    Object.values(sessionsMap||{}).forEach(s=>{
      if (s.date >= addDays(today, -days) && s.date <= today){ scheduled++; if(set.has(s.date)) completed++; }
    });
    return scheduled ? Math.round((completed/scheduled)*100) : 0;
  }
  return { adherence7: within(7), adherence30: within(30) };
}
function detectPRs(logs){
  const best = {};
  (logs||[]).forEach(l=>{ const score = (l.weight||0) * (l.reps||1); const k = l.exercise||'?'; if(!best[k] || score > best[k]) best[k] = score; });
  return { prCount: Object.keys(best).length };
}
function rollingVolume(logs, days){
  function addDays(iso, delta){ const d = new Date(iso); d.setDate(d.getDate()+delta); return d.toISOString().slice(0,10); }
  const start = addDays(new Date().toISOString().slice(0,10), -days);
  let sum = 0;
  (logs||[]).forEach(l=>{ if(l.date >= start){ const s = (l.weight||0) * (l.reps||1) * (l.sets||1); sum += s; } });
  return sum;
}


function CalendarPage(){
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1), startDow = first.getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const el = document.createElement('div'); el.className='calendar';
  const header = document.createElement('div'); header.className='row';
  header.innerHTML = `<strong>${now.toLocaleString(undefined,{month:'long'})} ${y}</strong>`; el.appendChild(header);
  const grid = document.createElement('div'); grid.className='grid';
  ['S','M','T','W','T','F','S'].forEach(d=>{ const h=document.createElement('div'); h.className='muted small center'; h.textContent=d; grid.appendChild(h); });
  for(let i=0;i<startDow;i++) grid.appendChild(document.createElement('div'));
  for(let d=1; d<=daysInMonth; d++){
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const cell = document.createElement('div'); cell.className='cell';
    cell.innerHTML = `<div class="bold">${d}</div>`;
    if(state.sessionsMap[dateStr]){ const dot=document.createElement('span'); dot.className='dot'; cell.appendChild(dot); cell.title=state.sessionsMap[dateStr].title; cell.style.cursor='pointer'; cell.addEventListener('click',()=> go('/today')); }
    if(dateStr===new Date().toISOString().slice(0,10)) cell.classList.add('today');
    grid.appendChild(cell);
  }
  el.appendChild(grid); page('Calendar', el);
}

function TodaysSession(){
  const today = new Date().toISOString().slice(0,10);
  const sess = (state.sessionsMap || {})[today];
  const el = document.createElement('div');

  if(!sess){
    const next = findNextSession(state.sessionsMap || {});
    el.innerHTML = `<p>No session scheduled for today.</p><p class="muted">Next: ${next? (next.date+' — '+next.title) : 'No upcoming'}</p>`;
    logEvent('session_opened', { date: today, scheduled: false });
    return page("Today's Session", el);
  }

  const status = sess.status || 'planned';
  const header = document.createElement('div');
  header.className = 'row';
  header.innerHTML = `
    <div class="chip">Status: ${status}</div>
    <button class="btn small" id="startBtn">Start</button>
    <button class="btn small" id="completeBtn">Complete</button>
  `;
  el.appendChild(header);

  const list = document.createElement('ul'); list.className='list';
  const blocks = sess.blocks || sess.planned || sess.exercises || [];

  blocks.forEach(ex=>{
    const setCount = ex.sets || ex.setCount || 1;
    const plannedReps = ex.reps ?? ex.targetReps ?? '';
    const rows = document.createElement('div');
    rows.className = 'grow';

    let html = `<div class="bold">${ex.name}</div><div class="muted small">${setCount} x ${plannedReps}${ex.weight? ' @ '+ex.weight+' lb':''}</div>`;
    for(let i=1;i<=setCount;i++){
      html += `
        <div class="row mt">
          <span class="small muted">Set ${i}</span>
          <label>Weight <input class="w" type="number" value="${ex.weight??''}"/></label>
          <label>Reps <input class="r" type="number" placeholder="${plannedReps}"/></label>
          <button class="btn small log" data-set="${i}">Log set</button>
        </div>`;
    }
    rows.innerHTML = html;

    const li = document.createElement('li'); li.className='item';
    li.appendChild(rows);
    list.appendChild(li);

    rows.querySelectorAll('.log').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const wrap = btn.parentElement;
        const w = parseFloat(wrap.querySelector('.w').value||'') || null;
        const r = parseInt(wrap.querySelector('.r').value||plannedReps,10) || null;
        const setNum = parseInt(btn.dataset.set,10) || 1;

        state.logs.unshift({date: today, exercise: ex.name, weight: w, reps: r, sets: 1});

        if(db && state.user){
          try{
            await db.collection('logs').doc(state.user.uid).collection('entries').add({
              date: today, exercise: ex.name, weight: w, reps: r, sets: 1, source:'set', createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('sessions').doc(state.user.uid).collection('days').doc(today).set({ status: 'in_progress' }, { merge: true });
          }catch(e){ console.warn(e); }
        }else{
          const local = ls.get('bs_logs',[]); local.unshift({date: today, exercise: ex.name, weight: w, reps: r, sets: 1}); ls.set('bs_logs', local);
        }
        logEvent('set_logged', { date: today, exercise: ex.name, weight: w, reps: r, set: setNum });
        btn.textContent = 'Logged ✓';
      });
    });
  });

  el.appendChild(list);
  page("Today's Session", el);

  el.querySelector('#startBtn')?.addEventListener('click', async ()=>{
    if(db && state.user){
      await db.collection('sessions').doc(state.user.uid).collection('days').doc(today).set({ status: 'in_progress', startedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    logEvent('session_started', { date: today });
    location.hash = '#/today';
  });
  el.querySelector('#completeBtn')?.addEventListener('click', async ()=>{
    if(db && state.user){
      await db.collection('sessions').doc(state.user.uid).collection('days').doc(today).set({ status: 'completed', completedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    logEvent('session_completed', { date: today });
    location.hash = '#/today';
  });

  logEvent('session_opened', { date: today, scheduled: true, title: sess.title||'' });
}


function VariationRecord(){
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="grid two">
      <input id="q" placeholder="Search exercise (e.g., Bench Press)"/>
      <select id="sort">
        <option value="recent">Sort: Most recent</option>
        <option value="best">Sort: Best set</option>
        <option value="heaviest">Sort: Heaviest weight</option>
      </select>
    </div>
    <div class="row mt">
      <label>From <input id="from" type="date"/></label>
      <label>To <input id="to" type="date"/></label>
      <button id="clearFilters" class="btn ghost">Clear</button>
    </div>
  `;
  const ul = document.createElement('ul'); ul.className='list mt';

  function renderList(){
    ul.innerHTML = '';
    const q = root.querySelector('#q').value.trim().toLowerCase();
    const from = root.querySelector('#from').value || '0000-00-00';
    const to   = root.querySelector('#to').value || '9999-12-31';
    const sort = root.querySelector('#sort').value;

    const names = new Set([...(state.exercises||[]), ...state.logs.map(h=>h.exercise)]);
    const list = [...names].filter(n=> n && (!q || n.toLowerCase().includes(q))).sort();

    list.forEach(name=>{
      const entries = state.logs.filter(h=> h.exercise===name && h.date >= from && h.date <= to);

      const preview = entries.slice().sort((a,b)=> b.date.localeCompare(a.date));
      const text = preview.slice(0,5).map(h=>{
        const wt = (h.weight!=null ? `${h.weight} lb` : '');
        const reps = (h.reps!=null ? ` x ${h.reps}` : '');
        const sets = (h.sets!=null ? `, sets ${h.sets}` : '');
        return `${h.date}: ${wt}${reps}${sets}`;
      }).join('<br/>') || '—';

      const scoreBest = Math.max(0, ...entries.map(h => (h.weight||0) * (h.reps||1)));
      const scoreHeaviest = Math.max(0, ...entries.map(h => (h.weight||0)));

      const li = document.createElement('li'); li.className='item';
      li.innerHTML = `<div class="grow">
        <div class="bold">${name}</div>
        <div class="muted small">${text}</div>
        <div class="row mt">
          <label>Date <input class="d" type="date"/></label>
          <label>Weight <input class="w" type="number" placeholder="lb"/></label>
          <label>Sets <input class="s" type="number" placeholder="e.g., 4"/></label>
          <label>Reps <input class="r" type="number" placeholder="e.g., 6"/></label>
          <button class="btn small add">Add past set</button>
        </div>
      </div>`;

      li.querySelector('.add').addEventListener('click', async()=>{
        const d = li.querySelector('.d').value || new Date().toISOString().slice(0,10);
        const w = parseFloat(li.querySelector('.w').value||'') || null;
        const s = parseInt(li.querySelector('.s').value||'') || null;
        const r = parseInt(li.querySelector('.r').value||'') || null;
        state.logs.unshift({date:d, exercise:name, weight:w, sets:s, reps:r});
        if(db && state.user){
          try{
            await db.collection('logs').doc(state.user.uid).collection('entries').add({
              date: d, exercise: name, weight: w, sets: s, reps: r, source:'retro',
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          }catch(e){ console.warn(e); }
        }else{
          const local = ls.get('bs_logs',[]); local.unshift({date:d, exercise:name, weight:w, sets:s, reps:r}); ls.set('bs_logs', local);
        }
        logEvent('retro_logged', { exercise: name, weight: w, reps: r });
        renderList();
      });

      li.dataset.sortRecent = entries.length ? Math.max(...entries.map(e=> e.date)) : '';
      li.dataset.sortBest = scoreBest;
      li.dataset.sortHeaviest = scoreHeaviest;

      ul.appendChild(li);
    });

    const items = Array.from(ul.children);
    items.sort((a,b)=>{
      if(sort==='best') return (+b.dataset.sortBest||0) - (+a.dataset.sortBest||0);
      if(sort==='heaviest') return (+b.dataset.sortHeaviest||0) - (+a.dataset.sortHeaviest||0);
      return (b.dataset.sortRecent||'').localeCompare(a.dataset.sortRecent||'');
    }).forEach(li=> ul.appendChild(li));

    if(!ul.children.length){
      const li = document.createElement('li'); li.className='item';
      li.innerHTML = `<div class="muted">No matching records yet.</div>`; ul.appendChild(li);
    }
  }

  root.appendChild(ul);
  root.querySelector('#q').addEventListener('input', renderList);
  root.querySelector('#sort').addEventListener('change', renderList);
  root.querySelector('#from').addEventListener('change', renderList);
  root.querySelector('#to').addEventListener('change', renderList);
  root.querySelector('#clearFilters').addEventListener('click', ()=>{
    root.querySelector('#q').value = '';
    root.querySelector('#from').value = '';
    root.querySelector('#to').value = '';
    root.querySelector('#sort').value = 'recent';
    renderList();
  });
  renderList();
  page('Variation Record', root);
}


function ProgramView(){
  const el = document.createElement('div');
  if(!state.program.length) el.innerHTML = `<p class="muted">No program published yet.</p>`;
  page('Program View', el);
}

function ExerciseLibrary(){
  const root = document.createElement('div');
  const list = document.createElement('ul'); list.className='list';
  const arr = (state.exercises||[]).slice().sort();
  if(!arr.length){ list.innerHTML = `<li class="item"><div class="muted">No exercises yet.</div></li>`; }
  arr.forEach(name=>{
    const li = document.createElement('li'); li.className='item';
    li.innerHTML = `<div class="grow"><div class="bold">${name}</div><div class="muted small">Use "Variation Record" to add history</div></div>`;
    list.appendChild(li);
  });
  const form = document.createElement('div'); form.className='row mt';
  form.innerHTML = `<label>New exercise <input id="exName" placeholder="e.g., Bulgarian Split Squat"/></label><button id="addEx" class="btn">Add</button>`;
  form.querySelector('#addEx').addEventListener('click', async()=>{
    const name = form.querySelector('#exName').value.trim(); if(!name) return;
    if(db && state.user){
      try{ await db.collection('users').doc(state.user.uid).collection('exercises').doc(slug(name)).set({ name }); }
      catch(e){ return alert(e.message); }
    }else{
      const local = ls.get('bs_exercises', DEFAULT_EXERCISES);
      if(!local.includes(name)) local.push(name);
      ls.set('bs_exercises', local); state.exercises = local;
    }
    location.hash = '#/exercises';
  });
  page('Exercise Library', [form, list]);
}

function CoachPortal(){
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="grid two">
      <label>Trainer Code <input id="tc" placeholder="BARN"/></label>
      <label>Week Number <input id="wk" type="number" min="1" value="1"/></label>
    </div>
    <div class="divider"></div>
    <div id="sessions"></div>
    <div class="row mt">
      <button class="btn" id="addSession">+ Add Session</button>
      <button class="btn ghost" id="dupWeek">Duplicate Week</button>
    </div>
    <div class="divider"></div>
    <button id="publish" class="btn">Publish Week</button>
    <div id="out" class="mt muted small"></div>
  `;

  const sessions = [];
  const sessionsWrap = root.querySelector('#sessions');

  function renderSessionCard(idx){
    const s = sessions[idx];
    const card = document.createElement('div'); card.className='item'; card.dataset.idx = idx;
    card.innerHTML = `
      <div class="grow">
        <div class="grid two">
          <label>Date <input class="date" value="${s.date||''}" placeholder="YYYY-MM-DD"/></label>
          <label>Title <input class="title" value="${s.title||''}" placeholder="Upper A"/></label>
        </div>
        <div class="divider"></div>
        <div class="small muted">Exercises</div>
        <div class="list exlist"></div>
        <div class="row mt">
          <input class="exname" placeholder="Exercise name"/>
          <input class="exsets" type="number" placeholder="Sets"/>
          <input class="exreps" type="number" placeholder="Reps"/>
          <input class="exload" type="number" placeholder="Target lb"/>
          <button class="btn small addEx">Add</button>
          <button class="btn small ghost dup">Duplicate session</button>
          <button class="btn small danger del">Delete session</button>
        </div>
      </div>
    `;
    const exlist = card.querySelector('.exlist');
    (s.blocks||[]).forEach((b, i)=>{
      const row = document.createElement('div'); row.className='item';
      row.innerHTML = `<div class="grow">${b.name} — ${b.sets||1} x ${b.reps||''}${b.weight? ' @ '+b.weight+' lb':''}</div>`;
      exlist.appendChild(row);
    });

    card.querySelector('.addEx').addEventListener('click', ()=>{
      const name = card.querySelector('.exname').value.trim();
      const sets = parseInt(card.querySelector('.exsets').value||'') || 1;
      const reps = parseInt(card.querySelector('.exreps').value||'') || null;
      const weight = parseFloat(card.querySelector('.exload').value||'') || null;
      if(!sessions[idx].blocks) sessions[idx].blocks = [];
      sessions[idx].blocks.push({ name, sets, reps, weight });
      render();
    });
    card.querySelector('.dup').addEventListener('click', ()=>{
      const clone = JSON.parse(JSON.stringify(sessions[idx]));
      sessions.push(clone); render();
    });
    card.querySelector('.del').addEventListener('click', ()=>{
      sessions.splice(idx,1); render();
    });
    card.querySelector('.date').addEventListener('input', e=> sessions[idx].date = e.target.value);
    card.querySelector('.title').addEventListener('input', e=> sessions[idx].title = e.target.value);

    return card;
  }

  function render(){
    sessionsWrap.innerHTML = '';
    sessions.forEach((_, i)=> sessionsWrap.appendChild(renderSessionCard(i)));
  }

  root.querySelector('#addSession').addEventListener('click', ()=>{ sessions.push({ date:'', title:'', blocks:[] }); render(); });

  root.querySelector('#dupWeek').addEventListener('click', ()=>{
    const copies = sessions.map(s=> JSON.parse(JSON.stringify(s)));
    sessions.push(...copies); render();
  });

  root.querySelector('#publish').addEventListener('click', async()=>{
    const tc = (root.querySelector('#tc').value.trim() || 'BARN');
    const weekNumber = parseInt(root.querySelector('#wk').value||'1',10);
    if(!db || !state.user){ alert('Login + Firebase required'); return }
    try{
      await db.collection('programs').doc(tc).collection('weeks').doc(String(weekNumber))
        .set({ weekNumber, sessions }, { merge: true });
      logEvent('program_published', { weekNumber, sessionCount: sessions.length });
      alert('Published!');
      root.querySelector('#out').textContent = `Published week ${weekNumber} with ${sessions.length} sessions.`;
    }catch(e){ alert(e.message) }
  });

  page('Coach Portal', root);
}


function Settings(){
  const el = document.createElement('div');
  const username = state.profile?.username || (state.user?.email?.split('@')[0] || '');
  const goal = state.profile?.goal || '';
  const trainerCode = state.profile?.trainerCode || 'BARN';
  el.innerHTML = `
    <div class="grid two">
      <label>Username <input id="un" value="${username}"/></label>
      <label>Goal <input id="go" value="${goal}"/></label>
      <label>Trainer Code <input id="tc" value="${trainerCode}"/></label>
    </div>
    <div class="row mt"><button id="save" class="btn">Save</button></div>`;
  el.querySelector('#save').addEventListener('click', async()=>{
    const payload = {
      username: el.querySelector('#un').value.trim(),
      goal: el.querySelector('#go').value.trim(),
      trainerCode: el.querySelector('#tc').value.trim() || 'BARN',
      updatedAt: firebase?.firestore?.FieldValue?.serverTimestamp?.() || null
    };
    state.profile = Object.assign({}, state.profile || {}, payload);
    if(db && state.user){ await db.collection('users').doc(state.user.uid).set(state.profile, {merge:true}); }
    else { ls.set('bs_profile', state.profile); }
    alert('Saved');
  });
  page('Settings', el);
}

// Defaults (seed for v2.2, replace in v2.3)
const DEFAULT_EXERCISES = [
  "1RM Touch and Go Bench",
  "Touch and Go Bench Backdowns",
  "Mega Mass Incline Press",
  "Dumbbell Lateral Raise",
  "JM Press",
  "Meadows Rows",
  "Pullup",
  "Rear Delt Flye",
  "Hammer Curls",
  "Decline Crunch",
  "Reverse Banded Cambered Bar Free Squat",
  "Front Squat",
  "Barbell RDL"
  "Barbell Walking Lunge",
  "Leg Extension",
  "Glute Ham Developer",
  "Lower Back Hyperextension",
  "Touch and Go Bench",
  "Standing Overhead Press",
  "Mega Mass Flat Press",
  "Bilateral Machine Row",
  "Banded Crunch",
  "1RM Deficit Beltless Conventional Deadlift from Two Mats plus Chain",
  "Deficit Beltless Conventional Deadlift from Two Mats plus Chain Backdowns",
  "Belt Squat to Box",
  "1RM Spoto Press",
  "Spoto Press Backdowns",
  "1RM Duffalo Squat to Box against Orange Bands",
  "Duffalo Squat to Box against Orange Bands Backdowns",
  "1RM Close Grip Bench (Paused)",
  "Close Grip Bench Backdowns (Paused)",
  "Incline Dumbbell Bench",
  "Barbell Pullover Press",
  "Yates Rows",
  "Behind-the-Neck Pulldowns",
  "Open Palm Curls",
  "Band-Assisted V-Ups",
  "Safety Squat Bar Goodmornings",
  "Bulgarian Split Squat",
  "Reverse Hyperextension",
  "Hamstring Curl",
  "Unilateral Machine Row",
  "1RM Two-Mat Deficit Sumo Deadlift",
  "1RM Comp Bench against Quadded Red Bands",
  "Comp Bench against Quadded Red Bands Backdowns",
  "Duffalo Squat to box against Orange Bands",
  "Manta Squat",
  "Close Grip Bench (paused)",
  "Standing Behind-the-Neck Press",
  "Flat Dumbbell Press",
  "1RM Cambered Bar squat to Box plus Chain",
  "Cambered Bar squat to Box plus Chain Backdowns",
  "Safety Squat Bar Squat to Box"
];

function ensureLocalExercises(){
  if(!ls.get('bs_exercises')) ls.set('bs_exercises', DEFAULT_EXERCISES);
  state.exercises = ls.get('bs_exercises', DEFAULT_EXERCISES);
}

// Simple utils
function findNextSession(map){
  const today = new Date().toISOString().slice(0,10);
  const future = Object.values(map).filter(s => (s.date||'') >= today).sort((a,b)=> (a.date||'').localeCompare(b.date));
  return future[0];
}

const drawer = qs('#drawer'), scrim = qs('#scrim');
qs('#hamburger').addEventListener('click', ()=> openDrawer(true));
scrim.addEventListener('click', ()=> openDrawer(false));
function openDrawer(open){ drawer.classList.toggle('open', open); scrim.hidden = !open; }

// Routes
route('/login', Login);
route('/dashboard', Dashboard);
route('/calendar', CalendarPage);
route('/today', TodaysSession);
route('/variations', VariationRecord);
route('/program', ProgramView);
route('/exercises', ExerciseLibrary);
route('/coach', CoachPortal);
route('/settings', Settings);
route('/404', ()=> page('Not found', `<p class="muted">Page not found.</p>`));

// Auth glue
async function main(){
  await initFirebase();
  if(auth){
    auth.onAuthStateChanged(async(user)=>{
      state.user = user;
      if(!user){ return go('/login'); }
      const uref = db.collection('users').doc(user.uid);
      const snap = await uref.get();
      if(!snap.exists){ await uref.set({ username: user.email.split('@')[0], goal:'', trainerCode:'BARN', createdAt: firebase.firestore.FieldValue.serverTimestamp() }); }
      // Streams kept minimal in v2.2; v2.3 will attach program/sessions listeners
      db.collection('users').doc(user.uid).collection('exercises').onSnapshot(s=>{
        state.exercises = s.docs.map(d=> d.data().name).sort();
      });
      db.collection('logs').doc(user.uid).collection('entries').orderBy('date','desc').limit(300).onSnapshot(s=>{ state.logs = s.docs.map(d=> d.data()); });
      go('/dashboard');
    });
  }else{
    const demoUser = ls.get('bs_demo_user') || { uid:'local', email:'demo@barnstrong.fit' };
    state.user = demoUser; ensureLocalExercises(); 
    await ensureExercises(); // v2.3: seed exercises for first-time cloud users
go('/dashboard');
  }
  render();
  setTimeout(setNetBanner, 500); // v2.3: show online/offline status after first render
}

function render(){
  const path = location.hash.replace('#','') || '/login';
  const authed = !!state.user;
  qs('#drawerName').textContent = state.profile?.username || (state.user?.email || 'Guest');
  qs('#drawerGoal').textContent = 'Goal: ' + (state.profile?.goal || '—');
  if(!authed && path !== '/login') return go('/login');
  (routes[path] || routes['/404'])();
}

document.addEventListener('click', (e)=>{
  if(e.target && e.target.id==='logoutBtn'){
    if(auth){ auth.signOut(); } else { state.user=null; ls.rm('bs_demo_user'); }
    openDrawer(false); go('/login');
  }
});

main();
