const OS_DEFAULT_VOUCH_LIMIT = 5;

function isGuildOwner(member) {
  return Boolean(member && member.id === member.guild.ownerId);
}

function isOs(member, db) {
  if (!member) return false;
  const settings = db.getSettings(member.guild.id);
  return db.getOsUsers(member.guild.id).includes(member.id)
    || Boolean(settings.os_role_id && member.roles.cache.has(settings.os_role_id));
}

function isOwnerOrOs(member, db) {
  return isGuildOwner(member) || isOs(member, db);
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
  const giver = db.getGiver(guildId, userId);
  if (giver?.custom_limit !== null && giver?.custom_limit !== undefined) return giver.custom_limit;
  const settings = db.getSettings(guildId);
  if (member ? isOs(member, db) : db.getOsUsers(guildId).includes(userId)) return OS_DEFAULT_VOUCH_LIMIT;
  if (!giver) return null;
  return settings.default_giver_limit;
}

function remainingVouches(guildId, userId, db, member = null) {
  const limit = giverLimit(guildId, userId, db, member);
  if (limit === null) return null;
  return Math.max(0, limit - db.countGiverVouches(guildId, userId));
}

function canGiveVouch(member, db) {
  const authorized = isGuildOwner(member) || isOs(member, db) || Boolean(db.getGiver(member.guild.id, member.id));
  if (!authorized) return { allowed: false, remaining: null };
  const limit = giverLimit(member.guild.id, member.id, db, member);
  if (limit === null) return { allowed: true, remaining: null };
  const remaining = remainingVouches(member.guild.id, member.id, db, member);
  return { allowed: remaining > 0, remaining };
}

module.exports = {
  OS_DEFAULT_VOUCH_LIMIT,
  isGuildOwner,
  isOs,
  isOwnerOrOs,
  isFounder,
  isForceManager,
  giverLimit,
  remainingVouches,
  canGiveVouch
};