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

function replyError(message, title) {
  return message.reply({ embeds: [failure(message, title)], allowedMentions: { parse: [] } });
}

function requiredOwner(member) {
  return member.id === member.guild.ownerId;
}

module.exports = { userIdFrom, roleIdFrom, isRoleMention, isUserMention, getMember, replyError, requiredOwner };