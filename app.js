// Barn Strong v2.5 (clean optimized build)
// ========================================

// ---- Helpers ----
const qs = s => document.querySelector(s);
const qsa = s => [...document.querySelectorAll(s)];
const ls = {
  get(k,f){ try{return JSON.parse(localStorage.getItem(k)) ?? f}catch{return f} },
  set(k,v){ localStorage.setItem(k, JSON.stringify(v)) },
  rm(k){ localStorage.removeItem(k) }
};
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

// Assign Template → User (resolved)
async function assignTemplateToUser({ templateId, template, trainerCode, userId, startDate }){
  // 1) Materialize template grid into programs/{trainerCode}/weeks/*
  //    Group rows by week and build sessions arrays.
  const weeksMap = {}; // week -> sessions[]

  (template.grid || []).forEach(cell => {
    const w = Number(cell.week);
    if (!weeksMap[w]) weeksMap[w] = [];

    // One "session" per day cell if it has content
    if (cell.movement || cell.setsreps || cell.load || cell.notes) {
      weeksMap[w].push({
        title: `${cell.day}`,
        date: null, // left null; UI can place relative to assignment startDate
        blocks: [{
          name:   cell.movement || '',
          sets:   parseInt((cell.setsreps || '').split('x')[0] || '') || null,
          reps:   parseInt((cell.setsreps || '').split('x')[1] || '') || null,
          weight: parseFloat((cell.load || '').replace(/[^\d.]/g, '')) || null,
          notes:  cell.notes || ''
        }]
      });
    }
  });

  // 2) Write weeks
  const batch = db.batch();
  Object.entries(weeksMap).forEach(([weekNumber, sessions]) => {
    const ref = db.collection('programs')
      .doc(trainerCode).collection('weeks').doc(String(weekNumber));
    batch.set(ref, { weekNumber: Number(weekNumber), sessions }, { merge: true });
  });

  // 3) Link assignment to the user
  batch.set(
    db.collection('assignments').doc(userId),
    {
      trainerCode,
      weekNumber: 1,
      startDate,
      templateId,
      assignedAt: firebase.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  await batch.commit();
}

// ---- Modal Helper ----
function openModal(contentHTML){
  let m = document.getElementById('modal');
  if(!m){
    m = document.createElement('div');
    m.id = 'modal';
    m.className = 'modal';
    m.innerHTML = `<div class="panel"><div id="modalBody"></div><div class="row mt"><button id="closeModal" class="btn ghost">Close</button></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click',(e)=>{ if(e.target.id==='modal' || e.target.id==='closeModal'){ m.classList.remove('open'); }});
  }
  m.querySelector('#modalBody').innerHTML = contentHTML;
  m.classList.add('open');
}

// --- Program hydration helpers ---
function addDaysISO(iso, n){
  const d = new Date(iso); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0,10);
}

function defaultOffsetsForCount(n){
  // Friendly defaults for common weekly structures.
  if (n === 4) return [0,2,4,6];    // Mon/Wed/Fri/Sun
  if (n === 3) return [0,2,5];      // Mon/Wed/Sat
  if (n === 5) return [0,1,3,4,6];  // Mon/Tue/Thu/Fri/Sun
  // Fallback: consecutive days
  return Array.from({length:n}, (_,i)=> i);
}

function buildSessionsMapFromWeeks(weeks, startDateISO){
  const map = {};
  if (!weeks || !weeks.length) return map;

  const base = startDateISO || new Date().toISOString().slice(0,10);

  // Sort by numeric weekNumber (tolerates doc id strings)
  const ordered = weeks.slice().sort((a,b)=>
    (Number(a.weekNumber)||0) - (Number(b.weekNumber)||0)
  );

  ordered.forEach((w, wi)=>{
    const sessions = w.sessions || [];
    const offsets = defaultOffsetsForCount(sessions.length);

    sessions.forEach((s, i)=>{
      // If coach provided an explicit date in the session, use it. Otherwise, compute.
      const computed = addDaysISO(addDaysISO(base, wi * 7), offsets[i] ?? i);
      const date = s.date || computed;
      map[date] = {
        ...s,
        date,
        title: s.title || `W${w.weekNumber || (wi+1)} S${i+1}`
      };
    });
  });
  return map;
}

// Attach live sync from assignments + programs → state.program + state.sessionsMap
function attachProgramSync(uid){
  // Clean up previous listeners if any
  if (!state.unsub) state.unsub = [];
  state.unsub.forEach(u => { try{ u(); }catch{} });
  state.unsub = [];

  const unsubAssign = db.collection('assignments').doc(uid).onSnapshot(async (doc)=>{
    if (!doc.exists){
      state.program = [];
      state.sessionsMap = {};
      rerenderIfProgramPages();
      return;
    }
    const { trainerCode, startDate } = doc.data() || {};
    if (!trainerCode){
      state.program = [];
      state.sessionsMap = {};
      rerenderIfProgramPages();
      return;
    }

    // Load all weeks for the trainer code (coach publishes here)
    const weeksSnap = await db.collection('programs').doc(trainerCode).collection('weeks').get();
    const weeks = weeksSnap.docs.map(d => {
      const data = d.data() || {};
      const wn = data.weekNumber != null ? data.weekNumber : Number(d.id) || null;
      return { weekNumber: wn, ...data };
    });

    state.program = weeks;
    state.sessionsMap = buildSessionsMapFromWeeks(weeks, startDate);
    rerenderIfProgramPages();
  });

  state.unsub.push(unsubAssign);
}

function rerenderIfProgramPages(){
  const path = location.hash.replace('#','') || '/login';
  // Lightweight: force a re-render if the user is on a page that shows program/sessions.
  if (['/dashboard','/calendar','/today','/program'].includes(path)) {
    render();
  }
}


function calcStreak(logs){
  const days = new Set((logs||[]).map(h=>h.date));
  let streak=0; const today = new Date();
  while(true){
    const d=new Date(today); d.setDate(today.getDate()-streak);
    const key=d.toISOString().slice(0,10);
    if(days.has(key)) streak++; else break;
  }
  return streak;
}

function detectPRs(logs){
  const best = {};
  (logs || []).forEach(l => {
    const score = (l.weight || 0) * (l.reps || 1);
    const k = l.exercise || '?';
    if (!best[k] || score > best[k]) best[k] = score;
  });
  return { prCount: Object.keys(best).length };
}

function rollingVolume(logs, days){
  const today = new Date().toISOString().slice(0,10);
  function addDays(iso, delta){ const d = new Date(iso); d.setDate(d.getDate()+delta); return d.toISOString().slice(0,10); }
  const start = addDays(today, -days);
  let sum = 0;
  (logs || []).forEach(l => {
    if (l.date >= start && l.date <= today){
      sum += (l.weight || 0) * (l.reps || 1) * (l.sets || 1);
    }
  });
  return sum;
}

function renderVolumeChart(canvasId, logs){
  const dayKey = d => d.toISOString().slice(0,10);
  const labels = [], data = [];
  for(let i=29;i>=0;i--){
    const dt = new Date(); dt.setDate(dt.getDate()-i);
    const key = dayKey(dt);
    labels.push(key.slice(5));
    const vol = (logs || [])
      .filter(l => l.date === key)
      .reduce((s,l) => s + (l.weight||0)*(l.reps||1)*(l.sets||1), 0);
    data.push(vol);
  }
  const el = document.getElementById(canvasId);
  if(!el || !window.Chart) return;
  new Chart(el, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Daily Volume', data }] },
    options: { responsive: true, plugins: { legend: { display:false }}, scales: { y: { beginAtZero:true } } }
  });
}

function renderRmChart(canvasId, logs){
  // e1RM = weight * (1 + reps/30)
  const byEx = {};
  (logs || []).forEach(l => {
    const name = l.exercise || '?';
    const e1 = (l.weight || 0) * (1 + (l.reps || 1)/30);
    (byEx[name] ||= []).push([l.date, e1]);
  });
  const top = Object.entries(byEx)
    .map(([k,v]) => [k, Math.max(...v.map(x=>x[1]))])
    .sort((a,b)=> b[1]-a[1]).slice(0,5).map(x=>x[0]);

  const dates = [...new Set((logs || []).map(l => l.date))].sort();
  const datasets = top.map(name => {
    const series = dates.map(d => {
      const arr = (byEx[name] || []).filter(x => x[0] === d).map(x => x[1]);
      return arr.length ? Math.max(...arr) : null;
    });
    return { label: name, data: series };
  });

  const el = document.getElementById(canvasId);
  if(!el || !window.Chart) return;
  new Chart(el, {
    type: 'line',
    data: { labels: dates.map(d => d.slice(5)), datasets },
    options: { responsive: true, plugins: { legend: { display:true }}, scales: { y: { beginAtZero:true } } }
  });
}

function calcAdherence(sessionsMap, logs){
  function addDays(iso, delta){
    const d = new Date(iso);
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0,10);
  }
  const today = new Date().toISOString().slice(0,10);

  function within(windowDays){
    const completedDates = new Set(
      (logs || [])
        .filter(h => h.date >= addDays(today, -windowDays) && h.date <= today)
        .map(h => h.date)
    );

    let scheduled = 0, completed = 0;
    Object.values(sessionsMap || {}).forEach(s => {
      const d = s.date || '';
      if (d >= addDays(today, -windowDays) && d <= today){
        scheduled++;
        if (completedDates.has(d)) completed++;
      }
    });

    return scheduled ? Math.round((completed / scheduled) * 100) : 0;
  }

  return { adherence7: within(7), adherence30: within(30) };
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
    if(state.sessionsMap[dateStr]){
      const dot=document.createElement('span'); dot.className='dot'; cell.appendChild(dot);
      cell.title=state.sessionsMap[dateStr].title;
      cell.style.cursor='pointer';
      cell.addEventListener('click',()=> go('/today'));
    }
    if(dateStr===new Date().toISOString().slice(0,10)) cell.classList.add('today');
    grid.appendChild(cell);
  }
  el.appendChild(grid);
  page('Calendar', el);
}


// ---- Exercise Library → dropdowns ----
let _exerciseNamesCache = null;
async function loadExerciseLibraryNames(){
  const names = new Set((typeof DEFAULT_EXERCISES !== 'undefined' ? DEFAULT_EXERCISES : []));
  try {
    if (db && state?.user?.uid) {
      const snap = await db.collection('users').doc(state.user.uid).collection('exercises').get();
      snap.forEach(d => d.data()?.name && names.add(d.data().name));
    } else {
      (ls.get('bs_exercises', []) || []).forEach(n => names.add(n));
    }
  } catch(e){ console.warn('loadExerciseLibraryNames', e); }
  return [...names].sort();
}
async function getExerciseNames() {
  if (_exerciseNamesCache) return _exerciseNamesCache;
  _exerciseNamesCache = await loadExerciseLibraryNames();
  return _exerciseNamesCache;
}
function makeExerciseSelect(className='exname', options=[]){
  const sel = document.createElement('select');
  sel.className = className;
  sel.innerHTML = `<option value="">— select exercise —</option>` + options.map(n=>`<option value="${n}">${n}</option>`).join('');
  return sel;
}

// ---- Theme install banner ----
let deferredPrompt; const installBtn = () => qs('#installBtn');
window.addEventListener('beforeinstallprompt', (e)=>{ e.preventDefault(); deferredPrompt = e; installBtn() && (installBtn().hidden=false); });
qsa('#installBtn').forEach(btn=> btn.addEventListener('click', async()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; btn.hidden=true; }));

// ---- Firebase init ----
let app, auth, db;
async function initFirebase(){
  const cfg = window.__FIREBASE_CONFIG__ || {};
  if(!cfg.apiKey){ console.warn('No Firebase config. Running in local demo mode.'); return; }
  app = firebase.initializeApp(cfg);
  auth = firebase.auth();
  db = firebase.firestore();
  try{ await db.enablePersistence({synchronizeTabs:true}); }catch(e){ console.warn('persistence', e); }
}

// ---- State ----
const state = { user:null, profile:null, sessionsMap:{}, logs:[], exercises:[], program:[], unsub:[] };

// ---- Router ----
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

// ---- Analytics ----
function logEvent(name, data = {}) {
  if (!db || !state.user) return;
  const ref = db.collection('events').doc(state.user.uid).collection('app').doc();
  ref.set({ name, ...data, ts: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
}

// ---- Net banner ----
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

// ---- Pages ----
function Login(){
  const wrap = document.createElement('div');
  wrap.className='login-wrap card';
  wrap.innerHTML = `
    <img class="brand-logo" src="assets/mascot-barn-angry.png?v=v2.4.3" alt="Barn Strong Mascot"/>
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
      try{
        await auth.signInWithEmailAndPassword(email, pass);
      }catch(e){
        alert(e.message);
      }
    }else{
      state.user = { uid:'local', email };
      state.profile = ls.get('bs_profile', { username: email.split('@')[0], goal:'', trainerCode:'BARN'});
      ensureLocalExercises();
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
    const email = wrap.querySelector('#email').value.trim();
    const pass = wrap.querySelector('#pass').value.trim();
    try{
      await auth.createUserWithEmailAndPassword(email, pass);
      alert('Account created! Verify your email.');
    }catch(e){
      alert(e.message);
    }
  });

  wrap.querySelector('#resetBtn').addEventListener('click', async()=>{
    if(!auth) return alert('Connect Firebase to enable reset.');
    const email = wrap.querySelector('#email').value.trim();
    try{
      await auth.sendPasswordResetEmail(email);
      alert('Reset email sent!');
    }catch(e){
      alert(e.message);
    }
  });

  qs('#root').innerHTML='';
  qs('#root').appendChild(wrap);
}

// ---- Dashboard ----
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
    <div class="card chart-card">
      <h3>Training Volume (last 30 days)</h3>
      <canvas id="volChart"></canvas>
    </div>
    <div class="card chart-card">
      <h3>Estimated 1RM Trend (top 5 exercises)</h3>
      <canvas id="rmChart"></canvas>
    </div>
  `;
  page('Dashboard', el);

  setTimeout(()=> {
    renderVolumeChart('volChart', state.logs || []);
    renderRmChart('rmChart', state.logs || []);
  }, 10);
}

// ---- Today's Session ----

function TodaysSession(){
  const today = new Date().toISOString().slice(0,10);
  const sess = (state.sessionsMap || {})[today];
  const el = document.createElement('div');

  const header = document.createElement('div');
  header.className = 'row';

  if(!sess){
    const next = findNextSession(state.sessionsMap || {});
    el.innerHTML = `<p>No session scheduled for today.</p><p class="muted">Next: ${next? (next.date+' — '+next.title) : 'No upcoming'}</p>`;
    const unscheduledBtn = document.createElement('a');
    unscheduledBtn.href = '#/unscheduled';
    unscheduledBtn.className = 'btn small ghost';
    unscheduledBtn.textContent = 'Unscheduled Session';
    el.appendChild(unscheduledBtn);
    logEvent('session_opened', { date: today, scheduled: false });
    return page("Today's Session", el);
  }

  const status = sess.status || 'planned';
  header.innerHTML = `
    <div class="chip">Status: ${status}</div>
    <button class="btn small" id="startBtn">Start</button>
    <button class="btn small" id="completeBtn">Complete</button>
    <a href="#/unscheduled" class="btn small ghost">Unscheduled Session</a>
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
}

// ---- Unscheduled Session ----
function UnscheduledSession(){
  const el = document.createElement('div');
  el.innerHTML = `
    <p>Create a workout from scratch.</p>
    <div id="unschedSessions"></div>
    <div class="row mt">
      <button class="btn" id="unschedAddSession">+ Add Exercise</button>
    </div>
  `;
  const wrap = el.querySelector('#unschedSessions');
  const sessions = [];

  function render(){
    wrap.innerHTML='';
    sessions.forEach((s,idx)=>{
      const row = document.createElement('div'); row.className='item';
      row.innerHTML = `
        <div class="row">
          <span class="exname-slot"></span>
          <input class="exsets" type="number" placeholder="Sets"/>
          <input class="exreps" type="number" placeholder="Reps"/>
          <input class="exload" type="number" placeholder="Weight"/>
          <button class="btn small danger del">Delete</button>
        </div>
      `;

      (function attachSelect(){
        const slot = row.querySelector('.exname-slot');
        if (!slot) return;
        const apply = (names)=> { slot.replaceWith(makeExerciseSelect('exname', names)); };
        if (_exerciseNamesCache) apply(_exerciseNamesCache);
        else getExerciseNames().then(apply).catch(()=> apply([]));
      })();

      row.querySelector('.del').addEventListener('click',()=>{ sessions.splice(idx,1); render(); });
      wrap.appendChild(row);
    });
  }

  el.querySelector('#unschedAddSession').addEventListener('click',()=>{ sessions.push({}); render(); });

  page('Unscheduled Session', el);
}

// ---- Variation Record ----
function VariationRecord(){
  const root = document.createElement('div');
  root.innerHTML = `
    <h3>Variation Record</h3>
    <p class="muted">Search and log past sets.</p>
    <input id="q" placeholder="Search exercise"/>
    <ul id="varList" class="list mt"></ul>
  `;
  const ul = root.querySelector('#varList');

  function renderList(){
    ul.innerHTML = '';
    const q = root.querySelector('#q').value.trim().toLowerCase();
    const names = new Set([...(state.exercises||[]), ...state.logs.map(h=>h.exercise)]);
    const list = [...names].filter(n=> n && (!q || n.toLowerCase().includes(q))).sort();

    list.forEach(name=>{
      const entries = state.logs.filter(h=> h.exercise===name).sort((a,b)=> b.date.localeCompare(a.date));
      const text = entries.slice(0,5).map(h=>{
        const wt = (h.weight!=null ? `${h.weight} lb` : '');
        const reps = (h.reps!=null ? ` x ${h.reps}` : '');
        return `${h.date}: ${wt}${reps}`;
      }).join('<br/>') || '—';

      const li = document.createElement('li'); li.className='item';
      li.innerHTML = `<div class="grow">
        <div class="bold">${name}</div>
        <div class="muted small">${text}</div>
      </div>`;
      ul.appendChild(li);
    });

    if(!ul.children.length){
      ul.innerHTML = `<li class="item"><div class="muted">No matching records.</div></li>`;
    }
  }

  root.querySelector('#q').addEventListener('input', renderList);
  renderList();
  page('Variation Record', root);
}

// ---- Program View ----
function ProgramView(){
  const root = document.createElement('div');

  if(!state.program || !state.program.length){
    root.innerHTML = `<p class="muted">No program published yet.</p>`;
    return page('Program View', root);
  }

  const list = document.createElement('ul'); list.className = 'list';
  const weeks = state.program.slice().sort((a,b)=>
    (Number(a.weekNumber)||0) - (Number(b.weekNumber)||0)
  );

  weeks.forEach(w=>{
    const li = document.createElement('li'); li.className = 'item';
    const sessions = w.sessions || [];
    const inner = sessions.map((s, i) => {
      const d = s.date || '—';
      const t = s.title || `Session ${i+1}`;
      return `<div class="row small"><div class="bold">${t}</div><div class="muted">${d}</div></div>`;
    }).join('');
    li.innerHTML = `<div class="grow">
      <div class="bold">Week ${w.weekNumber ?? '—'}</div>
      <div class="mt small">${inner || 'No sessions in this week.'}</div>
    </div>`;
    list.appendChild(li);
  });

  page('Program View', list);
}


// ---- Exercise Library ----
function ExerciseLibrary(){
  const root = document.createElement('div');
  const list = document.createElement('ul'); list.className='list';
  const arr = (state.exercises||[]).slice().sort();
  if(!arr.length){ list.innerHTML = `<li class="item"><div class="muted">No exercises yet.</div></li>`; }
  arr.forEach(name=>{
    const li = document.createElement('li'); li.className='item';
    li.innerHTML = `<div class="grow"><div class="bold">${name}</div><div class="muted small">Use Variation Record to add history</div></div>`;
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

// ---- Coach Portal ----
function CoachPortal(){
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="grid two">
      <label>Trainer Code
        <select id="trainerCode"></select>
      </label>
      <label>Assign to User
        <select id="assignUser"><option value="">— select user —</option></select>
      </label>
    </div>

    <div class="divider"></div>
    <div class="grid two">
      <label>Week Number <input id="wk" type="number" min="1" value="1"/></label>
      <label>Start Date <input id="startDate" placeholder="Pick a date"/></label>
    </div>

    <div class="divider"></div>
    <div id="sessions"></div>
    <div class="row mt">
      <button class="btn" id="addSession">+ Add Session</button>
      <button class="btn ghost" id="dupWeek">Duplicate Week</button>
      <button class="btn ghost" id="openTemplateBuilder">New Template</button>
      <button class="btn ghost" id="openSavedTemplates">Saved Templates</button>
      <button class="btn ghost" id="athleteViewBtn">Athlete View</button>
    </div>

    <div class="divider"></div>
    <button id="publish" class="btn">Publish Week</button>
    <div id="out" class="mt muted small"></div>
  `;

  root.querySelector('#openSavedTemplates')?.addEventListener('click', ()=> go('/templates'));
  root.querySelector('#openTemplateBuilder')?.addEventListener('click', ()=> go('/template-builder'));
  root.querySelector('#athleteViewBtn')?.addEventListener('click', ()=> go('/athletes'));
  
  // flatpickr on Start Date
  setTimeout(()=> { 
    if (window.flatpickr) { 
      flatpickr(root.querySelector('#startDate'), { dateFormat:'Y-m-d' }); 
    }
  }, 0);

  setTimeout(()=> { if(window.flatpickr){ flatpickr(root.querySelector('#startDate'), { dateFormat:'Y-m-d' }); }}, 0);

  const sessions = [];
  const sessionsWrap = root.querySelector('#sessions');

  function renderSessionCard(idx){
    const s = sessions[idx];
    const card = document.createElement('div');
    card.className = 'item';
    card.dataset.idx = idx;

    card.innerHTML = `
      <div class="grow">
        <div class="grid two">
          <label>Session Date <input class="date pick" value="${s.date||''}" placeholder="Pick date"/></label>
          <label>Title <input class="title" value="${s.title||''}" placeholder="Upper A"/></label>
        </div>
        <div class="divider"></div>
        <div class="small muted">Exercises</div>
        <div class="list exlist"></div>
        <div class="row mt">
          <span class="exname-slot"></span>
          <input class="exsets" type="number" placeholder="Sets"/>
          <input class="exreps" type="number" placeholder="Reps"/>
          <input class="exload" type="number" placeholder="Weight"/>
          <button class="btn small addEx">Add</button>
          <button class="btn small ghost dup">Duplicate</button>
          <button class="btn small danger del">Delete</button>
        </div>
      </div>
    `;

    (function attachSelect(){
      const slot = card.querySelector('.exname-slot');
      if (!slot) return;
      const apply = (names)=> { slot.replaceWith(makeExerciseSelect('exname', names)); };
      if (_exerciseNamesCache) apply(_exerciseNamesCache);
      else getExerciseNames().then(apply).catch(()=> apply([]));
    })();

    if (window.flatpickr) {
      flatpickr(card.querySelector('.pick'), {
        dateFormat: 'Y-m-d',
        onChange: (sel)=> s.date = sel[0]?.toISOString().slice(0,10)
      });
    }

    const exlist = card.querySelector('.exlist');
    (s.blocks||[]).forEach(b=>{
      const row = document.createElement('div'); row.className='item';
      row.innerHTML = `<div class="grow">${b.name} — ${b.sets||1} x ${b.reps||''}${b.weight? ' @ '+b.weight+' lb':''}</div>`;
      exlist.appendChild(row);
    });

 card.querySelector('.addEx').addEventListener('click', ()=>{
  const nameEl = card.querySelector('.exname');
  const name = (nameEl?.value || '').trim();
  if(!name) return alert('Select an exercise');

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
    card.querySelector('.title').addEventListener('input', e=> sessions[idx].title = e.target.value);

    return card;
  }

  function render(){
    sessionsWrap.innerHTML = '';
    sessions.forEach((_, i)=> sessionsWrap.appendChild(renderSessionCard(i)));
  }

  root.querySelector('#addSession').addEventListener('click', ()=>{
    sessions.push({ date:'', title:'', blocks:[] }); render();
  });
  root.querySelector('#dupWeek').addEventListener('click', ()=>{
    const copies = sessions.map(s=> JSON.parse(JSON.stringify(s)));
    sessions.push(...copies); render();
  });

  root.querySelector('#publish').addEventListener('click', async()=>{
    const weekNumber = parseInt(root.querySelector('#wk').value||'1',10);
    const trainerCode = root.querySelector('#trainerCode').value || 'BARN';
    const startDate = root.querySelector('#startDate').value || null;
    const targetUser = root.querySelector('#assignUser').value || '';

    if(!sessions.length) return alert('Add at least one session.');
    if(!db || !state.user) return alert('Login + Firebase required');

    try{
      await db.collection('programs').doc(trainerCode).collection('weeks').doc(String(weekNumber))
        .set({ weekNumber, sessions }, { merge: true });

      if(targetUser){
        await db.collection('assignments').doc(targetUser).set({
          trainerCode, weekNumber, startDate: startDate || new Date().toISOString().slice(0,10),
          assignedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }

      alert('Published!');
      root.querySelector('#out').textContent =
        `Published week ${weekNumber} (${sessions.length} sessions)` + (targetUser ? ' and assigned to user.' : '.');
    }catch(e){ alert(e.message); }
  });

  async function populateLookups(){
    const codeSel = root.querySelector('#trainerCode');
    const userSel = root.querySelector('#assignUser');
    codeSel.innerHTML = ``; userSel.innerHTML = `<option value="">— select user —</option>`;

    if(db && state.user){
      const codes = await db.collection('trainers').get();
      codes.forEach(d=>{
        const opt = document.createElement('option');
        opt.value = d.id; opt.textContent = d.id;
        codeSel.appendChild(opt);
      });
      if(!codes.size){
        const opt = document.createElement('option'); opt.value='BARN'; opt.textContent='BARN'; codeSel.appendChild(opt);
      }

      const users = await db.collection('users').limit(200).get();
      users.forEach(u=>{
        const d = u.data();
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = d.username || d.email || u.id.slice(0,6);
        userSel.appendChild(opt);
      });
    }else{
      const opt = document.createElement('option'); opt.value='local'; opt.textContent='Demo User'; userSel.appendChild(opt);
      const opt2 = document.createElement('option'); opt2.value='BARN'; opt2.textContent='BARN'; codeSel.appendChild(opt2);
    }
  }

  populateLookups();
  page('Coach Portal', root);
}

// ---- Template Builder ----
function TemplateBuilder(){
  const root = document.createElement('div');
  const DEFAULT_WEEKS = 4;
  const DAYS = ['ME Upper','DE Upper','DE Lower','ME Lower'];

  root.innerHTML = `
    <h3>Template Builder</h3>
    <div class="grid two">
      <label>Name <input id="tplName" placeholder="e.g., Fall Strength Cycle"/></label>
      <label>Weeks <input id="tplWeeks" type="number" min="1" value="${DEFAULT_WEEKS}"/></label>
    </div>

    <div class="muted small mt">Click cells to edit. Use exercise dropdowns in the row editor to add exercises.</div>
    <div class="divider"></div>

    <div class="scroll-x">
      <table class="sheet" id="tplTable">
        <thead>
          <tr>
            <th>Week</th>
            ${DAYS.map(d=>`<th>${d}<div class="muted tiny">Movement / Sets×Reps / Load / Notes</div></th>`).join('')}
          </tr>
        </thead>
        <tbody id="tplBody"></tbody>
      </table>
    </div>

    <div class="row mt">
      <button id="addWeek" class="btn small">+ Add Week</button>
      <button id="saveTemplate" class="btn">Save Template</button>
    </div>

    <div id="tplMsg" class="muted small mt"></div>
  `;

  // Render N weeks of rows
  const body = root.querySelector('#tplBody');
  function renderWeeks(n){
    body.innerHTML = '';
    for(let w=1; w<=n; w++){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="bold">Week ${w}</td>` + DAYS.map(()=>`
        <td class="cell" data-week="${w}">
          <div class="slot" contenteditable="true" data-field="movement" placeholder="Movement"></div>
          <div class="slot" contenteditable="true" data-field="setsreps" placeholder="Sets×Reps"></div>
          <div class="slot" contenteditable="true" data-field="load" placeholder="Load"></div>
          <div class="slot" contenteditable="true" data-field="notes" placeholder="Notes"></div>
        </td>
      `).join('');
      body.appendChild(tr);
    }
  }
  renderWeeks(DEFAULT_WEEKS);

  // Add week
  root.querySelector('#addWeek').addEventListener('click', ()=>{
    const n = body.querySelectorAll('tr').length + 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="bold">Week ${n}</td>` + DAYS.map(()=>`
      <td class="cell" data-week="${n}">
        <div class="slot" contenteditable="true" data-field="movement"></div>
        <div class="slot" contenteditable="true" data-field="setsreps"></div>
        <div class="slot" contenteditable="true" data-field="load"></div>
        <div class="slot" contenteditable="true" data-field="notes"></div>
      </td>
    `).join('');
    body.appendChild(tr);
  });

  // Save template (coach-only write)
  root.querySelector('#saveTemplate').addEventListener('click', async ()=>{
    const name = root.querySelector('#tplName').value.trim() || 'Untitled';
    const weeks = parseInt(root.querySelector('#tplWeeks').value||'4',10);
    if(!db || !state.user) return alert('Login + Firebase required.');
    const trainerCode = 'BARN'; // change if you want the Trainer Code dropdown here
    const grid = [];  // serialize cells → array of {week, day, movement, setsreps, load, notes}

    body.querySelectorAll('tr').forEach((tr, idx)=>{
      const week = idx+1;
      const cells = [...tr.querySelectorAll('td.cell')];
      cells.forEach((td, cIdx)=>{
        const rec = {
          week,
          day: DAYS[cIdx],
          movement: td.querySelector('[data-field="movement"]')?.innerText.trim() || '',
          setsreps: td.querySelector('[data-field="setsreps"]')?.innerText.trim() || '',
          load:     td.querySelector('[data-field="load"]')?.innerText.trim() || '',
          notes:    td.querySelector('[data-field="notes"]')?.innerText.trim() || ''
        };
        // skip completely empty cells
        if(rec.movement || rec.setsreps || rec.load || rec.notes) grid.push(rec);
      });
    });

    try{
      const ref = db.collection('templates').doc(trainerCode).collection('defs').doc();
      await ref.set({
        name, weeksPerMesocycle: weeks, mesocycles: 1,
        grid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: state.user.uid
      });
      root.querySelector('#tplMsg').textContent = `Saved "${name}" (${grid.length} items).`;
      alert('Template saved.');
      go('/templates');
    }catch(e){ alert(e.message); }
  });

  page('Template Builder', root);
}

// ---- Saved Templates ----
function SavedTemplates(){
  const root = document.createElement('div');
  root.innerHTML = `
    <h3>Saved Templates</h3>
    <div id="tplList" class="list"></div>
  `;
  page('Saved Templates', root);

  (async ()=>{
    if(!db) return root.querySelector('#tplList').innerHTML = `<div class="item">Firebase required.</div>`;
    const list = root.querySelector('#tplList');
    const code = 'BARN'; // or read from your Trainer Code selector

    try{
      const snap = await db.collection('templates').doc(code).collection('defs').orderBy('createdAt','desc').get();
      if (snap.empty){ list.innerHTML = `<div class="item">No templates yet.</div>`; return; }

      // Preload user options
      const usersSel = document.createElement('select'); usersSel.innerHTML = `<option value="">— select user —</option>`;
      const users = await db.collection('users').limit(200).get();
      users.forEach(u=> {
        const d = u.data(); const opt = document.createElement('option');
        opt.value = u.id; opt.textContent = d.username || d.email || u.id.slice(0,6);
        usersSel.appendChild(opt);
      });

      snap.forEach(doc=>{
        const t = doc.data();
        const row = document.createElement('div'); row.className='item';
        row.innerHTML = `
          <div class="grow">
            <div class="bold">${t.name}</div>
            <div class="muted small">${t.grid?.length||0} items • Weeks: ${t.weeksPerMesocycle || '?'}</div>
          </div>
          <div class="row">
            <input type="date" class="startDate" />
            <span class="userSlot"></span>
            <button class="btn small assignBtn">Assign</button>
          </div>
        `;
        // clone a users select per row
        const sel = usersSel.cloneNode(true);
        row.querySelector('.userSlot').appendChild(sel);

        row.querySelector('.assignBtn').addEventListener('click', async ()=>{
          const uid = sel.value;
          const start = row.querySelector('.startDate').value || new Date().toISOString().slice(0,10);
          if(!uid) return alert('Select a user.');
          try{
            await assignTemplateToUser({ templateId: doc.id, template: t, trainerCode: code, userId: uid, startDate: start });
            alert('Assigned!');
          }catch(e){ alert(e.message); }
        });

        list.appendChild(row);
      });
    }catch(e){
      console.warn(e);
      root.querySelector('#tplList').innerHTML = `<div class="item">Error: ${e.message}</div>`;
    }
  })();
}

// ---- Saved Templates ----
function SavedTemplates(){
  const root = document.createElement('div');
  root.innerHTML = `
    <h3>Saved Templates</h3>
    <div id="tplList" class="list"></div>
  `;
  page('Saved Templates', root);

  (async ()=>{
    if(!db) return root.querySelector('#tplList').innerHTML = `<div class="item">Firebase required.</div>`;
    const list = root.querySelector('#tplList');
    const code = 'BARN';

    try{
      const snap = await db.collection('templates').doc(code).collection('defs').orderBy('createdAt','desc').get();
      if (snap.empty){ list.innerHTML = `<div class="item">No templates yet.</div>`; return; }

      const usersSel = document.createElement('select'); usersSel.innerHTML = `<option value="">— select user —</option>`;
      const users = await db.collection('users').limit(200).get();
      users.forEach(u=> {
        const d = u.data(); const opt = document.createElement('option');
        opt.value = u.id; opt.textContent = d.username || d.email || u.id.slice(0,6);
        usersSel.appendChild(opt);
      });

      snap.forEach(doc=>{
        const t = doc.data();
        const row = document.createElement('div'); row.className='item';
        row.innerHTML = `
          <div class="grow">
            <div class="bold">${t.name}</div>
            <div class="muted small">${t.grid?.length||0} items • Weeks: ${t.weeksPerMesocycle || '?'}</div>
          </div>
          <div class="row">
            <input type="date" class="startDate" />
            <span class="userSlot"></span>
            <button class="btn small assignBtn">Assign</button>
          </div>
        `;
        const sel = usersSel.cloneNode(true);
        row.querySelector('.userSlot').appendChild(sel);

        row.querySelector('.assignBtn').addEventListener('click', async ()=>{
          const uid = sel.value;
          const start = row.querySelector('.startDate').value || new Date().toISOString().slice(0,10);
          if(!uid) return alert('Select a user.');
          try{
            await assignTemplateToUser({ templateId: doc.id, template: t, trainerCode: code, userId: uid, startDate: start });
            alert('Assigned!');
          }catch(e){ alert(e.message); }
        });

        list.appendChild(row);
      });
    }catch(e){
      console.warn(e);
      root.querySelector('#tplList').innerHTML = `<div class="item">Error: ${e.message}</div>`;
    }
  })();
}

// ---- Athlete View ----
function AthleteView(){
  const root = document.createElement('div');
  root.innerHTML = `<h3>Athlete View</h3><div id="athList" class="list"></div>`;
  page('Athlete View', root);

  (async ()=>{
    const listEl = root.querySelector('#athList');
    if(!db) { listEl.innerHTML = `<div class="item">Firebase required.</div>`; return; }

    try{
      const usersSnap = await db.collection('users').limit(200).get();
      if (usersSnap.empty){ listEl.innerHTML = `<div class="item">No users yet.</div>`; return; }

      for (const u of usersSnap.docs){
        const uid = u.id;
        const profile = u.data() || {};
        const name = profile.username || profile.email || uid.slice(0,6);

        const assign = await db.collection('assignments').doc(uid).get();
        let assignedText = 'No program assigned';
        let planCount = 0;
        if(assign.exists){
          const a = assign.data();
          assignedText = `Assigned: ${a.trainerCode} • Week ${a.weekNumber} • Start ${a.startDate}`;
          const weekDoc = await db.collection('programs').doc(a.trainerCode).collection('weeks').doc(String(a.weekNumber)).get();
          planCount = weekDoc.exists ? ((weekDoc.data().sessions||[]).length) : 0;
        }

        const today = new Date();
        let completed7 = 0;
        for(let i=0;i<7;i++){
          const d = new Date(today); d.setDate(today.getDate()-i);
          const key = d.toISOString().slice(0,10);
          const sdoc = await db.collection('sessions').doc(uid).collection('days').doc(key).get();
          if (sdoc.exists && (sdoc.data().status === 'completed')) completed7++;
        }

        const row = document.createElement('div'); row.className = 'item';
        row.innerHTML = `
          <div class="grow">
            <div class="bold">${name}</div>
            <div class="small muted">${assignedText}</div>
            <div class="small muted">Sessions in plan: ${planCount}</div>
            <div class="small">Completed (7d): ${completed7}</div>
          </div>
        `;
        listEl.appendChild(row);
      }
    }catch(e){
      console.warn(e);
      listEl.innerHTML = `<div class="item">Error loading athletes: ${e.message}</div>`;
    }
  })();
}

// ---- Settings ----
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

// ---- Defaults ----
const DEFAULT_EXERCISES = [
  "1RM Touch and Go Bench","Touch and Go Bench Backdowns","Mega Mass Incline Press",
  "Dumbbell Lateral Raise","JM Press","Meadows Rows","Pullup","Rear Delt Flye","Hammer Curls",
  "Decline Crunch","Reverse Banded Cambered Bar Free Squat","Front Squat","Barbell RDL",
  "Barbell Walking Lunge","Leg Extension","Glute Ham Developer","Lower Back Hyperextension",
  "Touch and Go Bench","Standing Overhead Press","Mega Mass Flat Press","Bilateral Machine Row",
  "Banded Crunch","1RM Deficit Beltless Conventional Deadlift from Two Mats plus Chain",
  "Deficit Beltless Conventional Deadlift from Two Mats plus Chain Backdowns",
  "Belt Squat to Box","1RM Spoto Press","Spoto Press Backdowns",
  "1RM Duffalo Squat to Box against Orange Bands","Duffalo Squat to Box against Orange Bands Backdowns",
  "1RM Close Grip Bench (Paused)","Close Grip Bench Backdowns (Paused)",
  "Incline Dumbbell Bench","Barbell Pullover Press","Yates Rows","Behind-the-Neck Pulldowns",
  "Open Palm Curls","Band-Assisted V-Ups","Safety Squat Bar Goodmornings","Bulgarian Split Squat",
  "Reverse Hyperextension","Hamstring Curl","Unilateral Machine Row",
  "1RM Two-Mat Deficit Sumo Deadlift","1RM Comp Bench against Quadded Red Bands",
  "Comp Bench against Quadded Red Bands Backdowns","Duffalo Squat to box against Orange Bands",
  "Manta Squat","Close Grip Bench (paused)","Standing Behind-the-Neck Press","Flat Dumbbell Press",
  "1RM Cambered Bar squat to Box plus Chain","Cambered Bar squat to Box plus Chain Backdowns",
  "Safety Squat Bar Squat to Box"
];

function ensureLocalExercises(){
  if(!ls.get('bs_exercises')) ls.set('bs_exercises', DEFAULT_EXERCISES);
  state.exercises = ls.get('bs_exercises', DEFAULT_EXERCISES);
}

// Seed a full exercise library in Firestore for first-time cloud users
async function ensureExercises(){
  if(!db || !state.user) return;               // only runs when Firebase is live
  try{
    const snap = await db.collection('users')
      .doc(state.user.uid).collection('exercises')
      .limit(1).get();
    if(snap.empty){
      const batch = db.batch();
      const ref = db.collection('users').doc(state.user.uid).collection('exercises');
      (DEFAULT_EXERCISES || []).forEach(name=>{
        const id = slug(name);
        batch.set(ref.doc(id), { name });
      });
      await batch.commit();
    }
  }catch(e){ console.warn('ensureExercises error', e); }
}


// ---- Utils ----
function findNextSession(map){
  const today = new Date().toISOString().slice(0,10);
  const future = Object.values(map).filter(s => (s.date||'') >= today).sort((a,b)=> (a.date||'').localeCompare(b.date));
  return future[0];
}

// Drawer UI
const drawer = qs('#drawer'), scrim = qs('#scrim');
qs('#hamburger').addEventListener('click', ()=> openDrawer(true));
scrim.addEventListener('click', ()=> openDrawer(false));
function openDrawer(open){ drawer.classList.toggle('open', open); scrim.hidden = !open; }
drawer.addEventListener('click', (e)=>{ const link = e.target.closest('a'); if(link) openDrawer(false); });

// ---- Routes ----
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
route('/unscheduled', UnscheduledSession);
route('/athletes', AthleteView);
route('/template-builder', TemplateBuilder);
route('/templates', SavedTemplates);

// ---- Auth glue ----
async function main(){
  await initFirebase();
  if(auth){
    auth.onAuthStateChanged(async(user)=>{
      state.user = user;
      if(!user){ return go('/login'); }
      const uref = db.collection('users').doc(user.uid);
      const snap = await uref.get();
      if(!snap.exists){
        await uref.set({
          username: user.email.split('@')[0],
          goal:'', trainerCode:'BARN',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        await ensureExercises();
      }
      
      db.collection('users').doc(user.uid).collection('exercises')
        .onSnapshot(s=>{ state.exercises = s.docs.map(d=> d.data().name).sort(); });
      db.collection('logs').doc(user.uid).collection('entries')
        .orderBy('date','desc').limit(300)
        .onSnapshot(s=>{ state.logs = s.docs.map(d=> d.data()); });

      attachProgramSync(user.uid);
      
      go('/dashboard');
    });
  }else{
    const demoUser = ls.get('bs_demo_user') || { uid:'local', email:'demo@barnstrong.fit' };
    state.user = demoUser;
    ensureLocalExercises();
    go('/dashboard');
  }
  render();
  setTimeout(setNetBanner, 500);
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
    if(auth){ auth.signOut(); }
    else { state.user=null; ls.rm('bs_demo_user'); }
    openDrawer(false); go('/login');
  }
});

main();
qs('#splash')?.remove();

