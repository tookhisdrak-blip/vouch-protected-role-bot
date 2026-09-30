const { AuditLogEvent } = require('discord.js');
const { isOs } = require('./permissions');
const { applyStripstaff, stripstaffPunishmentText } = require('./roleProtection');
const { logEvent } = require('./eventLogger');
const { withDiscordRetry } = require('./discordRetry');

const auditDelay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const activeEnforcements = new Set();
const roleOperationQueues = new Map();
const expectedReversals = new Map();
const processedIncidents = new Set();
const REVERSAL_MARKER_TTL_MS = 30_000;
const ROLE_OPERATION_ATTEMPTS = 8;
const ROLE_OPERATION_MAX_WAIT_MS = 5 * 60_000;

function roleOperationKey(guildId, memberId, roleId) {
  return `${guildId}:${memberId}:${roleId}`;
}

function roleState(member, roleId) {
  return member.roles.cache.has(roleId);
}

function markExpectedReversal(key, desiredState) {
  expectedReversals.set(key, { desiredState, pending: true, expiresAt: null });
}

function finalizeExpectedReversal(key, desiredState) {
  const marker = expectedReversals.get(key);
  if (marker?.desiredState !== desiredState) return;
  marker.pending = false;
  marker.expiresAt = Date.now() + REVERSAL_MARKER_TTL_MS;
}

function clearExpectedReversal(key, desiredState) {
  const marker = expectedReversals.get(key);
  if (marker?.desiredState === desiredState) expectedReversals.delete(key);
}

function consumeExpectedReversal(key, observedState) {
  const marker = expectedReversals.get(key);
  if (!marker) return false;
  if (!marker.pending && marker.expiresAt < Date.now()) {
    expectedReversals.delete(key);
    return false;
  }
  expectedReversals.delete(key);
  return marker.desiredState === observedState;
}

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
    refreshed = await withDiscordRetry(
      () => member.guild.members.fetch({ user: member.id, force: true }),
      {
        label: `Verifying role ${roleId} for ${member.id}`,
        attempts: ROLE_OPERATION_ATTEMPTS,
        maxWaitMs: ROLE_OPERATION_MAX_WAIT_MS
      }
    );
    if (!refreshed) refreshed = await member.guild.members.fetch(member.id);
  } catch (error) {
    try {
      refreshed = await withDiscordRetry(
        () => member.guild.members.fetch(member.id),
        {
          label: `Verifying role ${roleId} for ${member.id}`,
          attempts: ROLE_OPERATION_ATTEMPTS,
          maxWaitMs: ROLE_OPERATION_MAX_WAIT_MS
        }
      );
    } catch (fallbackError) {
      return { verified: false, error: fallbackError || error };
    }
  }
  if (!refreshed) return { verified: false, error: new Error('Discord did not return the updated member') };
  const actual = refreshed.roles.cache.has(roleId);
  return {
    verified: actual === expected,
    error: actual === expected ? null : new Error(`Discord still reports the role as ${actual ? 'present' : 'absent'}`)
  };
}

async function performRoleReversal(member, roleId, desiredState, reason) {
  const key = roleOperationKey(member.guild.id, member.id, roleId);
  if (roleState(member, roleId) === desiredState) {
    return verifyMemberRoleState(member, roleId, desiredState);
  }

  markExpectedReversal(key, desiredState);
  try {
    await withDiscordRetry(async () => {
      if (roleState(member, roleId) === desiredState) return;
      if (desiredState) await member.roles.add(roleId, reason);
      else await member.roles.remove(roleId, reason);
    }, {
      label: `${desiredState ? 'Restoring' : 'Removing'} locked role ${roleId} for ${member.id}`,
      attempts: ROLE_OPERATION_ATTEMPTS,
      maxWaitMs: ROLE_OPERATION_MAX_WAIT_MS,
      shouldContinue: () => roleState(member, roleId) !== desiredState
    });
  } catch (error) {
    const verification = await verifyMemberRoleState(member, roleId, desiredState);
    if (verification.verified) {
      finalizeExpectedReversal(key, desiredState);
      return verification;
    }
    clearExpectedReversal(key, desiredState);
    return { verified: false, error };
  }

  finalizeExpectedReversal(key, desiredState);
  const verification = await verifyMemberRoleState(member, roleId, desiredState);
  if (!verification.verified) clearExpectedReversal(key, desiredState);
  return verification;
}

function queueRoleReversal(member, roleId, desiredState, reason) {
  const key = roleOperationKey(member.guild.id, member.id, roleId);
  let queue = roleOperationQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: new Map() };
    roleOperationQueues.set(key, queue);
  }
  if (queue.pending.has(desiredState)) return queue.pending.get(desiredState);

  const operation = queue.tail
    .catch(() => undefined)
    .then(() => performRoleReversal(member, roleId, desiredState, reason));
  queue.pending.set(desiredState, operation);
  const tail = operation.finally(() => {
    if (queue.pending.get(desiredState) === operation) queue.pending.delete(desiredState);
    if (!queue.pending.size && queue.tail === tail) roleOperationQueues.delete(key);
  });
  queue.tail = tail;
  return operation;
}

async function reverseRoleChange(member, roleId, changeType) {
  const reason = `Unauthorized locked-role ${changeType === 'add' ? 'addition' : 'removal'}`;
  const desiredState = changeType === 'remove';
  const verification = await queueRoleReversal(member, roleId, desiredState, reason);
  if (!verification.verified) {
    return {
      success: false,
      action: `Unauthorized role ${changeType === 'add' ? 'addition' : 'removal'} reversal failed verification`,
      error: verification.error || new Error(`Discord did not confirm that the role was ${desiredState ? 'restored' : 'removed'}`)
    };
  }
  return {
    success: true,
    action: `Unauthorized role ${changeType === 'add' ? 'addition' : 'removal'} reversed and verified`
  };
}

function attributionReason(status, executor) {
  if (status === 'ambiguous') return 'Audit attribution was ambiguous; no executor was punished';
  if (status === 'unavailable') return 'Audit log was unavailable; no executor was punished';
  if (status === 'not-found') return 'No fresh matching audit entry was found; no executor was punished';
  if (executor?.bot) return 'Executor was a bot and exempt from punishment';
  return null;
}

async function enforceLockedRoleChange(member, roleId, changeType, db) {
  const enforcementKey = `${roleOperationKey(member.guild.id, member.id, roleId)}:${changeType}`;
  if (activeEnforcements.has(enforcementKey)) return true;
  activeEnforcements.add(enforcementKey);
  try {
    const lock = db.getRoleLock(member.guild.id, roleId);
    if (!lock) return false;
    if (changeType === 'add' && !member.roles.cache.has(roleId)) return true;
    if (changeType === 'remove' && member.roles.cache.has(roleId)) return true;

    const audit = await findRoleChangeExecutor(member.guild, member.id, roleId, changeType);
    const executor = audit.entry?.executor || null;
    const incidentKey = audit.entry?.id ? `${audit.entry.id}:${roleId}:${changeType}` : null;
    if (incidentKey && processedIncidents.has(incidentKey)) return true;
    if (incidentKey) {
      processedIncidents.add(incidentKey);
      if (processedIncidents.size > 2000) processedIncidents.clear();
    }
    const executorMember = await fetchExecutorMember(member.guild, executor);
    if (executorAuthorized(executorMember, executor, member.guild, lock.authorization_role_ids, db)) return false;

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
    activeEnforcements.delete(enforcementKey);
  }
}

async function handleRoleLockUpdate(oldMember, newMember, db) {
  const handledRoleIds = new Set();
  const locks = new Set(db.getRoleLocks(newMember.guild.id).map((lock) => lock.locked_role_id));
  if (!locks.size) return handledRoleIds;
  const roleIds = new Set([...oldMember.roles.cache.keys(), ...newMember.roles.cache.keys()]);
  for (const roleId of roleIds) {
    if (!locks.has(roleId)) continue;
    const hadRole = oldMember.roles.cache.has(roleId);
    const hasRole = newMember.roles.cache.has(roleId);
    if (hadRole === hasRole) continue;
    const key = roleOperationKey(newMember.guild.id, newMember.id, roleId);
    if (consumeExpectedReversal(key, hasRole)) {
      handledRoleIds.add(roleId);
      continue;
    }
    if (await enforceLockedRoleChange(newMember, roleId, hasRole ? 'add' : 'remove', db)) {
      handledRoleIds.add(roleId);
    }
  }
  return handledRoleIds;
}

function clearRoleLockEnforcementState() {
  activeEnforcements.clear();
  roleOperationQueues.clear();
  expectedReversals.clear();
  processedIncidents.clear();
}

module.exports = {
  auditEntryHasChange,
  findRoleChangeExecutor,
  roleOperationKey,
  consumeExpectedReversal,
  queueRoleReversal,
  reverseRoleChange,
  enforceLockedRoleChange,
  handleRoleLockUpdate,
  clearRoleLockEnforcementState
};
