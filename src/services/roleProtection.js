const { AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { isOwnerOrOs } = require('./permissions');
const { logEvent } = require('./eventLogger');

const removalQueue = new Set();
const auditDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const staffPermissions = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageGuildExpressions
].filter((permission) => permission !== undefined);

function auditRoleWasAdded(entry, roleId) {
  return (entry.changes || []).some((change) => change.key === '$add'
    && Array.isArray(change.new)
    && change.new.some((role) => role.id === roleId));
}

async function findRoleExecutor(guild, targetId, roleId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 8 });
      const matches = logs.entries.filter((candidate) => candidate.targetId === targetId
        && Date.now() - candidate.createdTimestamp >= 0
        && Date.now() - candidate.createdTimestamp < 15000
        && auditRoleWasAdded(candidate, roleId));
      if (matches.size === 1) return { entry: matches.first(), error: null, ambiguous: false };
      if (matches.size > 1) return { entry: null, error: null, ambiguous: true };
    } catch (error) {
      console.warn(`Could not read audit logs in ${guild.id}:`, error.message);
      return { entry: null, error, ambiguous: false };
    }
    if (attempt < 2) await auditDelay(650);
  }
  return { entry: null, error: null, ambiguous: false };
}

async function removeRoleDetailed(member, roleId, reason) {
  const key = `${member.guild.id}:${member.id}:${roleId}`;
  if (removalQueue.has(key)) return { status: 'busy', error: null };
  if (!member.roles.cache.has(roleId)) return { status: 'absent', error: null };
  removalQueue.add(key);
  try {
    await member.roles.remove(roleId, reason);
    return { status: 'removed', error: null };
  } catch (error) {
    console.warn(`Could not remove role ${roleId} from ${member.id}:`, error.message);
    return { status: 'failed', error };
  } finally {
    removalQueue.delete(key);
  }
}

async function removeRoleOnce(member, roleId, reason) {
  return (await removeRoleDetailed(member, roleId, reason)).status === 'removed';
}

async function applyStripstaff(guild, db, executor) {
  if (!executor) return { status: 'unverified' };
  if (executor.bot || executor.id === guild.ownerId) return { status: 'exempt' };
  const executorMember = await guild.members.fetch(executor.id).catch(() => null);
  if (!executorMember) return { status: 'unavailable' };
  if (isOwnerOrOs(executorMember, db)) return { status: 'exempt' };

  const staffRoleIds = [...executorMember.roles.cache.values()]
    .filter((role) => role.id !== guild.id
      && role.permissions
      && staffPermissions.some((permission) => role.permissions.has(permission)))
    .map((role) => role.id);
  if (!staffRoleIds.length) return { status: 'no-staff-roles' };
  const results = await Promise.all(staffRoleIds.map((roleId) =>
    removeRoleDetailed(executorMember, roleId, 'Protected role enforcement')));
  const removed = results.filter((result) => result.status === 'removed').length;
  const failed = results.filter((result) => result.status === 'failed' || result.status === 'busy').length;
  if (removed && failed) return { status: 'partial', removed, failed };
  if (removed) return { status: 'removed', removed };
  return { status: 'failed', removed: 0, failed };
}

async function enforceViolation(member, roleId, violation, db) {
  const roleRemoval = await removeRoleDetailed(member, roleId, violation.reason);
  if (roleRemoval.status === 'absent' || roleRemoval.status === 'busy') return false;

  const auditResult = await findRoleExecutor(member.guild, member.id, roleId);
  const executor = auditResult.entry?.executor || null;
  const punishment = await applyStripstaff(member.guild, db, executor);
  const roleRemovalFailed = roleRemoval.status === 'failed';
  const auditDetail = auditResult.error
    ? 'Audit log unavailable; executor could not be verified'
    : auditResult.ambiguous ? 'Audit attribution ambiguous; executor could not be verified'
      : !executor ? 'No fresh matching audit entry; executor could not be verified' : null;
  const punishmentText = punishment.status === 'removed' ? 'STRIPSTAFF removed'
    : punishment.status === 'failed' ? 'STRIPSTAFF removal failed; check Manage Roles and role hierarchy'
      : punishment.status === 'partial' ? `STRIPSTAFF partially removed (${punishment.removed} role(s) removed; ${punishment.failed} failed)`
      : punishment.status === 'exempt' ? 'None (exempt)'
          : punishment.status === 'unverified' ? 'None (executor unverified)'
          : punishment.status === 'unavailable' ? 'None (executor unavailable)'
                : 'None (no staff-permission roles held)';

  await logEvent(member.guild, db, {
    event_type: violation.eventType,
    executor_id: executor?.id || null,
    affected_user_id: member.id,
    role_id: roleId,
    reason: [violation.reason, auditDetail].filter(Boolean).join('; '),
    action_taken: roleRemovalFailed ? 'Role removal failed; check Manage Roles and role hierarchy' : 'Role removed',
    punishment: punishmentText
  });
  return true;
}

function roleChangeForEntry(entry, roleId) {
  for (const change of entry.changes || []) {
    if (change.key !== '$add' && change.key !== '$remove') continue;
    const roles = [
      ...(Array.isArray(change.new) ? change.new : []),
      ...(Array.isArray(change.old) ? change.old : [])
    ];
    if (Array.isArray(roles) && roles.some((role) => role.id === roleId)) {
      return change.key === '$add' ? 'add' : 'remove';
    }
  }
  return null;
}

async function latestRoleAssignmentMembers(guild, roleId, members) {
  let logs;
  try {
    logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 100 });
  } catch (error) {
    console.warn(`Could not inspect role assignment history for ${roleId} in ${guild.id}:`, error.message);
    return { members: [], auditUnavailable: true };
  }

  const currentMemberIds = new Set(members.keys());
  const latestByMember = new Map();
  for (const entry of logs.entries.values()) {
    if (!currentMemberIds.has(entry.targetId)) continue;
    const change = roleChangeForEntry(entry, roleId);
    if (!change || !Number.isFinite(entry.createdTimestamp)) continue;
    const current = latestByMember.get(entry.targetId);
    if (!current || entry.createdTimestamp > current.createdTimestamp) {
      latestByMember.set(entry.targetId, {
        memberId: entry.targetId,
        change,
        createdTimestamp: entry.createdTimestamp
      });
    } else if (entry.createdTimestamp === current.createdTimestamp && current.change !== change) {
      current.change = 'ambiguous';
    }
  }

  const assignments = [...latestByMember.values()]
    .filter((entry) => entry.change === 'add')
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp);
  return { members: assignments, auditUnavailable: false };
}

async function reconcileLimitedRole(guild, db, roleId, reason = 'Limited role reconciliation') {
  const role = guild.roles.cache.get(roleId);
  const config = db.getLimitedRole(guild.id, roleId);
  if (!role || !config) return { removed: [], remainingExcess: 0, auditUnavailable: false };
  const currentMembers = role.members;
  const excessCount = currentMembers.size - config.member_limit;
  if (excessCount <= 0) return { removed: [], remainingExcess: 0, auditUnavailable: false };

  const assignments = await latestRoleAssignmentMembers(guild, roleId, currentMembers);
  const selectedMembers = [];
  for (let index = 0; index < assignments.members.length && selectedMembers.length < excessCount;) {
    const assignment = assignments.members[index];
    const nextIndex = assignments.members.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.createdTimestamp !== assignment.createdTimestamp);
    const groupEnd = nextIndex === -1 ? assignments.members.length : nextIndex;
    if (groupEnd - index > 1) break;
    selectedMembers.push(currentMembers.get(assignment.memberId));
    index = groupEnd;
  }

  const removed = [];
  for (const member of selectedMembers) {
    const result = await removeRoleDetailed(member, roleId, reason);
    if (result.status === 'removed') removed.push(member.id);
  }
  const remainingExcess = Math.max(0, role.members.size - config.member_limit);
  if (remainingExcess > 0) {
    console.warn(`Limited role ${roleId} in ${guild.id} remains over limit by ${remainingExcess}; no unverified member was removed.`);
  }
  return { removed, remainingExcess, auditUnavailable: assignments.auditUnavailable };
}

async function enforceVouchRoleState(member, db) {
  const settings = db.getSettings(member.guild.id);
  const roleId = settings?.vouch_role_id;
  if (!roleId || !member.roles.cache.has(roleId) || db.getVouch(member.guild.id, member.id)) return false;
  return enforceViolation(member, roleId, {
    eventType: 'VOUCH ROLE VIOLATION',
    reason: 'No active vouch exists for this member'
  }, db);
}

async function reconcileVouchRole(guild, db, reason = 'Vouch role reconciliation: no active vouch') {
  const roleId = db.getSettings(guild.id)?.vouch_role_id;
  if (!roleId || !guild.roles.cache.has(roleId)) return { cleanupFailures: [], memberFetchFailed: false };
  let memberFetchFailed = false;
  const members = await guild.members.fetch().catch((error) => {
    memberFetchFailed = true;
    console.warn(`Could not fetch members for vouch role reconciliation in ${guild.id}:`, error.message);
    return guild.members.cache;
  });
  const activeVouchRecipients = new Set(db.getVouches(guild.id).map((vouch) => vouch.recipient_id));
  const cleanupFailures = [];
  for (const member of members.values()) {
    if (!member.roles.cache.has(roleId) || activeVouchRecipients.has(member.id)) continue;
    const removal = await removeRoleDetailed(member, roleId, reason);
    if (removal.status === 'failed' || removal.status === 'busy') cleanupFailures.push(member.id);
  }
  return { cleanupFailures, memberFetchFailed };
}

async function handleGuildMemberUpdate(oldMember, newMember, db) {
  const handledRoleIds = new Set();
  const guildId = newMember.guild.id;
  const settings = db.getSettings(guildId);
  if (!settings) return handledRoleIds;

  const addedRoleIds = newMember.roles.cache
    .filter((role) => !oldMember.roles.cache.has(role.id))
    .map((role) => role.id);

  const limitedRoles = new Map(db.getLimitedRoles(guildId).map((row) => [row.role_id, row.member_limit]));
  for (const roleId of addedRoleIds) {
    const limit = limitedRoles.get(roleId);
    if (limit !== undefined && newMember.guild.roles.cache.get(roleId)?.members.size > limit) {
      const handled = await enforceViolation(newMember, roleId, {
        eventType: 'ROLE LIMIT VIOLATION',
        reason: `Member limit is ${limit}`
      }, db);
      if (handled) handledRoleIds.add(roleId);
    }
  }
  if (await enforceVouchRoleState(newMember, db)) handledRoleIds.add(settings.vouch_role_id);
  else if (await restoreRemovedVouchRole(oldMember, newMember, db)) handledRoleIds.add(settings.vouch_role_id);
  return handledRoleIds;
}

// The vouch record is the source of truth: removing the role manually does not end a vouch.
// takeVouch/wipe delete the record before removing the role, so they are never reverted here.
async function restoreRemovedVouchRole(oldMember, newMember, db) {
  const guild = newMember.guild;
  const roleId = db.getSettings(guild.id)?.vouch_role_id;
  if (!roleId || !oldMember.roles.cache.has(roleId) || newMember.roles.cache.has(roleId)) return false;
  if (!db.getVouch(guild.id, newMember.id)) return false;
  const role = guild.roles.cache.get(roleId);
  if (!role) return false;
  // Force Management strips are explicit owner/OS decisions; never re-add a force-stripped role.
  if (db.getGlobalRoleStrip(guild.id, roleId) || db.getForcedRoleStrip(guild.id, newMember.id, roleId)) return false;
  const limit = db.getLimitedRole(guild.id, roleId);
  // Never fight the separate member-limit system: only restore when a slot is free.
  if (limit && role.members.size >= limit.member_limit) return false;
  try {
    await newMember.roles.add(roleId, 'Active vouch still exists; use -vouch take to remove a vouch');
  } catch (error) {
    console.warn(`Could not restore vouch role ${roleId} to ${newMember.id}:`, error.message);
    return false;
  }
  await logEvent(guild, db, {
    event_type: 'VOUCH ROLE RESTORED',
    executor_id: null,
    affected_user_id: newMember.id,
    role_id: roleId,
    reason: 'The vouch role was removed while the member still has an active vouch',
    action_taken: 'Role restored; vouches can only be removed with -vouch take',
    punishment: null
  });
  return true;
}

async function handleGuildMemberAdd(member, db) {
  const settings = db.getSettings(member.guild.id);
  if (!settings) return false;
  const limitedRoleIds = new Set(db.getLimitedRoles(member.guild.id).map((row) => row.role_id));
  for (const roleId of member.roles.cache.keys()) {
    if (!limitedRoleIds.has(roleId)) continue;
    const config = db.getLimitedRole(member.guild.id, roleId);
    if (config && member.guild.roles.cache.get(roleId)?.members.size > config.member_limit) {
      await enforceViolation(member, roleId, {
        eventType: 'ROLE LIMIT VIOLATION',
        reason: `Member limit is ${config.member_limit}`
      }, db);
    }
  }
  return enforceVouchRoleState(member, db);
}

async function reconcileGuild(guild, db) {
  const settings = db.getSettings(guild.id);
  if (!settings) return;
  for (const roleId of [settings.os_role_id, settings.vouch_role_id, settings.reward_role_id, settings.stripstaff_role_id]) {
    if (roleId && !guild.roles.cache.has(roleId)) {
      const settingKey = roleId === settings.os_role_id ? 'os_role_id'
        : roleId === settings.vouch_role_id ? 'vouch_role_id'
          : roleId === settings.reward_role_id ? 'reward_role_id' : 'stripstaff_role_id';
      db.setSetting(guild.id, settingKey, null);
    }
  }

  const existingRoleIds = new Set(guild.roles.cache.keys());
  const members = await guild.members.fetch().catch((error) => {
    console.warn(`Could not fetch members for startup reconciliation in ${guild.id}:`, error.message);
    return guild.members.cache;
  });

  const activeVouchRecipients = new Set(db.getVouches(guild.id).map((vouch) => vouch.recipient_id));
  if (settings.vouch_role_id && existingRoleIds.has(settings.vouch_role_id)) {
    for (const member of members.values()) {
      if (member.roles.cache.has(settings.vouch_role_id) && !activeVouchRecipients.has(member.id)) {
        await removeRoleOnce(member, settings.vouch_role_id, 'Startup reconciliation: no active vouch');
      }
    }
  }

  for (const { role_id: roleId } of db.getLimitedRoles(guild.id)) {
    if (!existingRoleIds.has(roleId)) continue;
    await reconcileLimitedRole(guild, db, roleId, 'Startup reconciliation: configured member limit');
  }
}

module.exports = {
  handleGuildMemberUpdate,
  handleGuildMemberAdd,
  reconcileVouchRole,
  reconcileLimitedRole,
  latestRoleAssignmentMembers,
  staffPermissions,
  reconcileGuild,
  removeRoleOnce,
  removeRoleDetailed,
  findRoleExecutor,
  applyStripstaff
};