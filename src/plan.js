const fail = message => { throw new Error(message); };
export const key = value => String(value);
export function bits(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('Unsafe numeric permission bitfield.');
  if (!/^[0-9]+$/.test(String(value))) fail('Invalid permission bitfield.');
  return BigInt(value).toString();
}
export function templateCode(input) {
  const match = input.trim().match(/^(?:https?:\/\/(?:discord\.new\/|(?:www\.)?discord\.com\/template\/))?([\w-]+)\/?$/);
  if (!match) fail('Use a template code or a discord.new / discord.com/template link.');
  return match[1];
}
function unique(items, label) {
  const ids = items.map(x => key(x.id));
  if (items.some(x => x.id == null) || new Set(ids).size !== ids.length) fail(`Invalid or duplicate ${label} IDs.`);
}
function name(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 100) fail(`Invalid ${label} name.`);
}
export function makePlan(template, { preservedCount = 1, maxBitrate = 96000 } = {}) {
  const source = template.serialized_source_guild;
  if (!source || !Array.isArray(source.roles) || !Array.isArray(source.channels)) fail('Template has no usable guild snapshot.');
  unique(source.roles, 'role'); unique(source.channels, 'channel');
  const everyone = source.roles.filter(r => r.name === '@everyone');
  if (everyone.length !== 1) fail('Template must contain exactly one @everyone role.');
  const roleIds = new Set(source.roles.map(r => key(r.id)));
  const channelsById = new Map(source.channels.map(c => [key(c.id), c]));
  for (const r of source.roles) {
    name(r.name, 'role'); bits(r.permissions);
    if (r.managed) fail('Template contains a managed role that cannot be recreated.');
    if (r.color != null && (!Number.isInteger(r.color) || r.color < 0 || r.color > 0xffffff)) fail('Invalid role color.');
    if (r.colors?.secondary_color || r.colors?.tertiary_color || r.icon || r.unicode_emoji) fail('Role icons and enhanced role colors are unsupported.');
  }
  if (source.roles.length - 1 + preservedCount > 250) fail('Template exceeds the destination role limit.');
  if (source.channels.length > 500) fail('Template exceeds the channel limit.');
  for (const c of source.channels) {
    name(c.name, 'channel');
    if (![0, 2, 4].includes(c.type)) fail(`Channel "${c.name}" has unsupported type ${c.type}. Community stays disabled; only text, voice and categories are supported.`);
    if (c.position != null && (!Number.isInteger(c.position) || c.position < 0)) fail('Invalid channel position.');
    if (c.parent_id != null && (c.type === 4 || channelsById.get(key(c.parent_id))?.type !== 4)) fail(`Invalid parent for ${c.name}.`);
    if (c.type === 2 && c.bitrate != null && (c.bitrate < 8000 || c.bitrate > maxBitrate)) fail(`Voice bitrate for ${c.name} exceeds destination capabilities.`);
    if (c.type === 2 && c.user_limit != null && (!Number.isInteger(c.user_limit) || c.user_limit < 0 || c.user_limit > 99)) fail('Invalid voice user limit.');
    if (c.rate_limit_per_user != null && (!Number.isInteger(c.rate_limit_per_user) || c.rate_limit_per_user < 0 || c.rate_limit_per_user > 21600)) fail('Invalid slowmode.');
    if (c.type === 0 && c.topic != null && (typeof c.topic !== 'string' || c.topic.length > 1024)) fail('Invalid text channel topic.');
    if (c.default_auto_archive_duration != null && ![60, 1440, 4320, 10080].includes(c.default_auto_archive_duration)) fail('Invalid archive duration.');
    const overwrites = c.permission_overwrites ?? [];
    if (!Array.isArray(overwrites) || overwrites.length > 100) fail('Invalid permission overwrites.');
    const seen = new Set();
    for (const o of overwrites) {
      if (o.type !== 0 || !roleIds.has(key(o.id))) fail(`Unresolvable permission overwrite in ${c.name}; refusing to weaken permissions.`);
      if (seen.has(key(o.id))) fail('Duplicate permission overwrite.');
      seen.add(key(o.id)); bits(o.allow ?? '0'); bits(o.deny ?? '0');
    }
  }
  for (const c of source.channels.filter(c => c.type === 4)) {
    if (source.channels.filter(child => child.parent_id != null && key(child.parent_id) === key(c.id)).length > 50) fail('A category exceeds 50 channels.');
  }
  const order = (a, b) => (a.position ?? 0) - (b.position ?? 0);
  return {
    everyone: everyone[0],
    roles: source.roles.filter(r => r !== everyone[0]).sort(order),
    categories: source.channels.filter(c => c.type === 4).sort(order),
    channels: source.channels.filter(c => c.type !== 4).sort(order),
  };
}
export function roleBody(role) {
  return { name: role.name, permissions: bits(role.permissions), color: role.colors?.primary_color ?? role.color ?? 0, hoist: Boolean(role.hoist), mentionable: Boolean(role.mentionable) };
}
export function channelBody(channel, roleMap, channelMap) {
  const body = { name: channel.name, type: channel.type, permission_overwrites: (channel.permission_overwrites ?? []).map(o => {
    const id = roleMap.get(key(o.id));
    if (!id) fail('Missing role mapping.');
    return { id, type: 0, allow: bits(o.allow ?? '0'), deny: bits(o.deny ?? '0') };
  }) };
  if (channel.parent_id != null) {
    body.parent_id = channelMap.get(key(channel.parent_id));
    if (!body.parent_id) fail('Missing category mapping.');
  }
  const fields = channel.type === 0
    ? ['topic', 'nsfw', 'rate_limit_per_user', 'default_auto_archive_duration', 'default_thread_rate_limit_per_user']
    : channel.type === 2 ? ['bitrate', 'user_limit', 'rtc_region', 'video_quality_mode', 'nsfw', 'rate_limit_per_user'] : [];
  for (const field of fields) if (channel[field] != null) body[field] = channel[field];
  return body;
}
