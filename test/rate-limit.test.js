const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, PermissionFlagsBits, RateLimitError, DiscordAPIError } = require('discord.js');
const { createDatabase } = require('../src/database');
const {
  withDiscordRetry, configureRetryTiming, clearDeferredRetries, hasDeferredRetry,
  isTransientDiscordError, retryAfterMs
} = require('../src/services/discordRetry');
const { handleGuildMemberUpdate, applyStripstaff, reconcileVouchRole } = require('../src/services/roleProtection');
const { handleRoleLockUpdate, clearRoleLockEnforcementState } = require('../src/services/roleLocks');
const { handlePaidRoleUpdate, clearPaidRoleEnforcementState } = require('../src/services/paidRoles');
const { handleMessageCreate } = require('../src/events/messageCreate');
const { runGlobalRoleStrip } = require('../src/services/forceRules');

const OWNER_ID = '100000000000000001';
const sleeps = [];
const queued = [];

test.beforeEach(() => {
  sleeps.length = 0;
  queued.length = 0;
  clearDeferredRetries();
  clearRoleLockEnforcementState();
  clearPaidRoleEnforcementState();
  configureRetryTiming({
    sleep: async (ms) => { sleeps.push(ms); },
    schedule: (callback, ms) => { const task = { callback, ms }; queued.push(task); return task; },
    cancel: () => {}
  });
});

test.after(() => {
  clearDeferredRetries();
  configureRetryTiming();
});

async function drainQueue() {
  while (queued.length) await queued.shift().callback();
}

function rateLimit(retryAfter = 1200) {
  return new RateLimitError({
    retryAfter, timeToReset: retryAfter, global: false, scope: 'user', method: 'PATCH',
    route: '/guilds/:id/members/:id/roles/:id', url: 'https://discord.com/api', hash: 'h',
    limit: 1, majorParameter: '1', sublimitTimeout: 0
  });
}

function missingPermissions() {
  return new DiscordAPIError({ code: 50013, message: 'Missing Permissions' }, 50013, 403, 'PUT', 'https://discord.com/api', {});
}

function createFixture(guildId) {
  const db = createDatabase(':memory:');
  db.ensureGuild(guildId);
  const logs = [];
  const addEventLog = db.addEventLog;
  db.addEventLog = (entry) => { logs.push(entry); return addEventLog(entry); };
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

  // failures: { add: [errors...], remove: [errors...] } consumed one per call (per role id key).
  function addMember(id, roleIds = [], failures = {}) {
    const calls = { add: [], remove: [] };
    const member = {
      id,
      guild,
      calls,
      failures,
      user: { id, bot: false, username: id, tag: `${id}#0001` },
      roles: {
        cache: new Collection(),
        async add(roleId) {
          calls.add.push(roleId);
          const error = (member.failures.add?.[roleId] || []).shift();
          if (error) throw error;
          member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
        },
        async remove(roleId) {
          calls.remove.push(roleId);
          const error = (member.failures.remove?.[roleId] || []).shift();
          if (error) throw error;
          member.roles.cache.delete(roleId);
        }
      }
    };
    for (const roleId of roleIds) member.roles.cache.set(roleId, guild.roles.cache.get(roleId) || { id: roleId });
    guild.members.cache.set(id, member);
    return member;
  }

  guild.members.fetch = async (id) => (id ? guild.members.cache.get(id) || null : guild.members.cache);
  return { db, guild, logs, addRole, addMember };
}

function auditAdd(guild, target, executor, roleId) {
  guild.auditEntries = [[`audit-${target.id}-${roleId}`, {
    targetId: target.id, executor: executor.user,
    changes: [{ key: '$add', new: [{ id: roleId }] }], createdTimestamp: Date.now()
  }]];
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

test('classifies rate limits and temporary Discord failures as transient, permission errors as permanent', () => {
  assert.equal(isTransientDiscordError(rateLimit()), true, 'discord.js RateLimitError');
  assert.equal(retryAfterMs(rateLimit(1500)), 1500);
  const raw429 = Object.assign(new Error('429'), { status: 429, rawError: { retry_after: 2.5 } });
  assert.equal(isTransientDiscordError(raw429), true);
  assert.equal(retryAfterMs(raw429), 2500, 'retry_after seconds are converted to ms');
  assert.equal(isTransientDiscordError(Object.assign(new Error('bad gateway'), { status: 502 })), true);
  assert.equal(isTransientDiscordError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientDiscordError(Object.assign(new Error('timeout'), { name: 'AbortError' })), true);
  assert.equal(isTransientDiscordError(missingPermissions()), false);
  assert.equal(isTransientDiscordError(Object.assign(new Error('unknown member'), { status: 404, code: 10007 })), false);
});

test('withDiscordRetry waits for retry_after and does not treat a rate limit as a failure', async () => {
  let calls = 0;
  const result = await withDiscordRetry(async () => {
    calls += 1;
    if (calls < 3) throw rateLimit(2000);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  for (const ms of sleeps) assert.ok(ms >= 2000 && ms < 2250, `waited retry_after (+jitter), got ${ms}`);

  let permanentCalls = 0;
  await assert.rejects(withDiscordRetry(async () => { permanentCalls += 1; throw missingPermissions(); }), /Missing Permissions/);
  assert.equal(permanentCalls, 1, 'permanent errors are not retried');
});

test('LockRole queues one reversal, respects retry_after, then punishes once', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000010');
  t.after(() => db.close());
  const lockedRole = '320000000000000010';
  const authorizationRole = '320000000000000011';
  const staffRole = '320000000000000012';
  addRole(lockedRole);
  addRole(authorizationRole);
  addRole(staffRole, [PermissionFlagsBits.ManageRoles]);
  db.setRoleLock(guild.id, lockedRole, [authorizationRole], OWNER_ID);
  const executor = addMember('420000000000000010', [staffRole]);
  const target = addMember('420000000000000011', [lockedRole], {
    remove: { [lockedRole]: [rateLimit(1250), rateLimit(1250)] }
  });
  auditAdd(guild, target, executor, lockedRole);
  const oldMember = { ...target, roles: { cache: new Collection() } };

  await Promise.all(Array.from({ length: 10 }, () =>
    handleRoleLockUpdate(oldMember, target, db)));

  assert.equal(target.calls.remove.length, 3, 'two rate limits and one successful removal');
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 1250 && ms < 1500));
  assert.equal(target.roles.cache.has(lockedRole), false);
  assert.equal(executor.calls.remove.length, 1, 'executor is punished only once');
  assert.equal(db.connection.prepare('SELECT COUNT(*) AS count FROM event_logs').get().count, 1);
});

test('paid-role enforcement shares the queue, respects retry_after, and punishes once', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000011');
  t.after(() => db.close());
  const paidRole = '320000000000000020';
  const staffRole = '320000000000000021';
  addRole(paidRole);
  addRole(staffRole, [PermissionFlagsBits.ManageRoles]);
  db.addPaidRole(guild.id, paidRole, OWNER_ID);
  const executor = addMember('420000000000000020', [staffRole]);
  const target = addMember('420000000000000021', [paidRole], {
    remove: { [paidRole]: [rateLimit(1750), rateLimit(1750)] }
  });
  auditAdd(guild, target, executor, paidRole);
  const oldMember = { ...target, roles: { cache: new Collection() } };

  await Promise.all(Array.from({ length: 10 }, () =>
    handlePaidRoleUpdate(oldMember, target, db)));

  assert.equal(target.calls.remove.length, 3, 'two rate limits and one successful removal');
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 1750 && ms < 2000));
  assert.equal(target.roles.cache.has(paidRole), false);
  assert.equal(executor.calls.remove.length, 1);
  const log = db.connection.prepare("SELECT * FROM event_logs WHERE event_type = 'PAID ROLE VIOLATION'").get();
  assert.equal(log.action_taken, 'Unauthorized paid role removed and verified');
  assert.equal(log.punishment, 'STRIPSTAFF removed');
});

test('unauthorized vouch-role removal is retried after a rate limit and the executor is still punished', async (t) => {
  const { db, guild, logs, addRole, addMember } = createFixture('220000000000000001');
  t.after(() => db.close());
  const vouchRole = '320000000000000001';
  const staffRole = '320000000000000002';
  const cosmetic = '320000000000000003';
  addRole(vouchRole);
  addRole(staffRole, [PermissionFlagsBits.ManageMessages]);
  addRole(cosmetic);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  addMember(OWNER_ID);
  const staff = addMember('420000000000000001', [staffRole, cosmetic], { remove: { [staffRole]: [rateLimit(800)] } });
  const target = addMember('420000000000000002', [vouchRole], { remove: { [vouchRole]: [rateLimit(1000), rateLimit(1000)] } });
  auditAdd(guild, target, staff, vouchRole);

  await handleGuildMemberUpdate({ ...target, roles: { cache: new Collection() } }, target, db);

  assert.equal(target.roles.cache.has(vouchRole), false, 'role removed after waiting out the rate limit');
  assert.equal(target.calls.remove.length, 3);
  assert.deepEqual([...staff.roles.cache.keys()], [cosmetic], 'STRIPSTAFF completed after its own rate limit; cosmetic kept');
  assert.equal(queued.length, 0, 'no background retry needed');
  const log = logs.find((entry) => entry.event_type === 'VOUCH ROLE VIOLATION');
  assert.equal(log.action_taken, 'Role removed');
  assert.equal(log.punishment, 'STRIPSTAFF removed');
});

test('persistent rate limit defers the vouch-role removal and STRIPSTAFF instead of failing them', async (t) => {
  const { db, guild, logs, addRole, addMember } = createFixture('220000000000000002');
  t.after(() => db.close());
  const vouchRole = '320000000000000011';
  const staffRole = '320000000000000012';
  const booster = '320000000000000013';
  addRole(vouchRole);
  addRole(staffRole, [PermissionFlagsBits.KickMembers]);
  addRole(booster);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  addMember(OWNER_ID);
  const many = () => Array.from({ length: 4 }, () => rateLimit(1000));
  const staff = addMember('420000000000000011', [staffRole, booster], { remove: { [staffRole]: many() } });
  const target = addMember('420000000000000012', [vouchRole], { remove: { [vouchRole]: many() } });
  auditAdd(guild, target, staff, vouchRole);

  await handleGuildMemberUpdate({ ...target, roles: { cache: new Collection() } }, target, db);

  assert.equal(target.roles.cache.has(vouchRole), true, 'still rate limited inline');
  assert.ok(hasDeferredRetry(`remove:${guild.id}:${target.id}:${vouchRole}`));
  assert.ok(hasDeferredRetry(`remove:${guild.id}:${staff.id}:${staffRole}`));
  const log = logs.find((entry) => entry.event_type === 'VOUCH ROLE VIOLATION');
  assert.equal(log.action_taken, 'Role removal rate limited by Discord; automatic retry scheduled');
  assert.match(log.punishment, /STRIPSTAFF in progress \(0 role\(s\) removed; 1 queued for automatic retry/);
  assert.ok(queued.every((task) => task.ms >= 1000), 'deferred retry waits for retry_after');

  const eventsBefore = logs.length;
  await handleGuildMemberUpdate({ ...target, roles: { cache: new Collection() } }, target, db);
  assert.equal(logs.length, eventsBefore + 1, 'a repeat event reports the pending removal without duplicating the retry');
  assert.equal(queued.length, 2, 'retries are deduplicated');

  await drainQueue();
  assert.equal(target.roles.cache.has(vouchRole), false, 'deferred removal completed');
  assert.deepEqual([...staff.roles.cache.keys()], [booster], 'deferred STRIPSTAFF completed and kept the booster role');
  assert.equal(hasDeferredRetry(`remove:${guild.id}:${target.id}:${vouchRole}`), false);
});

test('deferred vouch-role removal is skipped if the member received a real vouch meanwhile', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000003');
  t.after(() => db.close());
  const vouchRole = '320000000000000021';
  addRole(vouchRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  addMember(OWNER_ID);
  const target = addMember('420000000000000021', [vouchRole], { remove: { [vouchRole]: Array.from({ length: 4 }, () => rateLimit(500)) } });

  const result = await reconcileVouchRole(guild, db);
  assert.deepEqual(result.cleanupFailures, [], 'a rate-limited removal is not reported as a failure');
  assert.equal(queued.length, 1);

  db.addVouch(guild.id, target.id, OWNER_ID, 'legit', new Date().toISOString());
  await drainQueue();
  assert.equal(target.roles.cache.has(vouchRole), true, 'a now-valid vouch role is not removed by the stale retry');
  assert.equal(target.calls.remove.length, 4, 'no extra removal attempt after the re-check');
});

test('limited-role 21st member reversal survives a rate limit and still punishes a normal executor', async (t) => {
  const { db, guild, logs, addRole, addMember } = createFixture('220000000000000004');
  t.after(() => db.close());
  const limited = '320000000000000031';
  const staffRole = '320000000000000032';
  addRole(limited);
  addRole(staffRole, [PermissionFlagsBits.ManageRoles]);
  db.setLimitedRole(guild.id, limited, 20);
  addMember(OWNER_ID);
  for (let index = 0; index < 20; index += 1) addMember(`4200000000000001${String(index).padStart(2, '0')}`, [limited]);
  const staff = addMember('420000000000000031', [staffRole]);
  const extra = addMember('420000000000000032', [limited], { remove: { [limited]: [rateLimit(700)] } });
  auditAdd(guild, extra, staff, limited);

  await handleGuildMemberUpdate({ ...extra, roles: { cache: new Collection() } }, extra, db);

  assert.equal(extra.roles.cache.has(limited), false);
  assert.equal(guild.roles.cache.get(limited).members.size, 20);
  assert.equal(staff.roles.cache.has(staffRole), false, 'normal executor STRIPSTAFFed');
  assert.equal(logs.find((entry) => entry.event_type === 'ROLE LIMIT VIOLATION').action_taken, 'Role removed');
});

test('deferred limited-role reversal is skipped once the role is back under its limit', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000005');
  t.after(() => db.close());
  const limited = '320000000000000041';
  addRole(limited);
  db.setLimitedRole(guild.id, limited, 1);
  const owner = addMember(OWNER_ID);
  const holder = addMember('420000000000000041', [limited]);
  const extra = addMember('420000000000000042', [limited], { remove: { [limited]: Array.from({ length: 4 }, () => rateLimit(500)) } });
  auditAdd(guild, extra, owner, limited);

  await handleGuildMemberUpdate({ ...extra, roles: { cache: new Collection() } }, extra, db);
  assert.equal(queued.length, 1, 'reversal deferred');
  assert.equal(owner.roles.cache.size, 0, 'Guild Owner is not punished');

  holder.roles.cache.delete(limited);
  await drainQueue();
  assert.equal(extra.roles.cache.has(limited), true, 'no stale reversal once a slot freed up');
});

test('manually removed valid vouch role is restored after a rate limit (deferred if needed)', async (t) => {
  const { db, guild, logs, addRole, addMember } = createFixture('220000000000000006');
  t.after(() => db.close());
  const vouchRole = '320000000000000051';
  addRole(vouchRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  addMember(OWNER_ID);
  const target = addMember('420000000000000051', [], { add: { [vouchRole]: Array.from({ length: 4 }, () => rateLimit(900)) } });
  db.addVouch(guild.id, target.id, OWNER_ID, 'valid', new Date().toISOString());

  await handleGuildMemberUpdate({ ...target, roles: { cache: new Collection([[vouchRole, guild.roles.cache.get(vouchRole)]]) } }, target, db);
  assert.equal(target.roles.cache.has(vouchRole), false);
  assert.equal(logs.at(-1).action_taken, 'Role restore rate limited by Discord; automatic retry scheduled');
  await drainQueue();
  assert.equal(target.roles.cache.has(vouchRole), true, 'valid vouch keeps the vouch role');
});

test('-vouch give keeps the vouch when the reward/vouch role add is rate limited and assigns it later', async (t) => {
  const { db, guild, logs, addRole, addMember } = createFixture('220000000000000007');
  t.after(() => db.close());
  const vouchRole = '320000000000000061';
  const rewardRole = '320000000000000062';
  addRole(vouchRole);
  addRole(rewardRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  db.setSetting(guild.id, 'reward_role_id', rewardRole);
  const owner = addMember(OWNER_ID);
  const target = addMember('420000000000000061', [], {
    add: { [vouchRole]: [rateLimit(600)], [rewardRole]: Array.from({ length: 4 }, () => rateLimit(600)) }
  });

  const reply = await run(guild, db, owner, `-vouch give <@${target.id}>`);
  assert.match(reply, /received a vouch/);
  assert.match(reply, /rate limiting role changes/);
  assert.ok(db.getVouch(guild.id, target.id), 'vouch is kept, not rolled back');
  assert.equal(target.roles.cache.has(vouchRole), true, 'vouch role assigned after an inline retry');
  assert.equal(target.roles.cache.has(rewardRole), false);
  assert.match(logs.find((entry) => entry.event_type === 'VOUCH GIVEN').action_taken, /queued for automatic assignment/);

  await drainQueue();
  assert.equal(target.roles.cache.has(rewardRole), true, 'reward role assigned by the deferred retry');
});

test('-vouch give still rolls back cleanly on a permanent permission error', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000008');
  t.after(() => db.close());
  const vouchRole = '320000000000000071';
  addRole(vouchRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  const owner = addMember(OWNER_ID);
  const target = addMember('420000000000000071', [], { add: { [vouchRole]: [missingPermissions()] } });

  assert.match(await run(guild, db, owner, `-vouch give <@${target.id}>`), /vouch was not saved/);
  assert.equal(db.getVouch(guild.id, target.id), undefined);
  assert.equal(target.roles.cache.has(vouchRole), false);
  assert.equal(queued.length, 0);
});

test('deferred reward-role add is dropped if the vouch is taken before Discord allows it', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000009');
  t.after(() => db.close());
  const vouchRole = '320000000000000081';
  addRole(vouchRole);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  const owner = addMember(OWNER_ID);
  const target = addMember('420000000000000081', [], { add: { [vouchRole]: Array.from({ length: 4 }, () => rateLimit(600)) } });

  await run(guild, db, owner, `-vouch give <@${target.id}>`);
  assert.equal(queued.length, 1);
  assert.match(await run(guild, db, owner, `-vouch take <@${target.id}>`), /was removed/);
  await drainQueue();
  assert.equal(target.roles.cache.has(vouchRole), false, 'no role for a member whose vouch was removed');
});

test('-vouch take and STRIPSTAFF retry rate-limited role removals', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000010');
  t.after(() => db.close());
  const vouchRole = '320000000000000091';
  const staffA = '320000000000000092';
  const staffB = '320000000000000093';
  const cosmetic = '320000000000000094';
  addRole(vouchRole);
  addRole(staffA, [PermissionFlagsBits.BanMembers]);
  addRole(staffB, [PermissionFlagsBits.MuteMembers]);
  addRole(cosmetic);
  db.setSetting(guild.id, 'vouch_role_id', vouchRole);
  const owner = addMember(OWNER_ID);
  const target = addMember('420000000000000091', [vouchRole], { remove: { [vouchRole]: [rateLimit(500)] } });
  db.addVouch(guild.id, target.id, OWNER_ID, 'valid', new Date().toISOString());

  assert.match(await run(guild, db, owner, `-vouch take <@${target.id}>`), /was removed/);
  assert.equal(target.roles.cache.has(vouchRole), false);

  const staff = addMember('420000000000000092', [staffA, staffB, cosmetic], {
    remove: { [staffA]: [Object.assign(new Error('Service Unavailable'), { status: 503 })], [staffB]: [rateLimit(400)] }
  });
  const punishment = await applyStripstaff(guild, db, staff.user);
  assert.equal(punishment.status, 'removed');
  assert.deepEqual([...staff.roles.cache.keys()], [cosmetic]);
});

test('global force strip counts rate-limited removals as queued, not failed', async (t) => {
  const { db, guild, addRole, addMember } = createFixture('220000000000000011');
  t.after(() => db.close());
  const role = '320000000000000101';
  addRole(role);
  addMember(OWNER_ID);
  addMember('420000000000000101', [role]);
  addMember('420000000000000102', [role], { remove: { [role]: Array.from({ length: 4 }, () => rateLimit(500)) } });

  const result = await runGlobalRoleStrip(guild, guild.roles.cache.get(role), OWNER_ID, db);
  assert.equal(result.ok, true);
  assert.equal(result.stripped, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.queued, 1);
  await drainQueue();
  assert.equal(guild.roles.cache.get(role).members.size, 0);
});
