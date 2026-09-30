const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createDatabase(databasePath) {
  const resolvedPath = databasePath === ':memory:' ? databasePath : path.resolve(databasePath);
  if (resolvedPath !== ':memory:') fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const connection = new Database(resolvedPath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      os_role_id TEXT,
      vouch_role_id TEXT,
      reward_role_id TEXT,
      stripstaff_role_id TEXT,
      log_channel_id TEXT,
      default_giver_limit INTEGER NOT NULL DEFAULT 2
    );
    CREATE TABLE IF NOT EXISTS os_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS limited_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      member_limit INTEGER NOT NULL CHECK (member_limit >= 0),
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS vouch_givers (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      custom_limit INTEGER CHECK (custom_limit IS NULL OR custom_limit >= 0),
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS os_vouch_limits (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      custom_limit INTEGER NOT NULL CHECK (custom_limit >= 0),
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS vouch_admins (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      custom_limit INTEGER CHECK (custom_limit IS NULL OR custom_limit >= 0),
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS owner_allowed_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS active_vouches (
      guild_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      giver_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, recipient_id)
    );
    CREATE INDEX IF NOT EXISTS active_vouches_giver
      ON active_vouches (guild_id, giver_id);
    CREATE TABLE IF NOT EXISTS vouch_blacklist (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      executor_id TEXT,
      affected_user_id TEXT,
      role_id TEXT,
      reason TEXT,
      action_taken TEXT NOT NULL,
      punishment TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS forced_nicknames (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      nickname TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS forced_role_strips (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS global_role_strips (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS forever_bans (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      reason TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      original_ban_status TEXT NOT NULL,
      rule_status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS force_management_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT,
      role_id TEXT,
      nickname TEXT,
      executor_id TEXT,
      result TEXT NOT NULL,
      reason TEXT,
      punishment TEXT,
      failure_reason TEXT,
      attribution_status TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS forced_role_strips_target
      ON forced_role_strips (guild_id, user_id);
    CREATE INDEX IF NOT EXISTS forever_bans_user
      ON forever_bans (guild_id, user_id, rule_status);
  `);

  const forceLogColumns = new Set(connection.pragma('table_info(force_management_logs)').map((column) => column.name));
  if (!forceLogColumns.has('reason')) {
    connection.exec('ALTER TABLE force_management_logs ADD COLUMN reason TEXT');
  }
  if (!forceLogColumns.has('punishment')) {
    connection.exec('ALTER TABLE force_management_logs ADD COLUMN punishment TEXT');
  }

  const statements = {
    ensureGuild: connection.prepare(`
      INSERT INTO guild_settings (guild_id) VALUES (?)
      ON CONFLICT(guild_id) DO NOTHING
    `),
    getSettings: connection.prepare('SELECT * FROM guild_settings WHERE guild_id = ?'),
    getOsUsers: connection.prepare('SELECT user_id FROM os_users WHERE guild_id = ?'),
    addOsUser: connection.prepare('INSERT OR IGNORE INTO os_users (guild_id, user_id) VALUES (?, ?)'),
    removeOsUser: connection.prepare('DELETE FROM os_users WHERE guild_id = ? AND user_id = ?'),
    getLimitedRoles: connection.prepare('SELECT role_id, member_limit FROM limited_roles WHERE guild_id = ?'),
    getLimitedRole: connection.prepare('SELECT member_limit FROM limited_roles WHERE guild_id = ? AND role_id = ?'),
    setLimitedRole: connection.prepare(`
      INSERT INTO limited_roles (guild_id, role_id, member_limit) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, role_id) DO UPDATE SET member_limit = excluded.member_limit
    `),
    removeLimitedRole: connection.prepare('DELETE FROM limited_roles WHERE guild_id = ? AND role_id = ?'),
    addGiver: connection.prepare('INSERT OR IGNORE INTO vouch_givers (guild_id, user_id) VALUES (?, ?)'),
    removeGiver: connection.prepare('DELETE FROM vouch_givers WHERE guild_id = ? AND user_id = ?'),
    getGiver: connection.prepare('SELECT * FROM vouch_givers WHERE guild_id = ? AND user_id = ?'),
    getGivers: connection.prepare('SELECT user_id, custom_limit FROM vouch_givers WHERE guild_id = ?'),
    setGiverLimit: connection.prepare('UPDATE vouch_givers SET custom_limit = ? WHERE guild_id = ? AND user_id = ?'),
    getOsVouchLimit: connection.prepare('SELECT custom_limit FROM os_vouch_limits WHERE guild_id = ? AND user_id = ?'),
    setOsVouchLimit: connection.prepare(`
      INSERT INTO os_vouch_limits (guild_id, user_id, custom_limit) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET custom_limit = excluded.custom_limit
    `),
    removeOsVouchLimit: connection.prepare('DELETE FROM os_vouch_limits WHERE guild_id = ? AND user_id = ?'),
    addVouchAdmin: connection.prepare('INSERT OR IGNORE INTO vouch_admins (guild_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)'),
    removeVouchAdmin: connection.prepare('DELETE FROM vouch_admins WHERE guild_id = ? AND user_id = ?'),
    getVouchAdmin: connection.prepare('SELECT * FROM vouch_admins WHERE guild_id = ? AND user_id = ?'),
    getVouchAdmins: connection.prepare('SELECT * FROM vouch_admins WHERE guild_id = ? ORDER BY created_at, user_id'),
    setVouchAdminLimit: connection.prepare('UPDATE vouch_admins SET custom_limit = ? WHERE guild_id = ? AND user_id = ?'),
    addOwnerAllowed: connection.prepare('INSERT OR IGNORE INTO owner_allowed_users (guild_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)'),
    removeOwnerAllowed: connection.prepare('DELETE FROM owner_allowed_users WHERE guild_id = ? AND user_id = ?'),
    isOwnerAllowed: connection.prepare('SELECT 1 FROM owner_allowed_users WHERE guild_id = ? AND user_id = ?'),
    getOwnerAllowed: connection.prepare('SELECT * FROM owner_allowed_users WHERE guild_id = ? ORDER BY created_at, user_id'),
    getVouch: connection.prepare('SELECT * FROM active_vouches WHERE guild_id = ? AND recipient_id = ?'),
    getVouches: connection.prepare('SELECT * FROM active_vouches WHERE guild_id = ? ORDER BY created_at, recipient_id'),
    countGiverVouches: connection.prepare('SELECT COUNT(*) AS count FROM active_vouches WHERE guild_id = ? AND giver_id = ?'),
    addVouch: connection.prepare(`
      INSERT INTO active_vouches (guild_id, recipient_id, giver_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    removeVouch: connection.prepare('DELETE FROM active_vouches WHERE guild_id = ? AND recipient_id = ?'),
    clearVouches: connection.prepare('DELETE FROM active_vouches WHERE guild_id = ?'),
    isBlacklisted: connection.prepare('SELECT 1 FROM vouch_blacklist WHERE guild_id = ? AND user_id = ?'),
    getBlacklist: connection.prepare('SELECT user_id, added_by, created_at FROM vouch_blacklist WHERE guild_id = ?'),
    addBlacklist: connection.prepare(`
      INSERT OR IGNORE INTO vouch_blacklist (guild_id, user_id, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `),
    removeBlacklist: connection.prepare('DELETE FROM vouch_blacklist WHERE guild_id = ? AND user_id = ?'),
    addEventLog: connection.prepare(`
      INSERT INTO event_logs
        (guild_id, event_type, executor_id, affected_user_id, role_id, reason, action_taken, punishment, created_at)
      VALUES (@guild_id, @event_type, @executor_id, @affected_user_id, @role_id, @reason, @action_taken, @punishment, @created_at)
    `),
    setForcedNickname: connection.prepare(`
      INSERT INTO forced_nicknames (guild_id, user_id, username, nickname, executor_id, created_at, updated_at)
      VALUES (@guild_id, @user_id, @username, @nickname, @executor_id, @created_at, @updated_at)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        username = excluded.username,
        nickname = excluded.nickname,
        executor_id = excluded.executor_id,
        updated_at = excluded.updated_at
    `),
    getForcedNickname: connection.prepare('SELECT * FROM forced_nicknames WHERE guild_id = ? AND user_id = ?'),
    getForcedNicknames: connection.prepare('SELECT * FROM forced_nicknames WHERE guild_id = ? ORDER BY created_at, user_id'),
    removeForcedNickname: connection.prepare('DELETE FROM forced_nicknames WHERE guild_id = ? AND user_id = ?'),
    addForcedRoleStrip: connection.prepare(`
      INSERT OR IGNORE INTO forced_role_strips (guild_id, user_id, role_id, executor_id, created_at)
      VALUES (@guild_id, @user_id, @role_id, @executor_id, @created_at)
    `),
    getForcedRoleStrip: connection.prepare('SELECT * FROM forced_role_strips WHERE guild_id = ? AND user_id = ? AND role_id = ?'),
    getForcedRoleStrips: connection.prepare('SELECT * FROM forced_role_strips WHERE guild_id = ? ORDER BY created_at, user_id'),
    getForcedRoleStripsForUser: connection.prepare('SELECT * FROM forced_role_strips WHERE guild_id = ? AND user_id = ?'),
    getForcedRoleStripsForRole: connection.prepare('SELECT * FROM forced_role_strips WHERE guild_id = ? AND role_id = ?'),
    removeForcedRoleStripsForUser: connection.prepare('DELETE FROM forced_role_strips WHERE guild_id = ? AND user_id = ?'),
    addGlobalRoleStrip: connection.prepare(`
      INSERT OR IGNORE INTO global_role_strips (guild_id, role_id, executor_id, created_at)
      VALUES (@guild_id, @role_id, @executor_id, @created_at)
    `),
    getGlobalRoleStrip: connection.prepare('SELECT * FROM global_role_strips WHERE guild_id = ? AND role_id = ?'),
    getGlobalRoleStrips: connection.prepare('SELECT * FROM global_role_strips WHERE guild_id = ? ORDER BY created_at, role_id'),
    removeGlobalRoleStrip: connection.prepare('DELETE FROM global_role_strips WHERE guild_id = ? AND role_id = ?'),
    upsertForeverBan: connection.prepare(`
      INSERT INTO forever_bans
        (guild_id, user_id, username, reason, executor_id, created_at, original_ban_status, rule_status)
      VALUES (@guild_id, @user_id, @username, @reason, @executor_id, @created_at, @original_ban_status, 'active')
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        username = excluded.username,
        reason = excluded.reason,
        executor_id = excluded.executor_id,
        created_at = excluded.created_at,
        original_ban_status = excluded.original_ban_status,
        rule_status = 'active'
    `),
    getForeverBan: connection.prepare("SELECT * FROM forever_bans WHERE guild_id = ? AND user_id = ? AND rule_status = 'active'"),
    getForeverBans: connection.prepare("SELECT * FROM forever_bans WHERE guild_id = ? AND rule_status = 'active' ORDER BY created_at, user_id"),
    removeForeverBan: connection.prepare('DELETE FROM forever_bans WHERE guild_id = ? AND user_id = ?'),
    addForceManagementLog: connection.prepare(`
      INSERT INTO force_management_logs
        (guild_id, action, target_user_id, role_id, nickname, executor_id, result, reason, punishment, failure_reason, attribution_status, created_at)
      VALUES (@guild_id, @action, @target_user_id, @role_id, @nickname, @executor_id, @result, @reason, @punishment, @failure_reason, @attribution_status, @created_at)
    `)
  };

  return {
    connection,
    ensureGuild(guildId) {
      statements.ensureGuild.run(guildId);
      return statements.getSettings.get(guildId);
    },
    getSettings: (guildId) => statements.getSettings.get(guildId),
    setSetting(guildId, key, value) {
      const permitted = new Set(['os_role_id', 'vouch_role_id', 'reward_role_id', 'stripstaff_role_id', 'log_channel_id', 'default_giver_limit']);
      if (!permitted.has(key)) throw new Error('Unsupported guild setting.');
      connection.prepare(`UPDATE guild_settings SET ${key} = ? WHERE guild_id = ?`).run(value, guildId);
    },
    getOsUsers: (guildId) => statements.getOsUsers.all(guildId).map((row) => row.user_id),
    addOsUser: (guildId, userId) => statements.addOsUser.run(guildId, userId),
    removeOsUser: (guildId, userId) => statements.removeOsUser.run(guildId, userId),
    getLimitedRoles: (guildId) => statements.getLimitedRoles.all(guildId),
    getLimitedRole: (guildId, roleId) => statements.getLimitedRole.get(guildId, roleId),
    setLimitedRole: (guildId, roleId, limit) => statements.setLimitedRole.run(guildId, roleId, limit),
    removeLimitedRole: (guildId, roleId) => statements.removeLimitedRole.run(guildId, roleId),
    addGiver: (guildId, userId) => statements.addGiver.run(guildId, userId),
    removeGiver: (guildId, userId) => statements.removeGiver.run(guildId, userId),
    getGiver: (guildId, userId) => statements.getGiver.get(guildId, userId),
    getGivers: (guildId) => statements.getGivers.all(guildId),
    setGiverLimit: (guildId, userId, limit) => statements.setGiverLimit.run(limit, guildId, userId),
    getOsVouchLimit: (guildId, userId) => statements.getOsVouchLimit.get(guildId, userId)?.custom_limit ?? null,
    setOsVouchLimit: (guildId, userId, limit) => statements.setOsVouchLimit.run(guildId, userId, limit),
    removeOsVouchLimit: (guildId, userId) => statements.removeOsVouchLimit.run(guildId, userId),
    addVouchAdmin: (guildId, userId, addedBy, createdAt = new Date().toISOString()) => statements.addVouchAdmin.run(guildId, userId, addedBy, createdAt),
    removeVouchAdmin: (guildId, userId) => statements.removeVouchAdmin.run(guildId, userId),
    getVouchAdmin: (guildId, userId) => statements.getVouchAdmin.get(guildId, userId),
    getVouchAdmins: (guildId) => statements.getVouchAdmins.all(guildId),
    setVouchAdminLimit: (guildId, userId, limit) => statements.setVouchAdminLimit.run(limit, guildId, userId),
    addOwnerAllowed: (guildId, userId, addedBy, createdAt = new Date().toISOString()) => statements.addOwnerAllowed.run(guildId, userId, addedBy, createdAt),
    removeOwnerAllowed: (guildId, userId) => statements.removeOwnerAllowed.run(guildId, userId),
    isOwnerAllowed: (guildId, userId) => Boolean(statements.isOwnerAllowed.get(guildId, userId)),
    getOwnerAllowed: (guildId) => statements.getOwnerAllowed.all(guildId),
    getVouch: (guildId, recipientId) => statements.getVouch.get(guildId, recipientId),
    getVouches: (guildId) => statements.getVouches.all(guildId),
    countGiverVouches: (guildId, giverId) => statements.countGiverVouches.get(guildId, giverId).count,
    addVouch: (guildId, recipientId, giverId, reason, createdAt) => statements.addVouch.run(guildId, recipientId, giverId, reason, createdAt),
    removeVouch: (guildId, recipientId) => statements.removeVouch.run(guildId, recipientId),
    clearVouches: (guildId) => statements.clearVouches.run(guildId),
    isBlacklisted: (guildId, userId) => Boolean(statements.isBlacklisted.get(guildId, userId)),
    getBlacklist: (guildId) => statements.getBlacklist.all(guildId),
    addBlacklist: (guildId, userId, actorId, createdAt) => statements.addBlacklist.run(guildId, userId, actorId, createdAt),
    removeBlacklist: (guildId, userId) => statements.removeBlacklist.run(guildId, userId),
    addEventLog: (entry) => statements.addEventLog.run(entry),
    setForcedNickname: (entry) => statements.setForcedNickname.run(entry),
    getForcedNickname: (guildId, userId) => statements.getForcedNickname.get(guildId, userId),
    getForcedNicknames: (guildId) => statements.getForcedNicknames.all(guildId),
    removeForcedNickname: (guildId, userId) => statements.removeForcedNickname.run(guildId, userId),
    addForcedRoleStrip: (entry) => statements.addForcedRoleStrip.run(entry),
    getForcedRoleStrip: (guildId, userId, roleId) => statements.getForcedRoleStrip.get(guildId, userId, roleId),
    getForcedRoleStrips: (guildId) => statements.getForcedRoleStrips.all(guildId),
    getForcedRoleStripsForUser: (guildId, userId) => statements.getForcedRoleStripsForUser.all(guildId, userId),
    getForcedRoleStripsForRole: (guildId, roleId) => statements.getForcedRoleStripsForRole.all(guildId, roleId),
    removeForcedRoleStripsForUser: (guildId, userId) => statements.removeForcedRoleStripsForUser.run(guildId, userId),
    addGlobalRoleStrip: (entry) => statements.addGlobalRoleStrip.run(entry),
    getGlobalRoleStrip: (guildId, roleId) => statements.getGlobalRoleStrip.get(guildId, roleId),
    getGlobalRoleStrips: (guildId) => statements.getGlobalRoleStrips.all(guildId),
    removeGlobalRoleStrip: (guildId, roleId) => statements.removeGlobalRoleStrip.run(guildId, roleId),
    upsertForeverBan: (entry) => statements.upsertForeverBan.run(entry),
    getForeverBan: (guildId, userId) => statements.getForeverBan.get(guildId, userId),
    getForeverBans: (guildId) => statements.getForeverBans.all(guildId),
    removeForeverBan: (guildId, userId) => statements.removeForeverBan.run(guildId, userId),
    addForceManagementLog: (entry) => statements.addForceManagementLog.run(entry),
    close: () => connection.close()
  };
}

module.exports = { createDatabase };