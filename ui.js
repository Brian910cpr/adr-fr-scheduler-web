const grid = document.getElementById('grid');
const apiIn = document.getElementById('apiBase');
const monthIn = document.getElementById('month');
document.getElementById('prev').onclick=()=>shift(-1);
document.getElementById('next').onclick=()=>shift(1);
document.getElementById('reload').onclick=loadMonth;
document.getElementById('loadMe').onclick=()=>{document.getElementById('me').textContent='(demo) Chris Smith — EMT-B';loadMonth()};

monthIn.value = new Date().toISOString().slice(0,7);

function shift(n){ const [y,m]=monthIn.value.split('-').map(Number); const d=new Date(y,m-1,1); d.setMonth(d.getMonth()+n); monthIn.value=d.toISOString().slice(0,7); loadMonth(); }

function iso(d){ return d.toISOString().slice(0,10); }
function startOfGrid(first){
  const s=new Date(first); s.setDate(1); const dow=s.getDay(); s.setDate(1-dow); return s;
}

async function loadMonth(){
  const api = apiIn.value.trim();
  if(!api){
    renderDemo(); // no API -> demo
    return;
  }
  try{
    const ym = monthIn.value;
    const first = new Date(ym+'-01'); const last = new Date(first.getFullYear(), first.getMonth()+1, 0);
    const [fc,ua] = await Promise.all([
      fetch(api+`/forecast?from=${iso(first)}&to=${iso(last)}`).then(r=>r.json()),
      fetch(api+`/units-active?from=${iso(first)}&to=${iso(last)}`).then(r=>r.json())
    ]);
    renderGrid(first, fc.rows||[], ua.rows||[]);
  }catch(e){
    console.warn('API failed, showing demo grid', e);
    renderDemo();
  }
}

function renderGrid(first, forecasts, unitsActive){
  const fMap = new Map(); forecasts.forEach(r=>fMap.set(`${r.service_date}|${r.unit_id}|${r.block}`, r));
  const aMap = new Map(); unitsActive.forEach(r=>aMap.set(`${r.service_date}|${r.unit_id}`, r));
  grid.innerHTML='';
  const start = startOfGrid(first);
  for(let i=0;i<42;i++){
    const d = new Date(start); d.setDate(start.getDate()+i);
    const dateIso = iso(d);
    let daily='green', any=false;
    ['120','121','123'].forEach(u=>{
      const act=aMap.get(`${dateIso}|${u}`)||{am_active:1,pm_active:1};
      ['day','night'].forEach(b=>{
        if((b==='day'?act.am_active:act.pm_active)){
          const f=fMap.get(`${dateIso}|${u}|${b}`); if(f){ any=true; daily = worse(daily,f.forecast_quality); }
        }
      });
    });
    const day = el('div','day '+(any?daily:''));
    day.innerHTML = `<div class="dayHeader"><span>${dateIso}</span><span>${any?daily.toUpperCase():''}</span></div>`;
    const units = el('div','units');
    ['120','121','123'].forEach(u=>{
      const act=aMap.get(`${dateIso}|${u}`)||{am_active:1,pm_active:1};
      const unit = el('div','unit');
      unit.innerHTML = `<div class="row"><b>${u}</b><span class="small">AM/PM</span></div>`;
      const shifts = el('div','shifts');
      ['day','night'].forEach(b=>{
        if(!(b==='day'?act.am_active:act.pm_active)) return;
        const f=fMap.get(`${dateIso}|${u}|${b}`);
        const s = el('div','shift');
        const need = f&&f.need?`Need: ${f.need}`:'';
        s.innerHTML = `<div class="row"><span class="chip ${cls(f&&f.forecast_quality)}">${(b==='day'?'AM':'PM')}</span><span class="small">${need}</span></div>`
        + seatRow(dateIso,u,b,'Attendant') + seatRow(dateIso,u,b,'Driver');
        shifts.appendChild(s);
      });
      if(shifts.children.length) unit.appendChild(shifts);
      units.appendChild(unit);
    });
    day.appendChild(units); grid.appendChild(day);
  }
}

function renderDemo(){
  const ym = monthIn.value;
  const first = new Date(ym+'-01');
  const forecasts=[], active=[];
  for(let d=1; d<=new Date(first.getFullYear(),first.getMonth()+1,0).getDate(); d++){
    const date = iso(new Date(first.getFullYear(), first.getMonth(), d));
    ['120','121','123'].forEach(u=>{
      active.push({service_date:date, unit_id:u, am_active: (u!=='123'), pm_active:1});
      ['day','night'].forEach(b=>{
        const idx = (d + (u==='121'?1:u==='123'?2:0) + (b==='night'?1:0))%4;
        const qual = ['green','yellow','red','slow-flashing-red'][idx];
        const need = qual==='green' ? '' : (qual==='yellow'?'EMT-B':'ALS Attendant');
        forecasts.push({service_date:date,unit_id:u,block:b,forecast_quality:qual,need});
      });
    });
  }
  renderGrid(first, forecasts, active);
}

function seatRow(date, unit, block, seat){
  return `<div class="row"><span>${seat}</span>
    <span>
      <select><option>preferred</option><option>available</option><option>standby</option></select>
      <button>Submit</button>
    </span></div>`;
}
function el(tag, cls){ const x=document.createElement(tag); if(cls) x.className=cls; return x; }
function cls(q){ if(q==='green')return'green'; if(q==='yellow')return'yellow'; if(q==='slow-flashing-red')return'waiver'; return 'red'; }
function worse(a,b){ const r={green:3,yellow:2,red:1,'slow-flashing-red':0}; return (r[a]<r[b])?a:b; }

loadMonth();