
const grid = document.getElementById('grid');
const monthIn = document.getElementById('month');
const title = document.getElementById('monthTitle');

document.getElementById('prev').onclick = () => shift(-1);
document.getElementById('next').onclick = () => shift(1);
document.getElementById('reload').onclick = loadMonth;

monthIn.value = new Date().toISOString().slice(0,7);

function shift(n){
  const [y,m] = monthIn.value.split('-').map(Number);
  const d = new Date(y, m-1, 1);
  d.setMonth(d.getMonth()+n);
  monthIn.value = d.toISOString().slice(0,7);
  loadMonth();
}

function iso(d){ return d.toISOString().slice(0,10); }
function startOfGrid(first){
  const s = new Date(first);
  s.setDate(1);
  const dow = s.getDay(); // 0=Sun
  s.setDate(1 - dow);
  return s;
}
function monthLabel(d){ return d.toLocaleString(undefined,{month:'long', year:'numeric'}) }

// Quality ranking (higher is better)
const RANK = { "slow-flashing-red":0, "red":1, "yellow":2, "green":3 };
function worst(a,b){ return (RANK[a] < RANK[b]) ? a : b; }
function cls(q){ return q==="green" ? "green" : q==="yellow" ? "yellow" : q==="slow-flashing-red" ? "waiver" : "red"; }

// Local intent store (per date|block)
const intents = new Map();

function needHint(q){
  if(q==="green") return "";
  if(q==="yellow") return "Need: EMT‑B";
  if(q==="red") return "Need: ALS Attendant";
  return "Need: EMT‑B + ALS";
}

function buildDay(d, fMap, aMap, monthStart){
  const dateIso = iso(d);

  // Determine shift colors (worst of active units)
  const shiftColor = { day:null, night:null };
  ["day","night"].forEach(block => {
    let c = null, any = false;
    ["120","121","123"].forEach(u => {
      // unit activity (demo: 123 AM off some days)
      const a = aMap.get(`${dateIso}|${u}`) || { am_active:1, pm_active:1 };
      const on = (block==="day") ? a.am_active : a.pm_active;
      if(!on) return;
      const f = fMap.get(`${dateIso}|${u}|${block}`);
      if(f){
        any = true;
        c = c ? worst(c, f.forecast_quality) : f.forecast_quality;
      }
    });
    shiftColor[block] = any ? c : "slow-flashing-red";
  });

  // Day roll-up
  const dayRoll = worst(shiftColor.day, shiftColor.night);
  const day = el("div", "day outline-" + cls(dayRoll));
  if (d.getMonth() !== monthStart.getMonth()) day.classList.add("inactive");

  day.innerHTML = `
    <div class="dateBar">
      <div class="date">${dateIso}</div>
      <div class="roll">${dayRoll.toUpperCase()}</div>
    </div>`;

  const unitWrap = el("div","unitWrap");
  unitWrap.innerHTML = `<div class="unitHead"><b>AM / PM</b><span>shift‑level intents</span></div>`;
  const shifts = el("div","shifts");

  ["day","night"].forEach(block => {
    const color = shiftColor[block];
    const s = el("div","shift");
    s.innerHTML = `
      <div class="shiftHeader">
        <span class="bubble ${cls(color)}">${block==="day"?"AM":"PM"}</span>
        <span class="need">${needHint(color)}</span>
      </div>`;

    const seg = el("div","intent");
    seg.innerHTML = `
      <div class="seg">
        <button data-val="preferred">preferred</button>
        <button data-val="available">available</button>
        <button data-val="standby">standby</button>
      </div>`;

    // restore selection (if any)
    const key = `${dateIso}|${block}`;
    const saved = intents.get(key) || null;
    if(saved) seg.querySelector(`[data-val="${saved}"]`).classList.add("on");

    seg.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => {
        seg.querySelectorAll("button").forEach(x=>x.classList.remove("on"));
        btn.classList.add("on");
        intents.set(key, btn.dataset.val);
      };
    });

    s.appendChild(seg);
    shifts.appendChild(s);
  });

  unitWrap.appendChild(shifts);
  day.appendChild(unitWrap);
  grid.appendChild(day);
}

function renderDemo(first){
  // create fake forecasts + unit activity for visible month
  const last = new Date(first.getFullYear(), first.getMonth()+1, 0).getDate();
  const forecasts = [], active = [];
  for(let d=1; d<=last; d++){
    const di = new Date(first.getFullYear(), first.getMonth(), d).toISOString().slice(0,10);
    ["120","121","123"].forEach((u,ui)=>{
      active.push({ service_date:di, unit_id:u, am_active:(u!=="123" || d%3!==0), pm_active:1 });
      ["day","night"].forEach((b,bi)=>{
        const idx = (d + ui + bi) % 4;
        const qual = ["green","yellow","red","slow-flashing-red"][idx];
        forecasts.push({ service_date:di, unit_id:u, block:b, forecast_quality:qual });
      });
    });
  }
  const fMap = new Map(); forecasts.forEach(r=>fMap.set(`${r.service_date}|${r.unit_id}|${r.block}`, r));
  const aMap = new Map(); active.forEach(r=>aMap.set(`${r.service_date}|${r.unit_id}`, r));

  grid.innerHTML = "";
  const start = startOfGrid(first);
  for(let i=0;i<42;i++){
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate()+i);
    buildDay(day, fMap, aMap, first);
  }
}

function loadMonth(){
  const ym = monthIn.value;
  const first = new Date(ym + "-01");
  title.textContent = monthLabel(first);
  renderDemo(first);
}

function el(tag, cls){
  const x = document.createElement(tag);
  if(cls) x.className = cls;
  return x;
}

// initial render
loadMonth();
