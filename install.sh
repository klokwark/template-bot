#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

# Run from anywhere. Downloads an archive, never overwrites an existing install.
for tool in curl tar mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing %s. Install curl and tar first.\n' "$tool" >&2; exit 1; }
done
destination="${1:-$PWD/template-bot}"
if [[ -e "$destination" ]]; then
  printf 'Destination already exists: %s\nChoose a new folder: bash install.sh /path/to/new-folder\n' "$destination" >&2
  exit 1
fi
staging_dir="$(mktemp -d)"
trap 'rm -rf -- "$staging_dir"' EXIT

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)' >/dev/null 2>&1
}
used_nvm=0
if ! node_ready; then
  if [[ -z "${NVM_DIR:-}" ]]; then
    if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
      NVM_DIR="$XDG_CONFIG_HOME/nvm"
    else
      NVM_DIR="$HOME/.nvm"
    fi
  fi
  export NVM_DIR
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    printf 'Node.js is missing, too old, or npm is unavailable. Installing nvm...\n'
    mkdir -p -- "$NVM_DIR"
    curl --fail --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
      'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh' -o "$staging_dir/install-nvm.sh"
    # Script method also works on machines without git. nvm sets up the shell profile.
    METHOD=script bash "$staging_dir/install-nvm.sh"
  fi
  [[ -s "$NVM_DIR/nvm.sh" ]] || { printf 'nvm installation failed: nvm.sh is missing.\n' >&2; exit 1; }
  # nvm is a shell function; load it in this process, even in a noninteractive shell.
  # Temporarily disable nounset for compatibility with nvm's shell internals.
  set +u
  . "$NVM_DIR/nvm.sh" --no-use
  nvm use --silent default >/dev/null 2>&1 || true
  if ! node_ready; then
    printf 'Installing Node.js 24 and npm with nvm...\n'
    nvm install 24 || { printf 'Node.js installation failed. Check the nvm output above.\n' >&2; exit 1; }
    nvm use 24
  fi
  set -u
  used_nvm=1
fi
node_ready || { printf 'A working Node.js 22.12+ and npm are required; automatic setup failed.\n' >&2; exit 1; }
printf 'Using Node.js %s and npm %s\n' "$(node --version)" "$(npm --version)"

printf 'Downloading klokwark/template-bot...\n'
curl --fail --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  'https://codeload.github.com/klokwark/template-bot/tar.gz/refs/heads/main' -o "$staging_dir/repo.tar.gz"
mkdir "$staging_dir/repo"
tar -xzf "$staging_dir/repo.tar.gz" -C "$staging_dir/repo" --strip-components=1
[[ -f "$staging_dir/repo/package-lock.json" && -f "$staging_dir/repo/src/index.js" ]] || { printf 'Archive is missing bot files.\n' >&2; exit 1; }
mkdir -p -- "$(dirname -- "$destination")"
mv -- "$staging_dir/repo" "$destination"
cd -- "$destination"
printf 'Installing packages...\n'
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
printf '\nCreate a bot in https://discord.com/developers/applications and copy its bot token.\n'
IFS= read -r -s -p 'Discord bot token (hidden): ' bot_token </dev/tty
printf '\n'
[[ "$bot_token" =~ ^[A-Za-z0-9_.-]+$ ]] || { printf 'Token is empty or contains invalid characters.\n' >&2; exit 1; }
IFS= read -r -p 'Server ID for instant command registration (Enter for global): ' server_id </dev/tty
[[ -z "$server_id" || "$server_id" =~ ^[0-9]{17,20}$ ]] || { printf 'Invalid server ID.\n' >&2; exit 1; }
printf 'DISCORD_TOKEN=%s\nGUILD_ID=%s\n' "$bot_token" "$server_id" > .env
chmod 600 .env
unset bot_token
printf '\nStarting bot. The console will show registration, invite link and all load operations.\n'
if [[ "$used_nvm" == 1 ]]; then
  printf 'Restart later with: source %q && nvm use %q && cd %q && npm start\n' "$NVM_DIR/nvm.sh" "$(node --version)" "$PWD"
else
  printf 'Restart later with: cd %q && npm start\n' "$PWD"
fi
rm -rf -- "$staging_dir"
trap - EXIT
exec npm start
