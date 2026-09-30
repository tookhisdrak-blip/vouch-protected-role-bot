const { logForceEvent } = require('./forceLogger');
const { applyForeverBanOnJoin, banAccountOnce } = require('./forceRules');

function isUnknownBanError(error) {
  return error?.code === 10026 || error?.rawError?.code === 10026;
}

async function createForeverBan(guild, user, reason, executorId, db) {
  const now = new Date().toISOString();
  let originalBanStatus = 'unknown';
  try {
    await guild.bans.fetch(user.id);
    originalBanStatus = 'banned';
  } catch (error) {
    if (isUnknownBanError(error)) originalBanStatus = 'not_banned';
  }

  const record = {
    guild_id: guild.id,
    user_id: user.id,
    username: user.tag || user.username || null,
    reason: reason || 'No reason provided',
    executor_id: executorId,
    created_at: now,
    original_ban_status: originalBanStatus
  };
  db.upsertForeverBan(record);

  let result = originalBanStatus === 'banned' ? 'Rule stored; account was already banned' : 'Rule stored; ban applied';
  let failureReason = null;
  if (originalBanStatus !== 'banned') {
    const ban = await banAccountOnce(guild, user.id, record.reason);
    if (ban.status === 'already-processing') {
      result = 'Rule stored; a ban operation for this account is already in progress';
    } else if (ban.status === 'failed') {
      result = 'Rule stored; immediate ban failed and will be retried if the account joins';
      failureReason = ban.error.message;
    }
  }

  await logForceEvent(guild, db, {
    action: 'FOREVER BAN CREATED',
    target_user_id: user.id,
    executor_id: executorId,
    reason: record.reason,
    result,
    failure_reason: failureReason
  });
  return { record, result, failureReason };
}

async function removeForeverBan(guild, userId, executorId, db) {
  const record = db.getForeverBan(guild.id, userId);
  if (!record) return { removed: false };
  db.removeForeverBan(guild.id, userId);
  await logForceEvent(guild, db, {
    action: 'FOREVER BAN REMOVED',
    target_user_id: userId,
    executor_id: executorId,
    result: 'Forever-ban record removed; Discord ban status unchanged'
  });
  return { removed: true, record };
}

async function reconcileForeverBans(guild, db) {
  for (const record of db.getForeverBans(guild.id)) {
    try {
      await guild.bans.fetch(record.user_id);
      continue;
    } catch (error) {
      if (!isUnknownBanError(error)) {
        await logForceEvent(guild, db, {
          action: 'FOREVER BAN STARTUP RECONCILIATION',
          target_user_id: record.user_id,
          executor_id: null,
          reason: record.reason,
          result: 'Ban status could not be verified; no duplicate ban attempted',
          failure_reason: error.message
        });
        continue;
      }
    }

    const ban = await banAccountOnce(guild, record.user_id, record.reason || 'Active forever-ban rule');
    if (ban.status === 'banned') {
      await logForceEvent(guild, db, {
        action: 'FOREVER BAN STARTUP RECONCILIATION',
        target_user_id: record.user_id,
        executor_id: null,
        reason: record.reason,
        result: 'Stored account ID was not banned; ban restored without punishment'
      });
    } else if (ban.status === 'failed') {
      await logForceEvent(guild, db, {
        action: 'FOREVER BAN STARTUP RECONCILIATION',
        target_user_id: record.user_id,
        executor_id: null,
        reason: record.reason,
        result: 'Stored account ID was not banned; re-ban failed',
        failure_reason: ban.error.message
      });
    } else {
      await logForceEvent(guild, db, {
        action: 'FOREVER BAN STARTUP RECONCILIATION',
        target_user_id: record.user_id,
        executor_id: null,
        reason: record.reason,
        result: 'A ban operation for this account is already in progress'
      });
    }
  }
}

async function enforceForeverBanOnJoin(member, db) {
  const record = db.getForeverBan(member.guild.id, member.id);
  if (!record) return null;
  return applyForeverBanOnJoin(member, record, db);
}

module.exports = { createForeverBan, removeForeverBan, reconcileForeverBans, enforceForeverBanOnJoin };