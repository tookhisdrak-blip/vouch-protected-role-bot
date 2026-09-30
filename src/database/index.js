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
      reward TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guild_log_channels (
      guild_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('vouch', 'ban', 'main', 'admin')),
      channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, category)
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
    CREATE TABLE IF NOT EXISTS fake_permissions (
      guild_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('user', 'role')),
      target_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, target_type, target_id, permission)
    );
    CREATE TABLE IF NOT EXISTS command_aliases (
      guild_id TEXT NOT NULL,
      shortcut TEXT NOT NULL,
      command TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, shortcut)
    );
    CREATE TABLE IF NOT EXISTS role_locks (
      guild_id TEXT NOT NULL,
      locked_role_id TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, locked_role_id)
    );
    CREATE TABLE IF NOT EXISTS role_lock_authorizations (
      guild_id TEXT NOT NULL,
      locked_role_id TEXT NOT NULL,
      authorization_role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, locked_role_id, authorization_role_id),
      FOREIGN KEY (guild_id, locked_role_id)
        REFERENCES role_locks (guild_id, locked_role_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS paid_roles (
      guild_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS paid_role_whitelist (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS paid_verified_config (
      guild_id TEXT PRIMARY KEY,
      role_id TEXT,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paid_verified_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
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
  const eventLogColumns = new Set(connection.pragma('table_info(event_logs)').map((column) => column.name));
  if (!eventLogColumns.has('reward')) {
    connection.exec('ALTER TABLE event_logs ADD COLUMN reward TEXT');
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
        (guild_id, event_type, executor_id, affected_user_id, role_id, reason, action_taken, punishment, reward, created_at)
      VALUES (@guild_id, @event_type, @executor_id, @affected_user_id, @role_id, @reason, @action_taken, @punishment, @reward, @created_at)
    `),
    getLogChannel: connection.prepare('SELECT channel_id FROM guild_log_channels WHERE guild_id = ? AND category = ?'),
    getLogChannels: connection.prepare('SELECT category, channel_id FROM guild_log_channels WHERE guild_id = ?'),
    setLogChannel: connection.prepare(`
      INSERT INTO guild_log_channels (guild_id, category, channel_id) VALUES (?, ?, ?)
      ON CONFLICT(guild_id, category) DO UPDATE SET channel_id = excluded.channel_id
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
    addFakePermission: connection.prepare(`
      INSERT OR IGNORE INTO fake_permissions (guild_id, target_type, target_id, permission, added_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    removeFakePermission: connection.prepare('DELETE FROM fake_permissions WHERE guild_id = ? AND target_type = ? AND target_id = ? AND permission = ?'),
    getFakePermissions: connection.prepare('SELECT * FROM fake_permissions WHERE guild_id = ? ORDER BY permission, target_type, created_at, target_id'),
    getFakePermissionGrants: connection.prepare('SELECT target_type, target_id FROM fake_permissions WHERE guild_id = ? AND permission = ?'),
    getCommandAlias: connection.prepare('SELECT * FROM command_aliases WHERE guild_id = ? AND shortcut = ?'),
    getCommandAliases: connection.prepare('SELECT * FROM command_aliases WHERE guild_id = ? ORDER BY shortcut'),
    setCommandAlias: connection.prepare(`
      INSERT INTO command_aliases (guild_id, shortcut, command, added_by, created_at, updated_at)
      VALUES (@guild_id, @shortcut, @command, @added_by, @created_at, @updated_at)
      ON CONFLICT(guild_id, shortcut) DO UPDATE SET
        command = excluded.command,
        added_by = excluded.added_by,
        updated_at = excluded.updated_at
    `),
    removeCommandAlias: connection.prepare('DELETE FROM command_aliases WHERE guild_id = ? AND shortcut = ?'),
    getRoleLock: connection.prepare(`
      SELECT authorization_role_id
      FROM role_lock_authorizations
      WHERE guild_id = ? AND locked_role_id = ?
      ORDER BY rowid
    `),
    getRoleLocks: connection.prepare(`
      SELECT locks.locked_role_id, authorizations.authorization_role_id
      FROM role_locks AS locks
      JOIN role_lock_authorizations AS authorizations
        ON authorizations.guild_id = locks.guild_id
        AND authorizations.locked_role_id = locks.locked_role_id
      WHERE locks.guild_id = ?
      ORDER BY locks.created_at, locks.locked_role_id, authorizations.rowid
    `),
    upsertRoleLock: connection.prepare(`
      INSERT INTO role_locks (guild_id, locked_role_id, updated_by, created_at, updated_at)
      VALUES (@guild_id, @locked_role_id, @updated_by, @created_at, @updated_at)
      ON CONFLICT(guild_id, locked_role_id) DO UPDATE SET
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `),
    clearRoleLockAuthorizations: connection.prepare(
      'DELETE FROM role_lock_authorizations WHERE guild_id = ? AND locked_role_id = ?'
    ),
    addRoleLockAuthorization: connection.prepare(`
      INSERT INTO role_lock_authorizations (guild_id, locked_role_id, authorization_role_id)
      VALUES (?, ?, ?)
    `),
    removeRoleLock: connection.prepare('DELETE FROM role_locks WHERE guild_id = ? AND locked_role_id = ?'),
    addPaidRole: connection.prepare(`
      INSERT OR IGNORE INTO paid_roles (guild_id, role_id, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `),
    getPaidRoles: connection.prepare('SELECT role_id, added_by, created_at FROM paid_roles WHERE guild_id = ? ORDER BY created_at, role_id'),
    isPaidRole: connection.prepare('SELECT 1 FROM paid_roles WHERE guild_id = ? AND role_id = ?'),
    addPaidWhitelistUser: connection.prepare(`
      INSERT OR IGNORE INTO paid_role_whitelist (guild_id, user_id, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `),
    getPaidWhitelistUsers: connection.prepare(
      'SELECT user_id, added_by, created_at FROM paid_role_whitelist WHERE guild_id = ? ORDER BY created_at, user_id'
    ),
    isPaidWhitelisted: connection.prepare('SELECT 1 FROM paid_role_whitelist WHERE guild_id = ? AND user_id = ?'),
    setPaidVerifiedRole: connection.prepare(`
      INSERT INTO paid_verified_config (guild_id, role_id, updated_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        role_id = excluded.role_id,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `),
    getPaidVerifiedRole: connection.prepare('SELECT role_id FROM paid_verified_config WHERE guild_id = ?'),
    addPaidVerifiedUser: connection.prepare(`
      INSERT OR IGNORE INTO paid_verified_users (guild_id, user_id, added_by, created_at)
      VALUES (?, ?, ?, ?)
    `),
    getPaidVerifiedUsers: connection.prepare(
      'SELECT user_id, added_by, created_at FROM paid_verified_users WHERE guild_id = ? ORDER BY created_at, user_id'
    ),
    isPaidVerifiedUser: connection.prepare('SELECT 1 FROM paid_verified_users WHERE guild_id = ? AND user_id = ?'),
    addForceManagementLog: connection.prepare(`
      INSERT INTO force_management_logs
        (guild_id, action, target_user_id, role_id, nickname, executor_id, result, reason, punishment, failure_reason, attribution_status, created_at)
      VALUES (@guild_id, @action, @target_user_id, @role_id, @nickname, @executor_id, @result, @reason, @punishment, @failure_reason, @attribution_status, @created_at)
    `)
  };
  const setRoleLockTransaction = connection.transaction((guildId, lockedRoleId, authorizationRoleIds, updatedBy, now) => {
    statements.upsertRoleLock.run({
      guild_id: guildId,
      locked_role_id: lockedRoleId,
      updated_by: updatedBy,
      created_at: now,
      updated_at: now
    });
    statements.clearRoleLockAuthorizations.run(guildId, lockedRoleId);
    for (const authorizationRoleId of authorizationRoleIds) {
      statements.addRoleLockAuthorization.run(guildId, lockedRoleId, authorizationRoleId);
    }
  });

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
    addEventLog(entry) {
      return statements.addEventLog.run({
        guild_id: entry.guild_id,
        event_type: entry.event_type,
        executor_id: entry.executor_id || null,
        affected_user_id: entry.affected_user_id || null,
        role_id: entry.role_id || null,
        reason: entry.reason || null,
        action_taken: entry.action_taken,
        punishment: entry.punishment || null,
        reward: entry.reward || null,
        created_at: entry.created_at
      });
    },
    getLogChannel: (guildId, category) => statements.getLogChannel.get(guildId, category)?.channel_id ?? null,
    getLogChannels: (guildId) => statements.getLogChannels.all(guildId),
    setLogChannel: (guildId, category, channelId) => statements.setLogChannel.run(guildId, category, channelId),
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
    addFakePermission: (guildId, targetType, targetId, permission, addedBy, createdAt = new Date().toISOString()) =>
      statements.addFakePermission.run(guildId, targetType, targetId, permission, addedBy, createdAt),
    removeFakePermission: (guildId, targetType, targetId, permission) =>
      statements.removeFakePermission.run(guildId, targetType, targetId, permission),
    getFakePermissions: (guildId) => statements.getFakePermissions.all(guildId),
    getFakePermissionGrants: (guildId, permission) => statements.getFakePermissionGrants.all(guildId, permission),
    getCommandAlias: (guildId, shortcut) => statements.getCommandAlias.get(guildId, shortcut),
    getCommandAliases: (guildId) => statements.getCommandAliases.all(guildId),
    setCommandAlias(guildId, shortcut, command, addedBy, now = new Date().toISOString()) {
      return statements.setCommandAlias.run({
        guild_id: guildId,
        shortcut,
        command,
        added_by: addedBy,
        created_at: now,
        updated_at: now
      });
    },
    removeCommandAlias: (guildId, shortcut) => statements.removeCommandAlias.run(guildId, shortcut),
    getRoleLock(guildId, lockedRoleId) {
      const authorizationRoleIds = statements.getRoleLock.all(guildId, lockedRoleId)
        .map((row) => row.authorization_role_id);
      return authorizationRoleIds.length ? { locked_role_id: lockedRoleId, authorization_role_ids: authorizationRoleIds } : null;
    },
    getRoleLocks(guildId) {
      const locks = new Map();
      for (const row of statements.getRoleLocks.all(guildId)) {
        if (!locks.has(row.locked_role_id)) {
          locks.set(row.locked_role_id, { locked_role_id: row.locked_role_id, authorization_role_ids: [] });
        }
        locks.get(row.locked_role_id).authorization_role_ids.push(row.authorization_role_id);
      }
      return [...locks.values()];
    },
    setRoleLock(guildId, lockedRoleId, authorizationRoleIds, updatedBy, now = new Date().toISOString()) {
      if (!authorizationRoleIds.length) throw new Error('A role lock requires at least one authorization role.');
      setRoleLockTransaction(guildId, lockedRoleId, [...new Set(authorizationRoleIds)], updatedBy, now);
    },
    removeRoleLock: (guildId, lockedRoleId) => statements.removeRoleLock.run(guildId, lockedRoleId),
    addPaidRole: (guildId, roleId, addedBy, createdAt = new Date().toISOString()) =>
      statements.addPaidRole.run(guildId, roleId, addedBy, createdAt),
    getPaidRoles: (guildId) => statements.getPaidRoles.all(guildId),
    isPaidRole: (guildId, roleId) => Boolean(statements.isPaidRole.get(guildId, roleId)),
    addPaidWhitelistUser: (guildId, userId, addedBy, createdAt = new Date().toISOString()) =>
      statements.addPaidWhitelistUser.run(guildId, userId, addedBy, createdAt),
    getPaidWhitelistUsers: (guildId) => statements.getPaidWhitelistUsers.all(guildId),
    isPaidWhitelisted: (guildId, userId) => Boolean(statements.isPaidWhitelisted.get(guildId, userId)),
    setPaidVerifiedRole: (guildId, roleId, updatedBy, updatedAt = new Date().toISOString()) =>
      statements.setPaidVerifiedRole.run(guildId, roleId, updatedBy, updatedAt),
    getPaidVerifiedRole: (guildId) => statements.getPaidVerifiedRole.get(guildId)?.role_id ?? null,
    addPaidVerifiedUser: (guildId, userId, addedBy, createdAt = new Date().toISOString()) =>
      statements.addPaidVerifiedUser.run(guildId, userId, addedBy, createdAt),
    getPaidVerifiedUsers: (guildId) => statements.getPaidVerifiedUsers.all(guildId),
    isPaidVerifiedUser: (guildId, userId) => Boolean(statements.isPaidVerifiedUser.get(guildId, userId)),
    addForceManagementLog: (entry) => statements.addForceManagementLog.run(entry),
    close: () => connection.close()
  };
}

module.exports = { createDatabase };