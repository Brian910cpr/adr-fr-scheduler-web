import React, { useEffect, useMemo, useRef, useState } from "react";

// ShiftCommander — 3-view scheduling app (now with backend API + WebSocket sync)
// No email, no voice, no external SMS. Multiuser-ready.
// BACKEND EXPECTATIONS (see server code provided in chat):
//  - HTTP API base: http://localhost:4000
//    GET    /api/users
//    POST   /api/users                          { name, role, can_drive: string[], notes }
//    GET    /api/state?start=YYYY-MM-DD&end=YYYY-MM-DD  -> { shifts: {date:{AM:{assignees,status},PM:{...}}}, availability: { userId: { date:{AM,PM} } }, prefs: {userId:{...}} }
//    POST   /api/availability                   { userId, date, half:"AM|PM", state:"unset|prefer|available|no" }
//    POST   /api/shift/assign                   { date, half:"AM|PM", userId }
//    POST   /api/shift/status                   { date, half:"AM|PM", status:"unassigned|proposed|approved" }
//    GET    /api/prefs/:userId
//    POST   /api/prefs                          { userId, prefer24s:boolean, notes?:string }
//    POST   /api/seed                           (optional) create demo data
//  - WebSocket at ws://localhost:4000/ws pushing {type:"SYNC", payload:{changed:"availability|shift|prefs|users", key:..., ...}}
//  - Server stores data in SQLite so multiple browsers share one source of truth.

// Color legend remains:
//  - Availability: Prefer = green, Available = yellow, Do Not = red/transparent
//  - Assignments: Proposed = yellow badge, Approved = green badge, Unassigned = red dot

// API base is configurable so this can run on GitHub Pages (static) while calling a Cloudflare Worker API.
// Set window.__API_BASE__ in index.html or via a small inline script tag in GitHub Pages.
// Example: <script>window.__API_BASE__ = 'https://scheduler-api.example.org';</script>
const API_BASE = (typeof window !== 'undefined' && window.__API_BASE__) || "http://localhost:4000";

// ========================= Utilities =========================
const todayISO = () => new Date().toISOString().slice(0, 10);
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function toISODate(d) { return d.toISOString().slice(0, 10); }
function rangeDays(start, end) { const out=[]; let d=new Date(start); while(d<=end){ out.push(new Date(d)); d.setDate(d.getDate()+1);} return out; }
function getWeekKey(dateStr){ const d=new Date(dateStr); const jan1=new Date(d.getFullYear(),0,1); const diff=Math.floor((d-jan1)/86400000); const week=Math.floor((diff+jan1.getDay())/7)+1; return `${d.getFullYear()}-W${String(week).padStart(2,"0")}`; }

// ========================= Data Hook (backend) =========================
function useBackendStore() {
  const [users, setUsers] = useState([]);
  const [availability, setAvailability] = useState({});
  const [prefs, setPrefs] = useState({});
  const [shifts, setShifts] = useState({});
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);

  async function fetchUsers(){ const r=await fetch(`${API_BASE}/api/users`); setUsers(await r.json()); }

  async function fetchWindow(start, end){
    const params = new URLSearchParams({ start, end });
    const r = await fetch(`${API_BASE}/api/state?`+params.toString());
    const j = await r.json();
    setShifts(j.shifts || {});
    setAvailability(j.availability || {});
    setPrefs(j.prefs || {});
  }

  function openSocket(){
    try {
      const wsBase = (()=>{ try { const u = new URL(API_BASE); u.protocol = (u.protocol === 'https:') ? 'wss:' : 'ws:'; u.pathname = '/ws'; u.search = ''; u.hash = ''; return u.toString(); } catch { return API_BASE.replace('http','ws') + '/ws'; }})();
      const ws = new WebSocket(wsBase);
      wsRef.current = ws;
      ws.addEventListener("open", ()=> setConnected(true));
      ws.addEventListener("close", ()=> setConnected(false));
      ws.addEventListener("message", (ev)=>{
        try{
          const msg = JSON.parse(ev.data);
          if (msg.type === "SYNC") {
            const { changed } = msg;
            if (changed === "availability") {
              // minimal patch: re-fetch today±60 for simplicity
              const start = toISODate(new Date());
              const end = toISODate(addDays(new Date(), 60));
              fetchWindow(start, end);
            } else if (changed === "shift" || changed === "prefs" || changed === "users") {
              const start = toISODate(new Date());
              const end = toISODate(addDays(new Date(), 60));
              fetchWindow(start, end);
              if (changed === "users") fetchUsers();
            }
          }
        }catch{}
      });
    } catch {}
  }

  // Mutations
  async function setAvailabilityCell(userId, date, half, state){
    await fetch(`${API_BASE}/api/availability`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ userId, date, half, state })});
  }
  async function toggleAssign(date, half, userId){
    await fetch(`${API_BASE}/api/shift/assign`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ date, half, userId })});
  }
  async function setStatus(date, half, status){
    await fetch(`${API_BASE}/api/shift/status`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ date, half, status })});
  }

  async function savePrefs(userId, patch){
    await fetch(`${API_BASE}/api/prefs`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ userId, ...patch })});
  }

  useEffect(()=>{
    fetchUsers();
    const start = toISODate(new Date());
    const end = toISODate(addDays(new Date(), 60));
    fetchWindow(start, end);
    openSocket();
    return ()=> wsRef.current?.close();
  }, []);

  return {
    users, availability, prefs, shifts, connected,
    actions: { fetchUsers, fetchWindow, setAvailabilityCell, toggleAssign, setStatus, savePrefs }
  };
}

// ========================= Availability UI =========================
const AV_STATES = ["unset", "prefer", "available", "no"];
const AV_COLORS = { unset: "", prefer: "bg-green-200 ring-2 ring-green-500", available: "bg-yellow-200 ring-2 ring-yellow-500", no: "bg-red-200 ring-2 ring-red-500" };
function cycleAv(state){ const idx=AV_STATES.indexOf(state??"unset"); return AV_STATES[(idx+1)%AV_STATES.length]; }
function AvButton({ value, onChange, label }){
  return (
    <button className={`w-10 h-8 rounded text-xs font-medium border border-gray-300 ${AV_COLORS[value||"unset"]}`} onClick={()=>onChange(cycleAv(value))} title={`${label}: ${value||"unset"}`}>{label}</button>
  );
}

// ========================= Calendar =========================
function MonthCalendar({ year, month, renderCell, headerExtra }){
  const first = new Date(year, month, 1);
  const last = endOfMonth(first);
  const days = rangeDays(first, last);
  const startPad = (first.getDay()+6)%7; // Monday=0
  const totalCells = Math.ceil((startPad + days.length) / 7) * 7;
  const cells = Array.from({ length: totalCells }, (_, i)=>{ const dayIdx = i - startPad; return dayIdx>=0 && dayIdx<days.length ? days[dayIdx] : null; });
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">{first.toLocaleString(undefined,{month:"long",year:"numeric"})}</h3>
        {headerExtra}
      </div>
      <div className="grid grid-cols-7 gap-2 text-xs font-semibold text-gray-500">{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d)=> <div key={d} className="text-center">{d}</div>)}</div>
      <div className="grid grid-cols-7 gap-2 mt-2">
        {cells.map((d,i)=> (
          <div key={i} className={`min-h-[78px] border rounded-xl p-1 ${d?"bg-gray-50":"bg-transparent border-none"}`}>
            {d && (
              <div className="flex flex-col gap-1 h-full">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{d.getDate()}</span>
                  <span className={`w-2 h-2 rounded-full ${toISODate(d)===todayISO()?"bg-blue-500":"bg-transparent"}`} />
                </div>
                <div className="flex-1">{renderCell(d)}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ========================= User View =========================
function UserView({ store }){
  const { users, availability, prefs, actions } = store;
  const [userId, setUserId] = useState(users[0]?.id || "");
  const [monthsAhead, setMonthsAhead] = useState(2);

  useEffect(()=>{ if (users.length && !userId) setUserId(users[0].id); },[users]);

  const starting = useMemo(()=> new Date(), []);
  const months = useMemo(()=> Array.from({length: monthsAhead}, (_,i)=>{ const d=new Date(starting.getFullYear(), starting.getMonth()+i,1); return {year:d.getFullYear(), month:d.getMonth()}; }), [monthsAhead, starting]);

  const av = availability[userId] || {};
  const setAv = (dateISO, half, state)=> actions.setAvailabilityCell(userId, dateISO, half, state);

  const myPrefs = prefs[userId] || { prefer24s:false, notes:"" };

  const stats = useMemo(()=>{
    let prefer=0, avail=0, noCnt=0;
    Object.values(av).forEach((v)=>{ ["AM","PM"].forEach((h)=>{ if(v[h]==="prefer") prefer++; else if(v[h]==="available") avail++; else if(v[h]==="no") noCnt++; }); });
    return { prefer, avail, noCnt };
  },[av]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select className="border rounded-lg px-3 py-2" value={userId} onChange={(e)=> setUserId(e.target.value)}>
          {users.map((u)=> <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
        </select>
        <label className="text-sm">Months shown</label>
        <input type="number" min={1} max={6} className="w-16 border rounded-lg px-2 py-1" value={monthsAhead} onChange={(e)=> setMonthsAhead(Number(e.target.value))} />
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 bg-green-300 rounded"/>Prefer</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 bg-yellow-300 rounded"/>Available</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 bg-red-300 rounded"/>Do Not</span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {months.map(({year,month})=> (
          <MonthCalendar key={`${year}-${month}`} year={year} month={month}
            renderCell={(d)=>{
              const k = toISODate(d);
              const v = av[k] || { AM:"unset", PM:"unset" };
              return (
                <div className="flex items-center justify-between gap-2">
                  <AvButton label="AM" value={v.AM} onChange={(s)=> setAv(k,"AM",s)} />
                  <AvButton label="PM" value={v.PM} onChange={(s)=> setAv(k,"PM",s)} />
                </div>
              );
            }}
          />
        ))}
      </div>

      <div className="rounded-2xl bg-blue-50 p-3 text-sm space-y-2">
        <div className="font-semibold">Your quick stats</div>
        <div className="flex gap-6"><div>Prefer: {stats.prefer}</div><div>Available: {stats.avail}</div><div>Do Not: {stats.noCnt}</div></div>
        <div className="pt-2 border-t text-xs flex items-center gap-2">
          <label className="font-medium">Prefer 24s:</label>
          <input type="checkbox" checked={!!myPrefs.prefer24s} onChange={(e)=> actions.savePrefs(userId,{ prefer24s: e.target.checked })} />
          <input className="ml-4 flex-1 border rounded px-2 py-1" placeholder="Notes" defaultValue={myPrefs.notes||""} onBlur={(e)=> actions.savePrefs(userId,{ notes: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

// ========================= Supervisor View =========================
function SupervisorView({ store }){
  const { users, shifts, availability, actions } = store;
  const [selectedDate, setSelectedDate] = useState("");
  const [monthsAhead, setMonthsAhead] = useState(2);

  const starting = useMemo(()=> new Date(), []);
  const months = useMemo(()=> Array.from({length: monthsAhead}, (_,i)=>{ const d=new Date(starting.getFullYear(), starting.getMonth()+i,1); return {year:d.getFullYear(), month:d.getMonth()}; }), [monthsAhead, starting]);

  const usersById = useMemo(()=> Object.fromEntries(users.map((u)=>[u.id,u])), [users]);

  const getSlot = (dateISO, half)=> (shifts[dateISO]?.[half] || { assignees:[], status:"unassigned" });

  const openCounts = useMemo(()=>{
    let open=0, proposed=0, approved=0;
    Object.values(shifts).forEach((v)=>{ ["AM","PM"].forEach((h)=>{ const s=v[h]; if(!s.assignees?.length) open++; else if(s.status==="proposed") proposed++; else if(s.status==="approved") approved++; }); });
    return { open, proposed, approved };
  },[shifts]);

  const overtimeUsers = useMemo(()=>{
    const counts={};
    Object.entries(shifts).forEach(([date,v])=>{ const wk=getWeekKey(date); ["AM","PM"].forEach((h)=>{ const s=v[h]; if(s.status!=="approved") return; (s.assignees||[]).forEach((uid)=>{ counts[uid]=counts[uid]||{}; counts[uid][wk]=(counts[uid][wk]||0)+1; }); }); });
    return Object.entries(counts).map(([uid,wk])=>({uid,weeks:Object.entries(wk).filter(([,n])=> n>6).map(([w])=>w)})).filter(x=>x.weeks.length);
  },[shifts]);

  function autoAssignWindow(startDate, days=14){
    // Client-side helper: rank by availability and call /shift/assign for top candidate
    (async ()=>{
      for(let i=0;i<days;i++){
        const d=toISODate(addDays(startDate,i));
        if(!shifts[d]) continue;
        for (const half of ["AM","PM"]) {
          const slot = shifts[d][half];
          if (slot.assignees?.length) continue;
          const ranked = users.map((u)=>{
            const av = (availability[u.id]?.[d]) || {AM:"unset",PM:"unset"};
            const s = av[half];
            const score = s==="prefer"?3: s==="available"?2: s==="unset"?1: 0;
            return { id:u.id, score, state:s };
          }).filter(r=> r.state!=="no").sort((a,b)=> b.score - a.score);
          if (ranked.length && ranked[0].score>0) {
            await actions.toggleAssign(d, half, ranked[0].id);
            await actions.setStatus(d, half, "proposed");
          }
        }
      }
    })();
  }

  const approveAllVisible = ()=>{
    (async ()=>{
      months.forEach(({year,month})=>{
        const first = new Date(year,month,1); const last=endOfMonth(first); const days=rangeDays(first,last);
        days.forEach(async (dt)=>{
          const k=toISODate(dt); if(!shifts[k]) return; for (const half of ["AM","PM"]) {
            const slot = shifts[k][half]; if (slot.assignees?.length) await actions.setStatus(k,half,"approved");
          }
        });
      });
    })();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-2xl p-4 bg-white shadow"><div className="text-sm text-gray-500">Open Slots</div><div className="text-3xl font-bold">{openCounts.open}</div></div>
        <div className="rounded-2xl p-4 bg-white shadow"><div className="text-sm text-gray-500">Proposed</div><div className="text-3xl font-bold">{openCounts.proposed}</div></div>
        <div className="rounded-2xl p-4 bg-white shadow"><div className="text-sm text-gray-500">Approved</div><div className="text-3xl font-bold">{openCounts.approved}</div></div>
        <div className="rounded-2xl p-4 bg-white shadow"><div className="text-sm text-gray-500">Overtime Flags</div><div className="text-3xl font-bold">{overtimeUsers.length}</div></div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">Months shown</label>
        <input type="number" min={1} max={6} className="w-16 border rounded-lg px-2 py-1" value={monthsAhead} onChange={(e)=> setMonthsAhead(Number(e.target.value))} />
        <button className="px-3 py-2 rounded-xl bg-blue-600 text-white" onClick={()=> autoAssignWindow(new Date(), monthsAhead*30)}>Auto-assign (visible window)</button>
        <button className="px-3 py-2 rounded-xl bg-emerald-600 text-white" onClick={approveAllVisible}>Approve all with assignees</button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {months.map(({year,month})=> (
          <MonthCalendar key={`${year}-${month}`} year={year} month={month}
            headerExtra={<div className="text-xs text-gray-500">Click a slot to assign</div>}
            renderCell={(d)=>{
              const k=toISODate(d);
              const slot = shifts[k] || { AM:{assignees:[],status:"unassigned"}, PM:{assignees:[],status:"unassigned"} };
              return (
                <div className="flex flex-col gap-2">
                  {["AM","PM"].map((half)=> (
                    <div key={half} className="flex items-center gap-2">
                      <button className={`flex-1 text-left px-2 py-1 rounded-lg border ${slot[half].assignees?.length? (slot[half].status==="approved"?"bg-green-100 border-green-400":"bg-yellow-100 border-yellow-400"):"bg-red-50 border-red-300"}`} onClick={()=> setSelectedDate(`${k}|${half}`)} title={`${half} — ${slot[half].status}`}>
                        <div className="flex items-center justify-between"><span className="font-medium text-xs">{half}</span><span className="text-[10px] uppercase tracking-wide">{slot[half].status}</span></div>
                        <div className="text-xs truncate">{slot[half].assignees?.length? slot[half].assignees.map((uid)=> usersById[uid]?.name).join(", ") : "Unassigned"}</div>
                      </button>
                      {slot[half].assignees?.length? (
                        <button className="px-2 py-1 text-xs rounded-lg bg-gray-100" onClick={()=> actions.setStatus(k, half, slot[half].status==="approved"?"proposed":"approved")}>{slot[half].status==="approved"?"Unapprove":"Approve"}</button>
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                      )}
                    </div>
                  ))}
                </div>
              );
            }}
          />
        ))}
      </div>

      {selectedDate && selectedDate.includes("|") && (
        <AssignDrawer users={users} usersById={usersById} availability={availability} sel={selectedDate} onClose={()=> setSelectedDate("")} getSlot={(dateISO,half)=> shifts[dateISO]?.[half] || {assignees:[],status:"unassigned"}} toggleAssign={actions.toggleAssign} />
      )}

      {overtimeUsers.length>0 && (
        <div className="rounded-2xl bg-amber-50 p-3 text-sm">
          <div className="font-semibold mb-1">Overtime warnings</div>
          <ul className="list-disc ml-5">{overtimeUsers.map((o)=> <li key={o.uid}>{usersById[o.uid]?.name}: {o.weeks.join(", ")}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function AssignDrawer({ users, usersById, availability, sel, onClose, getSlot, toggleAssign }){
  const [dateISO, half] = sel.split("|");
  const slot = getSlot(dateISO, half);
  const ranked = useMemo(()=> users.map((u)=>{
    const av = (availability[u.id]?.[dateISO]) || {AM:"unset",PM:"unset"};
    const s = av[half];
    const score = s==="prefer"?3: s==="available"?2: s==="unset"?1: 0;
    return { ...u, state:s||"unset", score };
  }).sort((a,b)=> b.score - a.score || a.name.localeCompare(b.name)), [users, availability, dateISO, half]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end sm:items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-4" onClick={(e)=> e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <div>
            <div className="text-sm text-gray-500">{new Date(dateISO).toLocaleDateString()}</div>
            <div className="text-lg font-semibold">Assign {half} shift</div>
          </div>
          <button className="px-3 py-1 rounded-lg bg-gray-100" onClick={onClose}>Close</button>
        </div>
        <div className="text-xs text-gray-500 mb-2">Click a name to toggle assignment. Availability state shown at right.</div>
        <div className="max-h-[50vh] overflow-auto divide-y">
          {ranked.map((u)=>{
            const assigned = slot.assignees?.includes(u.id);
            return (
              <div key={u.id} className="flex items-center justify-between py-2">
                <button className={`text-left flex-1 px-2 py-1 rounded-lg border ${assigned?"bg-blue-50 border-blue-300":"bg-gray-50 border-gray-200"}`} onClick={()=> toggleAssign(dateISO, half, u.id)}>
                  <div className="font-medium">{u.name} <span className="text-xs text-gray-400">({u.role})</span></div>
                  {assigned && <div className="text-[10px] uppercase text-blue-600">Assigned</div>}
                </button>
                <span className={`ml-2 text-xs px-2 py-1 rounded-full border ${u.state==="prefer"?"bg-green-100 border-green-400": u.state==="available"?"bg-yellow-100 border-yellow-400": u.state==="no"?"bg-red-100 border-red-400":"bg-gray-50 border-gray-200"}`}>{u.state}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ========================= Display View =========================
function DisplayView({ store }){
  const { users, shifts } = store;
  const now = new Date();
  const monday = new Date(now); const day = (monday.getDay()+6)%7; monday.setDate(monday.getDate()-day);
  const days = rangeDays(monday, addDays(monday, 6));
  const usersById = useMemo(()=> Object.fromEntries(users.map((u)=>[u.id,u])), [users]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <h2 className="text-2xl font-bold">Station Schedule</h2>
        <div className="text-sm text-gray-500">Week of {monday.toLocaleDateString()}</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {days.map((d)=>{ const k=toISODate(d); const slots = shifts[k] || { AM:{assignees:[],status:"unassigned"}, PM:{assignees:[],status:"unassigned"} }; return (
          <div key={k} className="bg-white rounded-2xl shadow p-4">
            <div className="text-lg font-semibold mb-2">{d.toLocaleDateString(undefined,{weekday:"long", month:"short", day:"numeric"})}</div>
            {["AM","PM"].map((half)=> (
              <div key={half} className="mb-3">
                <div className="text-xs uppercase text-gray-500">{half} Shift</div>
                <div className={`mt-1 rounded-xl p-3 border ${slots[half].assignees?.length? (slots[half].status==="approved"?"bg-green-50 border-green-300":"bg-yellow-50 border-yellow-300"):"bg-red-50 border-red-300"}`}>
                  <div className="text-sm">
                    {slots[half].assignees?.length? (
                      <div className="flex flex-wrap gap-2">{slots[half].assignees.map((uid)=> <span key={uid} className="px-2 py-1 bg-white rounded-lg border text-xs">{usersById[uid]?.name}</span>)}</div>
                    ) : (<span className="text-red-600 font-medium">Unassigned</span>)}
                  </div>
                  {slots[half].assignees?.length>0 && (
                    <div className={`mt-2 inline-block text-[10px] uppercase px-2 py-1 rounded-full ${slots[half].status==="approved"?"bg-green-200":"bg-yellow-200"}`}>{slots[half].status}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        );})}
      </div>
    </div>
  );
}

// ========================= App Shell =========================
function NavTab({ id, label, active, onClick }){ return (<button className={`px-4 py-2 rounded-2xl text-sm font-medium border ${active?"bg-blue-600 text-white border-blue-600":"bg-white border-gray-300"}`} onClick={onClick}>{label}</button>); }

export default function App(){
  const store = useBackendStore();
  const [tab, setTab] = useState("user");
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="font-bold text-lg tracking-tight">ShiftCommander</div>
          <div className="ml-2 text-xs px-2 py-1 rounded-full border">{store.connected?"Live":"Offline"}</div>
          <div className="ml-auto flex items-center gap-2">
            <NavTab id="user" label="User View" active={tab==="user"} onClick={()=> setTab("user")} />
            <NavTab id="super" label="Supervisor" active={tab==="super"} onClick={()=> setTab("super")} />
            <NavTab id="display" label="Station Display" active={tab==="display"} onClick={()=> setTab("display")} />
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-4">
        {tab==="user" && <UserView store={store} />}
        {tab==="super" && <SupervisorView store={store} />}
        {tab==="display" && <DisplayView store={store} />}
        <footer className="mt-10 text-xs text-gray-500">
          <div>Multiuser demo with SQLite backend, HTTP API + WebSocket live sync. No email/voice/SMS yet.</div>
        </footer>
      </main>
    </div>
  );
}
