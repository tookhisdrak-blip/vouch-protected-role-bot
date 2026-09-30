const { isOwnerOrOs } = require('./permissions');
const { applyStripstaff, stripstaffPunishmentText } = require('./roleProtection');
const {
  findRoleChangeExecutor, roleOperationKey, consumeExpectedReversal, queueRoleReversal
} = require('./roleLocks');
const { logEvent } = require('./eventLogger');

const activeEnforcements = new Set();
const processedIncidents = new Set();

function canManagePaidWhitelist(member, db) {
  if (!member) return false;
  if (isOwnerOrOs(member, db)) return true;
  if (db.isPaidVerifiedUser(member.guild.id, member.id)) return true;
  const verifiedRoleId = db.getPaidVerifiedRole(member.guild.id);
  return Boolean(verifiedRoleId && member.roles.cache.has(verifiedRoleId));
}

function paidTargetAllowed(member, db) {
  return isOwnerOrOs(member, db) || db.isPaidWhitelisted(member.guild.id, member.id);
}

function attributionReason(status, executor) {
  if (status === 'ambiguous') return 'Audit attribution was ambiguous; no executor was punished';
  if (status === 'unavailable') return 'Audit log was unavailable; no executor was punished';
  if (status === 'not-found') return 'No fresh matching audit entry was found; no executor was punished';
  if (executor?.bot) return 'Executor was a bot and exempt from punishment';
  return executor ? 'Executor was human' : 'Executor was unknown';
}

async function enforcePaidRoleAddition(member, roleId, db) {
  const enforcementKey = `${roleOperationKey(member.guild.id, member.id, roleId)}:paid-add`;
  if (activeEnforcements.has(enforcementKey)) return true;
  activeEnforcements.add(enforcementKey);
  try {
    if (!db.isPaidRole(member.guild.id, roleId)) return false;
    if (!member.roles.cache.has(roleId)) return true;
    if (paidTargetAllowed(member, db)) return false;

    const audit = await findRoleChangeExecutor(member.guild, member.id, roleId, 'add');
    const executor = audit.entry?.executor || null;
    const incidentKey = audit.entry?.id ? `paid:${audit.entry.id}:${roleId}` : null;
    if (incidentKey && processedIncidents.has(incidentKey)) return true;
    if (incidentKey) {
      processedIncidents.add(incidentKey);
      if (processedIncidents.size > 2000) processedIncidents.clear();
    }

    const verification = await queueRoleReversal(
      member,
      roleId,
      false,
      'Unwhitelisted member received a configured paid role'
    );
    const reversalSucceeded = verification.verified;
    let punishment = { status: 'unverified' };
    if (reversalSucceeded && executor && !executor.bot) {
      punishment = await applyStripstaff(member.guild, db, executor);
    } else if (executor?.bot) {
      punishment = { status: 'exempt' };
    }

    const details = [
      'Target was not whitelisted for configured paid roles',
      attributionReason(audit.status, executor),
      verification.error?.message ? `Reversal failure: ${verification.error.message}` : null
    ].filter(Boolean);
    await logEvent(member.guild, db, {
      event_type: 'PAID ROLE VIOLATION',
      executor_id: executor?.id || null,
      affected_user_id: member.id,
      role_id: roleId,
      reason: details.join('; '),
      action_taken: reversalSucceeded
        ? 'Unauthorized paid role removed and verified'
        : 'Unauthorized paid role removal failed verification',
      punishment: stripstaffPunishmentText(punishment)
    });
    return true;
  } finally {
    activeEnforcements.delete(enforcementKey);
  }
}

async function handlePaidRoleUpdate(oldMember, newMember, db, ignoredRoleIds = new Set()) {
  const handledRoleIds = new Set();
  const paidRoleIds = new Set(db.getPaidRoles(newMember.guild.id).map((row) => row.role_id));
  for (const roleId of paidRoleIds) {
    if (ignoredRoleIds.has(roleId)) continue;
    const hadRole = oldMember.roles.cache.has(roleId);
    const hasRole = newMember.roles.cache.has(roleId);
    if (hadRole === hasRole) continue;
    const key = roleOperationKey(newMember.guild.id, newMember.id, roleId);
    if (consumeExpectedReversal(key, hasRole)) {
      handledRoleIds.add(roleId);
      continue;
    }
    if (hadRole || !hasRole) continue;
    if (await enforcePaidRoleAddition(newMember, roleId, db)) handledRoleIds.add(roleId);
  }
  return handledRoleIds;
}

function clearPaidRoleEnforcementState() {
  activeEnforcements.clear();
  processedIncidents.clear();
}

module.exports = {
  canManagePaidWhitelist,
  paidTargetAllowed,
  enforcePaidRoleAddition,
  handlePaidRoleUpdate,
  clearPaidRoleEnforcementState
};
