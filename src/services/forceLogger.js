const { logEvent } = require('./eventLogger');

async function logForceEvent(guild, db, entry) {
  const createdAt = entry.created_at || new Date().toISOString();
  const record = {
    guild_id: guild.id,
    action: entry.action,
    target_user_id: entry.target_user_id || null,
    role_id: entry.role_id || null,
    nickname: entry.nickname ?? null,
    executor_id: entry.executor_id || null,
    result: entry.result,
    reason: entry.reason || null,
    punishment: entry.punishment || null,
    failure_reason: entry.failure_reason || null,
    attribution_status: entry.attribution_status || null,
    created_at: createdAt
  };
  db.addForceManagementLog(record);
  await logEvent(guild, db, {
    event_type: `FORCE: ${entry.action}`,
    executor_id: record.executor_id,
    affected_user_id: record.target_user_id,
    role_id: record.role_id,
    reason: [record.reason, record.nickname !== null ? `Nickname: ${record.nickname || '(default account name)'}` : null,
      record.failure_reason, record.attribution_status ? `Audit attribution: ${record.attribution_status}` : null]
      .filter(Boolean).join('; ').slice(0, 1000) || null,
    action_taken: record.result,
    punishment: record.punishment,
    created_at: createdAt
  });
}

module.exports = { logForceEvent };