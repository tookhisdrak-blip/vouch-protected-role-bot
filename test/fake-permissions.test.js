const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { createDatabase } = require('../src/database');
const { handleMessageCreate, handleMessageUpdate } = require('../src/events/messageCreate');
const { hasFakePermission, FAKE_PERMISSIONS } = require('../src/services/fakePermissions');

const OWNER_ID = '100000000000000001';
const DENIED = /fake `ban_members` permission/;

function createFixture(guildId = '220000000000000001', db = createDatabase(':memory:')) {
  db.ensureGuild(guildId);
  const banned = [];
  const guild = {
    id: guildId,
    ownerId: OWNER_ID,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    bans: { async fetch() { const error = new Error('Unknown Ban'); error.code = 10026; throw error; } },
    async fetchAuditLogs() { return { entries: new Collection() }; }
  };
  guild.members.fetch = async (id) => (id ? guild.members.cache.get(id) || null : guild.members.cache);
  guild.members.ban = async (userId) => { banned.push(userId); };

  function addRole(roleId, permissions = []) {
    const role = { id: roleId, name: roleId, guild, permissions: { has: (permission) => permissions.includes(permission) } };
    guild.roles.cache.set(roleId, role);
    return role;
  }

  function addMember(id, roleIds = []) {
    const member = {
      id,
      guild,
      user: { id, bot: false, username: id, tag: `${id}#0001` },
      roles: { cache: new Collection() },
      permissions: { has: () => roleIds.some((roleId) => guild.roles.cache.get(roleId)?.permissions.has(PermissionFlagsBits.BanMembers)) }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
    guild.members.cache.set(id, member);
    return member;
  }

  return { db, guild, banned, addRole, addMember };
}

function client(guild) {
  return {
    guilds: { cache: new Collection([[guild.id, guild]]) },
    users: { fetch: async (id) => guild.members.cache.get(id)?.user || null }
  };
}

function messageFor(guild, member, content) {
  const replies = [];
  return {
    guild, member, author: member.user, content, replies, client: client(guild),
    async reply(payload) { replies.push(payload); return payload; }
  };
}

async function run(guild, db, member, content) {
  const message = messageFor(guild, member, content);
  await handleMessageCreate(message, message.client, db, '-');
  return message.replies[0]?.embeds[0].data.description || '';
}

async function runEdited(guild, db, member, content) {
  const message = messageFor(guild, member, content);
  await handleMessageUpdate({ content: 'not a command' }, message, message.client, db, '-');
  return message.replies[0]?.embeds[0].data.description || '';
}

test('fake permission registry is extensible and validates names', () => {
  assert.ok(FAKE_PERMISSIONS.ban_members);
  const { db, guild, addMember } = createFixture();
  const member = addMember('420000000000000009');
  assert.equal(hasFakePermission(member, db, 'not_a_permission'), false);
  db.close();
});

test('user with a direct fake ban_members permission can Forever Ban and Forever Unban', async (t) => {
  const { db, guild, banned, addMember } = createFixture();
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const mod = addMember('420000000000000001');
  const target = addMember('420000000000000002');

  assert.match(await run(guild, db, owner, `-fp add <@${mod.id}> ban_members`), /now has fake `ban_members`/);
  assert.equal(hasFakePermission(mod, db, 'ban_members'), true);
  assert.match(await run(guild, db, mod, `-foreverban <@${target.id}> spam`), /active forever-ban rule/);
  assert.ok(db.getForeverBan(guild.id, target.id));
  assert.deepEqual(banned, [target.id]);
  assert.match(await run(guild, db, mod, `-unforeverban <@${target.id}>`), /was removed/);
  assert.equal(db.getForeverBan(guild.id, target.id), undefined);
});

test('user with a fake-permission role can Forever Ban; raw user and role IDs are accepted', async (t) => {
  const { db, guild, addRole, addMember } = createFixture();
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const banRole = '320000000000000001';
  addRole(banRole);
  const mod = addMember('420000000000000011', [banRole]);
  const other = addMember('420000000000000012');
  const target = addMember('420000000000000013');

  assert.match(await run(guild, db, owner, `-fp add ${banRole} ban_members`), /<@&320000000000000001> now has fake/);
  assert.equal(db.getFakePermissions(guild.id)[0].target_type, 'role');
  assert.match(await run(guild, db, mod, `-foreverban <@${target.id}>`), /active forever-ban rule/);

  assert.match(await run(guild, db, owner, `-fp add ${other.id} ban_members`), /<@420000000000000012> now has fake/);
  assert.equal(hasFakePermission(other, db, 'ban_members'), true);

  mod.roles.cache.delete(banRole);
  assert.equal(hasFakePermission(mod, db, 'ban_members'), false, 'losing the role loses the fake permission');
  assert.match(await run(guild, db, mod, `-unforeverban <@${target.id}>`), DENIED);
});

test('users without the fake permission are denied, even with real BanMembers or other bot access', async (t) => {
  const { db, guild, banned, addRole, addMember } = createFixture();
  t.after(() => db.close());
  const realBanRole = '320000000000000002';
  addRole(realBanRole, [PermissionFlagsBits.BanMembers, PermissionFlagsBits.Administrator]);
  const realMod = addMember('420000000000000021', [realBanRole]);
  const vouchAdmin = addMember('420000000000000022');
  db.addVouchAdmin(guild.id, vouchAdmin.id, OWNER_ID);
  const giver = addMember('420000000000000023');
  db.addGiver(guild.id, giver.id);
  const target = addMember('420000000000000024');
  db.upsertForeverBan({ guild_id: guild.id, user_id: '420000000000000025', username: null, reason: 'x', executor_id: OWNER_ID, created_at: new Date().toISOString(), original_ban_status: 'banned' });

  for (const member of [realMod, vouchAdmin, giver]) {
    assert.match(await run(guild, db, member, `-foreverban <@${target.id}>`), DENIED);
    assert.match(await run(guild, db, member, '-unforeverban <@420000000000000025>'), DENIED);
    assert.match(await runEdited(guild, db, member, `-foreverban <@${target.id}>`), DENIED);
  }
  assert.equal(db.getForeverBan(guild.id, target.id), undefined);
  assert.ok(db.getForeverBan(guild.id, '420000000000000025'), 'denied unban leaves the record');
  assert.deepEqual(banned, []);
  assert.match(await run(guild, db, vouchAdmin, `-fp add <@${vouchAdmin.id}> ban_members`), /Only OS or the Guild Owner/);
  assert.equal(db.getFakePermissions(guild.id).length, 0);
});

test('OS automatically has every fake permission and can manage fake permissions', async (t) => {
  const { db, guild, addRole, addMember } = createFixture();
  t.after(() => db.close());
  const osRole = '320000000000000003';
  addRole(osRole);
  db.setSetting(guild.id, 'os_role_id', osRole);
  const osUser = addMember('420000000000000031');
  db.addOsUser(guild.id, osUser.id);
  const osByRole = addMember('420000000000000032', [osRole]);
  const target = addMember('420000000000000033');
  const mod = addMember('420000000000000034');

  for (const permission of Object.keys(FAKE_PERMISSIONS)) {
    assert.equal(hasFakePermission(osUser, db, permission), true);
    assert.equal(hasFakePermission(osByRole, db, permission), true);
  }
  assert.match(await run(guild, db, osByRole, `-foreverban <@${target.id}>`), /active forever-ban rule/);
  assert.match(await run(guild, db, osUser, `-unforeverban <@${target.id}>`), /was removed/);
  assert.match(await run(guild, db, osUser, `-fp add <@${mod.id}> ban_members`), /now has fake/);
  assert.match(await run(guild, db, osUser, '-fp list'), /`ban_members`: <@420000000000000034>/);
  assert.match(await run(guild, db, osUser, `-fp remove <@${mod.id}> ban_members`), /removed from/);
  assert.equal(hasFakePermission(mod, db, 'ban_members'), false);
  assert.match(await run(guild, db, osUser, `-fp add <@${mod.id}> manage_everything`), /Unknown fake permission/);
});

test('Guild Owner automatically has every fake permission; edited commands work', async (t) => {
  const { db, guild, addMember } = createFixture();
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const target = addMember('420000000000000041');
  assert.equal(hasFakePermission(owner, db, 'ban_members'), true);
  assert.equal(db.getFakePermissions(guild.id).length, 0, 'no stored grant needed');
  assert.match(await runEdited(guild, db, owner, `-foreverban <@${target.id}>`), /active forever-ban rule/);
  assert.match(await run(guild, db, owner, `-unforeverban <@${target.id}>`), /was removed/);
});

test('fake permissions persist in SQLite across restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'));
  const file = path.join(dir, 'test.sqlite');
  try {
    let db = createDatabase(file);
    const first = createFixture('220000000000000009', db);
    const owner = first.addMember(OWNER_ID);
    const mod = first.addMember('420000000000000051');
    await run(first.guild, db, owner, `-fp add <@${mod.id}> ban_members`);
    db.close();

    db = createDatabase(file);
    const second = createFixture('220000000000000009', db);
    const reloaded = second.addMember('420000000000000051');
    assert.equal(hasFakePermission(reloaded, db, 'ban_members'), true);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
