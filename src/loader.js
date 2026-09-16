import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makePlan, roleBody, channelBody, bits, key } from './plan.js';

export function isAdmin(guild, member, userId) {
  if (guild.owner_id === userId) return true;
  const ids = new Set([guild.id, ...member.roles]);
  return guild.roles.some(r => ids.has(r.id) && (BigInt(r.permissions) & 8n) !== 0n);
}
export async function preflight(rest, guildId, userId, botId, template) {
  const [guild, channels, member, bot] = await Promise.all([
    rest.get(`/guilds/${guildId}`), rest.get(`/guilds/${guildId}/channels`),
    rest.get(`/guilds/${guildId}/members/${userId}`), rest.get(`/guilds/${guildId}/members/${botId}`),
  ]);
  if (!isAdmin(guild, member, userId)) throw new Error('You must currently have Administrator permission in this server.');
  // The bot must retain Administrator after every ordinary role is deleted.
  const ownRole = guild.roles.find(r => r.managed && r.tags?.bot_id === botId && bot.roles.includes(r.id));
  if (!ownRole || !(BigInt(ownRole.permissions) & 8n)) throw new Error('Grant Administrator to the bot’s own managed role first.');
  const deletable = guild.roles.filter(r => r.id !== guildId && !r.managed);
  const blocked = deletable.filter(r => r.position >= ownRole.position);
  if (blocked.length) throw new Error(`Move the bot’s own role above all ordinary roles first. Blocked: ${blocked.map(r => r.name).join(', ')}`);
  const preserved = guild.roles.filter(r => r.id === guildId || r.managed);
  const maxBitrate = guild.features.includes('VIP_REGIONS') ? 384000 : [96000, 128000, 256000, 384000][guild.premium_tier ?? 0];
  const plan = makePlan(template, { preservedCount: preserved.length, maxBitrate });
  return { guild, channels, deletable, preserved, plan };
}

export async function applyTemplate({ rest, state, template, userId, log, backupDir = 'backups' }) {
  const { guild, channels, deletable, plan } = state;
  const job = `${guild.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDir, `${job}.json`);
  const journalPath = join(backupDir, `${job}.jsonl`);
  await writeFile(backupPath, JSON.stringify({ job, createdAt: new Date().toISOString(), requestedBy: userId, guild, channels, template }, null, 2), { flag: 'wx', mode: 0o600 });
  const record = async entry => appendFile(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  const reason = `Template ${template.code} requested by ${userId}; job ${job}`;
  const step = async (label, method, route, body) => {
    log('INFO', `[${job}] ${label}`);
    await record({ status: 'starting', label });
    const result = await rest[method](route, { ...(body === undefined ? {} : { body }), reason });
    await record({ status: 'done', label, id: result?.id });
    return result;
  };
  log('INFO', `[${job}] Structure backup saved: ${backupPath}`);
  try {
    if (guild.features.includes('COMMUNITY')) {
      const changed = await step('Disable Community and discovery', 'patch', `/guilds/${guild.id}`, {
        features: guild.features.filter(f => !['COMMUNITY', 'DISCOVERABLE'].includes(f)),
      });
      if (changed.features.includes('COMMUNITY')) throw new Error('Community is still enabled. No roles or channels were deleted.');
    }
    await step('Clear old guild channel references', 'patch', `/guilds/${guild.id}`, {
      rules_channel_id: null, public_updates_channel_id: null, safety_alerts_channel_id: null,
      system_channel_id: null, afk_channel_id: null,
    });
    // Delete children first. Deleting a category first would expose orphaned channels.
    const deleteOrder = [...channels].sort((a, b) => Number(a.type === 4) - Number(b.type === 4));
    for (const c of deleteOrder) await step(`Delete channel ${c.name} (${c.id})`, 'delete', `/channels/${c.id}`);
    for (const r of [...deletable].sort((a, b) => b.position - a.position)) await step(`Delete role ${r.name} (${r.id})`, 'delete', `/guilds/${guild.id}/roles/${r.id}`);
    const roleMap = new Map([[key(plan.everyone.id), guild.id]]);
    await step('Apply template @everyone permissions', 'patch', `/guilds/${guild.id}/roles/${guild.id}`, { permissions: bits(plan.everyone.permissions) });
    for (const r of plan.roles) {
      const made = await step(`Create role ${r.name}`, 'post', `/guilds/${guild.id}/roles`, roleBody(r));
      roleMap.set(key(r.id), made.id);
    }
    if (plan.roles.length) await step('Restore template role order', 'patch', `/guilds/${guild.id}/roles`, plan.roles.map((r, i) => ({ id: roleMap.get(key(r.id)), position: i + 1 })));
    const channelMap = new Map();
    for (const c of [...plan.categories, ...plan.channels]) {
      const made = await step(`Create ${c.type === 4 ? 'category' : 'channel'} ${c.name}`, 'post', `/guilds/${guild.id}/channels`, channelBody(c, roleMap, channelMap));
      channelMap.set(key(c.id), made.id);
    }
    const all = [...plan.categories, ...plan.channels];
    if (all.length) await step('Restore channel positions', 'patch', `/guilds/${guild.id}/channels`, all.map((c, i) => ({ id: channelMap.get(key(c.id)), position: c.position ?? i })));
    const source = template.serialized_source_guild;
    const references = {};
    for (const field of ['system_channel_id', 'afk_channel_id']) {
      if (source[field] != null && channelMap.has(key(source[field]))) references[field] = channelMap.get(key(source[field]));
    }
    if (source.system_channel_flags != null) references.system_channel_flags = source.system_channel_flags;
    if (references.afk_channel_id && source.afk_timeout != null) references.afk_timeout = source.afk_timeout;
    if (Object.keys(references).length) await step('Restore template system/AFK channel references', 'patch', `/guilds/${guild.id}`, references);
    const final = await rest.get(`/guilds/${guild.id}`);
    if (final.features.includes('COMMUNITY')) throw new Error('Community was re-enabled externally during the load.');
    if (final.name !== guild.name || final.icon !== guild.icon) throw new Error('Server name or icon changed externally during the load.');
    await record({ status: 'complete', roleMap: Object.fromEntries(roleMap), channelMap: Object.fromEntries(channelMap) });
    log('INFO', `[${job}] COMPLETE. Created ${plan.roles.length} roles and ${all.length} channels/categories. Name and icon preserved.`);
    return job;
  } catch (error) {
    log('ERROR', `[${job}] STOPPED: ${error.message}. Inspect ${backupPath} and ${journalPath}. No automatic rollback.`);
    await record({ status: 'failed', message: error.message }).catch(() => {});
    throw error;
  }
}
