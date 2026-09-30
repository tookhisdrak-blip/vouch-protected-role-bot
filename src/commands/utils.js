const { failure } = require('../utils/embeds');

function userIdFrom(value) {
  return value?.match(/^<@!?([0-9]+)>$/)?.[1] || (value?.match(/^[0-9]{17,20}$/) ? value : null);
}

function roleIdFrom(value) {
  return value?.match(/^<@&([0-9]+)>$/)?.[1] || (value?.match(/^[0-9]{17,20}$/) ? value : null);
}

function isRoleMention(value) {
  return /^<@&[0-9]+>$/.test(value || '');
}

function isUserMention(value) {
  return /^<@!?[0-9]+>$/.test(value || '');
}

async function getMember(guild, value) {
  const id = userIdFrom(value);
  if (!id) return null;
  return guild.members.fetch(id).catch(() => null);
}

async function getRole(guild, value) {
  const id = roleIdFrom(value);
  if (!id || id === guild.id) return null;
  const cached = guild.roles.cache.get(id);
  if (cached) return cached;
  if (typeof guild.roles.fetch !== 'function') return null;
  return guild.roles.fetch(id).catch(() => null);
}

async function resolveUserOrRole(guild, value) {
  if (isUserMention(value)) {
    const member = await getMember(guild, value);
    return member ? { type: 'user', id: member.id, member } : null;
  }
  if (isRoleMention(value)) {
    const role = await getRole(guild, value);
    return role ? { type: 'role', id: role.id, role } : null;
  }
  if (!/^[0-9]{17,20}$/.test(value || '')) return null;

  const role = await getRole(guild, value);
  if (role) return { type: 'role', id: role.id, role };
  const member = await getMember(guild, value);
  return member ? { type: 'user', id: member.id, member } : null;
}

function replyError(message, title) {
  return message.reply({ embeds: [failure(message, title)], allowedMentions: { parse: [] } });
}

function requiredOwner(member) {
  return member.id === member.guild.ownerId;
}

module.exports = {
  userIdFrom,
  roleIdFrom,
  isRoleMention,
  isUserMention,
  getMember,
  getRole,
  resolveUserOrRole,
  replyError,
  requiredOwner
};