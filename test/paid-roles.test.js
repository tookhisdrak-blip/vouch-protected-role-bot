const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { createDatabase } = require('../src/database');
const { handleMessageCreate, handlers } = require('../src/events/messageCreate');
const { handleMemberUpdate } = require('../src/events/guildMemberUpdate');
const { clearRoleLockEnforcementState } = require('../src/services/roleLocks');
const { handlePaidRoleUpdate, clearPaidRoleEnforcementState } = require('../src/services/paidRoles');
const dashboard = require('../src/commands/vouchCommands');
const { catalog } = require('../src/commands/help');

const OWNER_ID = '100000000000000001';
const PAID_A = '200000000000000001';
const PAID_B = '200000000000000002';
const VERIFIED_ROLE = '300000000000000001';
const STAFF_ROLE = '400000000000000001';

test.beforeEach(() => {
  clearRoleLockEnforcementState();
  clearPaidRoleEnforcementState();
});

function createFixture(guildId = '500000000000000001', databasePath = ':memory:') {
  const db = createDatabase(databasePath);
  db.ensureGuild(guildId);
  const guild = {
    id: guildId,
    ownerId: OWNER_ID,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    auditEntries: [],
    async fetchAuditLogs() {
      return { entries: new Collection(this.auditEntries) };
    }
  };

  function addRole(id, permissions = []) {
    const role = {
      id,
      name: id,
      guild,
      permissions: { has: (permission) => permissions.includes(permission) }
    };
    Object.defineProperty(role, 'members', {
      get: () => new Collection([...guild.members.cache.values()]
        .filter((member) => member.roles.cache.has(id))
        .map((member) => [member.id, member]))
    });
    guild.roles.cache.set(id, role);
    return role;
  }

  function addMember(id, roleIds = [], bot = false) {
    const calls = { add: [], remove: [] };
    const member = {
      id,
      guild,
      calls,
      user: { id, bot, username: id, tag: `${id}#0001` },
      roles: {
        cache: new Collection(),
        async add(roleId) {
          calls.add.push(roleId);
          member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
        },
        async remove(roleId) {
          calls.remove.push(roleId);
          member.roles.cache.delete(roleId);
        }
      }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
    guild.members.cache.set(id, member);
    return member;
  }

  guild.members.fetch = async (input) => {
    const id = typeof input === 'object' ? input.user : input;
    return id ? guild.members.cache.get(id) || null : guild.members.cache;
  };

  function setAudit(target, executor, roleId) {
    guild.auditEntries = [['paid-audit', {
      id: `paid-audit-${target.id}-${roleId}`,
      targetId: target.id,
      executor: executor.user,
      changes: [{ key: '$add', new: [{ id: roleId }] }],
      createdTimestamp: Date.now()
    }]];
  }

  function snapshot(member, roleIds) {
    return {
      ...member,
      roles: { cache: new Collection(roleIds.map((roleId) => [roleId, guild.roles.cache.get(roleId)])) }
    };
  }

  addRole(PAID_A);
  addRole(PAID_B);
  addRole(VERIFIED_ROLE);
  addRole(STAFF_ROLE, [PermissionFlagsBits.ManageRoles]);
  return { db, guild, addRole, addMember, setAudit, snapshot };
}

function makeMessage(fixture, member, content) {
  const replies = [];
  return {
    guild: fixture.guild,
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

async function command(fixture, member, content) {
  const message = makeMessage(fixture, member, content);
  await handleMessageCreate(message, {}, fixture.db, '-');
  return message.replies[0];
}

async function addPaidRole(fixture, executor, target, roleId) {
  const oldMember = fixture.snapshot(target, [...target.roles.cache.keys()]);
  target.roles.cache.set(roleId, fixture.guild.roles.cache.get(roleId));
  fixture.setAudit(target, executor, roleId);
  await handlePaidRoleUpdate(oldMember, target, fixture.db);
}

test('Guild Owner and OS configure multiple paid roles while regular users cannot', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const osMember = fixture.addMember('600000000000000001');
  const regular = fixture.addMember('600000000000000002');
  fixture.db.addOsUser(fixture.guild.id, osMember.id);

  assert.equal((await command(fixture, owner, `-setpaidrole ${PAID_A}`)).embeds[0].data.title, 'Paid role saved');
  assert.equal((await command(fixture, osMember, `-setpaidrole <@&${PAID_B}>`)).embeds[0].data.title, 'Paid role saved');
  const denied = await command(fixture, regular, `-setpaidrole ${VERIFIED_ROLE}`);
  assert.match(denied.embeds[0].data.description, /Only the Guild Owner, Owner Allow users, or OS/);
  assert.deepEqual(fixture.db.getPaidRoles(fixture.guild.id).map((row) => row.role_id), [PAID_A, PAID_B]);
});

test('verified role members and verified users can whitelist users; regular users cannot', async (t) => {
  const fixture = createFixture('500000000000000002');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const verifiedMember = fixture.addMember('600000000000000010', [VERIFIED_ROLE]);
  const verifiedUser = fixture.addMember('600000000000000011');
  const regular = fixture.addMember('600000000000000012');
  const firstTarget = fixture.addMember('600000000000000013');
  const secondTarget = fixture.addMember('600000000000000014');

  await command(fixture, owner, `-setverifiedrole <@&${VERIFIED_ROLE}>`);
  await command(fixture, owner, `-setverifiedrole <@${verifiedUser.id}>`);
  assert.equal((await command(fixture, verifiedMember, `-paid <@${firstTarget.id}>`)).embeds[0].data.title, 'Paid whitelist updated');
  assert.equal((await command(fixture, verifiedUser, `-paid ${secondTarget.id}`)).embeds[0].data.title, 'Paid whitelist updated');
  const denied = await command(fixture, regular, `-paid ${regular.id}`);
  assert.match(denied.embeds[0].data.description, /Only verified paid-role users/);
  assert.equal(fixture.db.isPaidWhitelisted(fixture.guild.id, firstTarget.id), true);
  assert.equal(fixture.db.isPaidWhitelisted(fixture.guild.id, secondTarget.id), true);
  assert.equal(fixture.db.isPaidWhitelisted(fixture.guild.id, regular.id), false);
});

test('one whitelist permits every configured paid role', async (t) => {
  const fixture = createFixture('500000000000000003');
  t.after(() => fixture.db.close());
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, OWNER_ID);
  fixture.db.addPaidRole(fixture.guild.id, PAID_B, OWNER_ID);
  const executor = fixture.addMember('600000000000000020', [STAFF_ROLE]);
  const target = fixture.addMember('600000000000000021');
  fixture.db.addPaidWhitelistUser(fixture.guild.id, target.id, OWNER_ID);

  await addPaidRole(fixture, executor, target, PAID_A);
  await addPaidRole(fixture, executor, target, PAID_B);

  assert.equal(target.roles.cache.has(PAID_A), true);
  assert.equal(target.roles.cache.has(PAID_B), true);
  assert.equal(executor.roles.cache.has(STAFF_ROLE), true);
  assert.equal(fixture.db.connection.prepare('SELECT COUNT(*) AS count FROM event_logs').get().count, 0);
});

test('unwhitelisted paid-role addition is reversed, verified, and human executor is stripped once', async (t) => {
  const fixture = createFixture('500000000000000004');
  t.after(() => fixture.db.close());
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, OWNER_ID);
  const executor = fixture.addMember('600000000000000030', [STAFF_ROLE]);
  const target = fixture.addMember('600000000000000031');
  const oldMember = fixture.snapshot(target, []);
  target.roles.cache.set(PAID_A, fixture.guild.roles.cache.get(PAID_A));
  fixture.setAudit(target, executor, PAID_A);

  await Promise.all(Array.from({ length: 10 }, () =>
    handlePaidRoleUpdate(oldMember, target, fixture.db)));

  assert.equal(target.roles.cache.has(PAID_A), false);
  assert.equal(target.calls.remove.length, 1);
  assert.equal(executor.roles.cache.has(STAFF_ROLE), false);
  assert.equal(executor.calls.remove.length, 1);
  const logs = fixture.db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'PAID ROLE VIOLATION'").all();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].executor_id, executor.id);
  assert.equal(logs[0].affected_user_id, target.id);
  assert.equal(logs[0].role_id, PAID_A);
  assert.equal(logs[0].action_taken, 'Unauthorized paid role removed and verified');
  assert.equal(logs[0].punishment, 'STRIPSTAFF removed');
  assert.match(logs[0].reason, /Executor was human/);
});

test('a bot paid-role addition is reversed without punishment', async (t) => {
  const fixture = createFixture('500000000000000005');
  t.after(() => fixture.db.close());
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, OWNER_ID);
  const bot = fixture.addMember('600000000000000040', [STAFF_ROLE], true);
  const target = fixture.addMember('600000000000000041');

  await addPaidRole(fixture, bot, target, PAID_A);

  assert.equal(target.roles.cache.has(PAID_A), false);
  assert.equal(bot.roles.cache.has(STAFF_ROLE), true);
  const log = fixture.db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'PAID ROLE VIOLATION'").get();
  assert.equal(log.punishment, 'None (exempt)');
  assert.match(log.reason, /bot and exempt/);
});

test('self-assignment is reversed and punishes the unwhitelisted human executor, not another member', async (t) => {
  const fixture = createFixture('500000000000000006');
  t.after(() => fixture.db.close());
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, OWNER_ID);
  const selfAssigningMember = fixture.addMember('600000000000000050', [STAFF_ROLE]);

  await addPaidRole(fixture, selfAssigningMember, selfAssigningMember, PAID_A);

  assert.equal(selfAssigningMember.roles.cache.has(PAID_A), false);
  assert.equal(selfAssigningMember.roles.cache.has(STAFF_ROLE), false);
  const log = fixture.db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'PAID ROLE VIOLATION'").get();
  assert.equal(log.executor_id, selfAssigningMember.id);
  assert.equal(log.affected_user_id, selfAssigningMember.id);
});

test('the paid-role reversal event is suppressed across the complete update pipeline', async (t) => {
  const fixture = createFixture('500000000000000007');
  t.after(() => fixture.db.close());
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, OWNER_ID);
  fixture.db.setSetting(fixture.guild.id, 'vouch_role_id', PAID_A);
  fixture.db.addVouch(fixture.guild.id, '600000000000000061', '600000000000000062', 'active', new Date().toISOString());
  const executor = fixture.addMember('600000000000000060', [STAFF_ROLE]);
  const target = fixture.addMember('600000000000000061', [PAID_A]);
  const oldMember = fixture.snapshot(target, []);
  fixture.setAudit(target, executor, PAID_A);
  let reversalEvents = 0;
  target.roles.remove = async (roleId) => {
    target.calls.remove.push(roleId);
    const reversalOldMember = fixture.snapshot(target, [roleId]);
    target.roles.cache.delete(roleId);
    reversalEvents += 1;
    await handleMemberUpdate(reversalOldMember, target, fixture.db);
  };

  await handleMemberUpdate(oldMember, target, fixture.db);

  assert.equal(reversalEvents, 1);
  assert.equal(target.calls.remove.length, 1);
  assert.equal(target.calls.add.length, 0, 'the vouch system did not restore the bot reversal');
  assert.equal(target.roles.cache.has(PAID_A), false);
  assert.equal(fixture.db.connection.prepare("SELECT COUNT(*) AS count FROM event_logs WHERE event_type = 'PAID ROLE VIOLATION'").get().count, 1);
});

test('failed paid-role reversal is logged as failed and does not punish', async (t) => {
  const fixture = createFixture('500000000000000008');
  t.after(() => fixture.db.close());
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, OWNER_ID);
  const executor = fixture.addMember('600000000000000070', [STAFF_ROLE]);
  const target = fixture.addMember('600000000000000071');
  target.roles.remove = async () => {
    throw new Error('Missing Permissions');
  };

  await addPaidRole(fixture, executor, target, PAID_A);

  assert.equal(target.roles.cache.has(PAID_A), true);
  assert.equal(executor.roles.cache.has(STAFF_ROLE), true);
  const log = fixture.db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'PAID ROLE VIOLATION'").get();
  assert.match(log.action_taken, /failed verification/);
  assert.match(log.reason, /Missing Permissions/);
  assert.equal(log.punishment, 'None (executor unverified)');
});

test('paidlist compactly shows paid roles, whitelist users, and verified managers', async (t) => {
  const fixture = createFixture('500000000000000009');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const whitelistUser = fixture.addMember('600000000000000080');
  const verifiedUser = fixture.addMember('600000000000000081');
  fixture.db.addPaidRole(fixture.guild.id, PAID_A, owner.id);
  fixture.db.addPaidRole(fixture.guild.id, PAID_B, owner.id);
  fixture.db.addPaidWhitelistUser(fixture.guild.id, whitelistUser.id, owner.id);
  fixture.db.setPaidVerifiedRole(fixture.guild.id, VERIFIED_ROLE, owner.id);
  fixture.db.addPaidVerifiedUser(fixture.guild.id, verifiedUser.id, owner.id);

  const response = await command(fixture, owner, '-paidlist');
  const text = response.embeds[0].data.description;
  assert.match(text, new RegExp(`<@&${PAID_A}>.*<@&${PAID_B}>`));
  assert.match(text, new RegExp(`<@${whitelistUser.id}>`));
  assert.match(text, new RegExp(`<@&${VERIFIED_ROLE}>`));
  assert.match(text, new RegExp(`<@${verifiedUser.id}>`));
});

test('paid-role data persists after restart without altering existing data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-roles-'));
  const databasePath = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const guildId = '500000000000000010';
  const first = createDatabase(databasePath);
  first.ensureGuild(guildId);
  first.addVouch(guildId, '600000000000000090', '600000000000000091', 'preserved', new Date().toISOString());
  first.addPaidRole(guildId, PAID_A, OWNER_ID);
  first.addPaidWhitelistUser(guildId, '600000000000000092', OWNER_ID);
  first.setPaidVerifiedRole(guildId, VERIFIED_ROLE, OWNER_ID);
  first.addPaidVerifiedUser(guildId, '600000000000000093', OWNER_ID);
  first.close();

  const second = createDatabase(databasePath);
  assert.equal(second.isPaidRole(guildId, PAID_A), true);
  assert.equal(second.isPaidWhitelisted(guildId, '600000000000000092'), true);
  assert.equal(second.getPaidVerifiedRole(guildId), VERIFIED_ROLE);
  assert.equal(second.isPaidVerifiedUser(guildId, '600000000000000093'), true);
  assert.equal(second.getVouch(guildId, '600000000000000090').reason, 'preserved');
  second.close();
});

test('paid role commands are registered in the in-channel vouchcommands catalog', () => {
  for (const name of ['setpaidrole', 'paid', 'paidlist', 'setverifiedrole']) assert.equal(handlers.has(name), true);
  for (const commandName of [
    '-setpaidrole @role',
    '-paid @user',
    '-paidlist',
    '-setverifiedrole @role|@user'
  ]) {
    assert.ok(catalog.some((entry) => entry.command === commandName));
    assert.ok(dashboard.registeredCatalog().some((entry) => entry.command === commandName));
  }
  assert.ok(dashboard.CATEGORIES.some((category) => category.key === 'paid'));
});
