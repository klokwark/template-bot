#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

main() {
cd -- "${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
[[ -f .env && -f package.json && -d src ]] || { printf 'Run update.sh in your existing template-bot directory. Your .env must already exist.\n' >&2; exit 1; }
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if [[ -z "${NVM_DIR:-}" ]]; then
    if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then NVM_DIR="$XDG_CONFIG_HOME/nvm"; else NVM_DIR="$HOME/.nvm"; fi
  fi
  export NVM_DIR
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    set +u
    . "$NVM_DIR/nvm.sh" --no-use
    nvm use 24
    set -u
  fi
fi
for tool in node npm curl tar mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing %s. Load your Node.js installation first.\n' "$tool" >&2; exit 1; }
done
# Share the bot's lock so a running bot or another updater cannot overlap this update.
if ! (set -o noclobber; printf '%s\n' "$$" > .bot.lock) 2>/dev/null; then
  printf 'Stop the bot with Ctrl+C and wait for it to exit before updating. If it crashed, stop all copies before removing .bot.lock.\n' >&2
  exit 1
fi
update_stage=''
cleanup() {
  if [[ -n "$update_stage" ]]; then rm -rf -- "$update_stage"; fi
  rm -f -- .bot.lock
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
update_stage="$(mktemp -d "$PWD/.update.XXXXXXXX")"
printf 'Downloading latest template-bot (keeping .env and backups)...\n'
curl --fail --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  "https://codeload.github.com/klokwark/template-bot/tar.gz/refs/heads/main?update=$(date +%s)" -o "$update_stage/repo.tar.gz"
mkdir "$update_stage/repo"
tar -xzf "$update_stage/repo.tar.gz" -C "$update_stage/repo" --strip-components=1
for file in package.json package-lock.json src/index.js src/loader.js update.sh; do
  [[ -f "$update_stage/repo/$file" ]] || { printf 'Downloaded archive is missing %s. Update cancelled.\n' "$file" >&2; exit 1; }
done
printf 'Installing updated packages...\n'
(cd "$update_stage/repo" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
# Copy only application files. Never copy, generate, source or prompt for .env.
cp -R "$update_stage/repo/src/." src/
for file in package.json package-lock.json README.md .env.example .gitignore install.sh update.sh; do
  cp "$update_stage/repo/$file" "$file"
done
if [[ -d "$update_stage/repo/test" ]]; then mkdir -p test; cp -R "$update_stage/repo/test/." test/; fi
if [[ -d node_modules ]]; then mv node_modules "$update_stage/previous-node_modules"; fi
mv "$update_stage/repo/node_modules" node_modules
chmod +x install.sh update.sh
printf 'Update complete. Existing .env and backups preserved. Starting bot...\n'
cleanup
trap - EXIT INT TERM
exec npm start
}

# Parse the whole updater before running it, so replacing update.sh is safe.
main "$@"
