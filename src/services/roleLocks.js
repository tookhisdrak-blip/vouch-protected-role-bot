const { AuditLogEvent } = require('discord.js');
const { isOs } = require('./permissions');
const {
  removeRoleDetailed, applyStripstaff, stripstaffPunishmentText
} = require('./roleProtection');
const { logEvent } = require('./eventLogger');
const { withDiscordRetry } = require('./discordRetry');

const auditDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const reversalLocks = new Set();

function auditEntryHasChange(entry, roleId, changeType) {
  const key = changeType === 'add' ? '$add' : '$remove';
  return (entry.changes || []).some((change) => {
    if (change.key !== key) return false;
    const roles = [
      ...(Array.isArray(change.new) ? change.new : []),
      ...(Array.isArray(change.old) ? change.old : [])
    ];
    return roles.some((role) => role.id === roleId);
  });
}

async function findRoleChangeExecutor(guild, targetId, roleId, changeType) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const logs = await withDiscordRetry(
        () => guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 12 }),
        { label: `Reading role-lock audit logs in ${guild.id}` }
      );
      const now = Date.now();
      const matches = logs.entries.filter((entry) => entry.targetId === targetId
        && Number.isFinite(entry.createdTimestamp)
        && now - entry.createdTimestamp >= 0
        && now - entry.createdTimestamp < 15_000
        && auditEntryHasChange(entry, roleId, changeType));
      if (matches.size === 1) return { entry: matches.first(), status: 'verified' };
      if (matches.size > 1) return { entry: null, status: 'ambiguous' };
    } catch (error) {
      console.warn(`Could not read role-lock audit logs in ${guild.id}:`, error.message);
      return { entry: null, status: 'unavailable', error };
    }
    if (attempt < 2) await auditDelay(650);
  }
  return { entry: null, status: 'not-found' };
}

async function fetchExecutorMember(guild, executor) {
  if (!executor) return null;
  try {
    const member = await guild.members.fetch({ user: executor.id, force: true });
    if (member) return member;
  } catch {
    // Fall back for partial guild mocks and older cache implementations.
  }
  return guild.members.fetch(executor.id).catch(() => null);
}

function executorAuthorized(executorMember, executor, guild, authorizationRoleIds, db) {
  if (!executor) return false;
  if (executor.id === guild.ownerId) return true;
  if (executorMember && isOs(executorMember, db)) return true;
  return Boolean(executorMember && authorizationRoleIds.some((roleId) => executorMember.roles.cache.has(roleId)));
}

async function verifyMemberRoleState(member, roleId, expected) {
  let refreshed = null;
  try {
    refreshed = await member.guild.members.fetch({ user: member.id, force: true });
    if (!refreshed) refreshed = await member.guild.members.fetch(member.id);
  } catch (error) {
    return { verified: false, error };
  }
  if (!refreshed) return { verified: false, error: new Error('Discord did not return the updated member') };
  const actual = refreshed.roles.cache.has(roleId);
  return {
    verified: actual === expected,
    error: actual === expected ? null : new Error(`Discord still reports the role as ${actual ? 'present' : 'absent'}`)
  };
}

async function reverseRoleChange(member, roleId, changeType) {
  const reason = `Unauthorized locked-role ${changeType === 'add' ? 'addition' : 'removal'}`;
  if (changeType === 'add') {
    const result = await removeRoleDetailed(member, roleId, reason);
    const verification = await verifyMemberRoleState(member, roleId, false);
    if (verification.verified) return { success: true, action: 'Unauthorized role addition reversed and verified' };
    return {
      success: false,
      action: 'Unauthorized role addition reversal failed verification',
      error: result.error || verification.error || new Error(`Role removal ended with status ${result.status}`)
    };
  }

  try {
    await withDiscordRetry(() => member.roles.add(roleId, reason), {
      label: `Restoring locked role ${roleId} to ${member.id}`,
      shouldContinue: () => !member.roles.cache.has(roleId)
    });
  } catch (error) {
    return { success: false, action: 'Unauthorized role removal reversal failed', error };
  }
  const verification = await verifyMemberRoleState(member, roleId, true);
  if (!verification.verified) {
    return {
      success: false,
      action: 'Unauthorized role removal reversal failed verification',
      error: verification.error || new Error('Discord did not confirm that the role was restored')
    };
  }
  return { success: true, action: 'Unauthorized role removal reversed and verified' };
}

function attributionReason(status, executor) {
  if (status === 'ambiguous') return 'Audit attribution was ambiguous; no executor was punished';
  if (status === 'unavailable') return 'Audit log was unavailable; no executor was punished';
  if (status === 'not-found') return 'No fresh matching audit entry was found; no executor was punished';
  if (executor?.bot) return 'Executor was a bot and exempt from punishment';
  return null;
}

async function enforceLockedRoleChange(member, roleId, changeType, db) {
  const key = `${member.guild.id}:${member.id}:${roleId}:${changeType}`;
  if (reversalLocks.has(key)) return false;
  reversalLocks.add(key);
  try {
    const lock = db.getRoleLock(member.guild.id, roleId);
    if (!lock) return false;
    if (changeType === 'add' && !member.roles.cache.has(roleId)) return false;
    if (changeType === 'remove' && member.roles.cache.has(roleId)) return false;

    const audit = await findRoleChangeExecutor(member.guild, member.id, roleId, changeType);
    const executor = audit.entry?.executor || null;
    const executorMember = await fetchExecutorMember(member.guild, executor);
    if (executorAuthorized(executorMember, executor, member.guild, lock.authorization_role_ids, db)) return true;

    const reversal = await reverseRoleChange(member, roleId, changeType);
    let punishment = { status: 'unverified' };
    if (reversal.success && executor && !executor.bot) {
      punishment = await applyStripstaff(member.guild, db, executor);
    } else if (executor?.bot) {
      punishment = { status: 'exempt' };
    }
    const details = [
      `Manual locked-role ${changeType === 'add' ? 'addition' : 'removal'} was not authorized`,
      attributionReason(audit.status, executor),
      reversal.error?.message ? `Reversal failure: ${reversal.error.message}` : null
    ].filter(Boolean);
    await logEvent(member.guild, db, {
      event_type: `LOCKED ROLE ${changeType === 'add' ? 'ADDITION' : 'REMOVAL'} VIOLATION`,
      executor_id: executor?.id || null,
      affected_user_id: member.id,
      role_id: roleId,
      reason: details.join('; '),
      action_taken: reversal.action,
      punishment: stripstaffPunishmentText(punishment)
    });
    return true;
  } finally {
    reversalLocks.delete(key);
  }
}

async function handleRoleLockUpdate(oldMember, newMember, db) {
  const locks = new Set(db.getRoleLocks(newMember.guild.id).map((lock) => lock.locked_role_id));
  if (!locks.size) return;
  const roleIds = new Set([...oldMember.roles.cache.keys(), ...newMember.roles.cache.keys()]);
  for (const roleId of roleIds) {
    if (!locks.has(roleId)) continue;
    const hadRole = oldMember.roles.cache.has(roleId);
    const hasRole = newMember.roles.cache.has(roleId);
    if (hadRole === hasRole) continue;
    await enforceLockedRoleChange(newMember, roleId, hasRole ? 'add' : 'remove', db);
  }
}

module.exports = {
  auditEntryHasChange,
  findRoleChangeExecutor,
  reverseRoleChange,
  enforceLockedRoleChange,
  handleRoleLockUpdate
};
