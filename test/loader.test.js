import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePlan, channelBody, templateCode, bits } from '../src/plan.js';
import { preflight, applyTemplate } from '../src/loader.js';

const fixture = () => ({ code: 'example', name: 'Test', serialized_source_guild: {
  roles: [
    { id: 0, name: '@everyone', permissions: '1024' },
    { id: 1, name: 'Member', permissions: '9007199254740993' },
    { id: 2, name: 'Admin', permissions: '8' },
  ],
  channels: [
    { id: 0, name: 'Private', type: 4, position: 0, parent_id: null, permission_overwrites: [{ id: 0, type: 0, deny: '1024', allow: '0' }] },
    { id: 1, name: 'secret', type: 0, position: 0, parent_id: 0, topic: 'Hello', permission_overwrites: [{ id: 0, type: 0, deny: '1024', allow: '0' }, { id: 1, type: 0, deny: '0', allow: '1024' }] },
    { id: 2, name: 'Voice', type: 2, position: 0, parent_id: null, bitrate: 64000, user_limit: 10, permission_overwrites: [] },
  ], system_channel_id: 1,
} });
function mock({ admin = true, botAdmin = true, blocked = false, communityFails = false, failCreate = false } = {}) {
  const calls = [];
  const guild = { id: '100', owner_id: 'owner', name: 'Original', icon: 'original-icon', premium_tier: 0, features: ['COMMUNITY'], roles: [
    { id: '100', name: '@everyone', permissions: '0', position: 0 },
    { id: '101', name: 'Old Admin', permissions: admin ? '8' : '0', position: blocked ? 10 : 1 },
    { id: '102', name: 'Loader', permissions: botAdmin ? '8' : '0', managed: true, position: 5, tags: { bot_id: 'bot' } },
    { id: '103', name: 'Integration', permissions: '0', managed: true, position: 2 },
  ] };
  const channels = [{ id: '201', name: 'Old category', type: 4 }, { id: '202', name: 'Old text', type: 0, parent_id: '201' }];
  let created = 300;
  const rest = {};
  for (const method of ['get', 'post', 'patch', 'delete']) rest[method] = async (route, options) => {
    calls.push({ method, route, body: options?.body });
    if (method === 'get') {
      if (route === '/guilds/100') return structuredClone(guild);
      if (route === '/guilds/100/channels') return structuredClone(channels);
      if (route.endsWith('/members/user')) return { roles: ['101'] };
      if (route.endsWith('/members/bot')) return { roles: ['102'] };
      throw new Error(`Unexpected GET: ${route}`);
    }
    if (method === 'patch' && route === '/guilds/100') {
      if (options.body.features && communityFails) throw new Error('Community rejected');
      Object.assign(guild, options.body); return structuredClone(guild);
    }
    if (method === 'post') {
      if (failCreate) throw new Error('Creation rejected');
      return { id: String(++created) };
    }
    return {};
  };
  return { rest, calls, guild };
}
async function run(t, options = {}) {
  const api = mock(options);
  const template = fixture();
  const state = await preflight(api.rest, '100', 'user', 'bot', template);
  const dir = await mkdtemp(join(tmpdir(), 'template-bot-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const execute = () => applyTemplate({ rest: api.rest, state, template, userId: 'user', log() {}, backupDir: dir });
  return { ...api, state, dir, execute };
}

test('parses codes and official template links, rejects arbitrary URLs', () => {
  for (const input of ['abc-123', 'https://discord.new/abc-123', 'https://discord.com/template/abc-123/']) assert.equal(templateCode(input), 'abc-123');
  assert.throws(() => templateCode('https://evil.example/abc'));
});
test('permission bitfields remain lossless; unsafe numbers fail', () => {
  assert.equal(bits('9007199254740993'), '9007199254740993');
  assert.throws(() => bits(9007199254740992));
});
test('maps placeholder zero, parent zero and explicit deny/allow without losing permissions', () => {
  const body = channelBody(fixture().serialized_source_guild.channels[1], new Map([['0', '100'], ['1', '301']]), new Map([['0', '400']]));
  assert.equal(body.parent_id, '400');
  assert.deepEqual(body.permission_overwrites, [{ id: '100', type: 0, allow: '0', deny: '1024' }, { id: '301', type: 0, allow: '1024', deny: '0' }]);
  assert.throws(() => channelBody(fixture().serialized_source_guild.channels[1], new Map(), new Map()));
});
test('rejects unsupported channel types before any mutation', async () => {
  for (const type of [5, 13, 15, 16, 99]) {
    const api = mock(); const template = fixture(); template.serialized_source_guild.channels[1].type = type;
    await assert.rejects(preflight(api.rest, '100', 'user', 'bot', template), /unsupported type/);
    assert.ok(api.calls.every(c => c.method === 'get'));
  }
});
test('rejects unresolved overwrites, member overwrites and missing parent references', () => {
  for (const mutate of [
    s => { s.channels[1].permission_overwrites[0].id = 999; },
    s => { s.channels[1].permission_overwrites[0].type = 1; },
    s => { s.channels[1].parent_id = 999; },
  ]) { const f = fixture(); mutate(f.serialized_source_guild); assert.throws(() => makePlan(f)); }
});
test('rejects impossible limits and bitrate without silently changing settings', () => {
  assert.throws(() => makePlan(fixture(), { preservedCount: 249 }), /role limit/);
  assert.throws(() => makePlan(fixture(), { maxBitrate: 32000 }), /bitrate/);
});
test('preflight requires requester admin, persistent bot admin and hierarchy', async () => {
  for (const options of [{ admin: false }, { botAdmin: false }, { blocked: true }]) {
    const api = mock(options);
    await assert.rejects(preflight(api.rest, '100', 'user', 'bot', fixture()));
    assert.ok(api.calls.every(c => c.method === 'get'));
  }
});
test('owner is authorized without any administrator role', async () => {
  const api = mock({ admin: false }); api.guild.owner_id = 'user';
  await preflight(api.rest, '100', 'user', 'bot', fixture());
});
test('complete load preserves identity/protected roles, orders mutations and remaps overwrites', async t => {
  const { execute, calls, guild, dir } = await run(t);
  await execute();
  const writes = calls.filter(c => c.method !== 'get');
  assert.deepEqual(writes[0].body, { features: [] });
  const deletions = writes.filter(c => c.method === 'delete').map(c => c.route);
  assert.deepEqual(deletions, ['/channels/202', '/channels/201', '/guilds/100/roles/101']);
  const creations = writes.filter(c => c.method === 'post');
  assert.deepEqual(creations.map(c => c.body.name), ['Member', 'Admin', 'Private', 'secret', 'Voice']);
  assert.equal(creations[0].body.permissions, '9007199254740993');
  assert.equal(creations[3].body.parent_id, '303');
  assert.equal(creations[3].body.permission_overwrites[1].id, '301');
  assert.equal(creations[3].body.permission_overwrites[0].id, '100');
  assert.ok(writes.every(c => !Object.hasOwn(c.body ?? {}, 'icon') && !Object.hasOwn(c.body ?? {}, 'name') || c.method === 'post'));
  assert.equal(guild.name, 'Original'); assert.equal(guild.icon, 'original-icon');
  assert.equal(guild.system_channel_id, '304');
  const files = await readdir(dir);
  const journal = await readFile(join(dir, files.find(f => f.endsWith('.jsonl'))), 'utf8');
  assert.match(journal, /"status":"complete"/);
  const backup = JSON.parse(await readFile(join(dir, files.find(f => f.endsWith('.json'))), 'utf8'));
  assert.equal(backup.guild.features[0], 'COMMUNITY');
});
test('Community failure stops before deletion and records failure', async t => {
  const { execute, calls, dir } = await run(t, { communityFails: true });
  await assert.rejects(execute(), /Community rejected/);
  assert.ok(!calls.some(c => c.method === 'delete'));
  const files = await readdir(dir);
  assert.match(await readFile(join(dir, files.find(f => f.endsWith('.jsonl'))), 'utf8'), /"status":"failed"/);
});
test('creation failure stops the job without creating channels or reporting success', async t => {
  const { execute, calls, dir } = await run(t, { failCreate: true });
  await assert.rejects(execute(), /Creation rejected/);
  assert.equal(calls.filter(c => c.method === 'post').length, 1);
  const files = await readdir(dir);
  assert.doesNotMatch(await readFile(join(dir, files.find(f => f.endsWith('.jsonl'))), 'utf8'), /"status":"complete"/);
});
