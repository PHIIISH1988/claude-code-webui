// Custom UI: fix context menu positioning for top-placed desktop previews
// Gitignored — survives git pulls. Re-inject via: bash apply-custom-ui.sh
//
// CSS handles the visual relocation (position:fixed to top).
// This JS only fixes context menus that desktop-manager positions with bottom.

(function() {
  'use strict';

  // Watch for context-menu elements added to body.
  // Desktop-manager forces bottom positioning (designed for taskbar at bottom).
  // We flip to top positioning since previews are now at the top.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1 || !node.classList?.contains('context-menu')) continue;
        // Wait one frame for desktop-manager's synchronous style.bottom override
        requestAnimationFrame(() => {
          if (node.style.bottom) {
            // Convert: was "distance from bottom" → make it "distance from top"
            const toolbarH = document.getElementById('toolbar')?.offsetHeight || 40;
            node.style.top = (toolbarH + 4) + 'px';
            node.style.bottom = '';
          }
          // Keep within viewport
          requestAnimationFrame(() => {
            const rect = node.getBoundingClientRect();
            if (rect.bottom > window.innerHeight - 8) {
              node.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
            }
            if (rect.right > window.innerWidth - 8) {
              node.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
            }
          });
        });
      }
    }
  });

  observer.observe(document.body, { childList: true });
})();
