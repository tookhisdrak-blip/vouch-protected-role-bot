const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { createDatabase } = require('../src/database');
const { giveVouch } = require('../src/services/vouches');
const { handleGuildMemberAdd, handleGuildMemberUpdate } = require('../src/services/roleProtection');
const { handleMessageCreate, handleMessageUpdate, handlers } = require('../src/events/messageCreate');
const vouchCommand = require('../src/commands/vouch');
const { catalog, execute: executeHelp } = require('../src/commands/help');
const dashboard = require('../src/commands/vouchCommands');
const { registeredCatalog } = dashboard;
test.after(() => dashboard.clearAllPanels());
const adminCommands = require('../src/commands/admin');
const { createForcedRoleStrip, handleForceMemberUpdate } = require('../src/services/forceRules');

const OWNER_ID = '100000000000000001';

function createFixture(guildId = '200000000000000001') {
  const db = createDatabase(':memory:');
  db.ensureGuild(guildId);
  const guild = {
    id: guildId,
    ownerId: OWNER_ID,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    async fetchAuditLogs() {
      return { entries: new Collection(this.auditEntries || []) };
    },
    bans: {
      async fetch() {
        const error = new Error('Unknown Ban');
        error.code = 10026;
        throw error;
      }
    }
  };

  function addRole(roleId, permissions = []) {
    const role = {
      id: roleId,
      name: roleId,
      guild,
      permissions: { has: (permission) => permissions.includes(permission) }
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
      user: { id, bot, username: id, tag: `${id}#0001` },
      roles: {
        cache: new Collection(),
        async add(roleId) {
          member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
        },
        async remove(roleId) {
          member.roles.cache.delete(roleId);
        }
      }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
    guild.members.cache.set(id, member);
    return member;
  }

  guild.members.fetch = async (id) => (id ? guild.members.cache.get(id) || null : guild.members.cache);
  return { db, guild, addRole, addMember };
}

function makeMessage(guild, member, content) {
  const replies = [];
  return {
    guild,
    member,
    author: member.user,
    content,
    replies,
    async reply(payload) {
      replies.push(payload);
      return payload;
    }
  };
}

async function dispatchEditedCommand(db, guild, member, content, previousContent = 'not a command') {
  const message = makeMessage(guild, member, content);
  await handleMessageUpdate(
    { content: previousContent },
    message,
    { guilds: { cache: new Collection([[guild.id, guild]]) } },
    db,
    '-'
  );
  return message;
}

test('Guild Owner vouch commands run from edited messages and preserve vouches when authorization/config changes', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('edited-command-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000001';
  const rewardRole = '300000000000000002';
  const stripstaffRole = '300000000000000003';
  addRole(vouchRole);
  addRole(rewardRole);
  addRole(stripstaffRole);
  const owner = addMember(OWNER_ID);
  const giver = addMember('400000000000000001');
  const recipient = addMember('400000000000000002');
  const staleRoleHolder = addMember('400000000000000003', [vouchRole]);
  db.setLimitedRole(guild.id, vouchRole, 3);

  assert.equal(handlers.has('vouch'), true);
  for (const command of [
    '-vouch setrole @role',
    '-vouch unsetrole',
    '-vouch addgiver @user',
    '-vouch removegiver @user',
    '-vouch limit [number]',
    '-vouch limit @user [number]',
    '-vouch limit remove @user',
    '-vouch wipeall',
    '-vouch setreward @role'
  ]) {
    assert.ok(catalog.some((entry) => entry.command === command), `${command} should appear in help`);
    assert.ok(registeredCatalog().some((entry) => entry.command === command), `${command} should appear in vouchcommands`);
  }

  await dispatchEditedCommand(db, guild, owner, `-vouch setrole <@&${vouchRole}>`);
  assert.equal(db.getSettings(guild.id).vouch_role_id, vouchRole);
  assert.equal(staleRoleHolder.roles.cache.has(vouchRole), false);

  await dispatchEditedCommand(db, guild, owner, `-vouch setreward <@&${rewardRole}>`);
  await dispatchEditedCommand(db, guild, owner, `-vouch addgiver <@${giver.id}>`);
  assert.equal(db.getGiver(guild.id, giver.id).custom_limit, null);
  assert.equal(db.getSettings(guild.id).default_giver_limit, 2);
  assert.equal(require('../src/services/permissions').remainingVouches(guild.id, giver.id, db), 2);

  await dispatchEditedCommand(db, guild, owner, '-vouch limit 4');
  assert.equal(db.getSettings(guild.id).default_giver_limit, 4);
  await dispatchEditedCommand(db, guild, owner, `-vouch limit <@${giver.id}> 5`);
  assert.equal(db.getGiver(guild.id, giver.id).custom_limit, 5);

  const giveMessage = makeMessage(guild, giver, `-vouch give <@${recipient.id}> preserved`);
  await handleMessageCreate(giveMessage, {}, db, '-');
  assert.equal(db.getVouch(guild.id, recipient.id).giver_id, giver.id);
  assert.equal(recipient.roles.cache.has(vouchRole), true);
  assert.equal(recipient.roles.cache.has(rewardRole), true);

  await dispatchEditedCommand(db, guild, owner, `-vouch limit remove <@${giver.id}>`);
  assert.equal(db.getGiver(guild.id, giver.id).custom_limit, null);
  assert.equal(require('../src/services/permissions').remainingVouches(guild.id, giver.id, db), 3);
  await dispatchEditedCommand(db, guild, owner, `-vouch removegiver <@${giver.id}>`);
  assert.equal(db.getGiver(guild.id, giver.id), undefined);
  assert.ok(db.getVouch(guild.id, recipient.id), 'removing giver authorization must preserve existing vouches');
  const nowUnauthorized = addMember('400000000000000004');
  assert.equal((await giveVouch(giver, nowUnauthorized, 'unauthorized', db)).message, 'You are not authorized to give vouches.');
  assert.equal(db.getVouch(guild.id, nowUnauthorized.id), undefined);

  await dispatchEditedCommand(db, guild, owner, '-vouch unsetrole');
  assert.equal(db.getSettings(guild.id).vouch_role_id, null);
  assert.equal(db.getLimitedRole(guild.id, vouchRole).member_limit, 3);
  assert.equal(db.getSettings(guild.id).reward_role_id, rewardRole);
  assert.ok(db.getVouch(guild.id, recipient.id), 'unsetting the role must not delete active vouches');

  await dispatchEditedCommand(db, guild, owner, '-vouch limit 2');
  const invalidLimit = await dispatchEditedCommand(db, guild, owner, '-vouch limit 2.5');
  assert.match(invalidLimit.replies[0].embeds[0].data.description, /whole number/);
});

test('giver limits reject third and concurrent excess vouches, punish staff, and keep Owner/OS exempt but capped', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('giver-limit-guild');
  t.after(() => db.close());
  const stripstaffRole = '300000000000000010';
  const vouchRole = '300000000000000011';
  const rewardRole = '300000000000000012';
  addRole(stripstaffRole, [PermissionFlagsBits.ManageRoles]);
  addRole(vouchRole);
  addRole(rewardRole);
  db.setSetting(guild.id, 'stripstaff_role_id', stripstaffRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'reward_role_id', rewardRole);

  const staffRole = '300000000000000013';
  const cosmeticRole = '300000000000000014';
  addRole(staffRole, [PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers]);
  addRole(cosmeticRole);
  const giver = addMember('400000000000000010', [stripstaffRole, staffRole, cosmeticRole]);
  db.addGiver(guild.id, giver.id);
  const targets = [
    addMember('400000000000000011'),
    addMember('400000000000000012'),
    addMember('400000000000000013'),
    addMember('400000000000000018')
  ];
  const simultaneous = await Promise.all(targets.map((target) => giveVouch(giver, target, 'limit test', db)));
  assert.equal(simultaneous.filter((result) => result.ok).length, 2);
  assert.equal(db.getVouches(guild.id).length, 2);
  assert.equal(simultaneous.find((result) => !result.ok).message,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');
  assert.equal(giver.roles.cache.has(stripstaffRole), false);
  assert.equal(giver.roles.cache.has(staffRole), false, 'all staff-permission roles should be removed');
  assert.equal(giver.roles.cache.has(cosmeticRole), true, 'cosmetic roles must be preserved');
  assert.equal(db.getVouch(guild.id, targets[2].id), undefined);
  assert.equal(targets[2].roles.cache.has(vouchRole), false);
  assert.equal(targets[2].roles.cache.has(rewardRole), false);
  const exhaustedReply = makeMessage(guild, giver, '-vouch give <@400000000000000018>');
  await vouchCommand.execute(exhaustedReply, ['give', `<@${targets[3].id}>`], db);
  assert.equal(exhaustedReply.replies[0].embeds[0].data.description,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');

  const owner = addMember(OWNER_ID, [stripstaffRole, staffRole, cosmeticRole]);
  db.addGiver(guild.id, owner.id);
  db.setGiverLimit(guild.id, owner.id, 1);
  const ownerFirst = addMember('400000000000000014');
  const ownerSecond = addMember('400000000000000015');
  assert.equal((await giveVouch(owner, ownerFirst, 'owner one', db)).ok, true);
  assert.equal((await giveVouch(owner, ownerSecond, 'owner over limit', db)).message,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');
  assert.equal(owner.roles.cache.has(stripstaffRole), true);

  assert.equal(owner.roles.cache.has(staffRole), true);
  assert.equal(owner.roles.cache.has(cosmeticRole), true);
  assert.equal(db.getVouch(guild.id, ownerSecond.id), undefined);
  assert.equal(ownerSecond.roles.cache.has(vouchRole), false);
  assert.equal(ownerSecond.roles.cache.has(rewardRole), false);

  const os = addMember('400000000000000016', [stripstaffRole, staffRole, cosmeticRole]);
  db.addOsUser(guild.id, os.id);
  db.addGiver(guild.id, os.id);
  db.setGiverLimit(guild.id, os.id, 0);
  const osTarget = addMember('400000000000000017');
  assert.equal((await giveVouch(os, osTarget, 'OS over limit', db)).message,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');
  assert.equal(os.roles.cache.has(stripstaffRole), true);
  assert.equal(os.roles.cache.has(staffRole), true);
  assert.equal(os.roles.cache.has(cosmeticRole), true);
  assert.equal(db.getVouch(guild.id, osTarget.id), undefined);
  assert.equal(osTarget.roles.cache.has(vouchRole), false);
  assert.equal(osTarget.roles.cache.has(rewardRole), false);

  const events = db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'VOUCH LIMIT VIOLATION' AND executor_id = ? ORDER BY id").all(giver.id);
  assert.ok(events.some((event) => event.punishment === 'STRIPSTAFF removed'));
});

test('OS members get five vouches by default and Guild Owner can adjust or restore an OS allowance', async (t) => {
  const { db, guild, addMember } = createFixture('os-vouch-allowance-guild');
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const os = addMember('400000000000000060');
  db.addOsUser(guild.id, os.id);
  assert.equal(db.getGiver(guild.id, os.id), undefined, 'OS authorization must not require or create manual giver authorization');
  assert.equal(require('../src/services/permissions').remainingVouches(guild.id, os.id, db, os), 5);

  const targets = Array.from({ length: 6 }, (_, index) => addMember(`40000000000000007${index}`));
  for (const target of targets.slice(0, 5)) {
    assert.equal((await giveVouch(os, target, 'OS default allowance', db)).ok, true);
  }
  assert.equal((await giveVouch(os, targets[5], 'OS sixth vouch', db)).message,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');
  assert.equal(db.getVouch(guild.id, targets[5].id), undefined);

  const limitMessage = makeMessage(guild, owner, `-vouch limit <@${os.id}> 7`);
  await vouchCommand.execute(limitMessage, ['limit', `<@${os.id}>`, '7'], db);
  assert.equal(db.getOsVouchLimit(guild.id, os.id), 7);
  assert.equal(require('../src/services/permissions').remainingVouches(guild.id, os.id, db, os), 2);

  const removeMessage = makeMessage(guild, owner, `-vouch limit remove <@${os.id}>`);
  await vouchCommand.execute(removeMessage, ['limit', 'remove', `<@${os.id}>`], db);
  assert.equal(db.getOsVouchLimit(guild.id, os.id), null);
  assert.equal(require('../src/services/permissions').remainingVouches(guild.id, os.id, db, os), 0);

  const osRoleId = '300000000000000062';
  const osRole = guild.roles.cache.get(osRoleId) || { id: osRoleId, name: osRoleId, permissions: { has: () => false } };
  guild.roles.cache.set(osRoleId, osRole);
  db.setSetting(guild.id, 'os_role_id', osRoleId);
  const roleOs = addMember('400000000000000080', [osRoleId]);
  assert.equal(require('../src/services/permissions').remainingVouches(guild.id, roleOs.id, db, roleOs), 5);
});

test('invalid vouch role is removed on joins and later role-state updates, with normal-staff punishment', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('vouch-role-enforcement-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000020';
  const stripstaffRole = '300000000000000021';
  addRole(vouchRole);
  addRole(stripstaffRole, [PermissionFlagsBits.ManageRoles]);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'stripstaff_role_id', stripstaffRole);

  const joinedMember = addMember('400000000000000020', [vouchRole]);
  guild.auditEntries = [['join-audit', {
    targetId: joinedMember.id,
    executor: { id: '400000000000000025', bot: true },
    changes: [{ key: '$add', new: [{ id: vouchRole }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberAdd(joinedMember, db);
  assert.equal(joinedMember.roles.cache.has(vouchRole), false);

  const owner = addMember(OWNER_ID, [stripstaffRole]);
  const os = addMember('400000000000000021', [stripstaffRole]);
  db.addOsUser(guild.id, os.id);
  const changedMember = addMember('400000000000000022', [vouchRole]);
  const oldMember = { ...changedMember, roles: { cache: new Collection() } };
  guild.auditEntries = [['owner-audit', {
    targetId: changedMember.id,
    executor: owner.user,
    changes: [{ key: '$add', new: [{ id: vouchRole }] }],
    createdTimestamp: Date.now()
  }]];

  await handleGuildMemberUpdate(oldMember, changedMember, db);
  assert.equal(changedMember.roles.cache.has(vouchRole), false);
  assert.equal(owner.roles.cache.has(stripstaffRole), true);

  const ownerTarget = addMember(OWNER_ID);
  const oldOwner = { ...ownerTarget, roles: { cache: new Collection() } };
  guild.auditEntries = [['owner-target-vouch', {
    targetId: ownerTarget.id,
    executor: os.user,
    changes: [{ key: '$add', new: [{ id: vouchRole }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberUpdate(oldOwner, ownerTarget, db);
  assert.equal(ownerTarget.roles.cache.has(vouchRole), false, 'Guild Owner still requires an active vouch to keep the vouch role');
  assert.equal(os.roles.cache.has(stripstaffRole), true, 'OS executor is exempt from punishment');

  const manualTarget = addMember('400000000000000023', [vouchRole]);
  const unrelatedRoleId = '300000000000000022';
  addRole(unrelatedRoleId);
  const oldManualMember = {
    ...manualTarget,
    roles: { cache: new Collection([[vouchRole, guild.roles.cache.get(vouchRole)]]) }
  };
  manualTarget.roles.cache.set(unrelatedRoleId, guild.roles.cache.get(unrelatedRoleId));
  const actor = addMember('400000000000000024', [stripstaffRole]);
  guild.auditEntries = [['staff-audit', {
    targetId: manualTarget.id,
    executor: actor.user,
    changes: [{ key: '$add', new: [{ id: vouchRole }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberUpdate(oldManualMember, manualTarget, db);
  assert.equal(manualTarget.roles.cache.has(vouchRole), false);
  assert.equal(actor.roles.cache.has(stripstaffRole), false);
  assert.equal(os.roles.cache.has(stripstaffRole), true);
});

test('failed role assignment rolls back its vouch and newly assigned roles while preserving a pre-existing reward role', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('vouch-rollback-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000030';
  const rewardRole = '300000000000000031';
  addRole(vouchRole);
  addRole(rewardRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'reward_role_id', rewardRole);
  const giver = addMember('400000000000000030');
  db.addGiver(guild.id, giver.id);
  const target = addMember('400000000000000031', [rewardRole]);
  target.roles.add = async (roleId) => {
    target.roles.cache.set(roleId, guild.roles.cache.get(roleId));
    if (roleId === vouchRole) throw new Error('simulated API failure after role mutation');
  };

  const result = await giveVouch(giver, target, 'rollback', db);

  assert.equal(result.ok, false);
  assert.equal(db.getVouch(guild.id, target.id), undefined);
  assert.equal(target.roles.cache.has(vouchRole), false);
  assert.equal(target.roles.cache.has(rewardRole), true);
});

test('wipeall removes vouches and their configured roles without clearing other SQLite state', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('wipeall-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000040';
  const rewardRole = '300000000000000041';
  const stripstaffRole = '300000000000000042';
  addRole(vouchRole);
  addRole(rewardRole);
  addRole(stripstaffRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'reward_role_id', rewardRole);
  db.setSetting(guild.id, 'stripstaff_role_id', stripstaffRole);
  db.setSetting(guild.id, 'default_giver_limit', 6);
  const owner = addMember(OWNER_ID);
  const giver = addMember('400000000000000040');
  const firstRecipient = addMember('400000000000000041');
  const secondRecipient = addMember('400000000000000042');
  db.addGiver(guild.id, giver.id);
  db.addOsUser(guild.id, '400000000000000043');
  db.addBlacklist(guild.id, '400000000000000044', owner.id, new Date().toISOString());
  db.setLimitedRole(guild.id, '400000000000000045', 9);
  assert.equal((await giveVouch(giver, firstRecipient, 'one', db)).ok, true);
  assert.equal((await giveVouch(giver, secondRecipient, 'two', db)).ok, true);

  const message = makeMessage(guild, owner, '-vouch wipeall');
  await handleMessageCreate(message, {}, db, '-');

  assert.equal(db.getVouches(guild.id).length, 0);
  for (const member of [firstRecipient, secondRecipient]) {
    assert.equal(member.roles.cache.has(vouchRole), false);
    assert.equal(member.roles.cache.has(rewardRole), false);
  }
  assert.ok(db.getGiver(guild.id, giver.id));
  assert.deepEqual(db.getOsUsers(guild.id), ['400000000000000043']);
  assert.equal(db.getBlacklist(guild.id)[0].user_id, '400000000000000044');
  assert.equal(db.getLimitedRole(guild.id, '400000000000000045').member_limit, 9);
  assert.equal(db.getSettings(guild.id).vouch_role_id, vouchRole);
  assert.equal(db.getSettings(guild.id).reward_role_id, rewardRole);
  assert.equal(db.getSettings(guild.id).stripstaff_role_id, stripstaffRole);
  assert.equal(db.getSettings(guild.id).default_giver_limit, 6);
  assert.ok(db.connection.prepare('SELECT COUNT(*) AS count FROM event_logs WHERE guild_id = ?').get(guild.id).count >= 3);
});

test('wipeall reports role cleanup failures after clearing only active vouches', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('wipeall-cleanup-failure-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000046';
  const rewardRole = '300000000000000047';
  addRole(vouchRole);
  addRole(rewardRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'reward_role_id', rewardRole);
  const owner = addMember(OWNER_ID);
  const giver = addMember('400000000000000046');
  const recipient = addMember('400000000000000047');
  db.addGiver(guild.id, giver.id);
  assert.equal((await giveVouch(giver, recipient, 'wipe failure', db)).ok, true);
  recipient.roles.remove = async (roleId) => {
    if (roleId === vouchRole) throw new Error('simulated missing permission');
    recipient.roles.cache.delete(roleId);
  };

  const message = makeMessage(guild, owner, '-vouch wipeall');
  await handleMessageCreate(message, {}, db, '-');

  assert.equal(db.getVouches(guild.id).length, 0);
  assert.equal(recipient.roles.cache.has(vouchRole), true);
  assert.equal(recipient.roles.cache.has(rewardRole), false);
  assert.equal(message.replies[0].embeds[0].data.title, 'Role cleanup incomplete');
  assert.match(message.replies[0].embeds[0].data.description, /role cleanup failed for 1 assignment/);
});

test('vouch configuration, giver limits, existing vouches, and history survive reopening SQLite', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-commands-'));
  const databasePath = path.join(directory, 'state.sqlite');
  let connection;
  t.after(() => {
    if (connection) connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  connection = createDatabase(databasePath);
  connection.ensureGuild('persistent-command-guild');
  connection.setSetting('persistent-command-guild', 'vouch_role_id', '300000000000000050');
  connection.setSetting('persistent-command-guild', 'reward_role_id', '300000000000000051');
  connection.setSetting('persistent-command-guild', 'default_giver_limit', 7);
  connection.addGiver('persistent-command-guild', '400000000000000050');
  connection.setGiverLimit('persistent-command-guild', '400000000000000050', 4);
  connection.addOsUser('persistent-command-guild', '400000000000000053');
  connection.setOsVouchLimit('persistent-command-guild', '400000000000000053', 8);
  connection.addVouch('persistent-command-guild', '400000000000000051', '400000000000000050', 'preserve me', '2026-09-30T00:00:00.000Z');
  connection.setLimitedRole('persistent-command-guild', '300000000000000052', 12);
  connection.addEventLog({
    guild_id: 'persistent-command-guild',
    event_type: 'PERSISTENCE CHECK',
    executor_id: '400000000000000050',
    affected_user_id: '400000000000000051',
    role_id: null,
    reason: null,
    action_taken: 'Preserved',
    punishment: null,
    created_at: '2026-09-30T00:00:00.000Z'
  });
  connection.close();
  connection = null;

  connection = createDatabase(databasePath);
  assert.equal(connection.getSettings('persistent-command-guild').vouch_role_id, '300000000000000050');
  assert.equal(connection.getSettings('persistent-command-guild').reward_role_id, '300000000000000051');
  assert.equal(connection.getSettings('persistent-command-guild').default_giver_limit, 7);
  assert.equal(connection.getGiver('persistent-command-guild', '400000000000000050').custom_limit, 4);
  assert.equal(connection.getOsVouchLimit('persistent-command-guild', '400000000000000053'), 8);
  assert.equal(connection.getVouch('persistent-command-guild', '400000000000000051').reason, 'preserve me');
  assert.equal(connection.getLimitedRole('persistent-command-guild', '300000000000000052').member_limit, 12);
  assert.equal(connection.connection.prepare("SELECT COUNT(*) AS count FROM event_logs WHERE event_type = 'PERSISTENCE CHECK'").get().count, 1);
});

test('Guild Owner help remains registered for all requested vouch commands', async (t) => {
  const { db, guild, addMember } = createFixture('vouch-help-guild');
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const helpPages = [];
  for (const category of ['givers', 'roles', 'admin', 'limited']) {
    const message = makeMessage(guild, owner, `-vouchhelp ${category}`);
    await executeHelp(message, [category], db);
    assert.match(message.replies[0].embeds[0].data.footer.text, /^Page 1\//);
    assert.ok(message.replies[0].components.length >= 2, 'category help opens with navigation buttons');
    helpPages.push(dashboard.getEntries(category, owner, db).map((entry) => entry.command).join('\n'));
  }
  const helpText = helpPages.join('\n');
  for (const command of ['-vouch setrole', '-vouch unsetrole', '-vouch setreward', '-vouch addgiver', '-vouch removegiver', '-vouch limit', '-vouch wipeall', '-setlimit']) {
    assert.ok(helpText.includes(command), `${command} should appear on a -vouchhelp category page`);
  }
  for (const command of ['setrole', 'unsetrole', 'setreward', 'addgiver', 'removegiver', 'limit', 'wipeall']) {
    assert.ok(catalog.some((entry) => entry.command.startsWith(`-vouch ${command}`)), `${command} should be catalogued`);
  }
  assert.match(helpText, /-vouch setrole/);
});

test('setlimit accepts role mentions and IDs, persists independently, and limitedroles shows refreshed counts', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('limited-role-command-guild');
  t.after(() => db.close());
  const mentionedRoleId = '300000000000000060';
  const idRoleId = '300000000000000061';
  const owner = addMember(OWNER_ID);
  addRole(mentionedRoleId);
  addRole(idRoleId);
  db.setSetting(guild.id, 'vouch_role_id', mentionedRoleId);
  for (let index = 0; index < 12; index += 1) addMember(`4000000000000001${String(index).padStart(2, '0')}`, [mentionedRoleId]);
  const ownerMessage = makeMessage(guild, owner, `-setlimit <@&${mentionedRoleId}> 20`);

  await handleMessageCreate(ownerMessage, {}, db, '-');
  assert.equal(db.getLimitedRole(guild.id, mentionedRoleId).member_limit, 20);
  assert.equal(db.getSettings(guild.id).vouch_role_id, mentionedRoleId, 'setlimit must not alter vouch-role configuration');

  const rawIdMessage = makeMessage(guild, owner, `-setlimit ${idRoleId} 10`);
  await handleMessageCreate(rawIdMessage, {}, db, '-');
  assert.equal(db.getLimitedRole(guild.id, idRoleId).member_limit, 10);
  assert.equal(db.getSettings(guild.id).vouch_role_id, mentionedRoleId);
  assert.equal(handlers.has('setlimit'), true);
  assert.ok(catalog.some((entry) => entry.command === '-setlimit @role|ROLE_ID number'));

  const countMessage = makeMessage(guild, owner, '-limitedroles');
  await handleMessageCreate(countMessage, {}, db, '-');
  const description = countMessage.replies[0].embeds[0].data.description;
  assert.match(description, new RegExp(`<@&${mentionedRoleId}> — members on this role: 12/20 \\(LIMITED\\)`));
  assert.match(description, new RegExp(`<@&${idRoleId}> — members on this role: 0/10 \\(LIMITED\\)`));

  const invalidMessage = makeMessage(guild, owner, '-setlimit nonexistent 4');
  await handleMessageCreate(invalidMessage, {}, db, '-');
  assert.equal(db.getLimitedRoles(guild.id).length, 2);
  const invalidNumber = makeMessage(guild, owner, `-setlimit ${idRoleId} 2.5`);
  await handleMessageCreate(invalidNumber, {}, db, '-');
  assert.equal(db.getLimitedRole(guild.id, idRoleId).member_limit, 10);
});

test('end-to-end setlimit rejects the 21st member, punishes only verified staff roles, and displays 20/20', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('limited-role-live-enforcement-guild');
  t.after(() => db.close());
  const roleId = '300000000000000065';
  const configuredStripstaffRole = '300000000000000066';
  const staffPermissionRole = '300000000000000067';
  const cosmeticRole = '300000000000000068';
  addRole(roleId);
  addRole(configuredStripstaffRole);
  addRole(staffPermissionRole, [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ModerateMembers]);
  addRole(cosmeticRole);
  db.setSetting(guild.id, 'stripstaff_role_id', configuredStripstaffRole);

  const owner = addMember(OWNER_ID);
  for (let index = 0; index < 20; index += 1) {
    addMember(`4000000000000003${String(index).padStart(2, '0')}`, [roleId]);
  }
  const configure = makeMessage(guild, owner, `-setlimit <@&${roleId}> 20`);
  await handleMessageCreate(configure, {}, db, '-');
  assert.equal(db.getLimitedRole(guild.id, roleId).member_limit, 20);
  assert.equal(guild.roles.cache.get(roleId).members.size, 20);

  const executor = addMember('400000000000000399', [configuredStripstaffRole, staffPermissionRole, cosmeticRole]);
  const twentyFirst = addMember('400000000000000398', [roleId]);
  const previousMember = { ...twentyFirst, roles: { cache: new Collection() } };
  guild.auditEntries = [['twenty-first-add', {
    id: 'twenty-first-add',
    targetId: twentyFirst.id,
    executor: executor.user,
    changes: [{ key: '$add', new: [{ id: roleId }] }],
    createdTimestamp: Date.now()
  }]];
  assert.equal(guild.roles.cache.get(roleId).members.size, 21);

  await require('../src/events/guildMemberUpdate').handleMemberUpdate(previousMember, twentyFirst, db);

  assert.equal(twentyFirst.roles.cache.has(roleId), false, 'the member causing 21/20 must lose the limited role');
  assert.equal(guild.roles.cache.get(roleId).members.size, 20);
  assert.equal(executor.roles.cache.has(staffPermissionRole), false, 'verified normal executor loses moderation roles');
  assert.equal(executor.roles.cache.has(cosmeticRole), true, 'non-staff role remains');
  assert.equal(executor.roles.cache.has(configuredStripstaffRole), true, 'marker role without staff permissions remains');
  const countMessage = makeMessage(guild, owner, '-limitedroles');
  await handleMessageCreate(countMessage, {}, db, '-');
  assert.match(countMessage.replies[0].embeds[0].data.description,
    new RegExp(`<@&${roleId}> — members on this role: 20/20 \\(LIMITED\\)`));
  const event = db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'ROLE LIMIT VIOLATION'").get();
  assert.equal(event.executor_id, executor.id);
  assert.equal(event.affected_user_id, twentyFirst.id);
  assert.equal(event.punishment, 'STRIPSTAFF removed');
});

test('limitedroles includes every configured role across compact pages and handles an empty configuration', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('limited-role-list-pages-guild');
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const configuredRoleIds = [];
  for (let index = 0; index < 100; index += 1) {
    const roleId = String(300000000000001000n + BigInt(index));
    configuredRoleIds.push(roleId);
    addRole(roleId);
    db.setLimitedRole(guild.id, roleId, index + 1);
  }
  const message = makeMessage(guild, owner, '-limitedroles');
  await handleMessageCreate(message, {}, db, '-');
  assert.ok(message.replies.length > 1);
  const descriptions = message.replies.map((reply) => reply.embeds[0].data.description);
  for (const roleId of configuredRoleIds) {
    assert.ok(descriptions.some((description) => description.includes(`<@&${roleId}> — members on this role: 0/`)), `${roleId} should be listed`);
  }

  const emptyFixture = createFixture('limited-role-list-empty-guild');
  t.after(() => emptyFixture.db.close());
  const emptyOwner = emptyFixture.addMember(OWNER_ID);
  const emptyMessage = makeMessage(emptyFixture.guild, emptyOwner, '-limitedroles');
  await handleMessageCreate(emptyMessage, {}, emptyFixture.db, '-');
  assert.match(emptyMessage.replies[0].embeds[0].data.description, /No roles have member limits configured/);
});

test('limited-role enforcement reverses the 21st assignment and removes staff-permission roles only', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('limited-role-enforcement-guild');
  t.after(() => db.close());
  const roleId = '300000000000000070';
  const stripstaffMarker = '300000000000000071';
  const staffRoleId = '300000000000000072';
  const cosmeticRoleId = '300000000000000073';
  addRole(roleId);
  addRole(stripstaffMarker, [PermissionFlagsBits.ManageRoles]);
  addRole(staffRoleId, [PermissionFlagsBits.BanMembers]);
  addRole(cosmeticRoleId);
  db.setLimitedRole(guild.id, roleId, 20);
  db.setSetting(guild.id, 'stripstaff_role_id', stripstaffMarker);
  for (let index = 0; index < 20; index += 1) addMember(`4000000000000002${String(index).padStart(2, '0')}`, [roleId]);
  assert.equal(guild.roles.cache.get(roleId).members.size, 20);

  const executor = addMember('400000000000000299', [stripstaffMarker, staffRoleId, cosmeticRoleId]);
  const recipient = addMember('400000000000000298');
  recipient.roles.cache.set(roleId, guild.roles.cache.get(roleId));
  const oldRecipient = { ...recipient, roles: { cache: new Collection() } };
  guild.auditEntries = [['entry-21', {
    id: 'entry-21',
    targetId: recipient.id,
    executor: executor.user,
    changes: [{ key: '$add', new: [{ id: roleId }] }],
    createdTimestamp: Date.now()
  }]];

  assert.equal(guild.roles.cache.get(roleId).members.size, 21);
  await handleGuildMemberUpdate(oldRecipient, recipient, db);

  assert.equal(recipient.roles.cache.has(roleId), false);
  assert.equal(guild.roles.cache.get(roleId).members.size, 20);
  assert.equal(executor.roles.cache.has(stripstaffMarker), false);
  assert.equal(executor.roles.cache.has(staffRoleId), false);
  assert.equal(executor.roles.cache.has(cosmeticRoleId), true);
  const event = db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'ROLE LIMIT VIOLATION'").get();
  assert.equal(event.executor_id, executor.id);
  assert.equal(event.affected_user_id, recipient.id);
  assert.equal(event.punishment, 'STRIPSTAFF removed');
});

test('limited-role join reversals are punitive only for verified normal executors', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('limited-role-join-guild');
  t.after(() => db.close());
  const roleId = '300000000000000080';
  const stripstaffRoleId = '300000000000000081';
  addRole(roleId);
  addRole(stripstaffRoleId, [PermissionFlagsBits.ManageChannels]);
  db.setLimitedRole(guild.id, roleId, 0);
  db.setSetting(guild.id, 'stripstaff_role_id', stripstaffRoleId);
  const owner = addMember(OWNER_ID, [stripstaffRoleId]);
  const joined = addMember('400000000000000080', [roleId]);
  guild.auditEntries = [['join-owner', {
    id: 'join-owner',
    targetId: joined.id,
    executor: owner.user,
    changes: [{ key: '$add', new: [{ id: roleId }] }],
    createdTimestamp: Date.now()
  }]];

  await handleGuildMemberAdd(joined, db);

  assert.equal(joined.roles.cache.has(roleId), false);
  assert.equal(owner.roles.cache.has(stripstaffRoleId), true);

  const os = addMember('400000000000000081', [stripstaffRoleId]);
  db.addOsUser(guild.id, os.id);
  const osJoined = addMember('400000000000000082', [roleId]);
  guild.auditEntries = [['join-os', {
    id: 'join-os',
    targetId: osJoined.id,
    executor: os.user,
    changes: [{ key: '$add', new: [{ id: roleId }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberAdd(osJoined, db);
  assert.equal(osJoined.roles.cache.has(roleId), false);
  assert.equal(os.roles.cache.has(stripstaffRoleId), true);

  const bot = addMember('400000000000000083', [stripstaffRoleId], true);
  const botJoined = addMember('400000000000000084', [roleId]);
  guild.auditEntries = [['join-bot', {
    id: 'join-bot',
    targetId: botJoined.id,
    executor: bot.user,
    changes: [{ key: '$add', new: [{ id: roleId }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberAdd(botJoined, db);
  assert.equal(botJoined.roles.cache.has(roleId), false);
  assert.equal(bot.roles.cache.has(stripstaffRoleId), true);
});

test('startup limited-role reconciliation uses newest audit assignment and never removes arbitrary existing members', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('limited-startup-guild');
  t.after(() => db.close());
  const roleId = '300000000000000090';
  addRole(roleId);
  db.setLimitedRole(guild.id, roleId, 2);
  const older = addMember('400000000000000090', [roleId]);
  const newer = addMember('400000000000000091', [roleId]);
  const unknown = addMember('400000000000000092', [roleId]);
  guild.auditEntries = [
    ['old-add', {
      id: 'old-add', targetId: older.id, executor: { id: '500000000000000090', bot: false },
      changes: [{ key: '$add', new: [{ id: roleId }] }], createdTimestamp: Date.now() - 5000
    }],
    ['new-add', {
      id: 'new-add', targetId: newer.id, executor: { id: '500000000000000091', bot: false },
      changes: [{ key: '$add', new: [{ id: roleId }] }], createdTimestamp: Date.now() - 1000
    }]
  ];
  await require('../src/services/roleProtection').reconcileGuild(guild, db);
  assert.equal(newer.roles.cache.has(roleId), false, 'newest attributable assignment is reconciled first');
  assert.equal(older.roles.cache.has(roleId), true);
  assert.equal(unknown.roles.cache.has(roleId), true);
  assert.equal(db.getLimitedRole(guild.id, roleId).member_limit, 2);

  const unsafeFixture = createFixture('limited-startup-unknown-guild');
  t.after(() => unsafeFixture.db.close());
  unsafeFixture.addRole(roleId);
  unsafeFixture.db.setLimitedRole(unsafeFixture.guild.id, roleId, 0);
  const unsafeMember = unsafeFixture.addMember('400000000000000093', [roleId]);
  unsafeFixture.guild.auditEntries = [];
  await require('../src/services/roleProtection').reconcileGuild(unsafeFixture.guild, unsafeFixture.db);
  assert.equal(unsafeMember.roles.cache.has(roleId), true, 'unknown startup excess must not cause random removal');
  assert.equal(unsafeFixture.db.getLimitedRole(unsafeFixture.guild.id, roleId).member_limit, 0);
});

test('vouch and limited-role systems remain independent when both configure the same role', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('dual-role-enforcement-guild');
  t.after(() => db.close());
  const sharedRole = '300000000000000100';
  const stripstaffRole = '300000000000000101';
  addRole(sharedRole);
  addRole(stripstaffRole, [PermissionFlagsBits.ManageRoles]);
  db.setSetting(guild.id, 'vouch_role_id', sharedRole);
  db.setSetting(guild.id, 'stripstaff_role_id', stripstaffRole);
  db.setLimitedRole(guild.id, sharedRole, 2);

  const unvouched = addMember('400000000000000100', [sharedRole]);
  const oldUnvouched = { ...unvouched, roles: { cache: new Collection() } };
  const actor = addMember('400000000000000101', [stripstaffRole]);
  guild.auditEntries = [['vouch-invalid', {
    id: 'vouch-invalid',
    targetId: unvouched.id,
    executor: actor.user,
    changes: [{ key: '$add', new: [{ id: sharedRole }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberUpdate(oldUnvouched, unvouched, db);
  assert.equal(unvouched.roles.cache.has(sharedRole), false);
  assert.equal(db.getLimitedRole(guild.id, sharedRole).member_limit, 2);
  assert.equal(db.getSettings(guild.id).vouch_role_id, sharedRole);

  const giver = addMember('400000000000000102');
  db.addGiver(guild.id, giver.id);
  const first = addMember('400000000000000103', [sharedRole]);
  const second = addMember('400000000000000104', [sharedRole]);
  db.addVouch(guild.id, first.id, giver.id, 'active', new Date().toISOString());
  db.addVouch(guild.id, second.id, giver.id, 'active', new Date().toISOString());
  const validButExcess = addMember('400000000000000105', [sharedRole]);
  db.addVouch(guild.id, validButExcess.id, giver.id, 'active', new Date().toISOString());
  const oldValid = { ...validButExcess, roles: { cache: new Collection() } };
  guild.auditEntries = [['limited-excess', {
    id: 'limited-excess',
    targetId: validButExcess.id,
    executor: actor.user,
    changes: [{ key: '$add', new: [{ id: sharedRole }] }],
    createdTimestamp: Date.now()
  }]];
  await handleGuildMemberUpdate(oldValid, validButExcess, db);
  assert.equal(validButExcess.roles.cache.has(sharedRole), false, 'valid vouch must not bypass the separate member maximum');
  assert.equal(db.getVouch(guild.id, validButExcess.id).giver_id, giver.id);
  assert.equal(db.getLimitedRole(guild.id, sharedRole).member_limit, 2);
  assert.equal(db.getSettings(guild.id).vouch_role_id, sharedRole);
});

test('STRIPSTAFF is automatic: unauthorized vouch-role assignment is reversed and the executor is punished with no STRIPSTAFF role configured', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('automatic-stripstaff-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000900';
  const manageMessages = '300000000000000901';
  const kickBan = '300000000000000902';
  const voiceMod = '300000000000000903';
  const cosmetic = '300000000000000904';
  const booster = '300000000000000905';
  const rewardRole = '300000000000000906';
  addRole(vouchRole);
  addRole(manageMessages, [PermissionFlagsBits.ManageMessages]);
  addRole(kickBan, [PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers]);
  addRole(voiceMod, [PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers]);
  addRole(cosmetic);
  addRole(booster);
  addRole(rewardRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'reward_role_id', rewardRole);
  assert.equal(db.getSettings(guild.id).stripstaff_role_id, null, 'no STRIPSTAFF role is configured');

  const owner = addMember(OWNER_ID, [manageMessages]);
  const os = addMember('400000000000000901', [kickBan]);
  db.addOsUser(guild.id, os.id);
  const staff = addMember('400000000000000902', [manageMessages, kickBan, voiceMod, cosmetic, booster, rewardRole, vouchRole]);
  db.addVouch(guild.id, staff.id, owner.id, 'staff is legitimately vouched', new Date().toISOString());
  const otherBot = addMember('400000000000000903', [manageMessages], true);

  async function assignWithoutVouch(recipientId, executor) {
    const recipient = addMember(recipientId, [vouchRole]);
    const before = { ...recipient, roles: { cache: new Collection() } };
    guild.auditEntries = [[`audit-${recipientId}`, {
      targetId: recipient.id,
      executor: executor.user,
      changes: [{ key: '$add', new: [{ id: vouchRole }] }],
      createdTimestamp: Date.now()
    }]];
    await handleGuildMemberUpdate(before, recipient, db);
    return recipient;
  }

  const staffTarget = await assignWithoutVouch('400000000000000910', staff);
  assert.equal(staffTarget.roles.cache.has(vouchRole), false, 'recipient loses the role');
  assert.deepEqual([...staff.roles.cache.keys()].sort(), [cosmetic, booster, rewardRole, vouchRole].sort(),
    'executor loses only staff-permission roles; cosmetic, booster, reward, and vouch roles stay');
  assert.equal(db.getVouch(guild.id, staff.id).recipient_id, staff.id, 'punishing the executor does not touch their own vouch');

  const osTarget = await assignWithoutVouch('400000000000000911', os);
  assert.equal(osTarget.roles.cache.has(vouchRole), false, 'OS assignment is still reversed');
  assert.equal(os.roles.cache.has(kickBan), true, 'OS is not punished');

  const ownerTarget = await assignWithoutVouch('400000000000000912', owner);
  assert.equal(ownerTarget.roles.cache.has(vouchRole), false, 'Guild Owner assignment is still reversed');
  assert.equal(owner.roles.cache.has(manageMessages), true, 'Guild Owner is not punished');

  const botTarget = await assignWithoutVouch('400000000000000913', otherBot);
  assert.equal(botTarget.roles.cache.has(vouchRole), false, 'bot assignment is still reversed');
  assert.equal(otherBot.roles.cache.has(manageMessages), true, 'bots are not punished');

  const logs = db.connection.prepare("SELECT executor_id, affected_user_id, punishment FROM event_logs WHERE event_type = 'VOUCH ROLE VIOLATION' ORDER BY id").all();
  assert.deepEqual(logs.map((row) => [row.executor_id, row.affected_user_id, row.punishment]), [
    [staff.id, staffTarget.id, 'STRIPSTAFF removed'],
    [os.id, osTarget.id, 'None (exempt)'],
    [owner.id, ownerTarget.id, 'None (exempt)'],
    [otherBot.id, botTarget.id, 'None (exempt)']
  ]);
});

test('valid vouch keeps the vouch role; only the original giver, OS, or Guild Owner can take it, and manual removal is restored', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('vouch-take-guild');
  t.after(() => db.close());
  const vouchRole = '300000000000000920';
  const staffRole = '300000000000000921';
  addRole(vouchRole);
  addRole(staffRole, [PermissionFlagsBits.ManageRoles]);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  const owner = addMember(OWNER_ID);
  const os = addMember('400000000000000921');
  db.addOsUser(guild.id, os.id);
  const giver = addMember('400000000000000922');
  const otherGiver = addMember('400000000000000923', [staffRole]);
  db.addGiver(guild.id, giver.id, owner.id);
  db.addGiver(guild.id, otherGiver.id, owner.id);
  db.setGiverLimit(guild.id, giver.id, 5);
  const recipients = ['400000000000000930', '400000000000000931', '400000000000000932'].map((id) => addMember(id));
  for (const recipient of recipients) {
    assert.equal((await giveVouch(giver, recipient, 'earned', db)).ok, true);
    assert.equal(recipient.roles.cache.has(vouchRole), true, 'valid vouch grants and keeps the role');
  }
  const [first, second, third] = recipients;

  const blocked = makeMessage(guild, otherGiver, `-vouch take <@${first.id}>`);
  await handleMessageCreate(blocked, blocked.client, db, '-');
  assert.match(blocked.replies[0].embeds[0].data.description, /Only the original giver, a Vouch Admin, OS, or the Guild Owner/);
  assert.ok(db.getVouch(guild.id, first.id), 'a different normal giver cannot remove the vouch');
  assert.equal(first.roles.cache.has(vouchRole), true);

  const own = makeMessage(guild, giver, `-vouch take <@${first.id}>`);
  await handleMessageCreate(own, own.client, db, '-');
  assert.equal(db.getVouch(guild.id, first.id), undefined);
  assert.equal(first.roles.cache.has(vouchRole), false, 'taking the vouch removes the vouch role');

  const byOs = makeMessage(guild, os, `-vouch take <@${second.id}>`);
  await handleMessageCreate(byOs, byOs.client, db, '-');
  assert.equal(db.getVouch(guild.id, second.id), undefined);
  assert.equal(second.roles.cache.has(vouchRole), false);

  const beforeManualRemoval = { ...third, roles: { cache: new Collection(third.roles.cache) } };
  await third.roles.remove(vouchRole);
  await handleGuildMemberUpdate(beforeManualRemoval, third, db);
  assert.equal(third.roles.cache.has(vouchRole), true, 'manually removing the role does not bypass the vouch system');
  assert.ok(db.getVouch(guild.id, third.id), 'the vouch record is untouched');

  const byOwner = makeMessage(guild, owner, `-vouch take <@${third.id}>`);
  await handleMessageCreate(byOwner, byOwner.client, db, '-');
  assert.equal(db.getVouch(guild.id, third.id), undefined);
  assert.equal(third.roles.cache.has(vouchRole), false);
  const afterTake = { ...third, roles: { cache: new Collection([[vouchRole, guild.roles.cache.get(vouchRole)]]) } };
  await handleGuildMemberUpdate(afterTake, third, db);
  assert.equal(third.roles.cache.has(vouchRole), false, 'a taken vouch is never restored');
  assert.equal(otherGiver.roles.cache.has(staffRole), true, 'a rejected take command is not a punishable role assignment');
});

test('automatic STRIPSTAFF also punishes over-limit vouch gives and force-management violations with no STRIPSTAFF role configured', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('automatic-stripstaff-other-paths');
  t.after(() => db.close());
  const staffRole = '300000000000000950';
  const cosmetic = '300000000000000951';
  const blockedRole = '300000000000000952';
  addRole(staffRole, [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers]);
  addRole(cosmetic);
  addRole(blockedRole);
  assert.equal(db.getSettings(guild.id).stripstaff_role_id, null, 'no STRIPSTAFF role is configured');

  const giver = addMember('400000000000000950', [staffRole, cosmetic]);
  db.addGiver(guild.id, giver.id);
  db.setGiverLimit(guild.id, giver.id, 1);
  const first = addMember('400000000000000951');
  const second = addMember('400000000000000952');
  assert.equal((await giveVouch(giver, first, 'one', db)).ok, true);
  assert.equal((await giveVouch(giver, second, 'over limit', db)).message,
    'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.');
  assert.equal(db.getVouch(guild.id, second.id), undefined);
  assert.equal(giver.roles.cache.has(staffRole), false, 'over-limit giver loses staff-permission role');
  assert.equal(giver.roles.cache.has(cosmetic), true, 'over-limit giver keeps cosmetic role');
  const limitLog = db.connection.prepare("SELECT punishment FROM event_logs WHERE event_type = 'VOUCH LIMIT VIOLATION' AND executor_id = ?").get(giver.id);
  assert.equal(limitLog.punishment, 'STRIPSTAFF removed');

  const target = addMember('400000000000000953', [blockedRole]);
  await createForcedRoleStrip(target, blockedRole, OWNER_ID, db);
  const executor = addMember('400000000000000954', [staffRole, cosmetic]);
  target.roles.cache.set(blockedRole, guild.roles.cache.get(blockedRole));
  guild.auditEntries = [['force-audit', {
    targetId: target.id,
    executor: executor.user,
    changes: [{ key: '$add', new: [{ id: blockedRole }] }],
    createdTimestamp: Date.now()
  }]];
  await handleForceMemberUpdate({ ...target, roles: { cache: new Collection() } }, target, db);
  assert.equal(target.roles.cache.has(blockedRole), false, 'forced role strip is re-enforced');
  assert.equal(executor.roles.cache.has(staffRole), false, 'force violator loses staff-permission role');
  assert.equal(executor.roles.cache.has(cosmetic), true, 'force violator keeps cosmetic role');
  const forceLog = db.connection.prepare("SELECT punishment FROM force_management_logs WHERE action = 'FORCED ROLE STRIP VIOLATION'").get();
  assert.equal(forceLog.punishment, 'STRIPSTAFF removed');
});
