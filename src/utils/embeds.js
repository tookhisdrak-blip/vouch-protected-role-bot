const { EmbedBuilder } = require('discord.js');

const COLORS = { info: 0x5865f2, success: 0x2d9d78, error: 0xc44545, log: 0x52616b };

function embed(title, description, color = COLORS.info) {
  const result = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (description) result.setDescription(description);
  return result;
}

function success(description, title = 'Complete') {
  return embed(title, description, COLORS.success);
}

function failure(description, title = 'Unable to complete') {
  return embed(title, description, COLORS.error);
}

function argumentFailure(description) {
  return embed('Invalid command', description, COLORS.error);
}

function userArgumentFailure() {
  return argumentFailure('Use a @mention or user ID bro.');
}

function roleArgumentFailure() {
  return argumentFailure('Use a @role or role ID bro.');
}

function userRoleArgumentFailure() {
  return argumentFailure('Use a @user/user ID and @role/role ID bro.');
}

function mentionUser(userId) {
  return `<@${userId}>`;
}

function mentionRole(roleId) {
  return `<@&${roleId}>`;
}

module.exports = {
  COLORS,
  embed,
  success,
  failure,
  argumentFailure,
  userArgumentFailure,
  roleArgumentFailure,
  userRoleArgumentFailure,
  mentionUser,
  mentionRole
};