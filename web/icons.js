/* Locally bundled thin-outline icons. No CDN/network dependency. */
(() => {
  'use strict';
  const paths = {
    'calendar-days':'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    'columns-3':'<rect width="6" height="18" x="2" y="3" rx="1"/><rect width="6" height="18" x="9" y="3" rx="1"/><rect width="6" height="18" x="16" y="3" rx="1"/>',
    'chart-no-axes-combined':'<path d="M4 17l6-6 4 4 6-8"/><path d="M16 7h4v4"/><path d="M4 21h16"/>',
    'users-round':'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    'settings-2':'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    'sparkles':'<path d="m12 3 1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8L12 3ZM20 17l.8 2.2L23 20l-2.2.8L20 23l-.8-2.2L17 20l2.2-.8L20 17Z"/>',
    'plus':'<path d="M12 5v14M5 12h14"/>',
    'chevron-left':'<path d="m15 18-6-6 6-6"/>',
    'chevron-right':'<path d="m9 18 6-6-6-6"/>',
    'calendar-check':'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18m6 6 2 2 4-4"/>',
    'mouse-pointer-click':'<path d="m9 9 5 12 2-5 5-2-12-5Zm-4-5 1 2M2 9h3M10 2v3M5 5l2 2"/>',
    'search':'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    'clock-3':'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'wallet':'<rect x="3" y="6" width="18" height="15" rx="2"/><path d="M3 10h18M7 6V4h12"/>',
    'arrow-up-right':'<path d="M7 17 17 7M8 7h9v9"/>',
    'arrow-down-left':'<path d="M17 7 7 17M7 8v9h9"/>',
    'pencil':'<path d="m15 5 4 4M4 20l4.7-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z"/>',
    'trash-2':'<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    'x':'<path d="M18 6 6 18M6 6l12 12"/>',
    'circle-check':'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    'circle-x':'<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
    'list-checks':'<path d="m3 7 2 2 3-3M11 8h10m-18 7 2 2 3-3M11 16h10"/>',
    'user-round':'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    'grip-vertical':'<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
    'package':'<path d="M12 2 3 7v10l9 5 9-5V7L12 2ZM3 7l9 5 9-5M12 12v10"/>',
    'circle-dollar-sign':'<circle cx="12" cy="12" r="9"/><path d="M16 8h-6a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H8M12 5v14"/>',
  };
  function icon(name, size = 19) {
    return `<svg aria-hidden="true" class="line-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths['circle-check']}</svg>`;
  }
  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach(el => {el.innerHTML = icon(el.dataset.icon);});
  }
  window.NailsIcons = {icon, hydrate};
})();
