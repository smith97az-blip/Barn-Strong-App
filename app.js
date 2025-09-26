console.log('Barn Strong build v3.1.2 @ ' + new Date().toISOString());
window.__BUILD_ID__ = 'v2.6.7';
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

function nextDateForDowOnOrAfter(anchorISO, dow /*0=Sun..6=Sat*/){
  const d = new Date(anchorISO);
  const cur = d.getDay();
  const add = ( (Number(dow) - cur) + 7 ) % 7;  // 0..6 days
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0,10);
}

// --- Global Exercise Library helpers (compat SDK) ---

async function upsertGlobalExercise(id, data) {
  // data: { name, category?, description?, tags? }
  const db = firebase.firestore();
  const uid = firebase.auth().currentUser?.uid || null;

  const ref = id
    ? db.collection("exercises").doc(id)
    : db.collection("exercises").doc(); // auto-ID

  const name = (data.name || "").trim();
  if (!name) throw new Error("Exercise name required");

  const now = firebase.firestore.FieldValue.serverTimestamp();
  const payload = {
    ...data,
    name,
    nameLower: name.toLowerCase(),
    updatedAt: now,
    ...(id ? {} : { createdAt: now, createdBy: uid }),
  };

  await ref.set(payload, { merge: true });
  return ref.id;
}

// Delete by *name* (handy if your UI currently only has the name, not the id)
async function deleteGlobalExerciseByName(name) {
  const db = firebase.firestore();
  const key = (name || "").trim().toLowerCase();
  if (!key) throw new Error("Exercise name required");

  // Look up the doc by nameLower
  const q = await db.collection("exercises")
    .where("nameLower", "==", key)
    .limit(1).get();

  if (q.empty) throw new Error("Exercise not found");

  await q.docs[0].ref.delete();
}

// ---- Toast helper ----
function showToast(msg){
  let t = document.getElementById('toast');
  if (!t){
    t = document.createElement('div');
    t.id = 'toast';
    t.style.position = 'fixed';
    t.style.bottom = '20px';
    t.style.left = '50%';
    t.style.transform = 'translateX(-50%)';
    t.style.background = '#333';
    t.style.color = '#fff';
    t.style.padding = '8px 16px';
    t.style.borderRadius = '6px';
    t.style.zIndex = 9999;
    t.style.transition = 'opacity 0.5s ease';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(()=>{ t.style.opacity = '0'; }, 2000);
}


async function deleteExerciseByName(name){
  if (!name) return;
  if (!confirm(`Delete "${name}" from the global exercise library?`)) return;

  try {
    await deleteGlobalExerciseByName(name); // uses the helper you already added
    // state.exercises will refresh via subscribeExercises()
    showToast(`Exercise "${name}" deleted`);
  } catch (e){
    alert(e.message || 'Failed to delete');
  }
}



function addDaysISO(iso, n){
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0,10);
}

// Build a { [date]: { title, blocks, status } } map from a week + startDate
function planSessionsToDates(sessions = [], startDate){
  const map = {};
  if (!sessions.length || !startDate) return map;
  let idx = 0;

  sessions.forEach((s) => {
    let date = null;

    if (s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
      date = s.date;  // explicit date wins
    } else if (s.dow != null && !isNaN(Number(s.dow))) {
      // place on the selected weekday on/after startDate
      date = nextDateForDowOnOrAfter(startDate, Number(s.dow));
    } else {
      // legacy: sequential placement from startDate
      date = addDaysISO(startDate, idx);
    }

    // avoid collisions (two sessions same day) by bumping forward
    while (map[date]) date = addDaysISO(date, 1);

    map[date] = {
      title: s.title || `Session ${idx+1}`,
      blocks: s.blocks || [],
      status: s.status || 'planned',
      date
    };
    idx++;
  });

  return map;
}

// Optional: persist the planned days to Firestore for the signed-in user so
// other parts of the app (and your rules) can read them as “planned” days.
async function writePlannedDaysToFirestore(uid, map){
  if (!db || !uid) return;
  const batch = db.batch();
  const base = db.collection('sessions').doc(uid).collection('days');
  Object.entries(map).forEach(([date, s])=>{
    batch.set(base.doc(date), {
      title: s.title,
      blocks: s.blocks,
      status: s.status || 'planned',
      plannedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });
  await batch.commit();
}

// Assign Template → User (respects DOW)
async function assignTemplateToUser({ templateId, template, trainerCode, userId, startDate }){
  // Build week → sessions[] from template.grid
  const weeksMap = {}; // weekNumber -> sessions[]

  (template.grid || []).forEach(cell => {
    const w = Number(cell.week);
    if (!weeksMap[w]) weeksMap[w] = [];

    // one session per non-empty cell
    if (cell.movement || cell.setsreps || cell.load || cell.notes || (cell.dow != null)) {
      weeksMap[w].push({
        title: `${cell.day}`,
        date: null,                 // left null; planning computes from DOW
        dow: (cell.dow != null && !isNaN(Number(cell.dow))) ? Number(cell.dow) : null, // 0..6 or null
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

  // Write weeks
  const batch = db.batch();
  Object.entries(weeksMap).forEach(([weekNumber, sessions]) => {
    const ref = db.collection('programs')
      .doc(trainerCode).collection('weeks').doc(String(weekNumber));
    batch.set(ref, { weekNumber: Number(weekNumber), sessions }, { merge: true });
  });

  // Link assignment to the user
  batch.set(
    db.collection('assignments').doc(userId),
    {
      trainerCode,
      weekNumber: 1, // you can change this if you assign other weeks
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
  if (!weeks || !weeks.length || !startDateISO) return map;

  // Sort by numeric weekNumber
  const ordered = weeks.slice().sort((a,b)=>
    (Number(a.weekNumber)||0) - (Number(b.weekNumber)||0)
  );

  ordered.forEach((w, wi)=>{
    const sessions = w.sessions || [];
    const weekAnchor = addDaysISO(startDateISO, wi * 7);

    sessions.forEach((s, i)=>{
      let date = null;

      if (s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
        date = s.date;
      } else if (s.dow != null && !isNaN(Number(s.dow))) {
        // place within this week on the selected DOW
        date = nextDateForDowOnOrAfter(weekAnchor, Number(s.dow));
      } else {
        // fallback: spread through the week with friendly offsets
        const offsets = defaultOffsetsForCount(sessions.length);
        const off = offsets[i] ?? i;
        date = addDaysISO(weekAnchor, off);
      }

      // avoid same-day collision
      while (map[date]) date = addDaysISO(date, 1);

      map[date] = {
        ...(s || {}),
        date,
        title: s.title || `W${w.weekNumber || (wi+1)} S${i+1}`,
        status: s.status || 'planned'
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
  const path = currentRoutePath();
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
    if (db) {
      // Read from GLOBAL library only
      const snap = await db.collection('exercises').orderBy('nameLower').get();
      snap.forEach(d => d.data()?.name && names.add(d.data().name));
    } else {
      // Local fallback
      (ls.get('bs_exercises', []) || []).forEach(n => names.add(n));
    }
  } catch(e){ console.warn('loadExerciseLibraryNames', e); }
  return [...names].sort((a,b)=> a.localeCompare(b, undefined, {sensitivity:'base'}));
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

// Returns just the route path (no query), e.g. "#/athlete?uid=123" -> "/athlete"
function currentRoutePath(){
  const hash = location.hash || '';
  return (hash.split('?')[0] || '#/login').replace('#','') || '/login';
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

function ProgramView(){
  const el = document.createElement('div');
  const sessions = state.program || [];

  if (!sessions.length){
    el.innerHTML = `<p class="muted">No program published yet.</p>`;
    return page('Program View', el);
  }

  const ul = document.createElement('ul'); ul.className = 'list';
  sessions.forEach((s, i)=>{
    const dateStr = Object.entries(state.sessionsMap).find(([,v]) => v.title === (s.title||`Session ${i+1}`))?.[0] || (s.date || '—');
    const li = document.createElement('li'); li.className = 'item';
    const ex = (s.blocks || []).map(b => `${b.name} — ${b.sets||1} x ${b.reps??'—'}${b.weight? ` @ ${b.weight} lb`:''}`).join('<br/>') || '<span class="muted">No blocks</span>';
    li.innerHTML = `
      <div class="grow">
        <div class="bold">${s.title || `Session ${i+1}`}</div>
        <div class="small muted">${dateStr}</div>
        <div class="mt small">${ex}</div>
      </div>
    `;
    ul.appendChild(li);
  });

  page('Program View', ul);
}

// ---- Exercise Library (shows ALL known exercises) ----
function ExerciseLibrary(){
  const root = document.createElement('div');

  // header + add form
  const form = document.createElement('div'); 
  form.className = 'row mt';
  form.innerHTML = `
    <label>New exercise <input id="exName" placeholder="e.g., Bulgarian Split Squat"/></label>
    <button id="addEx" class="btn">Add</button>
  `;

  const list = document.createElement('ul');
  list.className = 'list';
  list.innerHTML = `<li class="item"><div class="muted">Loading…</div></li>`;

  function renderList(names){
    list.innerHTML = '';

    const arr = (names || [])
      .slice()
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    if (!arr.length){
      list.innerHTML = `<li class="item"><div class="muted">No exercises yet.</div></li>`;
      return;
    }

    arr.forEach(name=>{
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <div class="grow">
          <div class="bold">${name}</div>
          <div class="muted small">Use Variation Record to add history</div>
        </div>
        <div class="row">
          <button class="btn small danger del-ex" data-name="${name}">Delete</button>
        </div>
      `;
      list.appendChild(li);
    });

    // Wire up delete buttons (fixed try/catch + braces)
    list.querySelectorAll('.del-ex').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const name = btn.getAttribute('data-name');
        try{
          await deleteExerciseByName(name);
          // cache-bust and reload
          _exerciseNamesCache = null;
          const fresh = db && state?.user?.uid ? await getExerciseNames() : (state.exercises || []);
          renderList(fresh);
          showToast(`Exercise "${name}" deleted`);
        }catch(e){
          alert(e.message);
        }
      });
    });
  }

  // load full library (DEFAULT_EXERCISES + user exercises)
  getExerciseNames()
    .then(names => {
      state.exercises = names; // keep in sync
      renderList(names);
    })
    .catch(() => renderList([]));

 form.querySelector('#addEx').addEventListener('click', async ()=>{
  const name = form.querySelector('#exName').value.trim();
  if (!name) return;

  try {
    if (db && state.user) {
      // Write to GLOBAL collection (coach-only per rules)
      await upsertGlobalExercise(null, { name });
    } else {
      // Local fallback only for demo mode
      const local = ls.get('bs_exercises', DEFAULT_EXERCISES) || [];
      if (!local.includes(name)) local.push(name);
      ls.set('bs_exercises', local);
      state.exercises = local;
    }

    _exerciseNamesCache = null;                 // cache-bust
    const names = await getExerciseNames();     // reload
    renderList(names);
    form.querySelector('#exName').value = '';
    showToast(`Exercise "${name}" added to global library ✅`);
  } catch(e){
    const msg = (e && e.code === 'permission-denied')
      ? 'Only coaches can add to the global library'
      : (e.message || 'Could not add exercise');
    alert(msg);
  }
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
      <label>Assign to Users
        <select id="assignUsers" multiple size="8" style="min-height: 8.5em;">
        </select>
        <div class="tiny muted">Tip: Cmd/Ctrl-click to select multiple.</div>
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
      <button class="btn ghost" id="exerciseLibBtn">Exercise Library</button>
    </div>

    <div class="divider"></div>
    <button id="publish" class="btn">Publish Week</button>
    <div id="out" class="mt muted small"></div>
  `;

  function getSelectedUserIds(){
  const sel = root.querySelector('#assignUsers');
  return Array.from(sel.selectedOptions || [])
    .map(o => o.value)
    .filter(Boolean);
}

  root.querySelector('#openSavedTemplates')?.addEventListener('click', ()=> go('/templates'));
  root.querySelector('#openTemplateBuilder')?.addEventListener('click', ()=> go('/template-builder'));
  root.querySelector('#athleteViewBtn')?.addEventListener('click', ()=> go('/athletes'));
  root.querySelector('#exerciseLibBtn').addEventListener('click', () => go('/exercises'));

  
  // flatpickr on Start Date
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
  const startDate = root.querySelector('#startDate').value || new Date().toISOString().slice(0,10);
  const targetUsers = getSelectedUserIds(); // <-- array

  if(!sessions.length) return alert('Add at least one session.');
  if(!db || !state.user) return alert('Login + Firebase required');

  try{
    // Publish/update the week once
    await db.collection('programs').doc(trainerCode)
      .collection('weeks').doc(String(weekNumber))
      .set({ weekNumber, sessions }, { merge: true });

    // Assign to all selected users (batched)
    if(targetUsers.length){
      const batch = db.batch();
      targetUsers.forEach(uid=>{
        const ref = db.collection('assignments').doc(uid);
        batch.set(ref, {
          trainerCode, weekNumber, startDate,
          assignedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
    }

    alert(`Published week ${weekNumber} (${sessions.length} sessions)` +
          (targetUsers.length ? ` and assigned to ${targetUsers.length} user(s).` : '.'));
    root.querySelector('#out').textContent =
      `Published week ${weekNumber} • ${sessions.length} sessions` +
      (targetUsers.length ? ` • Assigned to ${targetUsers.length}` : '');
  }catch(e){ alert(e.message); }
});

  async function populateLookups(){
    const codeSel = root.querySelector('#trainerCode');
    const userSel = root.querySelector('#assignUsers');
    codeSel.innerHTML = ``; userSel.innerHTML = ``;

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

// ---- Template Builder (with Day-of-Week) ----
function TemplateBuilder(){
  const root = document.createElement('div');
  const DEFAULT_WEEKS = 4;
  const DAYS = ['ME Upper','DE Upper','DE Lower','ME Lower'];
  const DOWS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  root.innerHTML = `
    <h3>Template Builder</h3>
    <div class="grid two">
      <label>Name <input id="tplName" placeholder="e.g., Fall Strength Cycle"/></label>
      <label>Weeks <input id="tplWeeks" type="number" min="1" value="${DEFAULT_WEEKS}"/></label>
    </div>

    <div class="muted small mt">
      Choose a Day of Week for each session (optional), then type/select a Movement.
    </div>
    <div class="divider"></div>

    <!-- Shared datalist used by all Movement inputs -->
    <datalist id="exOptions"></datalist>

    <div class="scroll-x">
      <table class="sheet" id="tplTable">
        <thead>
          <tr>
            <th style="white-space:nowrap;">Week</th>
            ${DAYS.map(d=>`<th>${d}<div class="muted tiny">Day • Movement • Sets×Reps • Load • Notes</div></th>`).join('')}
          </tr>
        </thead>
        <tbody id="tplBody"></tbody>
      </table>
    </div>

    <div class="row mt" style="gap:.5rem;">
      <button id="addWeek" class="btn small">+ Add Week</button>
      <button id="removeWeek" class="btn small danger">− Remove Last Week</button>
      <button id="saveTemplate" class="btn" style="margin-left:auto;">Save Template</button>
    </div>

    <div id="tplMsg" class="muted small mt"></div>
  `;

  // Populate the shared datalist from the Exercise Library
  (async ()=>{
    try{
      const names = await getExerciseNames();
      const dl = root.querySelector('#exOptions');
      dl.innerHTML = (names || [])
        .slice()
        .sort((a,b)=> a.localeCompare(b, undefined, {sensitivity:'base'}))
        .map(n => `<option value="${n}"></option>`).join('');
    }catch(e){ console.warn('exOptions load', e); }
  })();

  const body = root.querySelector('#tplBody');
  const weeksInput = root.querySelector('#tplWeeks');

  function daySelectHtml(){
    return `
      <select class="slot dow" data-field="dow">
        <option value="">— day —</option>
        ${DOWS.map((n,i)=> `<option value="${i}">${n}</option>`).join('')}
      </select>
    `;
  }

  function createWeekRow(weekNumber){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="bold" style="white-space:nowrap;">Week ${weekNumber}</td>` + DAYS.map(()=>`
      <td class="cell" data-week="${weekNumber}">
        <div class="row" style="gap:.5rem; align-items:center;">
          ${daySelectHtml()}
          <input class="slot input" data-field="movement" list="exOptions" placeholder="Movement" style="min-width:14em;"/>
        </div>
        <div class="slot" contenteditable="true" data-field="setsreps" placeholder="Sets×Reps"></div>
        <div class="slot" contenteditable="true" data-field="load" placeholder="Load"></div>
        <div class="slot" contenteditable="true" data-field="notes" placeholder="Notes"></div>
      </td>
    `).join('');
    return tr;
  }

  function currentWeekCount(){ return body.querySelectorAll('tr').length; }

  function addWeek(){
    const next = currentWeekCount() + 1;
    body.appendChild(createWeekRow(next));
    weeksInput.value = String(next);
  }

  function removeLastWeek(){
    const rows = body.querySelectorAll('tr');
    if (rows.length <= 1) { alert('At least 1 week is required.'); return; }
    body.removeChild(rows[rows.length - 1]);
    weeksInput.value = String(rows.length - 1);
  }

  function setWeekCount(n){
    n = Math.max(1, Math.floor(n || 1));
    const cur = currentWeekCount();
    if (n === cur) return;
    if (n > cur){
      for (let i = cur + 1; i <= n; i++) body.appendChild(createWeekRow(i));
    } else {
      for (let i = cur; i > n; i--){
        const last = body.querySelector('tr:last-child');
        if (last) body.removeChild(last);
      }
    }
    weeksInput.value = String(n);
  }

  // Initial render
  for (let w = 1; w <= DEFAULT_WEEKS; w++) body.appendChild(createWeekRow(w));

  // Buttons + Weeks input
  root.querySelector('#addWeek').addEventListener('click', addWeek);
  root.querySelector('#removeWeek').addEventListener('click', removeLastWeek);
  weeksInput.addEventListener('change', () => setWeekCount(parseInt(weeksInput.value || '1', 10)));

  // Save template (coach-only write)
  root.querySelector('#saveTemplate').addEventListener('click', async ()=>{
    const name = root.querySelector('#tplName').value.trim() || 'Untitled';
    if(!db || !state.user) return alert('Login + Firebase required.');
    const trainerCode = 'BARN';

    // Serialize cells → array of {week, day, dow, movement, setsreps, load, notes}
    const grid = [];
    const rows = [...body.querySelectorAll('tr')];
    rows.forEach((tr, idx)=>{
      const week = idx + 1;
      const cells = [...tr.querySelectorAll('td.cell')];
      cells.forEach((td, cIdx)=>{
        const dowRaw = td.querySelector('[data-field="dow"]')?.value ?? '';
        const dow = dowRaw === '' ? null : Number(dowRaw); // 0..6 or null

        const rec = {
          week,
          day: DAYS[cIdx],
          dow, // NEW
          movement: td.querySelector('[data-field="movement"]')?.value?.trim() || '',
          setsreps: td.querySelector('[data-field="setsreps"]')?.innerText.trim() || '',
          load:     td.querySelector('[data-field="load"]')?.innerText.trim() || '',
          notes:    td.querySelector('[data-field="notes"]')?.innerText.trim() || ''
        };
        // skip completely empty cells
        if(rec.movement || rec.setsreps || rec.load || rec.notes || rec.dow != null) grid.push(rec);
      });
    });

    try{
      const weeksCount = currentWeekCount(); // authoritative
      const ref = db.collection('templates').doc(trainerCode).collection('defs').doc();
      await ref.set({
        name,
        weeksPerMesocycle: weeksCount,
        mesocycles: 1,
        grid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: state.user.uid
      });
      root.querySelector('#tplMsg').textContent = `Saved "${name}" (${grid.length} items, ${weeksCount} week${weeksCount>1?'s':''}).`;
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
    const list = root.querySelector('#tplList');
    if(!db || !state.user){
      list.innerHTML = `<div class="item">Firebase required.</div>`;
      return;
    }

    const trainerCode = 'BARN'; // adjust if you support multiple codes

    try{
      // Load templates
      const snap = await db.collection('templates')
        .doc(trainerCode)
        .collection('defs')
        .orderBy('createdAt','desc')
        .get();

      if (snap.empty){
        list.innerHTML = `<div class="item">No templates yet. Create one in Template Builder.</div>`;
        return;
      }

      // Preload users for assignment
      const usersSelProto = document.createElement('select');
      usersSelProto.innerHTML = `<option value="">— select user —</option>`;
      const users = await db.collection('users').limit(300).get();
      users.forEach(u=>{
        const d = u.data() || {};
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = d.username || d.email || u.id.slice(0,6);
        usersSelProto.appendChild(opt);
      });

      snap.forEach(doc=>{
        const t = doc.data() || {};
        const row = document.createElement('div'); row.className='item';
        row.innerHTML = `
          <div class="grow">
            <div class="bold">${t.name || '(untitled)'}</div>
            <div class="muted small">
              Items: ${t.grid?.length || 0}${t.weeksPerMesocycle ? ` • Weeks: ${t.weeksPerMesocycle}` : ''}
            </div>
          </div>
          <div class="row" style="gap:.5rem; align-items:center;">
            <input type="date" class="startDate" />
            <span class="userSlot"></span>
            <button class="btn small assignBtn">Assign</button>
          </div>
        `;

        // Clone per-row user select
        const sel = usersSelProto.cloneNode(true);
        row.querySelector('.userSlot').appendChild(sel);

        // Wire assignment
        row.querySelector('.assignBtn').addEventListener('click', async ()=>{
          const uid = sel.value;
          const start = row.querySelector('.startDate').value || new Date().toISOString().slice(0,10);
          if(!uid) return alert('Select a user to assign.');

          try{
            await assignTemplateToUser({
              templateId: doc.id,
              template: t,
              trainerCode,
              userId: uid,
              startDate: start
            });
            alert('Assigned!');
          }catch(e){
            alert(e.message || 'Failed to assign');
          }
        });

        list.appendChild(row);
      });
    }catch(e){
      console.warn(e);
      list.innerHTML = `<div class="item">Error: ${e.message}</div>`;
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

        // Assignment summary
        const assign = await db.collection('assignments').doc(uid).get();
        let assignedText = 'No program assigned';
        let planCount = 0;
        if(assign.exists){
          const a = assign.data();
          assignedText = `Assigned: ${a.trainerCode} • Week ${a.weekNumber} • Start ${a.startDate}`;
          const weekDoc = await db.collection('programs')
                                  .doc(a.trainerCode)
                                  .collection('weeks')
                                  .doc(String(a.weekNumber)).get();
          planCount = weekDoc.exists ? ((weekDoc.data().sessions||[]).length) : 0;
        }

        // 7-day completion count
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
            <div class="bold">
              <a href="#/athlete?uid=${uid}">${name}</a>
            </div>
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

// ---- Small helper for hash query params (e.g., #/athlete?uid=123) ----
function getQueryParam(key){
  try{
    const q = (location.hash || '').split('?')[1] || '';
    return new URLSearchParams(q).get(key);
  }catch{ return null; }
}

// ---- Athlete Detail (Program | Scheduled Sessions | Variation Record) ----
function AthleteDetail(){
  if (!isCoachUser || !isCoachUser()) {
    return page('Athlete Detail', `<p class="muted">Coach access required.</p>`);
  }

  const uid = getQueryParam('uid');
  if (!uid){
    return page('Athlete Detail', `<p class="muted">No athlete selected.</p>`);
  }

  const root = document.createElement('div');
  root.innerHTML = `
    <div class="row" style="gap:.5rem; align-items:center;">
      <div class="tabs" style="display:flex; gap:.5rem;">
        <button class="btn small" data-tab="program">Program</button>
        <button class="btn small ghost" data-tab="scheduled">Scheduled Sessions</button>
        <button class="btn small ghost" data-tab="variations">Variation Record</button>
      </div>
      <div style="margin-left:auto; display:flex; gap:.5rem;">
        <button id="btnUnassign" class="btn small danger">Delete Program</button>
      </div>
    </div>
    <div id="athMeta" class="muted small mt">Loading athlete…</div>
    <div id="athBody" class="mt">Loading…</div>
  `;
  page('Athlete Detail', root);

  const metaEl = root.querySelector('#athMeta');
  const bodyEl = root.querySelector('#athBody');

  // Local-only (don't mutate global state.*)
  let profile = {};
  let sessionsMap = {};       // from program + startDate (reference)
  let scheduledDays = [];     // [{ date: 'YYYY-MM-DD', title, blocks, status }]
  let logs = [];              // athlete logs (if rules allow coach read)

  function setActive(tab){
    root.querySelectorAll('.tabs .btn').forEach(b=>{
      b.classList.toggle('ghost', b.dataset.tab !== tab);
    });
  }

  function renderProgram(){
    setActive('program');
    if (!Object.keys(sessionsMap).length){
      bodyEl.innerHTML = `<p class="muted">No scheduled sessions derived from program.</p>`;
      return;
    }
    const ul = document.createElement('ul'); ul.className = 'list';
    Object.entries(sessionsMap)
      .sort((a,b)=> a[0].localeCompare(b[0]))
      .forEach(([date, s])=>{
        const ex = (s.blocks || []).map(b =>
          `${b.name} — ${b.sets||1} x ${b.reps??'—'}${b.weight? ` @ ${b.weight} lb`:''}`
        ).join('<br/>') || '<span class="muted">No blocks</span>';
        const li = document.createElement('li'); li.className='item';
        li.innerHTML = `
          <div class="grow">
            <div class="bold">${s.title || 'Session'}</div>
            <div class="small muted">${date}</div>
            <div class="mt small">${ex}</div>
          </div>`;
        ul.appendChild(li);
      });
    bodyEl.innerHTML = '';
    bodyEl.appendChild(ul);
  }

  function renderScheduled(){
    setActive('scheduled');
    const today = new Date().toISOString().slice(0,10);

    // Show upcoming sessions; remove filter to include past as well.
    const upcoming = (scheduledDays || [])
      .filter(d => (d.date || '') >= today)
      .sort((a,b)=> a.date.localeCompare(b.date));

    if (!upcoming.length){
      bodyEl.innerHTML = `<p class="muted">No upcoming scheduled sessions.</p>`;
      return;
    }

    const ul = document.createElement('ul'); ul.className = 'list';
    upcoming.forEach(s => {
      const ex = (s.blocks || []).map(b =>
        `${b.name} — ${b.sets||1} x ${b.reps??'—'}${b.weight? ` @ ${b.weight} lb`:''}`
      ).join('<br/>') || '<span class="muted">No blocks</span>';

      const status = (s.status || 'planned');
      const deletable = status !== 'completed'; // safety: don't delete completed by default

      const li = document.createElement('li'); li.className='item';
      li.innerHTML = `
        <div class="grow">
          <div class="row" style="align-items:center; gap:.5rem;">
            <div class="bold">${s.title || 'Session'}</div>
            <span class="chip small" style="margin-left:auto">${status}</span>
            <button class="btn small danger del-day" data-date="${s.date}" ${deletable ? '' : 'disabled title="Completed sessions are not deleted"'}>Delete</button>
          </div>
          <div class="small muted">${s.date}</div>
          <div class="mt small">${ex}</div>
        </div>`;
      ul.appendChild(li);
    });

    bodyEl.innerHTML = '';
    bodyEl.appendChild(ul);

    // Wire per-session delete buttons
    bodyEl.querySelectorAll('.del-day').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const date = btn.getAttribute('data-date');
        if (!date) return;
        const ok = confirm(`Delete scheduled session on ${date}? This removes it from the athlete's calendar.`);
        if (!ok) return;
        try{
          await db.collection('sessions').doc(uid).collection('days').doc(date).delete();
          // Update local state and re-render
          scheduledDays = scheduledDays.filter(d => d.date !== date);
          showToast(`Deleted session on ${date}`);
          renderScheduled();
        }catch(e){
          alert(e.message || 'Failed to delete session');
        }
      });
    });
  }

  function renderVariations(){
    setActive('variations');
    const container = document.createElement('div');
    container.innerHTML = `
      <p class="muted">Recent sets grouped by exercise.</p>
      <input id="q" placeholder="Search exercise"/>
      <ul id="varList" class="list mt"></ul>
    `;
    const ul = container.querySelector('#varList');

    function renderList(){
      ul.innerHTML = '';
      const q = container.querySelector('#q').value.trim().toLowerCase();
      const names = new Set([...(state.exercises||[]), ...logs.map(h=>h.exercise)]);
      const list = [...names].filter(n=> n && (!q || n.toLowerCase().includes(q))).sort();

      list.forEach(name=>{
        const entries = logs.filter(h=> h.exercise===name).sort((a,b)=> b.date.localeCompare(a.date));
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

    container.querySelector('#q').addEventListener('input', renderList);
    renderList();
    bodyEl.innerHTML = '';
    bodyEl.appendChild(container);
  }

  // -------- Coach actions --------
  async function unassignProgramAndOptionallyClear(){
    if (!db) return alert('Firebase required.');
    // First confirm unassign
    const unassign = confirm('Delete this athlete’s program assignment? This will remove the assignment link.');
    if (!unassign) return;

    try{
      await db.collection('assignments').doc(uid).delete();
    }catch(e){
      alert(e.message || 'Failed to delete assignment');
      return;
    }

    // Then optionally clear scheduled (non-completed) days
    const clearDays = confirm('Also clear scheduled days that are NOT completed?');
    if (clearDays){
      try{
        const snap = await db.collection('sessions').doc(uid).collection('days').get();
        const toDelete = snap.docs.filter(d => (d.data()?.status || 'planned') !== 'completed');
        // Chunk deletes to be safe
        const chunk = 400;
        for (let i=0; i<toDelete.length; i+=chunk){
          const batch = db.batch();
          toDelete.slice(i, i+chunk).forEach(doc => batch.delete(doc.ref));
          await batch.commit();
        }
      }catch(e){
        alert(e.message || 'Assignment removed, but failed to clear some scheduled days');
      }
    }

    // Refresh local view
    try{
      const daysSnap = await db.collection('sessions').doc(uid).collection('days').get();
      scheduledDays = daysSnap.docs.map(d => ({ date: d.id, ...(d.data() || {}) }));
    }catch{ scheduledDays = []; }

    sessionsMap = {}; // derived program reference no longer relevant
    showToast('Program deleted');
    renderScheduled();
  }

  // Tab switching
  root.querySelectorAll('.tabs .btn').forEach(btn=>{
    btn.addEventListener('click', ()=> {
      if (btn.dataset.tab === 'program') renderProgram();
      else if (btn.dataset.tab === 'scheduled') renderScheduled();
      else renderVariations();
    });
  });

  // Wire delete program button
  root.querySelector('#btnUnassign').addEventListener('click', unassignProgramAndOptionallyClear);

  // -------- Data load --------
  async function loadAthleteData(){
    if(!db){ bodyEl.textContent = 'Firebase required.'; return; }

    // Profile
    const uref = await db.collection('users').doc(uid).get();
    profile = uref.exists ? (uref.data()||{}) : {};
    metaEl.textContent = `Athlete: ${profile.username || profile.email || uid}`;

    // Assignment → sessionsMap from program + startDate (reference)
    const asnap = await db.collection('assignments').doc(uid).get();
    if (asnap.exists){
      const a = asnap.data() || {};
      const trainerCode = a.trainerCode || 'BARN';
      const startDate = a.startDate || new Date().toISOString().slice(0,10);
      const weeksSnap = await db.collection('programs').doc(trainerCode).collection('weeks').get();
      const weeks = weeksSnap.docs.map(d=>{
        const data = d.data() || {};
        const wn = data.weekNumber != null ? data.weekNumber : Number(d.id) || null;
        return { weekNumber: wn, ...data };
      });
      sessionsMap = buildSessionsMapFromWeeks(weeks, startDate);
    } else {
      sessionsMap = {};
    }

    // Scheduled sessions (authoritative)
    try{
      const daysSnap = await db.collection('sessions').doc(uid).collection('days').get();
      scheduledDays = daysSnap.docs.map(d => ({ date: d.id, ...(d.data() || {}) }));
    }catch(e){
      scheduledDays = [];
      console.warn('Coach cannot read scheduled days (check /sessions rules)', e);
    }

    // Logs (optional; needs coach read in rules)
    try{
      const logsSnap = await db.collection('logs').doc(uid).collection('entries')
                        .orderBy('date','desc').limit(500).get();
      logs = logsSnap.docs.map(d => d.data());
    }catch(e){
      logs = [];
      console.warn('Coach cannot read athlete logs (expected if logs are private)', e);
    }

    // Default tab
    renderScheduled(); // start on Scheduled since it’s the actionable tab now
  }

  loadAthleteData().catch(e=>{
    console.warn(e);
    bodyEl.innerHTML = `<p class="muted">Error loading athlete: ${e.message}</p>`;
  });
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
route('/athlete', AthleteDetail);


// ---- Auth glue (compat SDK) ----

// Coach flag for UI gating (rules still enforce writes)
const COACH_UID = "Pxgym9zVYmYifKvF4AeXotus4wJ2";
function isCoachUser() {
  const u = firebase.auth().currentUser;
  return !!u && u.uid === COACH_UID;
}

// Toggle this if you still want athletes to see their *personal* exercises merged in
const INCLUDE_PERSONAL_EXERCISES = false;

// Helper: safely push an unsubscribe and create state.unsub if needed
function trackUnsub(fn) {
  (state.unsub ||= []).push(fn);
}

// Helper: clear all active listeners
function clearUnsubs() {
  if (Array.isArray(state.unsub)) {
    state.unsub.forEach(fn => { try { fn(); } catch (_) {} });
  }
  state.unsub = [];
}

// Subscribe to global + (optional) personal exercises and keep state.exercises updated
function subscribeExercises(uid) {
  const db = firebase.firestore();

  // Merge function that dedupes by name (case-insensitive) and sorts alpha
  function mergeAndPublish(globalDocs, personalDocs) {
    const items = [];
    const seen = new Set();
    const pushName = (name) => {
      const key = (name || "").trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push(name.trim());
    };

    globalDocs.forEach(d => pushName(d.data().name || d.data().nameLower || d.id));
    personalDocs.forEach(d => pushName(d.data().name || d.data().nameLower || d.id));

    items.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    state.exercises = items;
    // Only re-render Coach Portal-heavy views to avoid thrash
    const p = currentRoutePath();
      if (p === '/coach' || p === '/template' || p === '/exercises') {render();
    }
  }

  let globalDocs = [];
  let personalDocs = [];

  // Global exercises (coach-managed)
  const unsubGlobal = db.collection('exercises')
    .orderBy('nameLower') // single-field index, auto-created by Firestore
    .onSnapshot(snap => {
      globalDocs = snap.docs;
      mergeAndPublish(globalDocs, personalDocs);
    }, err => console.warn('global exercises snapshot error', err));
  trackUnsub(unsubGlobal);

  // Optional: personal exercises under the signed-in user
  if (INCLUDE_PERSONAL_EXERCISES && uid) {
    const unsubPersonal = db.collection('users').doc(uid)
      .collection('exercises')
      .orderBy('nameLower')
      .onSnapshot(snap => {
        personalDocs = snap.docs;
        mergeAndPublish(globalDocs, personalDocs);
      }, err => console.warn('personal exercises snapshot error', err));
    trackUnsub(unsubPersonal);
  }
}

async function main() {
  await initFirebase(); // should set window.db = firebase.firestore(), window.auth = firebase.auth()

  if (!auth) {
    console.error("Firebase auth not initialized");
    return;
  }

  auth.onAuthStateChanged(async (user) => {
    // Clean up old listeners on any auth change
    clearUnsubs();

    state.user = user;

    if (!user) {
      state.profile = {};
      render();
      return go('/login');
    }

    // Ensure a /users/{uid} doc exists
    const uref = db.collection('users').doc(user.uid);
    const snap = await uref.get();
    if (!snap.exists) {
      await uref.set({
        username: (user.email || '').split('@')[0],
        goal: '',
        trainerCode: 'BARN',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      // ❗ If you still want per-user libraries for athletes, you can keep this.
      // But for a *global* coach-managed library, you likely want this OFF.
      // await ensureExercises(); // (legacy) seeds *user* exercise library
    }

    // Live profile listener
    const unsubProfile = uref.onSnapshot(pdoc => {
      state.profile = pdoc.data() || {};
      render(); // updates drawer header, settings, etc.
    }, err => console.warn('profile snapshot error', err));
    trackUnsub(unsubProfile);

    // Live logs (private to the user)
    const unsubLogs = db.collection('logs').doc(user.uid).collection('entries')
      .orderBy('date', 'desc').limit(300)
      .onSnapshot(s => { state.logs = s.docs.map(d => d.data()); },
                  err => console.warn('logs snapshot error', err));
    trackUnsub(unsubLogs);

    // NEW: subscribe to global (+ optional personal) exercises
    subscribeExercises(user.uid);

    // Assignments → hydrate program into sessionsMap
    const unsubAssign = db.collection('assignments').doc(user.uid)
      .onSnapshot(async (asnap) => {
        if (!asnap.exists) {
          state.sessionsMap = {};
          state.program = [];
          render();
          return;
        }

        const a = asnap.data(); // {trainerCode, weekNumber, startDate}
        if (!a?.trainerCode || !a?.weekNumber) {
          state.sessionsMap = {};
          state.program = [];
          render();
          return;
        }

        try {
          const weekDoc = await db
            .collection('programs').doc(a.trainerCode)
            .collection('weeks').doc(String(a.weekNumber)).get();

          const sessions = weekDoc.exists ? (weekDoc.data().sessions || []) : [];

          // If startDate missing, anchor to today to keep UX alive
          const anchor = a.startDate || new Date().toISOString().slice(0, 10);
          const map = planSessionsToDates(sessions, anchor);

          state.program = sessions;
          state.sessionsMap = map;

          // Persist planned days under /sessions/{uid}/days for Calendar/Today views
          await writePlannedDaysToFirestore(user.uid, map);

          render();
        } catch (err) {
          console.warn('assignment -> program hydrate error', err);
        }
      }, err => console.warn('assignments snapshot error', err));
    trackUnsub(unsubAssign);

    // Land user
    go('/dashboard');
  });

  render();
  setTimeout(setNetBanner, 500);
}

function render() {
  const path = currentRoutePath();          // <-- strip ?uid=...
  const authed = !!state.user;

  qs('#drawerName').textContent = state.profile?.username || (state.user?.email || 'Guest');
  qs('#drawerGoal').textContent = 'Goal: ' + (state.profile?.goal || '—');

  if (!authed && path !== '/login') return go('/login');

  (routes[path] || routes['/404'])();
}


// Logout handling
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'logoutBtn') {
    if (auth) { auth.signOut(); }
    else { state.user = null; ls.rm('bs_demo_user'); }
    clearUnsubs();
    openDrawer(false);
    go('/login');
  }
});
// ---- Service Worker (GitHub Pages scope-safe) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => console.log('SW registered:', reg.scope))
      .catch(err => console.warn('SW register failed', err));
  });
}

main();
qs('#splash')?.remove();

