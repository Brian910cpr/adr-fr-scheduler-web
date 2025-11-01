// js/sc-preferences.js
// ShiftCommander: preferences + notes + bulk availability helpers
// Exposes window.SCPreferences.init({...})

(function () {
  const DEFAULTS = {
    apiBase: "",
    getMeId: () => localStorage.getItem("sc_me_id") || "",
    // DOM elements (optional—only wire what you use on this page)
    els: {
      reserve: null,        // <input type="checkbox" id="prefReserve">
      type3: null,          // <input type="checkbox" id="prefType3Approved"> (disabled in member UI)
      inactive: null,       // <input type="checkbox" id="prefInactivePreview"> (disabled in member UI)
      bulkFrom: null,       // <input id="bulkFrom">
      bulkUntil: null,      // <input id="bulkUntil">
      bulkStateRadios: null,// NodeList of radios name="bulkState"
      bulkHalfRadios: null, // NodeList of radios name="bulkHalf"
      bulkApplyBtn: null,   // <button id="btnApplyBulk">
      noteSelector: null,   // CSS selector for note <input> fields per day
      reserveChip: null,    // small “Reserve” chip to toggle visibility
    },
    onStateRefresh: async () => {}, // callback to refresh calendar after writes
    noteDebounceMs: 600,
  };

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function getCheckedValue(radios) {
    if (!radios) return null;
    const arr = Array.from(radios);
    const r = arr.find((el) => el && el.checked);
    return r ? r.value : null;
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  async function setReserve(apiBase, getMeId, onStateRefresh, checked, reserveChip) {
    const userId = getMeId();
    if (!userId) {
      alert("Load your member first.");
      return;
    }
    await postJSON(`${apiBase}/api/me/reserve`, { userId, reserve: !!checked });
    if (reserveChip) reserveChip.style.display = checked ? "" : "none";
    await onStateRefresh();
  }

  async function setInactive(apiBase, targetUserId, checked, onStateRefresh) {
    await postJSON(`${apiBase}/api/me/inactive`, { userId: targetUserId, inactive: !!checked });
    await onStateRefresh();
  }

  async function setType3(apiBase, targetUserId, checked, onStateRefresh) {
    await postJSON(`${apiBase}/api/me/type3`, { userId: targetUserId, type3: !!checked });
    await onStateRefresh();
  }

  async function applyBulk(apiBase, getMeId, els, onStateRefresh) {
    const userId = getMeId();
    if (!userId) {
      alert("Load your member first.");
      return;
    }
    const from = (els.bulkFrom?.value || "").trim();
    const until = (els.bulkUntil?.value || "").trim();
    const state = getCheckedValue(els.bulkStateRadios) || "available";
    const half = getCheckedValue(els.bulkHalfRadios) || "AM";
    if (!from || !until) {
      alert("Enter a date range.");
      return;
    }
    const dates = rangeDates(from, until);
    for (const d of dates) {
      // Fire-and-forget; keep it simple (could batch later)
      await postJSON(`${apiBase}/api/availability`, { userId, date: d, half, state });
    }
    await onStateRefresh();
  }

  function rangeDates(mdyFrom, mdyUntil) {
    const [m1, d1, y1] = mdyFrom.split("/").map((x) => parseInt(x, 10));
    const [m2, d2, y2] = mdyUntil.split("/").map((x) => parseInt(x, 10));
    const start = new Date(y1, m1 - 1, d1);
    const end = new Date(y2, m2 - 1, d2);
    const out = [];
    const cur = new Date(start);
    while (cur <= end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  function wireNotes(apiBase, getMeId, noteSelector, debounceMs, onStateRefresh) {
    if (!noteSelector) return;
    const nodes = document.querySelectorAll(noteSelector);
    if (!nodes.length) return;

    const debounced = debounce(async (input) => {
      const userId = getMeId();
      if (!userId) return;
      const date = input.dataset.date;
      const text = (input.value || "").slice(0, 60);
      await postJSON(`${apiBase}/api/note`, { userId, date, text });
      // Supervisor view wants notes to pop—refresh is fine
      await onStateRefresh();
    }, debounceMs);

    nodes.forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      input.addEventListener("input", () => debounced(input));
    });
  }

  function init(userConfig) {
    const cfg = Object.assign({}, DEFAULTS, userConfig || {});
    const { apiBase, getMeId, onStateRefresh, els } = cfg;

    // Reserve (member-controlled)
    if (els.reserve) {
      els.reserve.addEventListener("change", (e) =>
        setReserve(apiBase, getMeId, onStateRefresh, e.target.checked, els.reserveChip)
      );
    }

    // Supervisor-controlled toggles (if you render them on this page)
    // Expect data-user-id attribute on checkboxes you render in roster list.
    document.addEventListener("change", async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.matches("[data-inactive-user]")) {
        const uid = t.getAttribute("data-inactive-user");
        await setInactive(apiBase, uid, t.checked, onStateRefresh);
      }
      if (t.matches("[data-type3-user]")) {
        const uid = t.getAttribute("data-type3-user");
        await setType3(apiBase, uid, t.checked, onStateRefresh);
      }
    });

    // Bulk apply (member)
    if (els.bulkApplyBtn) {
      els.bulkApplyBtn.addEventListener("click", () => applyBulk(apiBase, getMeId, els, onStateRefresh));
    }

    // Notes
    wireNotes(apiBase, getMeId, els.noteSelector, cfg.noteDebounceMs, onStateRefresh);

    return {
      // Expose helpers if you want to call them manually
      setReserve: (on) => setReserve(apiBase, getMeId, onStateRefresh, !!on, els.reserveChip),
      setInactive: (uid, on) => setInactive(apiBase, uid, !!on, onStateRefresh),
      setType3: (uid, on) => setType3(apiBase, uid, !!on, onStateRefresh),
      applyBulk: () => applyBulk(apiBase, getMeId, els, onStateRefresh),
    };
  }

  window.SCPreferences = { init };
})();
