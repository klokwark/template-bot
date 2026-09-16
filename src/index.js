import { Client, GatewayIntentBits, Events, RESTEvents, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { templateCode } from './plan.js';
import { preflight, applyTemplate } from './loader.js';

const token = process.env.DISCORD_TOKEN?.trim();
const guildId = process.env.GUILD_ID?.trim();
export function log(level, message) {
  const safe = String(message).replaceAll(token || '\0', '[REDACTED]').replace(/[\r\n]/g, ' ');
  console.log(`${new Date().toISOString()} ${level} ${safe}`);
}
if (!token || token === 'put_your_bot_token_here') throw new Error('Set DISCORD_TOKEN in .env first.');
if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error('GUILD_ID must be a Discord server ID or blank.');
const lock = await open('.bot.lock', 'wx', 0o600).catch(() => {
  throw new Error('Cannot acquire .bot.lock. Another bot may be running. If a previous process crashed, stop all copies before removing this file.');
});
await lock.writeFile(`${process.pid}\n`);
await lock.close();
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 }, allowedMentions: { parse: [] } });
const pending = new Map();
const active = new Set();
let stopping = false;
const commands = ['template-load', 'teamplte-load'].map(name => new SlashCommandBuilder()
  .setName(name).setDescription('Replace this server’s roles and channels using a Discord template')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setDMPermission(false)
  .addStringOption(option => option.setName('template').setDescription('Discord template code or URL').setRequired(true)).toJSON());

async function register(target) {
  const route = target ? `/applications/${client.user.id}/guilds/${target}/commands` : `/applications/${client.user.id}/commands`;
  for (const command of commands) await client.rest.post(route, { body: command });
  log('INFO', `Registered /template-load and /teamplte-load ${target ? `in guild ${target}` : 'globally (Discord may take time to show them)'}.`);
}
async function notify(interaction, content) {
  try { await interaction.editReply({ content, components: [], allowedMentions: { parse: [] } }); }
  catch (error) { log('WARN', `Could not update interaction after channel deletion/expiry: ${error.message}. Check console for job status.`); }
}
client.once(Events.ClientReady, async () => {
  try {
    log('INFO', `Logged in as ${client.user.tag}.`);
    log('INFO', `Invite: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`);
    await register(guildId);
    log('INFO', 'READY. Move the bot’s own role above every ordinary role before loading a template.');
  } catch (error) { log('ERROR', `Startup registration failed: ${error.message}. If GUILD_ID is set, invite the bot to that server using the URL above, then restart.`); await shutdown(1); }
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
  if (interaction.isChatInputCommand() && !commands.some(c => c.name === interaction.commandName)) return;
  if (interaction.isButton() && !interaction.customId.startsWith('load:')) return;
  try {
    if (!interaction.inGuild() || (guildId && interaction.guildId !== guildId)) {
      await interaction.reply({ content: 'Run this in the configured server.', flags: MessageFlags.Ephemeral }); return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (stopping) { await notify(interaction, 'Bot is shutting down.'); return; }
    if (active.has(interaction.guildId)) { await notify(interaction, 'A template load is already running in this server. Watch the console.'); return; }
    if (interaction.isChatInputCommand()) {
      const code = templateCode(interaction.options.getString('template', true));
      log('INFO', `Preflight requested by ${interaction.user.id} in ${interaction.guildId}, template ${code}.`);
      const template = await client.rest.get(`/guilds/templates/${encodeURIComponent(code)}`);
      const state = await preflight(client.rest, interaction.guildId, interaction.user.id, client.user.id, template);
      const id = randomUUID();
      // Replace the caller’s older confirmations and expire all sessions after five minutes.
      for (const [key, p] of pending) if (p.userId === interaction.user.id && p.guildId === interaction.guildId) pending.delete(key);
      pending.set(id, { userId: interaction.user.id, guildId: interaction.guildId, template, expires: Date.now() + 300000 });
      const { plan } = state;
      await interaction.editReply({
        content: `**IRREVERSIBLE — ${state.guild.name}**\nDisable Community, permanently delete ${state.channels.length} channels/categories (including their messages and threads) and ${state.deletable.length} roles. Keep ${state.preserved.length} protected roles, server name and icon.\nCreate ${plan.roles.length} roles and ${plan.categories.length + plan.channels.length} channels/categories from template **${template.name}**.\nRole assignments are lost, including your admin role if it is deleted. The server owner keeps access. Backup is structure only; no message recovery or automatic rollback.\nConfirm within 5 minutes.`,
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`load:${id}`).setLabel('Permanently erase and load template').setStyle(ButtonStyle.Danger))],
        allowedMentions: { parse: [] },
      });
      return;
    }
    const id = interaction.customId.slice(5);
    const session = pending.get(id);
    if (!session || session.expires < Date.now() || session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
      await notify(interaction, 'Confirmation expired or does not belong to you. Run the command again.'); return;
    }
    // Set the lock before awaiting any API call to prevent double clicks/concurrent admins.
    pending.delete(id);
    active.add(interaction.guildId);
    try {
      const state = await preflight(client.rest, interaction.guildId, interaction.user.id, client.user.id, session.template);
      await notify(interaction, 'Confirmed. Starting the load; all progress and the final result are logged to the bot console.');
      const job = await applyTemplate({ rest: client.rest, state, template: session.template, userId: interaction.user.id, log });
      await notify(interaction, `Template loaded successfully. Job: ${job}. Server name and icon preserved.`);
    } finally { active.delete(interaction.guildId); }
  } catch (error) {
    log('ERROR', `Interaction ${interaction.id}: ${error.message}`);
    if (interaction.deferred || interaction.replied) await notify(interaction, `Stopped: ${error.message.slice(0, 1500)}\nIf loading had started, changes may be partial. Check the console and backups before trying again.`);
    else await interaction.reply({ content: 'Command failed; check the bot console.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});
const timer = setInterval(() => { for (const [id, p] of pending) if (p.expires < Date.now()) pending.delete(id); }, 60000);
timer.unref();
client.rest.on(RESTEvents.RateLimited, data => log('WARN', `Discord rate limit: ${data.method} ${data.route}; waiting ${data.timeToReset}ms.`));
client.on(Events.Error, error => log('ERROR', error.message));
client.on(Events.Warn, message => log('WARN', message));
client.on(Events.ShardReconnecting, id => log('WARN', `Shard ${id} reconnecting.`));
client.on(Events.ShardResume, id => log('INFO', `Shard ${id} resumed.`));
async function shutdown(code = 0) {
  if (active.size) {
    stopping = true;
    log('WARN', 'Shutdown requested. Waiting for active loads to finish; new loads are disabled.');
    setTimeout(() => { void shutdown(code); }, 1000).unref();
    return;
  }
  stopping = true;
  clearInterval(timer);
  client.destroy();
  await unlink('.bot.lock').catch(() => {});
  process.exitCode = code;
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
try { await client.login(token); }
catch (error) { log('ERROR', `Login failed: ${error.message}`); await shutdown(1); }
