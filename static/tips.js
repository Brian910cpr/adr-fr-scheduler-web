<script>
/**
 * paintTips(state) — adds a pill into each AM/PM tile that has a non-empty tip.
 * Requirements in your markup:
 *   <div class="half" data-date="YYYY-MM-DD" data-half="AM"> ... </div>
 *   <div class="half" data-date="YYYY-MM-DD" data-half="PM"> ... </div>
 */
(function () {
  const TIP_CLASS = "tip-badge";

  window.paintTips = function paintTips(state) {
    if (!state || !state.shifts) return;
    const halves = document.querySelectorAll('[data-date][data-half]');
    halves.forEach(node => {
      const date = node.getAttribute('data-date');
      const half = node.getAttribute('data-half');
      const tip  = state.shifts?.[date]?.[half]?.tip || "";

      // clear old
      node.querySelectorAll('.' + TIP_CLASS).forEach(n => n.remove());
      if (!tip) return;

      const pill = document.createElement('span');
      pill.className = TIP_CLASS;
      pill.textContent = tip;
      node.appendChild(pill);
    });
  };

  // apple-ish subtle pill
  const css = `
    .tip-badge{
      display:inline-block; margin-top:6px; padding:2px 8px;
      border-radius:9999px; font-size:11px; line-height:18px;
      background: rgba(255,163,0,.12); color:#b26a00;
      border:1px solid rgba(255,163,0,.35);
      backdrop-filter: saturate(180%) blur(6px);
      -webkit-backdrop-filter: saturate(180%) blur(6px);
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
})();
</script>
