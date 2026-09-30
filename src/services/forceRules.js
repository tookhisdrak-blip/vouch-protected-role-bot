const { findRoleExecutor, removeRoleDetailed, applyStripstaff } = require('./roleProtection');
const { logForceEvent } = require('./forceLogger');

const nicknameLocks = new Set();
const roleStripLocks = new Set();
const globalStripLocks = new Set();
const processedAuditEntries = new Set();
const processedForeverBanJoins = new WeakSet();
const foreverBanLocks = new Set();

function nicknameKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function roleRuleKey(guildId, userId, roleId) {
  return `${guildId}:${userId}:${roleId}`;
}

async function applyNickname(member, rule, db, options = {}) {
  const currentNickname = member.nickname || '';
  const desiredNickname = rule.nickname || '';
  if (currentNickname === desiredNickname) return { status: 'already-correct' };

  const key = nicknameKey(member.guild.id, member.id);
  if (nicknameLocks.has(key)) return { status: 'queued' };
  nicknameLocks.add(key);
  let result;
  try {
    await member.setNickname(desiredNickname || null, options.reason || 'Forced nickname rule');
    result = { status: 'applied' };
  } catch (error) {
    result = { status: 'failed', error };
  } finally {
    nicknameLocks.delete(key);
  }

  if (options.log !== false) {
    await logForceEvent(member.guild, db, {
      action: options.action || 'FORCED NICKNAME ENFORCEMENT',
      target_user_id: member.id,
      nickname: desiredNickname,
      executor_id: options.executorId || null,
      result: result.status === 'applied' ? 'Forced nickname applied'
        : result.status === 'queued' ? 'Nickname update already in progress'
          : 'Could not apply forced nickname',
      failure_reason: result.error?.message || null
    });
  }
  return result;
}

async function setForcedNickname(member, nickname, executorId, db) {
  const now = new Date().toISOString();
  const rule = {
    guild_id: member.guild.id,
    user_id: member.id,
    username: member.user.tag || member.user.username,
    nickname: nickname || '',
    executor_id: executorId,
    created_at: now,
    updated_at: now
  };
  db.setForcedNickname(rule);
  const result = await applyNickname(member, rule, db, {
    action: 'FORCED NICKNAME SET',
    executorId,
    reason: 'Forced nickname configured'
  });
  if (result.status === 'already-correct') {
    await logForceEvent(member.guild, db, {
      action: 'FORCED NICKNAME SET',
      target_user_id: member.id,
      nickname: rule.nickname,
      executor_id: executorId,
      result: 'Rule saved; nickname was already correct'
    });
  }
  return { rule, result };
}

async function removeForcedNickname(guild, userId, executorId, db) {
  const rule = db.getForcedNickname(guild.id, userId);
  if (!rule) return { removed: false };
  db.removeForcedNickname(guild.id, userId);
  await logForceEvent(guild, db, {
    action: 'FORCED NICKNAME REMOVED',
    target_user_id: userId,
    nickname: rule.nickname,
    executor_id: executorId,
    result: 'Forced nickname rule removed; current nickname left unchanged'
  });
  return { removed: true, rule };
}

async function createForcedRoleStrip(member, roleId, executorId, db) {
  const createdAt = new Date().toISOString();
  const inserted = db.addForcedRoleStrip({
    guild_id: member.guild.id,
    user_id: member.id,
    role_id: roleId,
    executor_id: executorId,
    created_at: createdAt
  });
  const removal = await removeRoleDetailed(member, roleId, 'Forced role-strip rule');
  const result = removal.status === 'removed' || removal.status === 'absent'
    ? (removal.status === 'removed' ? 'Rule created; role removed' : 'Rule created; member did not have the role')
    : 'Rule created; immediate role removal failed';
  await logForceEvent(member.guild, db, {
    action: 'FORCED ROLE STRIP CREATED',
    target_user_id: member.id,
    role_id: roleId,
    executor_id: executorId,
    result,
    failure_reason: removal.error?.message || null
  });
  return { created: inserted.changes > 0, removal };
}

async function removeForcedRoleStripsForUser(guild, userId, executorId, db) {
  const removed = db.removeForcedRoleStripsForUser(guild.id, userId).changes;
  await logForceEvent(guild, db, {
    action: 'FORCED ROLE STRIPS REMOVED',
    target_user_id: userId,
    executor_id: executorId,
    result: `${removed} forced role-strip rule(s) removed`
  });
  return removed;
}

async function enforceForcedRoleAddition(member, roleId, db, options = {}) {
  const key = roleRuleKey(member.guild.id, member.id, roleId);
  if (roleStripLocks.has(key)) return { status: 'queued' };
  roleStripLocks.add(key);
  try {
    const removal = await removeRoleDetailed(member, roleId, options.reason || 'Active force role-strip rule');
    if (removal.status === 'absent' || removal.status === 'busy') return { status: removal.status };

    let attributionStatus = options.startup ? 'not checked during startup' : 'not checked';
    let executor = null;
    let punishment = { status: 'unverified' };
    if (!options.startup) {
      const audit = await findRoleExecutor(member.guild, member.id, roleId);
      if (audit.ambiguous) {
        attributionStatus = 'ambiguous; no punishment';
      } else if (audit.error) {
        attributionStatus = 'unavailable; no punishment';
      } else if (!audit.entry?.executor) {
        attributionStatus = 'no fresh match; no punishment';
      } else {
        executor = audit.entry.executor;
        const auditId = audit.entry.id;
        if (auditId && processedAuditEntries.has(auditId)) {
          attributionStatus = 'duplicate audit entry; no repeat punishment';
          executor = null;
        } else {
          if (auditId) {
            processedAuditEntries.add(auditId);
            if (processedAuditEntries.size > 2000) processedAuditEntries.clear();
          }
          attributionStatus = 'verified';
          punishment = await applyStripstaff(member.guild, db, executor);
        }
      }
    }

    const failureReason = removal.error?.message || null;
    const removalResult = removal.status === 'failed'
      ? 'Forced role removal failed; check Manage Roles and role hierarchy'
      : 'Forced role removed';
    const punishmentResult = punishment.status === 'removed' ? '; STRIPSTAFF removed'
      : punishment.status === 'failed' ? '; STRIPSTAFF removal failed'
        : punishment.status === 'partial' ? `; STRIPSTAFF partially removed (${punishment.removed} role(s) removed; ${punishment.failed} failed)`
        : punishment.status === 'exempt' ? '; no punishment (exempt)'
          : punishment.status === 'not-configured-or-held' ? '; no STRIPSTAFF role configured or held'
            : punishment.status === 'unavailable' ? '; executor unavailable, no punishment'
              : options.startup ? '; startup cleanup is non-punitive' : '; no verified punishment';

    await logForceEvent(member.guild, db, {
      action: options.global ? 'GLOBAL ROLE STRIP ENFORCEMENT' : 'FORCED ROLE STRIP VIOLATION',
      target_user_id: member.id,
      role_id: roleId,
      executor_id: executor?.id || null,
      result: `${removalResult}${options.global ? '' : punishmentResult}`,
      punishment: options.global ? null : punishment.status === 'removed' ? 'STRIPSTAFF removed'
        : punishment.status === 'partial' ? `STRIPSTAFF partially removed (${punishment.removed} role(s) removed; ${punishment.failed} failed)`
        : punishment.status === 'exempt' ? 'None (exempt)'
          : 'None (no verified applicable punishment)',
      failure_reason: failureReason,
      attribution_status: options.global ? null : attributionStatus
    });
    return { status: removal.status, executor, attributionStatus, punishment };
  } finally {
    roleStripLocks.delete(key);
  }
}

async function handleForceRoleUpdate(oldMember, newMember, db, alreadyHandledRoleIds = new Set()) {
  const addedRoleIds = newMember.roles.cache
    .filter((role) => !oldMember.roles.cache.has(role.id))
    .map((role) => role.id);
  for (const roleId of addedRoleIds) {
    if (alreadyHandledRoleIds.has(roleId)) continue;
    const specificRule = db.getForcedRoleStrip(newMember.guild.id, newMember.id, roleId);
    const globalRule = db.getGlobalRoleStrip(newMember.guild.id, roleId);
    if (!specificRule && !globalRule) continue;
    if (!specificRule && globalRule && (newMember.id === newMember.guild.ownerId || newMember.user.bot)) continue;
    await enforceForcedRoleAddition(newMember, roleId, db, { global: !specificRule && Boolean(globalRule) });
  }
}

function isProtectedGlobalStripRole(guild, roleId, db) {
  const settings = db.getSettings(guild.id);
  return roleId === guild.id || roleId === settings.os_role_id
    || roleId === settings.vouch_role_id || roleId === settings.reward_role_id;
}

async function runGlobalRoleStrip(guild, role, executorId, db) {
  const lockKey = `${guild.id}:${role.id}`;
  if (globalStripLocks.has(lockKey)) return { ok: false, busy: true };
  if (isProtectedGlobalStripRole(guild, role.id, db)) return { ok: false, protected: true };
  globalStripLocks.add(lockKey);
  try {
    const members = await guild.members.fetch();
    const holders = [...members.values()].filter((member) => member.roles.cache.has(role.id));
    db.addGlobalRoleStrip({
      guild_id: guild.id,
      role_id: role.id,
      executor_id: executorId,
      created_at: new Date().toISOString()
    });

    let stripped = 0;
    let failed = 0;
    let skipped = 0;
    for (const member of holders) {
      if (member.id === guild.ownerId || member.user.bot) {
        skipped += 1;
        continue;
      }
      const result = await removeRoleDetailed(member, role.id, 'Confirmed global role strip');
      if (result.status === 'removed') stripped += 1;
      else if (result.status === 'failed' || result.status === 'busy') failed += 1;
      else skipped += 1;
    }

    const summary = `Members found: ${holders.length}; stripped: ${stripped}; failed: ${failed}; skipped: ${skipped}`;
    await logForceEvent(guild, db, {
      action: 'GLOBAL ROLE STRIP COMPLETED',
      role_id: role.id,
      executor_id: executorId,
      result: summary,
      failure_reason: failed ? `${failed} member role removal(s) failed` : null
    });
    return { ok: true, found: holders.length, stripped, failed, skipped };
  } catch (error) {
    await logForceEvent(guild, db, {
      action: 'GLOBAL ROLE STRIP INCOMPLETE',
      role_id: role.id,
      executor_id: executorId,
      result: 'No role removals were completed; member list could not be fetched',
      failure_reason: error.message
    });
    return { ok: false, error };
  } finally {
    globalStripLocks.delete(lockKey);
  }
}

async function handleForceMemberUpdate(oldMember, newMember, db, alreadyHandledRoleIds) {
  if (oldMember.nickname !== newMember.nickname) {
    const rule = db.getForcedNickname(newMember.guild.id, newMember.id);
    if (rule && (newMember.nickname || '') !== (rule.nickname || '')) {
      await applyNickname(newMember, rule, db, { action: 'FORCED NICKNAME RESTORED' });
    }
  }
  await handleForceRoleUpdate(oldMember, newMember, db, alreadyHandledRoleIds);
}

async function handleForceMemberAdd(member, db) {
  const banRecord = db.getForeverBan(member.guild.id, member.id);
  if (banRecord) return { banned: await applyForeverBanOnJoin(member, banRecord, db) };

  const nicknameRule = db.getForcedNickname(member.guild.id, member.id);
  if (nicknameRule) await applyNickname(member, nicknameRule, db, { action: 'FORCED NICKNAME RESTORED ON REJOIN' });

  for (const rule of db.getForcedRoleStripsForUser(member.guild.id, member.id)) {
    if (member.roles.cache.has(rule.role_id)) await enforceForcedRoleAddition(member, rule.role_id, db, { startup: true });
  }
  for (const rule of db.getGlobalRoleStrips(member.guild.id)) {
    if (member.id !== member.guild.ownerId && !member.user.bot && member.roles.cache.has(rule.role_id)) {
      await enforceForcedRoleAddition(member, rule.role_id, db, { startup: true, global: true });
    }
  }
  return { banned: false };
}

async function banAccountOnce(guild, userId, reason) {
  const key = `${guild.id}:${userId}`;
  if (foreverBanLocks.has(key)) return { status: 'already-processing' };
  foreverBanLocks.add(key);
  try {
    await guild.members.ban(userId, { reason });
    return { status: 'banned' };
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    foreverBanLocks.delete(key);
  }
}

async function reconcileForceGuild(guild, db) {
  const members = await guild.members.fetch();
  const memberById = members;
  for (const rule of db.getForcedNicknames(guild.id)) {
    const member = memberById.get(rule.user_id);
    if (member) await applyNickname(member, rule, db, { action: 'FORCED NICKNAME STARTUP RECONCILIATION' });
  }

  const stripRulesByMember = new Map();
  for (const rule of db.getForcedRoleStrips(guild.id)) {
    if (!stripRulesByMember.has(rule.user_id)) stripRulesByMember.set(rule.user_id, new Set());
    stripRulesByMember.get(rule.user_id).add(rule.role_id);
  }
  for (const rule of db.getGlobalRoleStrips(guild.id)) {
    for (const member of members.values()) {
      if (member.id !== guild.ownerId && !member.user.bot && member.roles.cache.has(rule.role_id)) {
        if (!stripRulesByMember.has(member.id)) stripRulesByMember.set(member.id, new Set());
        stripRulesByMember.get(member.id).add(rule.role_id);
      }
    }
  }
  for (const [userId, roleIds] of stripRulesByMember) {
    const member = memberById.get(userId);
    if (!member) continue;
    for (const roleId of roleIds) {
      if (!member.roles.cache.has(roleId)) continue;
      const removal = await removeRoleDetailed(member, roleId, 'Force-rule startup reconciliation');
      await logForceEvent(guild, db, {
        action: 'FORCE ROLE STARTUP RECONCILIATION',
        target_user_id: member.id,
        role_id: roleId,
        executor_id: null,
        result: removal.status === 'removed' ? 'Role removed; no punishment during startup'
          : 'Role removal failed during startup; no punishment applied',
        failure_reason: removal.error?.message || null,
        attribution_status: 'not checked during startup'
      });
    }
  }
}

async function applyForeverBanOnJoin(member, record, db) {
  if (processedForeverBanJoins.has(member)) return { status: 'already-processed' };
  processedForeverBanJoins.add(member);
  const ban = await banAccountOnce(member.guild, member.id, record.reason || 'Active forever-ban rule');
  if (ban.status === 'banned') {
    await logForceEvent(member.guild, db, {
      action: 'FOREVER BAN JOIN ENFORCEMENT',
      target_user_id: member.id,
      executor_id: null,
      reason: record.reason,
      result: 'Stored account ID matched; member banned again'
    });
    return { status: 'banned' };
  }
  if (ban.status === 'already-processing') return ban;
  await logForceEvent(member.guild, db, {
      action: 'FOREVER BAN JOIN ENFORCEMENT',
      target_user_id: member.id,
      executor_id: null,
      reason: record.reason,
      result: 'Stored account ID matched; ban could not be applied',
      failure_reason: ban.error?.message
    });
  return ban;
}

module.exports = {
  applyNickname,
  setForcedNickname,
  removeForcedNickname,
  createForcedRoleStrip,
  removeForcedRoleStripsForUser,
  handleForceRoleUpdate,
  handleForceMemberUpdate,
  handleForceMemberAdd,
  reconcileForceGuild,
  runGlobalRoleStrip,
  isProtectedGlobalStripRole,
  applyForeverBanOnJoin,
  banAccountOnce
};