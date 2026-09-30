const OS_DEFAULT_VOUCH_LIMIT = 5;
const VOUCH_ADMIN_DEFAULT_LIMIT = 5;

// The real Discord Guild Owner. Only this user can grant or revoke Owner Allow.
function isGuildOwner(member) {
  return Boolean(member && member.id === member.guild.ownerId);
}

function isOwnerAllowed(member, db) {
  return Boolean(member && db && db.isOwnerAllowed(member.guild.id, member.id));
}

// Guild Owner or a user granted Owner Allow: full Guild Owner treatment everywhere.
function hasOwnerAccess(member, db) {
  return isGuildOwner(member) || isOwnerAllowed(member, db);
}

function isOs(member, db) {
  if (!member) return false;
  const settings = db.getSettings(member.guild.id);
  return db.getOsUsers(member.guild.id).includes(member.id)
    || Boolean(settings.os_role_id && member.roles.cache.has(settings.os_role_id));
}

function isOwnerOrOs(member, db) {
  return hasOwnerAccess(member, db) || isOs(member, db);
}

function isVouchAdmin(member, db) {
  return Boolean(member && db.getVouchAdmin(member.guild.id, member.id));
}

// Vouch Admin powers: granted admins, OS, Guild Owner and Owner Allow users.
function hasVouchAdminAccess(member, db) {
  return isOwnerOrOs(member, db) || isVouchAdmin(member, db);
}

function isVouchGiver(member, db) {
  return Boolean(member && db.getGiver(member.guild.id, member.id));
}

function isFounder(member) {
  if (!member) return false;
  const founderIds = (process.env.FORCE_FOUNDER_IDS || '').split(/[\s,;]+/).filter(Boolean);
  return founderIds.includes(member.id);
}

function isForceManager(member, db) {
  return isOwnerOrOs(member, db) || isFounder(member);
}

function giverLimit(guildId, userId, db, member = null) {
  const osCustomLimit = db.getOsVouchLimit(guildId, userId);
  if (osCustomLimit !== null) return osCustomLimit;
  const admin = db.getVouchAdmin(guildId, userId);
  if (admin?.custom_limit !== null && admin?.custom_limit !== undefined) return admin.custom_limit;
  const giver = db.getGiver(guildId, userId);
  if (giver?.custom_limit !== null && giver?.custom_limit !== undefined) return giver.custom_limit;
  const ownerAccess = member ? hasOwnerAccess(member, db) : db.isOwnerAllowed(guildId, userId);
  if (ownerAccess) return null;
  if (member ? isOs(member, db) : db.getOsUsers(guildId).includes(userId)) return OS_DEFAULT_VOUCH_LIMIT;
  if (admin) return VOUCH_ADMIN_DEFAULT_LIMIT;
  if (!giver) return null;
  return db.getSettings(guildId).default_giver_limit;
}

function remainingVouches(guildId, userId, db, member = null) {
  const limit = giverLimit(guildId, userId, db, member);
  if (limit === null) return null;
  return Math.max(0, limit - db.countGiverVouches(guildId, userId));
}

function canGiveVouch(member, db) {
  const authorized = hasVouchAdminAccess(member, db) || isVouchGiver(member, db);
  if (!authorized) return { allowed: false, remaining: null };
  const limit = giverLimit(member.guild.id, member.id, db, member);
  if (limit === null) return { allowed: true, remaining: null };
  const remaining = remainingVouches(member.guild.id, member.id, db, member);
  return { allowed: remaining > 0, remaining };
}

module.exports = {
  OS_DEFAULT_VOUCH_LIMIT,
  VOUCH_ADMIN_DEFAULT_LIMIT,
  isGuildOwner,
  isOwnerAllowed,
  hasOwnerAccess,
  isVouchAdmin,
  hasVouchAdminAccess,
  isVouchGiver,
  isOs,
  isOwnerOrOs,
  isFounder,
  isForceManager,
  giverLimit,
  remainingVouches,
  canGiveVouch
};