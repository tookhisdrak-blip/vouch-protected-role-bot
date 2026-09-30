const { isOwnerOrOs } = require('./permissions');

// Internal bot-only permissions. Discord permissions are never changed.
// Add new entries here to extend the system.
const FAKE_PERMISSIONS = Object.freeze({
  ban_members: 'Use Forever Ban and Forever Unban commands.'
});

function normalizeFakePermission(value) {
  const key = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FAKE_PERMISSIONS, key) ? key : null;
}

function hasFakePermission(member, db, permission) {
  if (!member || !normalizeFakePermission(permission)) return false;
  if (isOwnerOrOs(member, db)) return true;
  const grants = db.getFakePermissionGrants(member.guild.id, permission);
  return grants.some((grant) => (grant.target_type === 'user'
    ? grant.target_id === member.id
    : member.roles.cache.has(grant.target_id)));
}

module.exports = { FAKE_PERMISSIONS, normalizeFakePermission, hasFakePermission };
