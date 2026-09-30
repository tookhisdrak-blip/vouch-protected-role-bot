const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { createDatabase } = require('../src/database');
const { handleMessageCreate, handlers } = require('../src/events/messageCreate');
const { handleRoleLockUpdate } = require('../src/services/roleLocks');
const dashboard = require('../src/commands/vouchCommands');
const { catalog } = require('../src/commands/help');

const OWNER_ID = '100000000000000001';
const LOCKED_A = '200000000000000001';
const LOCKED_B = '200000000000000002';
const AUTH_OS = '300000000000000001';
const AUTH_STAFF = '300000000000000002';
const AUTH_THIRD = '300000000000000003';
const STAFF_PERMISSION = '400000000000000001';

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

  guild.members.fetch = async (input) => {
    const id = typeof input === 'object' ? input.user : input;
    return id ? guild.members.cache.get(id) || null : guild.members.cache;
  };

  function setAudit(targetId, roleIds, executor, changeType) {
    guild.auditEntries = [['audit-entry', {
      id: `audit-${Date.now()}`,
      targetId,
      executor,
      createdTimestamp: Date.now(),
      changes: [{
        key: changeType === 'add' ? '$add' : '$remove',
        new: roleIds.map((id) => ({ id }))
      }]
    }]];
  }

  function snapshot(member, roleIds) {
    return {
      ...member,
      roles: {
        cache: new Collection(roleIds.map((roleId) => [roleId, guild.roles.cache.get(roleId)]))
      }
    };
  }

  addRole(LOCKED_A);
  addRole(LOCKED_B);
  addRole(AUTH_OS);
  addRole(AUTH_STAFF);
  addRole(AUTH_THIRD);
  addRole(STAFF_PERMISSION, [PermissionFlagsBits.ManageRoles]);
  return { db, guild, addRole, addMember, setAudit, snapshot };
}

function messageFor(guild, member, content) {
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

async function command(fixture, member, content) {
  const message = messageFor(fixture.guild, member, content);
  await handleMessageCreate(message, {}, fixture.db, '-');
  return message.replies[0];
}

async function applyChange(fixture, executor, target, roleId, changeType, auditRoleIds = [roleId]) {
  const oldRoleIds = [...target.roles.cache.keys()];
  if (changeType === 'remove' && !oldRoleIds.includes(roleId)) oldRoleIds.push(roleId);
  const oldMember = fixture.snapshot(target, oldRoleIds);
  if (changeType === 'add') target.roles.cache.set(roleId, fixture.guild.roles.cache.get(roleId));
  else target.roles.cache.delete(roleId);
  fixture.setAudit(target.id, auditRoleIds, executor.user, changeType);
  await handleRoleLockUpdate(oldMember, target, fixture.db);
}

test('authorized OS and Staff can add and remove a locked role', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS, AUTH_STAFF], OWNER_ID);
  const target = fixture.addMember('600000000000000001');

  for (const [id, authorizationRole] of [
    ['600000000000000002', AUTH_OS],
    ['600000000000000003', AUTH_STAFF]
  ]) {
    const executor = fixture.addMember(id, [authorizationRole]);
    await applyChange(fixture, executor, target, LOCKED_A, 'add');
    assert.equal(target.roles.cache.has(LOCKED_A), true);
    await applyChange(fixture, executor, target, LOCKED_A, 'remove');
    assert.equal(target.roles.cache.has(LOCKED_A), false);
  }
  assert.equal(fixture.db.connection.prepare('SELECT COUNT(*) AS count FROM event_logs').get().count, 0);
});

test('holding any one of three authorization roles is sufficient', async (t) => {
  const fixture = createFixture('500000000000000002');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS, AUTH_STAFF, AUTH_THIRD], OWNER_ID);
  const target = fixture.addMember('600000000000000004');
  for (const [index, roleId] of [AUTH_OS, AUTH_STAFF, AUTH_THIRD].entries()) {
    const executor = fixture.addMember(`60000000000000001${index}`, [roleId]);
    await applyChange(fixture, executor, target, LOCKED_A, 'add');
    assert.equal(target.roles.cache.has(LOCKED_A), true);
    target.roles.cache.delete(LOCKED_A);
  }
});

test('unauthorized additions are removed and unauthorized removals are restored before stripstaff', async (t) => {
  const fixture = createFixture('500000000000000003');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS], OWNER_ID);
  const target = fixture.addMember('600000000000000020');

  const additionExecutor = fixture.addMember('600000000000000021', [STAFF_PERMISSION]);
  await applyChange(fixture, additionExecutor, target, LOCKED_A, 'add');
  assert.equal(target.roles.cache.has(LOCKED_A), false);
  assert.equal(additionExecutor.roles.cache.has(STAFF_PERMISSION), false);

  target.roles.cache.set(LOCKED_A, fixture.guild.roles.cache.get(LOCKED_A));
  const removalExecutor = fixture.addMember('600000000000000022', [STAFF_PERMISSION]);
  await applyChange(fixture, removalExecutor, target, LOCKED_A, 'remove');
  assert.equal(target.roles.cache.has(LOCKED_A), true);
  assert.equal(removalExecutor.roles.cache.has(STAFF_PERMISSION), false);

  const logs = fixture.db.connection.prepare('SELECT * FROM event_logs ORDER BY id').all();
  assert.match(logs[0].action_taken, /reversed and verified/);
  assert.match(logs[1].action_taken, /reversed and verified/);
  assert.equal(logs[0].punishment, 'STRIPSTAFF removed');
  assert.equal(logs[1].punishment, 'STRIPSTAFF removed');
});

test('Guild Owner and configured OS are fully exempt from role locks', async (t) => {
  const fixture = createFixture('500000000000000004');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_STAFF], OWNER_ID);
  fixture.db.setSetting(fixture.guild.id, 'os_role_id', AUTH_OS);
  const owner = fixture.addMember(OWNER_ID);
  const osMember = fixture.addMember('600000000000000030', [AUTH_OS]);
  const target = fixture.addMember('600000000000000031');

  await applyChange(fixture, owner, target, LOCKED_A, 'add');
  assert.equal(target.roles.cache.has(LOCKED_A), true);
  await applyChange(fixture, owner, target, LOCKED_A, 'remove');
  assert.equal(target.roles.cache.has(LOCKED_A), false);
  await applyChange(fixture, osMember, target, LOCKED_A, 'add');
  assert.equal(target.roles.cache.has(LOCKED_A), true);
  await applyChange(fixture, osMember, target, LOCKED_A, 'remove');
  assert.equal(target.roles.cache.has(LOCKED_A), false);
});

test('bot additions and removals are reversed but bots are never punished', async (t) => {
  const fixture = createFixture('500000000000000005');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS], OWNER_ID);
  const bot = fixture.addMember('600000000000000040', [STAFF_PERMISSION], true);
  const target = fixture.addMember('600000000000000041');

  await applyChange(fixture, bot, target, LOCKED_A, 'add');
  assert.equal(target.roles.cache.has(LOCKED_A), false);
  assert.equal(bot.roles.cache.has(STAFF_PERMISSION), true);
  target.roles.cache.set(LOCKED_A, fixture.guild.roles.cache.get(LOCKED_A));
  await applyChange(fixture, bot, target, LOCKED_A, 'remove');
  assert.equal(target.roles.cache.has(LOCKED_A), true);
  assert.equal(bot.roles.cache.has(STAFF_PERMISSION), true);

  const logs = fixture.db.connection.prepare('SELECT * FROM event_logs ORDER BY id').all();
  assert.ok(logs.every((entry) => /exempt/.test(entry.punishment)));
  assert.ok(logs.every((entry) => /bot and exempt/.test(entry.reason)));
});

test('multiple locked roles and authorization lists operate independently', async (t) => {
  const fixture = createFixture('500000000000000006');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS], OWNER_ID);
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_B, [AUTH_STAFF], OWNER_ID);
  const executor = fixture.addMember('600000000000000050', [AUTH_OS, STAFF_PERMISSION]);
  const target = fixture.addMember('600000000000000051');

  await applyChange(fixture, executor, target, LOCKED_A, 'add');
  assert.equal(target.roles.cache.has(LOCKED_A), true);
  await applyChange(fixture, executor, target, LOCKED_B, 'add');
  assert.equal(target.roles.cache.has(LOCKED_B), false);
  assert.equal(executor.roles.cache.has(STAFF_PERMISSION), false);
});

test('one audit action changing multiple locked roles is matched per role without misattribution', async (t) => {
  const fixture = createFixture('500000000000000013');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS], OWNER_ID);
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_B, [AUTH_STAFF], OWNER_ID);
  const executor = fixture.addMember('600000000000000080', [AUTH_OS, STAFF_PERMISSION]);
  const target = fixture.addMember('600000000000000081');
  const oldMember = fixture.snapshot(target, []);
  target.roles.cache.set(LOCKED_A, fixture.guild.roles.cache.get(LOCKED_A));
  target.roles.cache.set(LOCKED_B, fixture.guild.roles.cache.get(LOCKED_B));
  fixture.setAudit(target.id, [LOCKED_A, LOCKED_B], executor.user, 'add');

  await handleRoleLockUpdate(oldMember, target, fixture.db);

  assert.equal(target.roles.cache.has(LOCKED_A), true, 'the role authorized by AUTH_OS remains');
  assert.equal(target.roles.cache.has(LOCKED_B), false, 'the independently unauthorized role is reversed');
  const log = fixture.db.connection.prepare('SELECT * FROM event_logs').get();
  assert.equal(log.executor_id, executor.id);
  assert.equal(log.role_id, LOCKED_B);
});

test('lockrole parses comma-separated mentions, IDs, mixed inputs, and spaces around commas', async (t) => {
  const fixture = createFixture('500000000000000007');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const variants = [
    `<@&${AUTH_OS}>,<@&${AUTH_STAFF}>`,
    `${AUTH_OS}, ${AUTH_STAFF}`,
    `<@&${AUTH_OS}> , ${AUTH_THIRD}`,
    `${AUTH_OS} ,<@&${AUTH_STAFF}>`
  ];
  for (const authorizationInput of variants) {
    const response = await command(fixture, owner, `-lockrole <@&${LOCKED_A}> to ${authorizationInput}`);
    assert.equal(response.embeds[0].data.title, 'Role lock saved');
    assert.equal(fixture.db.getRoleLocks(fixture.guild.id).length, 1);
  }
  assert.deepEqual(fixture.db.getRoleLock(fixture.guild.id, LOCKED_A).authorization_role_ids, [AUTH_OS, AUTH_STAFF]);
});

test('lockrole reports specific malformed and invalid role errors', async (t) => {
  const fixture = createFixture('500000000000000008');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const cases = [
    ['-lockrole', 'use a role mention or role ID bro'],
    [`-lockrole <@&${LOCKED_A}>`, 'use: -lockrole @role to @role, @role'],
    [`-lockrole <@&${LOCKED_A}> to`, 'use at least one role after "to"'],
    [`-lockrole 999999999999999999 to ${AUTH_OS}`, "I couldn't find that role bro"],
    [`-lockrole ${LOCKED_A} to 999999999999999999`, "I couldn't find one of the authorization roles bro"]
  ];
  for (const [content, expected] of cases) {
    const response = await command(fixture, owner, content);
    assert.equal(response.embeds[0].data.title, 'Invalid command');
    assert.equal(response.embeds[0].data.description, expected);
  }
});

test('only Guild Owner, Owner Allow users, and OS can manage role locks', async (t) => {
  const fixture = createFixture('500000000000000014');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const ownerAllowed = fixture.addMember('600000000000000090');
  const osMember = fixture.addMember('600000000000000091', [AUTH_OS]);
  const regular = fixture.addMember('600000000000000092');
  fixture.db.addOwnerAllowed(fixture.guild.id, ownerAllowed.id, owner.id);
  fixture.db.setSetting(fixture.guild.id, 'os_role_id', AUTH_OS);

  for (const manager of [owner, ownerAllowed, osMember]) {
    const response = await command(fixture, manager, `-lockrole ${LOCKED_A} to ${AUTH_STAFF}`);
    assert.equal(response.embeds[0].data.title, 'Role lock saved');
  }

  const denied = await command(fixture, regular, `-lockrole ${LOCKED_B} to ${AUTH_STAFF}`);
  assert.equal(denied.embeds[0].data.title, 'Unable to complete');
  assert.equal(
    denied.embeds[0].data.description,
    'Only the Guild Owner, Owner Allow users, or OS can manage role locks.'
  );
  assert.equal(fixture.db.getRoleLock(fixture.guild.id, LOCKED_B), null);
});

test('updating a lock replaces its authorization list without duplicates', async (t) => {
  const fixture = createFixture('500000000000000009');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  await command(fixture, owner, `-lockrole ${LOCKED_A} to ${AUTH_OS}`);
  await command(fixture, owner, `-lockrole ${LOCKED_A} to ${AUTH_STAFF}, ${AUTH_THIRD}, ${AUTH_THIRD}`);
  assert.equal(fixture.db.getRoleLocks(fixture.guild.id).length, 1);
  assert.deepEqual(
    fixture.db.getRoleLock(fixture.guild.id, LOCKED_A).authorization_role_ids,
    [AUTH_STAFF, AUTH_THIRD]
  );
});

test('unlockrole removes only the selected lock and lockroles displays every authorization role', async (t) => {
  const fixture = createFixture('500000000000000010');
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS, AUTH_STAFF], OWNER_ID);
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_B, [AUTH_THIRD], OWNER_ID);

  const listing = await command(fixture, owner, '-lockroles');
  const text = listing.embeds[0].data.description;
  assert.match(text, new RegExp(`<@&${LOCKED_A}>.*<@&${AUTH_OS}>, <@&${AUTH_STAFF}>`));
  assert.match(text, new RegExp(`<@&${LOCKED_B}>.*<@&${AUTH_THIRD}>`));

  await command(fixture, owner, `-unlockrole ${LOCKED_A}`);
  assert.equal(fixture.db.getRoleLock(fixture.guild.id, LOCKED_A), null);
  assert.ok(fixture.db.getRoleLock(fixture.guild.id, LOCKED_B));
});

test('role locks persist after a database restart without altering existing data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'role-locks-'));
  const databasePath = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = createDatabase(databasePath);
  first.ensureGuild('500000000000000011');
  first.addVouch('500000000000000011', '600000000000000060', '600000000000000061', 'keep me', new Date().toISOString());
  first.setRoleLock('500000000000000011', LOCKED_A, [AUTH_OS, AUTH_STAFF], OWNER_ID);
  first.close();

  const second = createDatabase(databasePath);
  assert.deepEqual(second.getRoleLock('500000000000000011', LOCKED_A).authorization_role_ids, [AUTH_OS, AUTH_STAFF]);
  assert.equal(second.getVouch('500000000000000011', '600000000000000060').reason, 'keep me');
  second.close();
});

test('failed reversal is logged as failed and never falsely reported or punished', async (t) => {
  const fixture = createFixture('500000000000000012');
  t.after(() => fixture.db.close());
  fixture.db.setRoleLock(fixture.guild.id, LOCKED_A, [AUTH_OS], OWNER_ID);
  const executor = fixture.addMember('600000000000000070', [STAFF_PERMISSION]);
  const target = fixture.addMember('600000000000000071');
  target.roles.remove = async () => {
    throw new Error('Missing Permissions');
  };

  await applyChange(fixture, executor, target, LOCKED_A, 'add');
  assert.equal(target.roles.cache.has(LOCKED_A), true);
  assert.equal(executor.roles.cache.has(STAFF_PERMISSION), true);
  const log = fixture.db.connection.prepare('SELECT * FROM event_logs').get();
  assert.match(log.action_taken, /failed verification/);
  assert.doesNotMatch(log.action_taken, /reversed and verified/);
  assert.match(log.reason, /Missing Permissions/);
});

test('lockrole commands are registered in the in-channel vouchcommands catalog', () => {
  for (const commandName of ['lockrole', 'unlockrole', 'lockroles']) assert.equal(handlers.has(commandName), true);
  for (const commandName of [
    '-lockrole @role to @role, @role',
    '-unlockrole @role',
    '-lockroles'
  ]) {
    assert.ok(catalog.some((entry) => entry.command === commandName));
    assert.ok(dashboard.registeredCatalog().some((entry) => entry.command === commandName));
  }
  assert.ok(dashboard.CATEGORIES.some((category) => category.key === 'locks'));
});
