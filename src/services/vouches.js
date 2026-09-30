const { canGiveVouch, hasVouchAdminAccess, remainingVouches } = require('./permissions');
const { logEvent } = require('./eventLogger');
const { applyStripstaff, removeRoleDetailed, stripstaffPunishmentText } = require('./roleProtection');
const { withDiscordRetry, scheduleDeferredRetry } = require('./discordRetry');

const pendingRoleAssignments = new Map();
const LIMIT_MESSAGE = 'you ran out of vouches bud, remove your vouch from a user or keep it how u got it.';

function configuredVouchRoles(guildId, db) {
  const settings = db.getSettings(guildId);
  return [...new Set([settings.vouch_role_id, settings.reward_role_id].filter(Boolean))];
}

function roleLimitFailure(member, roleId, db) {
  if (member.roles.cache.has(roleId)) return null;
  const configuredLimit = db.getLimitedRole(member.guild.id, roleId);
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return `Configured role ${roleId} no longer exists.`;
  const reservationKey = `${member.guild.id}:${roleId}`;
  const pending = pendingRoleAssignments.get(reservationKey) || 0;
  if (configuredLimit && role.members.size + pending >= configuredLimit.member_limit) {
    return `The limit for <@&${roleId}> is ${configuredLimit.member_limit}; no member slot is available.`;
  }
  return null;
}

async function giveVouch(giver, recipient, reason, db) {
  const guildId = giver.guild.id;
  const permission = canGiveVouch(giver, db);
  if (!permission.allowed) {
    if (permission.remaining === 0) {
      const punishment = await applyStripstaff(giver.guild, db, giver.user);
      await logEvent(giver.guild, db, {
        event_type: 'VOUCH LIMIT VIOLATION',
        executor_id: giver.id,
        affected_user_id: recipient?.id || null,
        role_id: db.getSettings(guildId).stripstaff_role_id,
        reason: 'The giver attempted to exceed their active vouch allowance',
        action_taken: 'Vouch rejected; no active vouch or configured roles were assigned',
        punishment: stripstaffPunishmentText(punishment)
      });
      return { ok: false, message: LIMIT_MESSAGE };
    }
    return { ok: false, message: 'You are not authorized to give vouches.' };
  }

  let reservedRoleIds = [];
  try {
    if (!recipient?.user) return { ok: false, message: 'Mention a valid server member.' };
    if (recipient.user.bot) return { ok: false, message: 'Bots cannot receive vouches.' };
    if (recipient.id === giver.id) return { ok: false, message: 'You cannot vouch for yourself.' };
    if (db.isBlacklisted(guildId, recipient.id)) return { ok: false, message: 'That member is blacklisted from receiving vouches.' };
    if (db.getVouch(guildId, recipient.id)) return { ok: false, message: 'That member already has an active vouch.' };

    const roleIds = configuredVouchRoles(guildId, db);
    for (const roleId of roleIds) {
      const failure = roleLimitFailure(recipient, roleId, db);
      if (failure) return { ok: false, message: failure };
    }

    reservedRoleIds = roleIds.filter((roleId) => !recipient.roles.cache.has(roleId) && db.getLimitedRole(guildId, roleId));
    for (const roleId of reservedRoleIds) {
      const key = `${guildId}:${roleId}`;
      pendingRoleAssignments.set(key, (pendingRoleAssignments.get(key) || 0) + 1);
    }

    const createdAt = new Date().toISOString();
    const rolesToAssign = roleIds.filter((roleId) => !recipient.roles.cache.has(roleId));
    const deferredRoleIds = [];
    let vouchPersisted = false;
    try {
      db.addVouch(guildId, recipient.id, giver.id, reason || 'No reason provided', createdAt);
      vouchPersisted = true;
      for (const roleId of rolesToAssign) {
        if (deferredRoleIds.length) {
          deferredRoleIds.push(roleId);
          continue;
        }
        try {
          await withDiscordRetry(() => recipient.roles.add(roleId, 'Active vouch'), {
            label: `Assigning vouch role ${roleId} to ${recipient.id}`
          });
        } catch (error) {
          // A rate limit is not a failed vouch: keep the record and finish the assignment later.
          if (!error.transient) throw error;
          deferredRoleIds.push(roleId);
        }
      }
    } catch (error) {
      const rollbackFailures = [];
      if (vouchPersisted) {
        try {
          db.removeVouch(guildId, recipient.id);
        } catch (rollbackError) {
          console.error(`Could not roll back vouch ${guildId}:${recipient.id}:`, rollbackError.message);
          rollbackFailures.push('the active vouch record');
        }
      }
      for (const roleId of rolesToAssign) {
        const removal = await removeRoleDetailed(recipient, roleId, 'Vouch assignment rolled back', {
          isStillRequired: () => !db.getVouch(guildId, recipient.id)
        });
        if (removal.status === 'failed' || removal.status === 'busy') rollbackFailures.push(`role ${roleId}`);
      }
      console.error(`Vouch assignment failed for ${guildId}:${recipient.id}:`, error.message);
      const incomplete = rollbackFailures.length
        ? ` Rollback was incomplete for ${rollbackFailures.join(', ')}; manual cleanup is required.`
        : '';
      return {
        ok: false,
        message: `The vouch was not saved because the bot could not assign its configured role. Check Manage Roles and role hierarchy.${incomplete}`
      };
    }

    for (const roleId of deferredRoleIds) {
      const reservationKey = `${guildId}:${roleId}`;
      // Keep any limited-role slot reserved until the deferred assignment settles.
      const keepsReservation = reservedRoleIds.includes(roleId);
      if (keepsReservation) reservedRoleIds = reservedRoleIds.filter((reserved) => reserved !== roleId);
      const scheduled = scheduleDeferredRetry(`add:${guildId}:${recipient.id}:${roleId}`, () => recipient.roles.add(roleId, 'Active vouch'), {
        label: `Assigning vouch role ${roleId} to ${recipient.id}`,
        isStillRequired: () => Boolean(db.getVouch(guildId, recipient.id))
          && !recipient.roles.cache.has(roleId)
          && configuredVouchRoles(guildId, db).includes(roleId),
        onSettled: () => {
          if (keepsReservation) releaseReservation(reservationKey);
        }
      });
      if (!scheduled && keepsReservation) releaseReservation(reservationKey);
    }

    await logEvent(giver.guild, db, {
      event_type: 'VOUCH GIVEN',
      executor_id: giver.id,
      affected_user_id: recipient.id,
      role_id: db.getSettings(guildId).vouch_role_id,
      reason: reason || 'No reason provided',
      action_taken: deferredRoleIds.length
        ? `Vouch recorded; ${deferredRoleIds.length} configured role(s) rate limited by Discord and queued for automatic assignment`
        : 'Vouch recorded; configured roles assigned',
      punishment: null,
      reward: db.getSettings(guildId).reward_role_id
        ? `${deferredRoleIds.includes(db.getSettings(guildId).reward_role_id) ? 'Pending' : 'Assigned'} <@&${db.getSettings(guildId).reward_role_id}>`
        : null,
      created_at: createdAt
    });
    return { ok: true, createdAt, remaining: remainingVouches(guildId, giver.id, db, giver), deferredRoleIds };
  } finally {
    for (const roleId of reservedRoleIds) releaseReservation(`${guildId}:${roleId}`);
  }
}

function releaseReservation(key) {
  const remaining = (pendingRoleAssignments.get(key) || 1) - 1;
  if (remaining > 0) pendingRoleAssignments.set(key, remaining);
  else pendingRoleAssignments.delete(key);
}

async function takeVouch(actor, recipient, reason, db) {
  const guildId = actor.guild.id;
  const vouch = db.getVouch(guildId, recipient.id);
  if (!vouch) return { ok: false, message: 'That member has no active vouch.' };
  if (!hasVouchAdminAccess(actor, db) && actor.id !== vouch.giver_id) {
    return { ok: false, message: 'Only the original giver, a Vouch Admin, OS, or the Guild Owner can remove this vouch.' };
  }

  db.removeVouch(guildId, recipient.id);
  const cleanupFailures = [];
  const roleIds = configuredVouchRoles(guildId, db);
  const rewardRoleId = db.getSettings(guildId).reward_role_id;
  const hadRewardRole = Boolean(rewardRoleId && recipient.roles.cache.has(rewardRoleId));
  for (const roleId of roleIds) {
    const result = await removeRoleDetailed(recipient, roleId, reason || 'Active vouch removed', {
      isStillRequired: () => !db.getVouch(guildId, recipient.id)
    });
    if (result.status === 'failed' || result.status === 'busy') cleanupFailures.push(roleId);
  }
  const removedAt = new Date().toISOString();
  await logEvent(actor.guild, db, {
    event_type: 'VOUCH REMOVED',
    executor_id: actor.id,
    affected_user_id: recipient.id,
    role_id: db.getSettings(guildId).vouch_role_id,
    reason: reason || 'No reason provided',
    action_taken: cleanupFailures.length
      ? `Vouch removed; role cleanup failed for ${cleanupFailures.length} configured role(s)`
      : 'Vouch and configured roles removed',
    punishment: null,
    reward: hadRewardRole
      ? `${cleanupFailures.includes(rewardRoleId) ? 'Removal failed for' : 'Removed'} <@&${rewardRoleId}>`
      : null,
    created_at: removedAt
  });
  return { ok: true, vouch, removedAt, cleanupFailures };
}

async function wipeVouches(guild, db, actorId) {
  const activeVouches = db.getVouches(guild.id);
  const roleIds = configuredVouchRoles(guild.id, db);
  const rewardRoleId = db.getSettings(guild.id).reward_role_id;
  const cleanupFailures = [];
  let rewardsRemoved = 0;
  let rewardsQueued = 0;
  let rewardFailures = 0;
  db.clearVouches(guild.id);
  for (const vouch of activeVouches) {
    const member = await guild.members.fetch(vouch.recipient_id).catch((error) => {
      console.warn(`Could not fetch vouch recipient ${vouch.recipient_id} during wipe in ${guild.id}:`, error.message);
      for (const roleId of roleIds) {
        cleanupFailures.push({ memberId: vouch.recipient_id, roleId });
        if (roleId === rewardRoleId) rewardFailures += 1;
      }
      return null;
    });
    if (!member) continue;
    const hadRewardRole = Boolean(rewardRoleId && member.roles.cache.has(rewardRoleId));
    for (const roleId of roleIds) {
      const result = await removeRoleDetailed(member, roleId, 'All active vouches wiped', {
        isStillRequired: () => !db.getVouch(guild.id, member.id)
      });
      if (result.status === 'failed' || result.status === 'busy') {
        cleanupFailures.push({ memberId: member.id, roleId });
        if (roleId === rewardRoleId && hadRewardRole) rewardFailures += 1;
      } else if (roleId === rewardRoleId && hadRewardRole && result.status === 'removed') {
        rewardsRemoved += 1;
      } else if (roleId === rewardRoleId && hadRewardRole && result.status === 'deferred') {
        rewardsQueued += 1;
      }
    }
  }
  await logEvent(guild, db, {
    event_type: 'VOUCH WIPE',
    executor_id: actorId,
    affected_user_id: null,
    role_id: db.getSettings(guild.id).vouch_role_id,
    reason: 'Guild Owner requested a full vouch wipe',
    action_taken: `${activeVouches.length} active vouch(es) removed; giver allowance recalculated${cleanupFailures.length ? `; role cleanup failed for ${cleanupFailures.length} assignment(s)` : ''}`,
    punishment: null,
    reward: rewardRoleId
      ? `${rewardsRemoved} removed${rewardsQueued ? `; ${rewardsQueued} queued` : ''}${rewardFailures ? `; ${rewardFailures} failed` : ''}`
      : null
  });
  return { count: activeVouches.length, cleanupFailures };
}

module.exports = { giveVouch, takeVouch, wipeVouches, configuredVouchRoles };