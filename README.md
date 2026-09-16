# Discord template bot

Plain JavaScript + discord.js. No build step. Requires Bash, curl and tar. The installer checks for Node.js **22.12+** and npm, loads an existing nvm installation if needed, and installs **Node.js 24** through nvm when no compatible runtime is available. It installs nvm automatically if missing.

## Install and run

```bash
curl -fsSL https://raw.githubusercontent.com/klokwark/template-bot/main/install.sh -o template-bot-install.sh
bash template-bot-install.sh
```

The installer downloads and extracts the repository into a new `template-bot` folder, installs locked dependencies, asks for your bot token with input hidden, writes a private `.env`, and starts the bot. It also asks for an optional server ID for immediate server command registration. Leave this blank for global commands, which may take time to appear. An existing destination is never overwritten. Use `bash template-bot-install.sh /path/to/new-folder` to choose another folder.

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Use a **bot token**, never your personal user token.
2. Use the invite URL printed on startup. It requests `bot`, `applications.commands` and Administrator.
3. In Server Settings → Roles, give the bot's own managed role **Administrator** and drag it above every ordinary role. No privileged gateway intents are needed.
4. Run `/teamplte-load template:CODE` or `/template-load template:CODE`. A `https://discord.new/CODE` or `https://discord.com/template/CODE` URL also works.
5. Review the irreversible change preview and click **Permanently erase and load template** within five minutes. Only the requesting administrator can confirm. Administrator permission and hierarchy are checked again immediately before starting.

To restart (the installer prints an exact command, including loading nvm when needed):

```bash
cd template-bot
npm start
```

If `npm` is unavailable in your original terminal after installation, use the full restart command printed by the installer. Installing inside a Bash script does not change its parent terminal's PATH. nvm's installer also configures the shell profile for future sessions; existing nvm default aliases are preserved.

Manual setup requires Node.js 22.12+ and npm: clone/download the repository, run `npm ci --ignore-scripts`, copy `.env.example` to `.env`, enter `DISCORD_TOKEN`, optionally enter `GUILD_ID`, and run `npm start`. Never commit `.env` or share the token. Only one bot process should run for this application, including across different computers.

## What it does

- Registers both slash commands on every startup, without a separate registration/build command. Upserts only these two commands.
- Restricts execution to current server administrators. When `GUILD_ID` is set, execution is restricted to that server too.
- Validates the complete template, permission references, supported channel types, destination role hierarchy, role/channel limits and voice bitrate before any deletion.
- Saves the current guild structure and selected template under `backups/`, then logs each step to the console and a `.jsonl` operation journal.
- Disables Community and discovery first. If Discord refuses, it stops before deleting any channels or roles.
- Clears old system/rules/AFK references, deletes channels before categories, then deletes ordinary roles.
- Updates `@everyone`, creates template roles and orders them, creates categories, then channels with mapped role overwrites and category IDs. Restores channel positions and template system/AFK references when present.
- Keeps the destination server name and icon. Leaves Community disabled.
- Serializes mutations, respects discord.js rate limits, rejects overlapping loads, and stops on the first failure. Automatic retries for server errors are disabled to avoid duplicate creations after ambiguous API failures.

## Limits and recovery

**This permanently deletes channels, their messages/threads, associated webhooks and ordinary roles. Deleted role assignments are lost, including administrator roles. The server owner retains access.** This is a structure replacement, not a data migration. No members are kicked, and no memberships are assigned to the newly created roles.

Discord does not allow deleting `@everyone` or managed bot/integration roles. These remain; ordinary roles at or above the bot's role block the entire load. Existing managed roles retain their guild permissions, so the resulting server cannot be an exact clone of template access for those roles.

Supported template channels: text, voice and categories. Announcement, stage, forum, media, thread and unknown channel types are rejected before deletion rather than silently converted. Templates with unresolved/member-specific permission overwrites, managed roles, custom role icons or enhanced role colors are also rejected. Templates only contain Discord's saved snapshot; unsynced changes, messages, members, emojis and other absent data cannot be imported. Role/channel mentions embedded in topic text are copied as text, not rewritten.

The backup contains guild/role/channel configuration and the template, **not messages, member role assignments, or a full server export**. There is no automatic restore command or transactional rollback. On failure, stop and inspect the console and operation journal before making further changes. A timeout/network failure can occur after Discord applied the last request; verify the live server before retrying. Starting the command again wipes the current structure again. Keep the bot running while loading; shutdown signals wait for active jobs. After a crash, ensure all copies are stopped before removing `.bot.lock` and restarting. A restart never automatically resumes a destructive job.

Avoid editing the server during a load. Changes between preview and confirmation invalidate the preview. If the original channel disappears or an interaction expires, the final result may only be available in the console. Other bots, onboarding, automod and integrations may still reference deleted IDs and need manual reconfiguration. Discord can impose additional feature restrictions; such API errors stop the load and may leave a partial result.

## Development

```bash
npm test
```

Tests use mocked Discord REST calls and never delete a live server. Live end-to-end operation requires your bot token and a disposable test server.

API references: [Guild Templates](https://docs.discord.com/developers/resources/guild-template), [Guilds](https://docs.discord.com/developers/resources/guild), [Channels](https://docs.discord.com/developers/resources/channel).
