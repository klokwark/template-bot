#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

# Run from anywhere. Downloads an archive, never overwrites an existing install.
for tool in node npm curl tar mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing %s. Install Node.js 22.12+ (or 24 LTS), npm, curl and tar first.\n' "$tool" >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)' || { printf 'Node.js 22.12 or newer is required.\n' >&2; exit 1; }
destination="${1:-$PWD/template-bot}"
if [[ -e "$destination" ]]; then
  printf 'Destination already exists: %s\nChoose a new folder: bash install.sh /path/to/new-folder\n' "$destination" >&2
  exit 1
fi
staging_dir="$(mktemp -d)"
trap 'rm -rf -- "$staging_dir"' EXIT
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
printf 'Restart later with: cd %q && npm start\n' "$PWD"
rm -rf -- "$staging_dir"
trap - EXIT
exec npm start
