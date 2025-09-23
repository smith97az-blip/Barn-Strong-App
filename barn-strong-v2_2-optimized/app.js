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

// ---- v2.3 seam: analytics() placeholder (no-op in v2.2) ----
function logEvent(){ /* no-op in v2.2; real impl lands in v2.3 */ }

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
  // Simple KPIs (dumb metrics in v2.2, richer in v2.3)
  const totalSessions = new Set(state.logs.map(h=>h.date)).size;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="kpi">
      <div class="tile"><div class="title">Sessions Logged</div><div class="value">${totalSessions}</div></div>
      <div class="tile"><div class="title">Exercises</div><div class="value">${state.exercises.length}</div></div>
      <div class="tile"><div class="title">Upcoming</div><div>${findNextSession(state.sessionsMap)?.title || '—'}</div></div>
    </div>
    <div class="divider"></div>
    <div class="chips">
      <a class="chip" href="#/today">Today’s Session</a>
      <a class="chip" href="#/calendar">Calendar</a>
      <a class="chip" href="#/variations">Variation Record</a>
      <a class="chip" href="#/program">Program View</a>
      <a class="chip" href="#/exercises">Exercise Library</a>
      <a class="chip" href="#/coach">Coach Portal</a>
    </div>`;
  page('Dashboard', el);
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
  const sess = state.sessionsMap[today];
  const el = document.createElement('div');
  if(!sess){ el.innerHTML = `<p>No session scheduled for today.</p>`; return page("Today's Session", el); }
  const list = document.createElement('ul'); list.className='list';
  (sess.blocks || sess.exercises || []).forEach(ex=>{
    const li = document.createElement('li'); li.className='item';
    li.innerHTML = `<div class="grow">
      <div class="bold">${ex.name}</div>
      <div class="muted small">${(ex.sets||1)} x ${(ex.reps||'—')}${ex.weight?' @ '+ex.weight+' lb':''}</div>
      <div class="row mt">
        <label>Date <input class="d" type="date" value="${today}"/></label>
        <label>Weight <input class="w" type="number" value="${ex.weight??''}"/></label>
        <label>Sets <input class="s" type="number" value="${ex.sets??1}"/></label>
        <label>Reps <input class="r" type="number" value="${ex.reps??''}"/></label>
        <button class="btn small log">Log</button>
      </div>
    </div>`;
    li.querySelector('.log').addEventListener('click', async()=>{
      const d = li.querySelector('.d').value || today;
      const w = parseFloat(li.querySelector('.w').value||'') || null;
      const s = parseInt(li.querySelector('.s').value||'') || null;
      const r = parseInt(li.querySelector('.r').value||'') || null;
      state.logs.unshift({ date:d, exercise: ex.name, weight:w, sets:s, reps:r });
      if(db && state.user){
        try{
          await db.collection('logs').doc(state.user.uid).collection('entries').add({ date:d, exercise:ex.name, weight:w, sets:s, reps:r, source:'today', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        }catch(e){ console.warn(e); }
      }else{
        const local = ls.get('bs_logs',[]); local.unshift({ date:d, exercise:ex.name, weight:w, sets:s, reps:r }); ls.set('bs_logs', local);
      }
      alert('Logged!');
    });
    list.appendChild(li);
  });
  page("Today's Session", list);
}

function VariationRecord(){
  const root = document.createElement('div');
  const ul = document.createElement('ul'); ul.className='list mt';
  const names = new Set([...(state.exercises||[]), ...state.logs.map(h=>h.exercise)]);
  [...names].sort().forEach(name=>{
    const li = document.createElement('li'); li.className='item';
    li.innerHTML = `<div class="grow">
      <div class="bold">${name}</div>
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
      state.logs.unshift({ date:d, exercise:name, weight:w, sets:s, reps:r });
      if(db && state.user){
        try{
          await db.collection('logs').doc(state.user.uid).collection('entries').add({ date:d, exercise:name, weight:w, sets:s, reps:r, source:'retro', createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        }catch(e){ console.warn(e); }
      }else{
        const local = ls.get('bs_logs',[]); local.unshift({ date:d, exercise:name, weight:w, sets:s, reps:r }); ls.set('bs_logs', local);
      }
      alert('Saved.');
    });
    ul.appendChild(li);
  });
  page('Variation Record', [ul]);
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
  const el = document.createElement('div');
  el.innerHTML = `<p class="muted">Coach Portal (basic). v2.3 will add Program Builder & publishing.</p>`;
  page('Coach Portal', el);
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
    state.user = demoUser; ensureLocalExercises(); go('/dashboard');
  }
  render();
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
