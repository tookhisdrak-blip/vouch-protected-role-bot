const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');
const Database = require('better-sqlite3');
const { createDatabase } = require('../src/database');
const { giveVouch, takeVouch } = require('../src/services/vouches');
const { canGiveVouch, remainingVouches } = require('../src/services/permissions');
const { handleGuildMemberUpdate, reconcileGuild } = require('../src/services/roleProtection');
const adminCommands = require('../src/commands/admin');
const vouchCommands = require('../src/commands/vouch');
const helpCommand = require('../src/commands/help');
const { handlers } = require('../src/events/messageCreate');
const { handleMemberUpdate } = require('../src/events/guildMemberUpdate');
const forceCommands = require('../src/commands/forceManagement');
const { setForcedNickname, removeForcedNickname, createForcedRoleStrip, removeForcedRoleStripsForUser, handleForceMemberUpdate, runGlobalRoleStrip, reconcileForceGuild } = require('../src/services/forceRules');
const { createForeverBan, removeForeverBan, reconcileForeverBans } = require('../src/services/foreverBans');
const { handleMemberAdd } = require('../src/events/guildMemberAdd');

function createFixture(guildId = 'guild', ownerId = 'owner') {
  const db = createDatabase(':memory:');
  db.ensureGuild(guildId);
  const guild = {
    id: guildId,
    ownerId,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    async fetchAuditLogs() {
      return { entries: new Collection(this.auditEntries || []) };
    }
  };
  const bans = new Map();
  const banRequests = [];
  guild.bans = {
    async fetch(userId) {
      const entry = bans.get(userId);
      if (entry) return entry;
      const error = new Error('Unknown Ban');
      error.code = 10026;
      throw error;
    }
  };
  guild.members.fetch = async (id) => id ? guild.members.cache.get(id) || null : guild.members.cache;
  guild.members.ban = async (userId, options = {}) => {
    banRequests.push({ userId, options });
    bans.set(userId, { user: { id: userId }, reason: options.reason });
    guild.members.cache.delete(userId);
    return bans.get(userId);
  };

  function addRole(roleId) {
    const role = {
      id: roleId,
      name: roleId,
      guild,
      permissions: { has: (permission) => roleId === 'stripstaff-role' && permission === PermissionFlagsBits.ManageRoles }
    };
    Object.defineProperty(role, 'members', {
      get: () => new Collection([...guild.members.cache.values()]
        .filter((member) => member.roles.cache.has(roleId))
        .map((member) => [member.id, member]))
    });
    guild.roles.cache.set(roleId, role);
    return role;
  }

  function addMember(id, roleIds = [], bot = false) {
    const member = {
      id,
      guild,
      nickname: null,
      user: { id, bot, username: id, tag: `${id}#0001` },
      roleRemoveCalls: 0,
      async setNickname(nickname) {
        member.nickname = nickname;
      },
      roles: {
        cache: new Collection(),
        async add(roleId) {
          member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
        },
        async remove(roleId) {
          member.roleRemoveCalls += 1;
          member.roles.cache.delete(roleId);
        }
      }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
    guild.members.cache.set(id, member);
    return member;
  }

  function setAuditExecutor(targetId, roleId, executor) {
    guild.auditEntries = [['entry', {
      id: `audit-${targetId}-${roleId}`,
      targetId,
      executor,
      changes: [{ key: '$add', new: [{ id: roleId }] }],
      createdTimestamp: Date.now()
    }]];
  }

  return { db, guild, addRole, addMember, setAuditExecutor, bans, banRequests };
}

test('vouch flow assigns roles, consumes allowance, and restores it when removed', async (t) => {
  const { db, guild, addRole, addMember } = createFixture();
  t.after(() => db.close());
  addRole('vouch-role');
  addRole('reward-role');
  db.setSetting(guild.id, 'vouch_role_id', 'vouch-role');
  db.setSetting(guild.id, 'reward_role_id', 'reward-role');
  const giver = addMember('giver');
  db.addGiver(guild.id, giver.id);
  const first = addMember('recipient-one');
  const second = addMember('recipient-two');
  const third = addMember('recipient-three');

  assert.equal(remainingVouches(guild.id, giver.id, db), 2);
  assert.equal((await giveVouch(giver, first, 'first reason', db)).ok, true);
  assert.equal((await giveVouch(giver, second, 'second reason', db)).ok, true);
  assert.equal(db.getVouch(guild.id, first.id).giver_id, giver.id);
  assert.equal(db.getVouch(guild.id, first.id).reason, 'first reason');
  assert.match(db.getVouch(guild.id, first.id).created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.roles.cache.has('vouch-role'), true);
  assert.equal(first.roles.cache.has('reward-role'), true);
  assert.equal(remainingVouches(guild.id, giver.id, db), 0);
  assert.equal((await giveVouch(giver, third, 'third reason', db)).message,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');

  const removal = await takeVouch(giver, first, 'retracted', db);
  assert.equal(removal.ok, true);
  assert.equal(first.roles.cache.has('vouch-role'), false);
  assert.equal(first.roles.cache.has('reward-role'), false);
  assert.equal(remainingVouches(guild.id, giver.id, db), 1);
  assert.equal(db.getVouch(guild.id, first.id), undefined);
  const removalLog = db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'VOUCH REMOVED'").get();
  assert.equal(removalLog.executor_id, giver.id);
  assert.equal(removalLog.affected_user_id, first.id);
  assert.equal(removalLog.reason, 'retracted');
  assert.equal(removalLog.reward, 'Removed <@&reward-role>');

  assert.equal((await takeVouch(giver, second, 'also retracted', db)).ok, true);
  assert.equal(remainingVouches(guild.id, giver.id, db), 2);
});

test('vouch records persist after reopening SQLite', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-bot-'));
  const databasePath = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstConnection = createDatabase(databasePath);
  firstConnection.ensureGuild('persistent-guild');
  firstConnection.setSetting('persistent-guild', 'os_role_id', 'os-role');
  firstConnection.setSetting('persistent-guild', 'vouch_role_id', 'vouch-role');
  firstConnection.setSetting('persistent-guild', 'reward_role_id', 'reward-role');
  firstConnection.setSetting('persistent-guild', 'stripstaff_role_id', 'stripstaff-role');
  firstConnection.setSetting('persistent-guild', 'log_channel_id', 'log-channel');
  firstConnection.setSetting('persistent-guild', 'default_giver_limit', 4);
  firstConnection.addOsUser('persistent-guild', 'os-user');
  firstConnection.setLimitedRole('persistent-guild', 'limited-role', 7);
  firstConnection.addGiver('persistent-guild', 'giver');
  firstConnection.setGiverLimit('persistent-guild', 'giver', 5);
  firstConnection.addVouch('persistent-guild', 'recipient', 'giver', 'stored reason', '2026-09-28T00:00:00.000Z');
  firstConnection.addBlacklist('persistent-guild', 'blocked-user', 'owner', '2026-09-28T00:00:00.000Z');
  firstConnection.setForcedNickname({
    guild_id: 'persistent-guild', user_id: 'nick-user', username: 'nick#0001', nickname: 'forced',
    executor_id: 'owner', created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z'
  });
  firstConnection.addForcedRoleStrip({
    guild_id: 'persistent-guild', user_id: 'strip-user', role_id: 'strip-role',
    executor_id: 'owner', created_at: '2026-09-28T00:00:00.000Z'
  });
  firstConnection.addGlobalRoleStrip({
    guild_id: 'persistent-guild', role_id: 'global-role', executor_id: 'owner', created_at: '2026-09-28T00:00:00.000Z'
  });
  firstConnection.upsertForeverBan({
    guild_id: 'persistent-guild', user_id: 'banned-user', username: 'banned#0001', reason: 'persistent reason',
    executor_id: 'owner', created_at: '2026-09-28T00:00:00.000Z', original_ban_status: 'not_banned'
  });
  firstConnection.addForceManagementLog({
    guild_id: 'persistent-guild', action: 'test', target_user_id: 'nick-user', role_id: null, nickname: 'forced',
    executor_id: 'owner', result: 'applied', reason: null, punishment: null, failure_reason: null, attribution_status: null,
    created_at: '2026-09-28T00:00:00.000Z'
  });
  firstConnection.close();

  const reopened = createDatabase(databasePath);
  assert.equal(reopened.getSettings('persistent-guild').os_role_id, 'os-role');
  assert.equal(reopened.getSettings('persistent-guild').vouch_role_id, 'vouch-role');
  assert.equal(reopened.getSettings('persistent-guild').reward_role_id, 'reward-role');
  assert.equal(reopened.getSettings('persistent-guild').stripstaff_role_id, 'stripstaff-role');
  assert.equal(reopened.getSettings('persistent-guild').log_channel_id, 'log-channel');
  assert.equal(reopened.getSettings('persistent-guild').default_giver_limit, 4);
  assert.deepEqual(reopened.getOsUsers('persistent-guild'), ['os-user']);
  assert.equal(reopened.getLimitedRole('persistent-guild', 'limited-role').member_limit, 7);
  assert.equal(remainingVouches('persistent-guild', 'giver', reopened), 4);
  assert.equal(reopened.isBlacklisted('persistent-guild', 'blocked-user'), true);
  assert.equal(reopened.getVouch('persistent-guild', 'recipient').reason, 'stored reason');
  assert.equal(reopened.getForcedNickname('persistent-guild', 'nick-user').nickname, 'forced');
  assert.equal(reopened.getForcedRoleStrip('persistent-guild', 'strip-user', 'strip-role').role_id, 'strip-role');
  assert.equal(reopened.getGlobalRoleStrip('persistent-guild', 'global-role').role_id, 'global-role');
  assert.equal(reopened.getForeverBan('persistent-guild', 'banned-user').original_ban_status, 'not_banned');
  assert.equal(reopened.connection.prepare('SELECT COUNT(*) AS count FROM force_management_logs').get().count, 1);
  reopened.close();
});

test('additive force migration leaves a pre-existing vouch database intact', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-legacy-'));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE guild_settings (
      guild_id TEXT PRIMARY KEY, os_role_id TEXT, vouch_role_id TEXT, reward_role_id TEXT,
      stripstaff_role_id TEXT, log_channel_id TEXT, default_giver_limit INTEGER NOT NULL DEFAULT 2
    );
    CREATE TABLE active_vouches (
      guild_id TEXT NOT NULL, recipient_id TEXT NOT NULL, giver_id TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (guild_id, recipient_id)
    );
    CREATE TABLE force_management_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, action TEXT NOT NULL,
      target_user_id TEXT, role_id TEXT, nickname TEXT, executor_id TEXT, result TEXT NOT NULL,
      failure_reason TEXT, attribution_status TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO force_management_logs (guild_id, action, result, created_at)
      VALUES ('legacy-guild', 'old-force-entry', 'preserve me', '2026-09-28T00:00:00.000Z');
    INSERT INTO guild_settings (guild_id) VALUES ('legacy-guild');
    INSERT INTO active_vouches VALUES ('legacy-guild', 'recipient', 'giver', 'keep me', '2026-09-28T00:00:00.000Z');
  `);
  legacy.close();

  const db = createDatabase(databasePath);
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(db.getVouch('legacy-guild', 'recipient').reason, 'keep me');
  db.setForcedNickname({
    guild_id: 'legacy-guild', user_id: 'member', username: 'member#0001', nickname: 'safe',
    executor_id: 'owner', created_at: '2026-09-28T00:00:00.000Z', updated_at: '2026-09-28T00:00:00.000Z'
  });
  assert.equal(db.getVouch('legacy-guild', 'recipient').reason, 'keep me');
  assert.equal(db.getForcedNickname('legacy-guild', 'member').nickname, 'safe');
  assert.equal(db.connection.prepare('SELECT result FROM force_management_logs WHERE action = ?').get('old-force-entry').result, 'preserve me');
  assert.ok(db.connection.pragma('table_info(force_management_logs)').some((column) => column.name === 'reason'));
});

test('forced nicknames persist, restore after changes and rejoins, and stop after removal', async (t) => {
  const { db, guild, addMember } = createFixture('nickname-guild');
  t.after(() => db.close());
  const member = addMember('nickname-user');
  let nicknameCalls = 0;
  const originalSetNickname = member.setNickname;
  member.setNickname = async (nickname) => {
    nicknameCalls += 1;
    return originalSetNickname.call(member, nickname);
  };

  const created = await setForcedNickname(member, 'Fixed Name', 'owner', db);
  assert.equal(created.result.status, 'applied');
  assert.equal(db.getForcedNickname(guild.id, member.id).nickname, 'Fixed Name');
  await setForcedNickname(member, 'Fixed Name', 'owner', db);
  assert.equal(nicknameCalls, 1, 'correct nickname should not cause another Discord request');

  const oldMember = { ...member, nickname: 'Fixed Name', roles: { cache: new Collection() } };
  member.nickname = 'Manual Change';
  await handleMemberUpdate(oldMember, member, db);
  assert.equal(member.nickname, 'Fixed Name');
  assert.equal(nicknameCalls, 2);

  member.nickname = 'Changed While Away';
  await handleMemberAdd(member, db);
  assert.equal(member.nickname, 'Fixed Name');
  assert.equal(nicknameCalls, 3);

  const removed = await removeForcedNickname(guild, member.id, 'owner', db);
  assert.equal(removed.removed, true);
  member.nickname = 'Manual After Removal';
  const beforeRemoval = { ...member, nickname: 'Fixed Name', roles: { cache: new Collection() } };
  await handleMemberUpdate(beforeRemoval, member, db);
  assert.equal(member.nickname, 'Manual After Removal');
  assert.equal(db.getForcedNickname(guild.id, member.id), undefined);
});

test('OS can manage force rules, regular users cannot, and forever bans need fake ban_members (OS/Owner automatic)', async (t) => {
  const { db, guild, addRole, addMember, bans } = createFixture('force-permissions');
  t.after(() => db.close());
  const owner = addMember('owner');
  const os = addMember('os-user');
  const regular = addMember('regular');
  const founder = addMember('configured-founder');
  const target = addMember('777777777777777777');
  db.addOsUser(guild.id, os.id);
  addRole('role-one');

  async function makeMessage(member) {
    const replies = [];
    return {
      guild,
      member,
      author: member.user,
      client: { users: { fetch: async () => target.user } },
      replies,
      async reply(payload) { replies.push(payload); return payload; }
    };
  }

  const banTarget = addMember('888888888888888888');
  const osMessage = await makeMessage(os);
  await forceCommands.execute(osMessage, ['forcenickname', `<@${target.id}>`, 'OS Nick'], db);
  assert.equal(db.getForcedNickname(guild.id, target.id).nickname, 'OS Nick');
  await forceCommands.execute(osMessage, ['foreverban', `<@${banTarget.id}>`, 'os rule'], db);
  assert.equal(db.getForeverBan(guild.id, banTarget.id).executor_id, os.id, 'OS has fake ban_members automatically');
  await forceCommands.execute(osMessage, ['unforeverban', `<@${banTarget.id}>`], db);
  assert.equal(db.getForeverBan(guild.id, banTarget.id), undefined);

  const previousFounderIds = process.env.FORCE_FOUNDER_IDS;
  process.env.FORCE_FOUNDER_IDS = founder.id;
  try {
    const founderMessage = await makeMessage(founder);
    await forceCommands.execute(founderMessage, ['forcenickname', `<@${target.id}>`, 'Founder Nick'], db);
    assert.equal(db.getForcedNickname(guild.id, target.id).nickname, 'Founder Nick');
    await forceCommands.execute(founderMessage, ['foreverban', `<@${target.id}>`, 'owner-only'], db);
    assert.equal(db.getForeverBan(guild.id, target.id), undefined);
    assert.match(founderMessage.replies.at(-1).embeds[0].data.description, /fake `ban_members` permission/);
  } finally {
    if (previousFounderIds === undefined) delete process.env.FORCE_FOUNDER_IDS;
    else process.env.FORCE_FOUNDER_IDS = previousFounderIds;
  }

  const regularMessage = await makeMessage(regular);
  await forceCommands.execute(regularMessage, ['forcenickname', `<@${target.id}>`, 'Nope'], db);
  assert.equal(db.getForcedNickname(guild.id, target.id).nickname, 'Founder Nick');
  assert.match(regularMessage.replies[0].embeds[0].data.description, /Only OS or the Guild Owner/);

  const ownerMessage = await makeMessage(owner);
  await forceCommands.execute(ownerMessage, ['foreverban', `<@${target.id}>`, 'permanent rule'], db);
  const record = db.getForeverBan(guild.id, target.id);
  assert.equal(record.executor_id, owner.id);
  assert.equal(record.reason, 'permanent rule');
  assert.equal(record.original_ban_status, 'not_banned');
  assert.ok(bans.has(target.id));
  await forceCommands.execute(regularMessage, ['unforeverban', `<@${target.id}>`], db);
  assert.ok(db.getForeverBan(guild.id, target.id), 'members without fake ban_members cannot unforeverban');
  assert.match(regularMessage.replies.at(-1).embeds[0].data.description, /fake `ban_members` permission/);
  await forceCommands.execute(ownerMessage, ['unforeverban', `<@${target.id}>`], db);
  assert.equal(db.getForeverBan(guild.id, target.id), undefined);
  assert.equal(db.getForeverBans(guild.id).length, 0);
  assert.equal(owner.id, guild.ownerId);
});

test('forced role-strip rules remove roles immediately and punish only a verified normal executor once', async (t) => {
  const { db, guild, addRole, addMember, setAuditExecutor } = createFixture('forced-strip-guild');
  t.after(() => db.close());
  addRole('blocked-role');
  addRole('stripstaff-role');
  db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
  const target = addMember('forced-target', ['blocked-role']);
  const executor = addMember('normal-executor', ['stripstaff-role']);

  const created = await createForcedRoleStrip(target, 'blocked-role', 'owner', db);
  assert.equal(created.removal.status, 'removed');
  assert.ok(db.getForcedRoleStrip(guild.id, target.id, 'blocked-role'));

  target.roles.cache.set('blocked-role', guild.roles.cache.get('blocked-role'));
  setAuditExecutor(target.id, 'blocked-role', executor.user);
  const oldMember = { ...target, roles: { cache: new Collection() } };
  await handleForceMemberUpdate(oldMember, target, db);
  assert.equal(target.roles.cache.has('blocked-role'), false);
  assert.equal(executor.roles.cache.has('stripstaff-role'), false);
  const forceLog = db.connection.prepare('SELECT * FROM force_management_logs WHERE action = ?').get('FORCED ROLE STRIP VIOLATION');
  assert.equal(forceLog.executor_id, executor.id);
  assert.equal(forceLog.punishment, 'STRIPSTAFF removed');
  const punishmentCount = executor.roleRemoveCalls;
  await handleForceMemberUpdate(oldMember, target, db);
  assert.equal(executor.roleRemoveCalls, punishmentCount, 'duplicate update must not repeat punishment');

  const removedCount = await removeForcedRoleStripsForUser(guild, target.id, 'owner', db);
  assert.equal(removedCount, 1);
  assert.equal(db.getForcedRoleStripsForUser(guild.id, target.id).length, 0);
});

test('forced role restoration with unavailable audit attribution is reversed without punishment', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('forced-strip-audit-failure');
  t.after(() => db.close());
  addRole('blocked-role');
  addRole('stripstaff-role');
  db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
  const target = addMember('forced-target', ['blocked-role']);
  const executor = addMember('unknown-executor', ['stripstaff-role']);
  db.addForcedRoleStrip({
    guild_id: guild.id, user_id: target.id, role_id: 'blocked-role', executor_id: 'owner', created_at: new Date().toISOString()
  });
  guild.fetchAuditLogs = async () => {
    const error = new Error('Missing View Audit Log');
    error.code = 50013;
    throw error;
  };
  const oldMember = { ...target, roles: { cache: new Collection() } };

  await handleForceMemberUpdate(oldMember, target, db);

  assert.equal(target.roles.cache.has('blocked-role'), false);
  assert.equal(executor.roles.cache.has('stripstaff-role'), true);
  const log = db.connection.prepare('SELECT * FROM force_management_logs ORDER BY id DESC').get();
  assert.equal(log.executor_id, null);
  assert.match(log.attribution_status, /unavailable/);
  assert.match(log.result, /no verified punishment/);
});

test('global role strip is confirmed, sequential, and reports partial failures', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('global-strip-guild');
  t.after(() => db.close());
  const role = addRole('global-role-id');
  role.name = 'Trial';
  const owner = addMember('owner', [role.id]);
  const first = addMember('first', [role.id]);
  const second = addMember('second', [role.id]);
  const bot = addMember('bot-user', [role.id], true);
  let activeRequests = 0;
  let maxConcurrent = 0;
  const firstOriginalRemove = first.roles.remove;
  second.roles.remove = async (roleId) => {
    const error = new Error('Missing Permissions');
    error.code = 50013;
    throw error;
  };
  first.roles.remove = async (roleId) => {
    activeRequests += 1;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
    await new Promise((resolve) => setImmediate(resolve));
    await firstOriginalRemove(roleId);
    activeRequests -= 1;
  };

  const result = await runGlobalRoleStrip(guild, role, owner.id, db);

  assert.deepEqual(result, { ok: true, found: 4, stripped: 1, failed: 1, skipped: 2 });
  assert.equal(maxConcurrent, 1);
  assert.equal(owner.roles.cache.has(role.id), true);
  assert.equal(bot.roles.cache.has(role.id), true);
  assert.equal(first.roles.cache.has(role.id), false);
  assert.equal(second.roles.cache.has(role.id), true);
  assert.ok(db.getGlobalRoleStrip(guild.id, role.id));
  const log = db.connection.prepare('SELECT * FROM force_management_logs WHERE action = ?').get('GLOBAL ROLE STRIP COMPLETED');
  assert.match(log.result, /failed: 1/);
});

test('global role-strip prefix command waits for confirmation before changing roles', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('global-strip-confirm');
  t.after(() => db.close());
  const role = addRole('confirmed-role');
  role.name = 'Confirmed';
  const owner = addMember('owner');
  const target = addMember('target', [role.id]);
  const replies = [];
  const message = {
    guild,
    member: owner,
    author: owner.user,
    async reply(payload) { replies.push(payload); return payload; }
  };

  await forceCommands.execute(message, ['rolestrip', 'Confirmed'], db);
  assert.equal(target.roles.cache.has(role.id), true);
  assert.match(replies[0].embeds[0].data.title, /Confirm/);
  const buttonId = replies[0].components[0].components[0].data.custom_id;
  let completed;
  await forceCommands.handleInteraction({
    customId: buttonId,
    guild,
    guildId: guild.id,
    user: owner.user,
    async deferUpdate() {},
    message: { async edit(payload) { completed = payload; } }
  }, db);

  assert.equal(target.roles.cache.has(role.id), false);
  assert.match(completed.embeds[0].data.title, /complete/);
  assert.match(completed.embeds[0].data.description, /Successfully stripped: 1/);
});

test('forcestrip aliases distinguish member-specific and global role forms', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('forcestrip-alias-guild');
  t.after(() => db.close());
  const owner = addMember('owner');
  const target = addMember('888888888888888888');
  const role = addRole('999999999999999999');
  role.name = 'Alias Role';
  target.roles.cache.set(role.id, role);
  const message = {
    guild,
    member: owner,
    author: owner.user,
    async reply(payload) { return payload; }
  };

  await forceCommands.execute(message, ['forcestrip', `<@${target.id}>`, `<@&${role.id}>`], db);
  assert.ok(db.getForcedRoleStrip(guild.id, target.id, role.id));
  assert.equal(target.roles.cache.has(role.id), false);
  await forceCommands.execute(message, ['unforcestrip', `<@${target.id}>`], db);
  assert.equal(db.getForcedRoleStripsForUser(guild.id, target.id).length, 0);

  const globalRole = addRole('999999999999999998');
  globalRole.name = 'Global Alias Role';
  const confirmation = await forceCommands.execute(message, ['forcestrip', 'Global Alias Role'], db);
  assert.match(confirmation.embeds[0].data.title, /Confirm/);
  assert.equal(db.getGlobalRoleStrip(guild.id, globalRole.id), undefined);
  const cancelId = confirmation.components[0].components[1].data.custom_id;
  await forceCommands.handleInteraction({
    customId: cancelId,
    guildId: guild.id,
    user: owner.user,
    async update() {}
  }, db);
});

test('concurrent forever-ban requests issue at most one ban API call per account', async (t) => {
  const { db, guild, addMember, banRequests } = createFixture('ban-lock-guild');
  t.after(() => db.close());
  const target = addMember('concurrent-target');
  guild.members.ban = async (userId, options = {}) => {
    banRequests.push({ userId, options });
    await new Promise((resolve) => setImmediate(resolve));
    return { user: { id: userId } };
  };

  await Promise.all([
    createForeverBan(guild, target.user, 'first', 'owner', db),
    createForeverBan(guild, target.user, 'second', 'owner', db)
  ]);

  assert.equal(banRequests.length, 1);
  assert.ok(db.getForeverBan(guild.id, target.id));
});

test('forever-ban records survive restarts, re-ban matching joins once, and removal never unbans', async (t) => {
  const { db, guild, addMember, bans, banRequests } = createFixture('forever-join-guild');
  t.after(() => db.close());
  const banned = addMember('stored-account');
  const created = await createForeverBan(guild, banned.user, 'stored reason', 'owner', db);
  assert.equal(created.record.user_id, banned.id);
  assert.equal(db.getForeverBan(guild.id, banned.id).reason, 'stored reason');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forever-ban-'));
  const databasePath = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const persistent = createDatabase(databasePath);
  persistent.ensureGuild('forever-persistent');
  persistent.upsertForeverBan({
    guild_id: 'forever-persistent', user_id: 'stored-id', username: 'stored#0001', reason: 'keep',
    executor_id: 'owner', created_at: new Date().toISOString(), original_ban_status: 'not_banned'
  });
  persistent.close();
  const reopened = createDatabase(databasePath);
  assert.equal(reopened.getForeverBan('forever-persistent', 'stored-id').reason, 'keep');
  reopened.close();

  bans.delete(banned.id);
  const returningMember = addMember(banned.id);
  await handleMemberAdd(returningMember, db);
  await handleMemberAdd(returningMember, db);
  assert.equal(banRequests.filter((request) => request.userId === banned.id).length, 2);
  assert.equal(bans.has(banned.id), true);

  const removal = await removeForeverBan(guild, banned.id, 'owner', db);
  assert.equal(removal.removed, true);
  assert.equal(db.getForeverBan(guild.id, banned.id), undefined);
  assert.equal(bans.has(banned.id), true, 'removing the record must not unban the account');
});

test('startup force reconciliation is non-punitive and startup forever-ban checks avoid duplicate bans', async (t) => {
  const { db, guild, addRole, addMember, bans, banRequests } = createFixture('force-startup-guild');
  t.after(() => db.close());
  addRole('blocked-role');
  addRole('stripstaff-role');
  addRole('global-role');
  const target = addMember('target', ['blocked-role']);
  const staff = addMember('staff', ['stripstaff-role']);
  const owner = addMember('owner', ['global-role']);
  const bot = addMember('startup-bot', ['global-role'], true);
  db.addForcedRoleStrip({
    guild_id: guild.id, user_id: target.id, role_id: 'blocked-role', executor_id: 'owner', created_at: new Date().toISOString()
  });
  db.addGlobalRoleStrip({
    guild_id: guild.id, role_id: 'global-role', executor_id: owner.id, created_at: new Date().toISOString()
  });
  db.upsertForeverBan({
    guild_id: guild.id, user_id: 'already-banned', username: 'already#0001', reason: 'rule', executor_id: 'owner',
    created_at: new Date().toISOString(), original_ban_status: 'banned'
  });
  bans.set('already-banned', { user: { id: 'already-banned' } });

  await reconcileForceGuild(guild, db);
  await reconcileForeverBans(guild, db);

  assert.equal(target.roles.cache.has('blocked-role'), false);
  assert.equal(owner.roles.cache.has('global-role'), true);
  assert.equal(bot.roles.cache.has('global-role'), true);
  assert.equal(staff.roles.cache.has('stripstaff-role'), true);
  assert.equal(banRequests.length, 0);
  const log = db.connection.prepare('SELECT * FROM force_management_logs WHERE action = ?').get('FORCE ROLE STARTUP RECONCILIATION');
  assert.match(log.result, /no punishment during startup/);
});

test('concurrent vouches reserve the final limited-role slot', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('reservation-guild');
  t.after(() => db.close());
  addRole('limited-vouch-role');
  db.setSetting(guild.id, 'vouch_role_id', 'limited-vouch-role');
  db.setLimitedRole(guild.id, 'limited-vouch-role', 1);
  const giver = addMember('giver');
  db.addGiver(guild.id, giver.id);
  const first = addMember('first-recipient');
  const second = addMember('second-recipient');

  const results = await Promise.all([
    giveVouch(giver, first, 'first', db),
    giveVouch(giver, second, 'second', db)
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(db.getVouches(guild.id).length, 1);
  assert.equal(guild.roles.cache.get('limited-vouch-role').members.size, 1);
});

test('blacklisted members cannot receive vouches', async (t) => {
  const { db, guild, addMember } = createFixture('blacklist-guild');
  t.after(() => db.close());
  const giver = addMember('giver');
  const target = addMember('blacklisted');
  db.addGiver(guild.id, giver.id);
  db.addBlacklist(guild.id, target.id, 'owner', new Date().toISOString());

  const result = await giveVouch(giver, target, 'attempt', db);

  assert.equal(result.ok, false);
  assert.match(result.message, /blacklisted/);
  assert.equal(db.getVouch(guild.id, target.id), undefined);
});

test('owner and OS permission boundaries are enforced and help is paginated by permission', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('permissions-guild');
  t.after(() => db.close());
  const osRoleId = '111111111111111111';
  const vouchRoleId = '222222222222222222';
  addRole(osRoleId);
  addRole(vouchRoleId);
  const owner = addMember('owner');
  const os = addMember('os-user');
  const giver = addMember('giver');
  const regular = addMember('regular');
  const newGiver = addMember('333333333333333333');
  const commandTarget = addMember('666666666666666666');
  db.addOsUser(guild.id, os.id);
  db.addGiver(guild.id, giver.id);

  assert.equal(canGiveVouch(regular, db).allowed, false);
  assert.equal(canGiveVouch(giver, db).allowed, true);
  assert.equal(canGiveVouch(os, db).allowed, true);
  assert.equal(canGiveVouch(owner, db).allowed, true);

  async function mockMessage(member) {
    const replies = [];
    return {
      guild,
      member,
      author: { id: member.id },
      replies,
      async reply(options) { replies.push(options); return options; }
    };
  }

  const regularConfigMessage = await mockMessage(regular);
  await vouchCommands.execute(regularConfigMessage, ['setrole', `<@&${vouchRoleId}>`], db);
  await vouchCommands.execute(regularConfigMessage, ['addgiver', `<@${newGiver.id}>`], db);
  assert.equal(db.getSettings(guild.id).vouch_role_id, null, 'regular members cannot manage the vouch role');
  assert.equal(db.getGiver(guild.id, newGiver.id), undefined, 'regular members cannot authorize givers');

  const osMessage = await mockMessage(os);
  await adminCommands.setRole(osMessage, ['os', `<@&${osRoleId}>`], db);
  await vouchCommands.execute(osMessage, ['setrole', `<@&${vouchRoleId}>`], db);
  await vouchCommands.execute(osMessage, ['addgiver', `<@${newGiver.id}>`], db);
  assert.equal(db.getSettings(guild.id).os_role_id, null, 'OS cannot configure the OS role');
  assert.equal(db.getSettings(guild.id).vouch_role_id, vouchRoleId, 'OS can manage the vouch role');
  assert.ok(db.getGiver(guild.id, newGiver.id), 'OS can authorize vouch givers');
  db.setSetting(guild.id, 'vouch_role_id', null);
  db.removeGiver(guild.id, newGiver.id);

  const ownerMessage = await mockMessage(owner);
  await adminCommands.setRole(ownerMessage, ['os', `<@&${osRoleId}>`], db);
  await vouchCommands.execute(ownerMessage, ['setrole', `<@&${vouchRoleId}>`], db);
  await vouchCommands.execute(ownerMessage, ['addgiver', `<@${newGiver.id}>`], db);
  assert.equal(db.getSettings(guild.id).os_role_id, osRoleId);
  assert.equal(db.getSettings(guild.id).vouch_role_id, vouchRoleId);
  assert.equal(remainingVouches(guild.id, newGiver.id, db), 2);
  db.upsertForeverBan({
    guild_id: guild.id, user_id: 'panel-private-account', username: 'panel-user#0001', reason: 'panel-only reason',
    executor_id: owner.id, created_at: new Date().toISOString(), original_ban_status: 'not_banned'
  });

  const newGiverMessage = await mockMessage(newGiver);
  await vouchCommands.execute(newGiverMessage, ['give', `<@${commandTarget.id}>`, 'command reason'], db);
  assert.equal(db.getVouch(guild.id, commandTarget.id).giver_id, newGiver.id);
  assert.equal(db.getVouch(guild.id, commandTarget.id).reason, 'command reason');
  assert.equal(remainingVouches(guild.id, newGiver.id, db), 1);
  assert.deepEqual([...handlers.keys()].sort(), [
    'forcemanage', 'forcenickname', 'forcerolestrip', 'forcestrip', 'foreverban', 'foreverbanlist', 'fp',
    'limitedroles', 'rolestrip', 'setlimit', 'setlog', 'setrole', 'unforcenickname', 'unforcerolestrip',
    'unforcestrip', 'unforeverban', 'vouch', 'vouchblacklist', 'vouchcommands', 'vouchhelp', 'vouchlogsetup'
  ]);

  const helpDashboard = require('../src/commands/vouchCommands');
  t.after(() => helpDashboard.clearAllPanels());
  const commandsFor = (member) => helpDashboard.getEntries('all', member, db).map((entry) => entry.command).join('\n');

  const regularMessage = await mockMessage(regular);
  await helpCommand.execute(regularMessage, [], db);
  assert.equal(regularMessage.replies[0].embeds[0].data.title, 'Vouch Management');
  assert.ok(regularMessage.replies[0].components.length >= 2, '-vouchhelp opens the button dashboard');
  assert.doesNotMatch(commandsFor(regular), /-setrole|-vouch addgiver|-vouchblacklist/);

  const osHelpMessage = await mockMessage(os);
  await helpCommand.execute(osHelpMessage, [], db);
  const osCategoryButtons = osHelpMessage.replies[0].components.slice(1).flatMap((row) => row.components.map((button) => button.data.label));
  assert.ok(osCategoryButtons.includes('Blacklist'), 'OS sees the Blacklist category');
  const osCommands = commandsFor(os);
  assert.match(osCommands, /-vouchblacklist add/);
  assert.match(osCommands, /-forcemanage/);
  assert.match(osCommands, /-vouch addgiver/);
  assert.doesNotMatch(osCommands, /-setrole os|-vouch owner allow|-vouch reset/);
  assert.match(osCommands, /-foreverban @user/, 'OS has fake ban_members automatically');
  assert.doesNotMatch(commandsFor(regular), /-foreverban|-fp /);

  const ownerPageMessage = await mockMessage(owner);
  await helpCommand.execute(ownerPageMessage, ['2'], db);
  assert.equal(ownerPageMessage.replies[0].embeds[0].data.title, 'All Commands');
  assert.match(ownerPageMessage.replies[0].embeds[0].data.footer.text, /^Page 2\/\d+ /);
  const ownerEntries = helpDashboard.getEntries('all', owner, db);
  const expectedPages = Math.ceil(ownerEntries.length / helpDashboard.PAGE_SIZE);
  const pageCounts = [];
  for (let page = 1; page <= expectedPages; page += 1) {
    const pageMessage = await mockMessage(owner);
    await helpCommand.execute(pageMessage, [String(page)], db);
    pageCounts.push(pageMessage.replies[0].embeds[0].data.description.split('\n').length);
  }
  assert.ok(pageCounts.every((count) => count <= helpDashboard.PAGE_SIZE));
  assert.equal(pageCounts.reduce((sum, count) => sum + count, 0), ownerEntries.length);
  assert.match(commandsFor(owner), /-foreverban @user/);
  const privatePanels = [];
  const osPanelMessage = await mockMessage(os);
  osPanelMessage.author.send = async (payload) => { privatePanels.push(payload); };
  await forceCommands.execute(osPanelMessage, ['forcemanage'], db);
  assert.equal(privatePanels.length, 1);
  assert.ok(privatePanels[0].components.length);
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  let osBanPanel;
  await forceCommands.handleInteraction({
    customId: `force-panel-category:${guild.id}`,
    client,
    user: os.user,
    values: ['forever-bans'],
    async update(payload) { osBanPanel = payload; }
  }, db);
  assert.match(osBanPanel.embeds[0].data.description, /panel-private-account.*panel-only reason/);

  const ownerPanels = [];
  const ownerPanelMessage = await mockMessage(owner);
  ownerPanelMessage.author.send = async (payload) => { ownerPanels.push(payload); };
  await forceCommands.execute(ownerPanelMessage, ['forcemanage'], db);
  let ownerBanPanel;
  await forceCommands.handleInteraction({
    customId: `force-panel-category:${guild.id}`,
    client,
    user: owner.user,
    values: ['forever-bans'],
    async update(payload) { ownerBanPanel = payload; }
  }, db);
  assert.match(ownerBanPanel.embeds[0].data.description, /panel-private-account.*panel-only reason/);
});

test('over-limit manual role additions are reversed and stripstaff is removed from a human executor', async (t) => {
  const { db, guild, addRole, addMember, setAuditExecutor } = createFixture('limit-guild');
  t.after(() => db.close());
  addRole('limited-role');
  addRole('stripstaff-role');
  db.setLimitedRole(guild.id, 'limited-role', 1);
  db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
  const existing = addMember('existing', ['limited-role']);
  const target = addMember('target', ['limited-role']);
  const oldMember = { ...target, roles: { cache: new Collection() } };
  const executor = addMember('executor', ['stripstaff-role']);
  setAuditExecutor(target.id, 'limited-role', executor.user);

  await handleGuildMemberUpdate(oldMember, target, db);

  assert.equal(target.roles.cache.has('limited-role'), false);
  assert.equal(executor.roles.cache.has('stripstaff-role'), false);
  const event = db.connection.prepare('SELECT * FROM event_logs WHERE guild_id = ?').get(guild.id);
  assert.equal(event.event_type, 'ROLE LIMIT VIOLATION');
  assert.equal(event.executor_id, 'executor');
  assert.equal(event.affected_user_id, 'target');
  assert.equal(event.role_id, 'limited-role');
  assert.equal(event.punishment, 'STRIPSTAFF removed');
  assert.equal(existing.roles.cache.has('limited-role'), true);
});

test('unauthorized vouch-role addition is reversed', async (t) => {
  const { db, guild, addRole, addMember, setAuditExecutor } = createFixture('vouch-role-guild');
  t.after(() => db.close());
  addRole('vouch-role');
  addRole('stripstaff-role');
  db.setSetting(guild.id, 'vouch_role_id', 'vouch-role');
  db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
  const target = addMember('target', ['vouch-role']);
  const oldMember = { ...target, roles: { cache: new Collection() } };
  const executor = addMember('executor', ['stripstaff-role']);
  setAuditExecutor(target.id, 'vouch-role', executor.user);

  await handleGuildMemberUpdate(oldMember, target, db);

  assert.equal(target.roles.cache.has('vouch-role'), false);
  assert.equal(executor.roles.cache.has('stripstaff-role'), false);
  const event = db.connection.prepare('SELECT * FROM event_logs WHERE guild_id = ?').get(guild.id);
  assert.equal(event.executor_id, executor.id);
  assert.equal(event.affected_user_id, target.id);
  assert.equal(event.role_id, 'vouch-role');
  assert.equal(event.punishment, 'STRIPSTAFF removed');
  assert.ok(event.created_at);
});

test('vouch take reports failed role cleanup instead of claiming full success', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('take-permission-guild');
  t.after(() => db.close());
  addRole('vouch-role');
  db.setSetting(guild.id, 'vouch_role_id', 'vouch-role');
  const giver = addMember('444444444444444444');
  const recipient = addMember('555555555555555555', ['vouch-role']);
  db.addGiver(guild.id, giver.id);
  db.addVouch(guild.id, recipient.id, giver.id, 'original', new Date().toISOString());
  recipient.roles.remove = async () => {
    const error = new Error('Missing Permissions');
    error.code = 50013;
    throw error;
  };
  const replies = [];
  const message = {
    guild,
    member: giver,
    author: { id: giver.id },
    async reply(options) { replies.push(options); return options; }
  };

  await vouchCommands.execute(message, ['take', `<@${recipient.id}>`, 'retracted'], db);

  assert.equal(db.getVouch(guild.id, recipient.id), undefined);
  assert.equal(recipient.roles.cache.has('vouch-role'), true);
  assert.equal(replies[0].embeds[0].data.title, 'Role cleanup incomplete');
  assert.match(replies[0].embeds[0].data.description, /Manage Roles and role hierarchy/);
});

test('role permission failures are logged and missing audit access never punishes an unknown executor', async (t) => {
  const { db, guild, addRole, addMember, setAuditExecutor } = createFixture('manage-permission-guild');
  t.after(() => db.close());
  addRole('limited-role');
  addRole('stripstaff-role');
  db.setLimitedRole(guild.id, 'limited-role', 0);
  db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
  const target = addMember('target', ['limited-role']);
  const oldMember = { ...target, roles: { cache: new Collection() } };
  const executor = addMember('executor', ['stripstaff-role']);
  setAuditExecutor(target.id, 'limited-role', executor.user);
  const sent = [];
  guild.channels.cache.set('log-channel', {
    isTextBased: () => true,
    async send(payload) { sent.push(payload); }
  });
  db.setSetting(guild.id, 'log_channel_id', 'log-channel');
  target.roles.remove = async () => {
    const error = new Error('Missing Permissions');
    error.code = 50013;
    throw error;
  };

  await handleGuildMemberUpdate(oldMember, target, db);

  const manageEvent = db.connection.prepare('SELECT * FROM event_logs WHERE guild_id = ?').get(guild.id);
  assert.match(manageEvent.action_taken, /Role removal failed/);
  assert.equal(manageEvent.punishment, 'STRIPSTAFF removed');
  assert.equal(executor.roles.cache.has('stripstaff-role'), false);
  assert.deepEqual(sent[0].allowedMentions.parse, []);
  assert.equal(sent[0].embeds[0].data.fields.find((field) => field.name === 'Who').value, '<@executor>');
  assert.ok(sent[0].embeds[0].data.timestamp);

  const auditFixture = createFixture('audit-permission-guild');
  t.after(() => auditFixture.db.close());
  auditFixture.addRole('limited-role');
  auditFixture.addRole('stripstaff-role');
  auditFixture.db.setLimitedRole(auditFixture.guild.id, 'limited-role', 0);
  auditFixture.db.setSetting(auditFixture.guild.id, 'stripstaff_role_id', 'stripstaff-role');
  const auditTarget = auditFixture.addMember('audit-target', ['limited-role']);
  const auditOldMember = { ...auditTarget, roles: { cache: new Collection() } };
  const auditExecutor = auditFixture.addMember('audit-executor', ['stripstaff-role']);
  const auditEmbeds = [];
  auditFixture.guild.channels.cache.set('audit-log-channel', {
    isTextBased: () => true,
    async send(payload) { auditEmbeds.push(payload); }
  });
  auditFixture.db.setSetting(auditFixture.guild.id, 'log_channel_id', 'audit-log-channel');
  auditFixture.guild.fetchAuditLogs = async () => {
    const error = new Error('Missing Permissions');
    error.code = 50013;
    throw error;
  };

  await handleGuildMemberUpdate(auditOldMember, auditTarget, auditFixture.db);

  const auditEvent = auditFixture.db.connection.prepare('SELECT * FROM event_logs WHERE guild_id = ?').get(auditFixture.guild.id);
  assert.equal(auditTarget.roles.cache.has('limited-role'), false);
  assert.equal(auditEvent.executor_id, null);
  assert.equal(auditEvent.punishment, 'None (executor unverified)');
  assert.match(auditEvent.reason, /Audit log unavailable/);
  assert.equal(auditExecutor.roles.cache.has('stripstaff-role'), true);
  assert.deepEqual(auditEmbeds[0].allowedMentions.parse, []);
  assert.equal(auditEmbeds[0].embeds[0].data.fields.find((field) => field.name === 'Who').value, 'Unknown');
  assert.equal(auditEmbeds[0].embeds[0].data.fields.find((field) => field.name === 'Target').value, '<@audit-target>');
});

test('startup reconciliation removes invalid roles without logging punishment', async (t) => {
  const { db, guild, addRole, addMember, setAuditExecutor } = createFixture('startup-guild');
  t.after(() => db.close());
  addRole('vouch-role');
  addRole('limited-role');
  addRole('stripstaff-role');
  db.setSetting(guild.id, 'vouch_role_id', 'vouch-role');
  db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
  db.setLimitedRole(guild.id, 'limited-role', 0);
  const invalid = addMember('invalid-vouch', ['vouch-role']);
  const overLimit = addMember('over-limit', ['limited-role', 'stripstaff-role']);
  const startupActor = addMember('startup-actor');
  setAuditExecutor(overLimit.id, 'limited-role', startupActor.user);

  await reconcileGuild(guild, db);

  assert.equal(invalid.roles.cache.has('vouch-role'), false);
  assert.equal(overLimit.roles.cache.has('limited-role'), false);
  assert.equal(overLimit.roles.cache.has('stripstaff-role'), true);
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS count FROM event_logs').get().count, 0);
});

test('Guild Owner, OS, and bot executors are exempt from stripstaff punishment', async (t) => {
  for (const [kind, executorId, bot] of [['owner', 'owner', false], ['os', 'os-user', false], ['bot', 'bot-user', true]]) {
    const { db, guild, addRole, addMember, setAuditExecutor } = createFixture(`exempt-${kind}`);
    t.after(() => db.close());
    addRole('limited-role');
    addRole('stripstaff-role');
    db.setLimitedRole(guild.id, 'limited-role', 0);
    db.setSetting(guild.id, 'stripstaff_role_id', 'stripstaff-role');
    if (kind === 'os') db.addOsUser(guild.id, executorId);
    const target = addMember('target', ['limited-role']);
    const oldMember = { ...target, roles: { cache: new Collection() } };
    const executor = addMember(executorId, ['stripstaff-role'], bot);
    setAuditExecutor(target.id, 'limited-role', executor.user);

    await handleGuildMemberUpdate(oldMember, target, db);

    assert.equal(target.roles.cache.has('limited-role'), false, `${kind} violation must be reversed`);
    assert.equal(executor.roles.cache.has('stripstaff-role'), true, `${kind} executor must be exempt`);
  }
});