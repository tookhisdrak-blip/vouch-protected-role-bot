const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection } = require('discord.js');
const { createDatabase } = require('../src/database');
const { handleMessageCreate } = require('../src/events/messageCreate');

const OWNER_ID = '100000000000000001';

function createFixture(db = createDatabase(':memory:')) {
  const remoteMembers = new Collection();
  const remoteRoles = new Collection();
  const bans = [];
  const guild = {
    id: '230000000000000001',
    ownerId: OWNER_ID,
    roles: { cache: new Collection() },
    members: { cache: new Collection() },
    channels: { cache: new Collection() },
    bans: {
      async fetch() {
        const error = new Error('Unknown Ban');
        error.code = 10026;
        throw error;
      }
    },
    async fetchAuditLogs() {
      return { entries: new Collection() };
    }
  };
  db.ensureGuild(guild.id);

  guild.roles.fetch = async (id) => {
    const role = remoteRoles.get(id) || null;
    if (role) guild.roles.cache.set(id, role);
    return role;
  };
  guild.members.fetch = async (id) => {
    if (!id) {
      for (const [memberId, member] of remoteMembers) guild.members.cache.set(memberId, member);
      return new Collection(remoteMembers);
    }
    const member = remoteMembers.get(id) || null;
    if (member) guild.members.cache.set(id, member);
    return member;
  };
  guild.members.ban = async (id) => {
    bans.push(id);
  };

  function addRole(id, cached = true) {
    const role = {
      id,
      name: id,
      guild,
      permissions: { has: () => false }
    };
    Object.defineProperty(role, 'members', {
      get: () => new Collection([...remoteMembers]
        .filter(([, member]) => member.roles.cache.has(id)))
    });
    remoteRoles.set(id, role);
    if (cached) guild.roles.cache.set(id, role);
    return role;
  }

  function addMember(id, roleIds = [], cached = true) {
    const member = {
      id,
      guild,
      user: { id, bot: false, username: id, tag: `${id}#0001` },
      roles: {
        cache: new Collection(),
        async add(roleId) {
          member.roles.cache.set(roleId, remoteRoles.get(roleId) || { id: roleId });
        },
        async remove(roleId) {
          member.roles.cache.delete(roleId);
        }
      }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, remoteRoles.get(roleId) || { id: roleId });
    remoteMembers.set(id, member);
    if (cached) guild.members.cache.set(id, member);
    return member;
  }

  const client = {
    guilds: { cache: new Collection([[guild.id, guild]]) },
    users: {
      async fetch(id) {
        return remoteMembers.get(id)?.user || null;
      }
    }
  };

  async function run(member, content) {
    const replies = [];
    const message = {
      guild,
      member,
      author: member.user,
      content,
      client,
      replies,
      async reply(payload) {
        replies.push(payload);
        return payload;
      }
    };
    await handleMessageCreate(message, client, db, '-');
    return replies[0]?.embeds[0].data.description || '';
  }

  function setDatabase(nextDatabase) {
    db = nextDatabase;
  }

  return { db, guild, remoteMembers, remoteRoles, bans, addRole, addMember, run, setDatabase };
}

test('user and role commands accept mentions and uncached IDs without confusing target types', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const giver = fixture.addMember('430000000000000001', [], false);
  const permissionUser = fixture.addMember('430000000000000002', [], false);
  const vouchRole = fixture.addRole('330000000000000001', false);
  const rewardRole = fixture.addRole('330000000000000002', false);
  const permissionRole = fixture.addRole('330000000000000003', false);

  assert.match(await fixture.run(owner, `-setrole os ${giver.id}`), /is now OS/);
  assert.ok(fixture.db.getOsUsers(fixture.guild.id).includes(giver.id));
  assert.match(await fixture.run(owner, `-setrole os <@&${permissionRole.id}>`), /is now the OS role/);
  assert.equal(fixture.db.getSettings(fixture.guild.id).os_role_id, permissionRole.id);

  assert.match(await fixture.run(owner, `-vouch addgiver <@${giver.id}>`), /can give vouches/);
  assert.ok(fixture.db.getGiver(fixture.guild.id, giver.id));
  assert.match(await fixture.run(owner, `-vouch removegiver ${giver.id}`), /can no longer give vouches/);

  assert.match(await fixture.run(owner, `-vouch setreward <@&${rewardRole.id}>`), /now assigned with a vouch/);
  assert.equal(fixture.db.getSettings(fixture.guild.id).reward_role_id, rewardRole.id);
  fixture.guild.roles.cache.delete(vouchRole.id);
  assert.match(await fixture.run(owner, `-vouch setrole ${vouchRole.id}`), /official vouch role/);
  assert.equal(fixture.db.getSettings(fixture.guild.id).vouch_role_id, vouchRole.id);

  assert.match(await fixture.run(owner, `-fp add <@${permissionUser.id}> ban_members`), /<@430000000000000002> now has fake/);
  assert.equal(fixture.db.getFakePermissions(fixture.guild.id).at(-1).target_type, 'user');
  fixture.guild.roles.cache.delete(permissionRole.id);
  assert.match(await fixture.run(owner, `-fp add ${permissionRole.id} ban_members`), /<@&330000000000000003> now has fake/);
  assert.equal(fixture.db.getFakePermissions(fixture.guild.id)
    .find((row) => row.target_id === permissionRole.id).target_type, 'role');

  fixture.guild.members.cache.delete(permissionUser.id);
  fixture.guild.roles.cache.delete(permissionRole.id);
  assert.match(await fixture.run(owner, `-forcerolestrip ${permissionUser.id} ${permissionRole.id}`), /rule is active/);
  assert.equal(fixture.db.getForcedRoleStrip(fixture.guild.id, permissionUser.id, permissionRole.id).role_id, permissionRole.id);
});

test('default aliases execute the original handlers with their permission checks and arguments', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const owner = fixture.addMember(OWNER_ID);
  const giver = fixture.addMember('430000000000000011');
  const outsider = fixture.addMember('430000000000000012');
  const first = fixture.addMember('430000000000000013');
  const second = fixture.addMember('430000000000000014');

  assert.match(await fixture.run(outsider, `-vag ${giver.id}`), /Only Vouch Admins, OS, or the Guild Owner/);
  assert.equal(fixture.db.getGiver(fixture.guild.id, giver.id), undefined);
  assert.match(await fixture.run(owner, `-vag ${giver.id}`), /can give vouches/);

  assert.match(await fixture.run(giver, `-vg <@${first.id}> mention reason`), /received a vouch/);
  assert.equal(fixture.db.getVouch(fixture.guild.id, first.id).reason, 'mention reason');
  assert.match(await fixture.run(giver, `-vg ${second.id} id reason`), /received a vouch/);
  assert.equal(fixture.db.getVouch(fixture.guild.id, second.id).reason, 'id reason');
});

test('custom aliases persist, forward arguments, reject conflicts, and never bypass permissions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vouch-aliases-'));
  const databasePath = path.join(directory, 'state.sqlite');
  let db = createDatabase(databasePath);
  const fixture = createFixture(db);
  t.after(() => {
    if (db.connection.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const owner = fixture.addMember(OWNER_ID);
  const osUser = fixture.addMember('430000000000000021');
  const regular = fixture.addMember('430000000000000022');
  const target = fixture.addMember('430000000000000023', [], false);
  db.addOsUser(fixture.guild.id, osUser.id);

  assert.match(await fixture.run(regular, '-alias add fb foreverban'), /Only OS or the Guild Owner/);
  assert.equal(db.getCommandAlias(fixture.guild.id, 'fb'), undefined);
  assert.match(await fixture.run(osUser, '-alias add fb foreverban'), /now runs `-foreverban`/);
  assert.match(await fixture.run(osUser, '-alias add vg foreverban'), /conflicts with an existing command or default alias/);
  assert.match(await fixture.run(osUser, '-alias add vouch foreverban'), /conflicts with an existing command or default alias/);
  assert.match(await fixture.run(osUser, '-alias add nested fb'), /original command must be an existing command/);
  assert.match(await fixture.run(osUser, '-alias add Upper! foreverban'), /shortcuts must be/);
  assert.match(await fixture.run(osUser, '-alias add fb vouch check'), /now runs `-vouch check`/);
  assert.equal(db.getCommandAlias(fixture.guild.id, 'fb').command, 'vouch check');
  assert.match(await fixture.run(osUser, '-alias add fb foreverban'), /now runs `-foreverban`/);

  assert.match(await fixture.run(regular, `-fb ${target.id} denied`), /fake `ban_members` permission/);
  assert.equal(db.getForeverBan(fixture.guild.id, target.id), undefined);

  db.close();
  db = createDatabase(databasePath);
  fixture.setDatabase(db);
  assert.equal(db.getCommandAlias(fixture.guild.id, 'fb').command, 'foreverban');
  assert.match(await fixture.run(owner, `-fb ${target.id} persisted reason`), /active forever-ban rule/);
  assert.equal(db.getForeverBan(fixture.guild.id, target.id).reason, 'persisted reason');
  assert.deepEqual(fixture.bans, [target.id]);

  assert.match(await fixture.run(osUser, '-alias remove fb'), /was removed/);
  assert.equal(db.getCommandAlias(fixture.guild.id, 'fb'), undefined);
});
