const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { createDatabase } = require('../src/database');
const { handleGuildMemberUpdate } = require('../src/services/roleProtection');
const { handleMessageCreate, handleMessageUpdate } = require('../src/events/messageCreate');
const { giverLimit, remainingVouches } = require('../src/services/permissions');
const { catalog, allowed } = require('../src/commands/help');
const dashboard = require('../src/commands/vouchCommands');

test.after(() => dashboard.clearAllPanels());

const OWNER_ID = '100000000000000001';
const LIMIT_MESSAGE = 'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.';

function createFixture(guildId = '210000000000000001', db = createDatabase(':memory:')) {
  db.ensureGuild(guildId);
  const guild = {
    id: guildId,
    ownerId: OWNER_ID,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    async fetchAuditLogs() {
      return { entries: new Collection(this.auditEntries || []) };
    }
  };

  function addRole(roleId, permissions = []) {
    const role = { id: roleId, name: roleId, guild, permissions: { has: (permission) => permissions.includes(permission) } };
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
        async add(roleId) { member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId }); },
        async remove(roleId) { member.roles.cache.delete(roleId); }
      }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
    guild.members.cache.set(id, member);
    return member;
  }

  guild.members.fetch = async (id) => (id ? guild.members.cache.get(id) || null : guild.members.cache);
  return { db, guild, addRole, addMember };
}

async function run(guild, db, member, content) {
  const replies = [];
  const message = {
    guild, member, author: member.user, content, replies,
    async reply(payload) { replies.push(payload); return payload; }
  };
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  await handleMessageCreate(message, client, db, '-');
  return replies[0]?.embeds[0].data.description || '';
}

async function runEdited(guild, db, member, content) {
  const replies = [];
  const message = {
    guild, member, author: member.user, content, replies,
    async reply(payload) { replies.push(payload); return payload; }
  };
  const client = { guilds: { cache: new Collection([[guild.id, guild]]) } };
  await handleMessageUpdate({ content: 'not a command' }, message, client, db, '-');
  return replies[0]?.embeds[0].data.description || '';
}

test('Vouch Admin: granted by OS or Guild Owner, 5 default vouches, manages givers, and can remove any vouch', async (t) => {
  const { db, guild, addRole, addMember } = createFixture();
  t.after(() => db.close());
  const vouchRole = '310000000000000001';
  addRole(vouchRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  const owner = addMember(OWNER_ID);
  const osUser = addMember('410000000000000001');
  db.addOsUser(guild.id, osUser.id);
  const admin = addMember('410000000000000002');
  const giver = addMember('410000000000000003');
  const outsider = addMember('410000000000000004');
  const recipients = Array.from({ length: 7 }, (_, index) => addMember(`41000000000000010${index}`));

  assert.match(await run(guild, db, outsider, `-vouch admin allow <@${admin.id}>`), /Only OS or the Guild Owner can manage Vouch Admins/);
  assert.equal(db.getVouchAdmin(guild.id, admin.id), undefined);
  assert.match(await run(guild, db, osUser, `-vouch admin allow <@${admin.id}>`), /is now a Vouch Admin/);
  assert.ok(db.getVouchAdmin(guild.id, admin.id), 'OS can grant Vouch Admin');
  assert.match(await run(guild, db, admin, `-vouch admin allow <@${outsider.id}>`), /Only OS or the Guild Owner/, 'Vouch Admins cannot grant Vouch Admin');

  assert.equal(giverLimit(guild.id, admin.id, db, admin), 5, 'Vouch Admin default limit is 5');
  for (const recipient of recipients.slice(0, 5)) {
    assert.match(await run(guild, db, admin, `-vouch give <@${recipient.id}>`), /received a vouch/);
    assert.equal(recipient.roles.cache.has(vouchRole), true, 'Vouch Admin vouches grant the vouch role');
  }
  assert.equal(await run(guild, db, admin, `-vouch give <@${recipients[5].id}>`), LIMIT_MESSAGE);
  assert.equal(db.getVouch(guild.id, recipients[5].id), undefined, 'the sixth vouch is not created');

  assert.match(await run(guild, db, admin, `-vouch addgiver <@${giver.id}>`), /can give vouches/);
  assert.ok(db.getGiver(guild.id, giver.id), 'Vouch Admins can authorize normal givers');
  assert.equal(giverLimit(guild.id, giver.id, db, giver), 2, 'normal givers still default to 2');
  assert.match(await run(guild, db, giver, `-vouch give <@${recipients[6].id}>`), /received a vouch/);

  assert.match(await run(guild, db, giver, `-vouch admin take <@${recipients[0].id}>`), /Only Vouch Admins, OS, or the Guild Owner/);
  assert.match(await run(guild, db, giver, `-vouch take <@${recipients[0].id}>`), /Only the original giver/, 'normal givers cannot take other vouches');
  assert.ok(db.getVouch(guild.id, recipients[0].id));

  assert.match(await run(guild, db, admin, `-vouch admin take <@${recipients[6].id}>`), /was removed/);
  assert.equal(db.getVouch(guild.id, recipients[6].id), undefined, 'Vouch Admin removes a vouch they did not give');
  assert.equal(recipients[6].roles.cache.has(vouchRole), false, 'removing the vouch removes the vouch role');
  assert.equal(remainingVouches(guild.id, giver.id, db, giver), 2, 'the original giver gets the slot back');

  assert.match(await run(guild, db, admin, `-vouch removegiver <@${giver.id}>`), /can no longer give vouches/);
  assert.equal(db.getGiver(guild.id, giver.id), undefined);

  for (const [content, denial] of [
    [`-vouch role add <@&${vouchRole}>`, /Only OS or the Guild Owner can manage the vouch role/],
    ['-vouch role remove', /Only OS or the Guild Owner can manage the vouch role/],
    ['-vouch reset', /Only the Guild Owner/],
    [`-vouch owner allow <@${outsider.id}>`, /Only the Guild Owner can grant or remove Owner Allow/],
    [`-vouch limit <@${admin.id}> 50`, /Only the Guild Owner/]
  ]) {
    assert.match(await run(guild, db, admin, content), denial, `Vouch Admin is denied: ${content}`);
  }
  assert.equal(db.getSettings(guild.id).vouch_role_id, vouchRole);
  assert.equal(db.getVouches(guild.id).length, 5);

  assert.match(await run(guild, db, owner, `-vouch limit <@${admin.id}> 7`), /up to 7/);
  assert.equal(giverLimit(guild.id, admin.id, db, admin), 7, 'Guild Owner can raise a Vouch Admin limit');
  assert.match(await run(guild, db, owner, `-vouch limit remove <@${admin.id}>`), /Vouch Admin default/);
  assert.equal(giverLimit(guild.id, admin.id, db, admin), 5);

  assert.match(await run(guild, db, osUser, `-vouch admin remove <@${admin.id}>`), /no longer a Vouch Admin/);
  assert.equal(db.getVouchAdmin(guild.id, admin.id), undefined);
  assert.equal(db.getVouches(guild.id).length, 5, 'revoking Vouch Admin keeps their existing vouches');
  assert.match(await run(guild, db, admin, `-vouch give <@${recipients[5].id}>`), /not authorized/);
});

test('Vouch Admins are not exempt from STRIPSTAFF: over-limit gives and unauthorized vouch-role assignments are punished', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('210000000000000002');
  t.after(() => db.close());
  const vouchRole = '310000000000000010';
  const staffRole = '310000000000000011';
  const cosmetic = '310000000000000012';
  addRole(vouchRole);
  addRole(staffRole, [PermissionFlagsBits.ManageRoles]);
  addRole(cosmetic);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  addMember(OWNER_ID);
  const admin = addMember('410000000000000010', [staffRole, cosmetic]);
  db.addVouchAdmin(guild.id, admin.id, OWNER_ID);
  db.setVouchAdminLimit(guild.id, admin.id, 0);

  const target = addMember('410000000000000011');
  assert.equal(await run(guild, db, admin, `-vouch give <@${target.id}>`), LIMIT_MESSAGE);
  assert.deepEqual([...admin.roles.cache.keys()], [cosmetic], 'over-limit Vouch Admin loses only staff-permission roles');

  admin.roles.cache.set(staffRole, guild.roles.cache.get(staffRole));
  const recipient = addMember('410000000000000012', [vouchRole]);
  guild.auditEntries = [['admin-manual', {
    targetId: recipient.id, executor: admin.user,
    changes: [{ key: '$add', new: [{ id: vouchRole }] }], createdTimestamp: Date.now()
  }]];
  await handleGuildMemberUpdate({ ...recipient, roles: { cache: new Collection() } }, recipient, db);
  assert.equal(recipient.roles.cache.has(vouchRole), false, 'manual vouch-role assignment without a vouch is reversed');
  assert.deepEqual([...admin.roles.cache.keys()], [cosmetic], 'the Vouch Admin executor is punished');
});

test('OS manages the vouch role and Vouch Admins but cannot grant Owner Allow', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('210000000000000003');
  t.after(() => db.close());
  const vouchRole = '310000000000000020';
  const limitedRole = '310000000000000021';
  addRole(vouchRole);
  addRole(limitedRole);
  db.setLimitedRole(guild.id, limitedRole, 20);
  addMember(OWNER_ID);
  const osUser = addMember('410000000000000020');
  db.addOsUser(guild.id, osUser.id);
  const candidate = addMember('410000000000000021');

  assert.match(await run(guild, db, osUser, `-vouch role add <@&${vouchRole}>`), /official vouch role/);
  assert.equal(db.getSettings(guild.id).vouch_role_id, vouchRole);
  assert.match(await run(guild, db, osUser, '-vouch role remove'), /unset/);
  assert.equal(db.getSettings(guild.id).vouch_role_id, null);
  assert.equal(db.getLimitedRole(guild.id, limitedRole).member_limit, 20, 'vouch role commands never touch limited roles');

  assert.match(await run(guild, db, osUser, `-vouch owner allow <@${candidate.id}>`), /Only the Guild Owner can grant or remove Owner Allow/);
  assert.equal(db.isOwnerAllowed(guild.id, candidate.id), false);
  assert.match(await run(guild, db, osUser, '-vouch reset'), /Only the Guild Owner/);
});

test('Owner Allow: only the real Guild Owner grants it; holders get full owner access, uncapped vouches, and STRIPSTAFF exemption', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('210000000000000004');
  t.after(() => db.close());
  const vouchRole = '310000000000000030';
  const staffRole = '310000000000000031';
  const limitedRole = '310000000000000032';
  addRole(vouchRole);
  addRole(staffRole, [PermissionFlagsBits.ManageRoles]);
  addRole(limitedRole);
  const owner = addMember(OWNER_ID);
  const trusted = addMember('410000000000000030', [staffRole]);
  const another = addMember('410000000000000031');
  const regular = addMember('410000000000000032');

  assert.match(await run(guild, db, trusted, '-vouch reset'), /Only the Guild Owner/);
  assert.match(await run(guild, db, trusted, `-setlimit <@&${limitedRole}> 3`), /Only the Guild Owner/);
  assert.match(await run(guild, db, owner, `-vouch owner allow <@${trusted.id}>`), /full Guild Owner access/);
  assert.equal(db.isOwnerAllowed(guild.id, trusted.id), true);

  assert.match(await run(guild, db, trusted, `-setlimit <@&${limitedRole}> 3`), /3/);
  assert.equal(db.getLimitedRole(guild.id, limitedRole).member_limit, 3, 'Owner Allow can override bot settings');
  assert.match(await run(guild, db, trusted, `-vouch setrole <@&${vouchRole}>`), /official vouch role/);
  assert.match(await run(guild, db, trusted, `-vouch admin allow <@${another.id}>`), /Vouch Admin/);
  assert.ok(db.getVouchAdmin(guild.id, another.id), 'Owner Allow can grant Vouch Admin');
  assert.match(await run(guild, db, trusted, `-vouch owner allow <@${regular.id}>`), /Only the Guild Owner can grant or remove Owner Allow/);
  assert.equal(db.isOwnerAllowed(guild.id, regular.id), false, 'Owner Allow users cannot grant Owner Allow');

  assert.equal(giverLimit(guild.id, trusted.id, db, trusted), null, 'Owner Allow users are uncapped like the Guild Owner');
  const recipients = Array.from({ length: 6 }, (_, index) => addMember(`41000000000000040${index}`));
  for (const recipient of recipients) {
    assert.match(await run(guild, db, trusted, `-vouch give <@${recipient.id}>`), /received a vouch/);
  }
  assert.match(await run(guild, db, trusted, `-vouch admin take <@${recipients[0].id}>`), /was removed/);

  const unvouched = addMember('410000000000000050', [vouchRole]);
  guild.auditEntries = [['trusted-manual', {
    targetId: unvouched.id, executor: trusted.user,
    changes: [{ key: '$add', new: [{ id: vouchRole }] }], createdTimestamp: Date.now()
  }]];
  await handleGuildMemberUpdate({ ...unvouched, roles: { cache: new Collection() } }, unvouched, db);
  assert.equal(unvouched.roles.cache.has(vouchRole), false, 'Owner Allow assignments are still reversed');
  assert.equal(trusted.roles.cache.has(staffRole), true, 'Owner Allow users are exempt from STRIPSTAFF');

  assert.match(await run(guild, db, trusted, '-vouch reset'), /removed/);
  assert.equal(db.getVouches(guild.id).length, 0, 'Owner Allow can reset all vouches');
  assert.ok(db.getLimitedRole(guild.id, limitedRole), 'reset keeps limited-role configuration');

  assert.match(await run(guild, db, owner, `-vouch owner remove <@${trusted.id}>`), /no longer has Owner Allow/);
  assert.equal(db.isOwnerAllowed(guild.id, trusted.id), false);
  assert.match(await run(guild, db, trusted, '-vouch reset'), /Only the Guild Owner/);
});

test('new vouch admin commands run from edited messages', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('210000000000000005');
  t.after(() => db.close());
  const vouchRole = '310000000000000040';
  addRole(vouchRole);
  const owner = addMember(OWNER_ID);
  const admin = addMember('410000000000000060');
  const trusted = addMember('410000000000000061');
  const recipient = addMember('410000000000000062');

  assert.match(await runEdited(guild, db, owner, `-vouch admin allow <@${admin.id}>`), /Vouch Admin/);
  assert.match(await runEdited(guild, db, owner, `-vouch owner allow <@${trusted.id}>`), /full Guild Owner access/);
  assert.match(await runEdited(guild, db, owner, `-vouch role add <@&${vouchRole}>`), /official vouch role/);
  assert.match(await runEdited(guild, db, owner, `-vouch give <@${recipient.id}>`), /received a vouch/);
  assert.match(await runEdited(guild, db, admin, `-vouch admin take <@${recipient.id}>`), /was removed/);
  assert.match(await runEdited(guild, db, owner, '-vouch reset'), /removed/);
  assert.ok(db.getVouchAdmin(guild.id, admin.id));
  assert.equal(db.isOwnerAllowed(guild.id, trusted.id), true);
});

test('Vouch Admin and Owner Allow grants survive reopening SQLite', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-admin-'));
  const file = path.join(directory, 'test.sqlite');
  const guildId = '210000000000000006';
  const first = createDatabase(file);
  first.ensureGuild(guildId);
  first.addVouchAdmin(guildId, 'admin-user', OWNER_ID);
  first.setVouchAdminLimit(guildId, 'admin-user', 8);
  first.addOwnerAllowed(guildId, 'trusted-user', OWNER_ID);
  first.addVouch(guildId, 'recipient', 'admin-user', 'kept', new Date().toISOString());
  first.close();

  const reopened = createDatabase(file);
  t.after(() => {
    reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(reopened.getVouchAdmin(guildId, 'admin-user').custom_limit, 8);
  assert.equal(reopened.isOwnerAllowed(guildId, 'trusted-user'), true);
  assert.equal(reopened.getVouch(guildId, 'recipient').giver_id, 'admin-user');
});

test('help catalog lists the new access commands with permissions matching the code', async (t) => {
  const { db, guild, addMember } = createFixture('210000000000000007');
  t.after(() => db.close());
  const owner = addMember(OWNER_ID);
  const osUser = addMember('410000000000000070');
  db.addOsUser(guild.id, osUser.id);
  const admin = addMember('410000000000000071');
  db.addVouchAdmin(guild.id, admin.id, OWNER_ID);
  const trusted = addMember('410000000000000072');
  db.addOwnerAllowed(guild.id, trusted.id, OWNER_ID);
  const byCommand = new Map(catalog.map((entry) => [entry.command, entry]));
  const expectations = {
    '-vouch admin take @user [reason]': [owner, trusted, osUser, admin],
    '-vouch admin allow @user': [owner, trusted, osUser],
    '-vouch admin remove @user': [owner, trusted, osUser],
    '-vouch owner allow @user': [owner],
    '-vouch owner remove @user': [owner],
    '-vouch role add @role': [owner, trusted, osUser],
    '-vouch role remove': [owner, trusted, osUser],
    '-vouch reset': [owner, trusted],
    '-vouch addgiver @user': [owner, trusted, osUser, admin],
    '-fp add @user|@role ban_members': [owner, trusted, osUser],
    '-foreverban @user [reason]': [owner, trusted, osUser],
    '-unforeverban @user': [owner, trusted, osUser]
  };
  for (const [command, permitted] of Object.entries(expectations)) {
    const entry = byCommand.get(command);
    assert.ok(entry, `${command} is in the help catalog`);
    for (const viewer of [owner, trusted, osUser, admin]) {
      assert.equal(allowed(entry, viewer, db), permitted.includes(viewer), `${command} visibility for ${viewer.id}`);
    }
  }
  const lines = [];
  const pages = Math.ceil(dashboard.getEntries('access', owner, db).length / dashboard.PAGE_SIZE);
  for (let page = 1; page <= pages; page += 1) {
    lines.push(...dashboard.renderPage({ category: 'access', page, history: [], id: 'access' }, owner, db).data.description.split('\n'));
  }
  assert.deepEqual(lines.map((line) => line.split('`')[1]), [
    '-vouch admin allow @user', '-vouch admin remove @user',     '-vouch owner allow @user', '-vouch owner remove @user',
    '-fp add @user|@role ban_members', '-fp remove @user|@role ban_members', '-fp list'
  ]);
  const rolesLines = dashboard.renderPage({ category: 'roles', page: 1, history: [], id: 'roles' }, osUser, db).data.description;
  assert.match(rolesLines, /`-vouch setrole @role` — .*\(alias `-vouch role add`\)/);
  assert.match(rolesLines, /`-vouch unsetrole` — .*\(alias `-vouch role remove`\)/);
});
