#!/bin/bash
# Inject custom-ui.css and custom-ui.js into index.html
# Run this after git pull to restore custom layout.
# The custom-ui files themselves are gitignored and survive pulls.

FILE="public/index.html"

# Add custom-ui.css link if not present
if ! grep -q 'custom-ui.css' "$FILE"; then
  sed -i '' 's|</head>|  <link rel="stylesheet" href="/custom-ui.css">\n</head>|' "$FILE"
  echo "Injected custom-ui.css"
fi

# Add custom-ui.js script if not present
if ! grep -q 'custom-ui.js' "$FILE"; then
  sed -i '' 's|<script src="/bundle.js"></script>|<script src="/custom-ui.js"></script>\n  <script src="/bundle.js"></script>|' "$FILE"
  echo "Injected custom-ui.js"
fi

echo "Custom UI applied. Restart server to see changes."
