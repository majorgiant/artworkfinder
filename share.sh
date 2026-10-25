#!/bin/sh
# Makes a clean zip of Artwork Finder to give to others.
#
# Only the files listed below go in, so your API keys (config.json, data/, .env), your
# history and caches never end up in it.
#
#   ./share.sh            -> dist/artworkfinder-YYYY-MM-DD.zip

set -e
cd "$(dirname "$0")"

FILES="Dockerfile docker-compose.yml docker-compose.image.yml .dockerignore .gitignore .env.example package.json share.sh LICENSE
server.js providers.js images.js README.md
public/index.html public/app.js public/styles.css public/sources.js"

NAME="artworkfinder-$(date +%Y-%m-%d)"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/artworkfinder/public" dist

for f in $FILES; do
  cp "$f" "$STAGE/artworkfinder/$f"
done

rm -f "dist/$NAME.zip"
(cd "$STAGE" && zip -qr - artworkfinder) > "dist/$NAME.zip"
rm -rf "$STAGE"

# Double check: no key may appear in the zip.
for key in $(cat data/config.json config.json 2>/dev/null | grep -oE '"(tmdbKey|fanartKey|tvdbKey|tvdbPin|serpKey)": *"[^"]{8,}"' | sed 's/.*: *"//; s/"$//'); do
  if unzip -p "dist/$NAME.zip" | grep -q "$key"; then
    echo "Stopped: an API key was found in the zip. Nothing should be shared." >&2
    rm -f "dist/$NAME.zip"
    exit 1
  fi
done

echo "Ready to share: dist/$NAME.zip"
