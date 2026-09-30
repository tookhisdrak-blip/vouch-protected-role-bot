const { embed, success, failure, argumentFailure, mentionRole, mentionUser } = require('../utils/embeds');
const { isOwnerOrOs } = require('../services/permissions');
const { canManagePaidWhitelist } = require('../services/paidRoles');
const { getMember, getRole, resolveUserOrRole } = require('./utils');

function reply(message, payload) {
  return message.reply({ ...payload, allowedMentions: { parse: [] } });
}

function requireManager(message, db) {
  if (isOwnerOrOs(message.member, db)) return null;
  return reply(message, {
    embeds: [failure('Only the Guild Owner, Owner Allow users, or OS can configure paid roles.')]
  });
}

function compactMentions(ids, formatter, limit = 25) {
  if (!ids.length) return 'None';
  const shown = ids.slice(0, limit).map(formatter).join(', ');
  return ids.length > limit ? `${shown}, and ${ids.length - limit} more` : shown;
}

async function setPaidRole(message, args, db) {
  const denied = requireManager(message, db);
  if (denied) return denied;
  if (!args[0]) return reply(message, { embeds: [argumentFailure('Use a @role or role ID bro.')] });
  const role = await getRole(message.guild, args[0]);
  if (!role) return reply(message, { embeds: [argumentFailure("I couldn't find that role bro.")] });
  const result = db.addPaidRole(message.guild.id, role.id, message.author.id);
  return reply(message, {
    embeds: [success(
      result.changes
        ? `${mentionRole(role.id)} is now protected by the paid-role whitelist.`
        : `${mentionRole(role.id)} is already a paid role.`,
      'Paid role saved'
    )]
  });
}

async function setVerifiedRole(message, args, db) {
  const denied = requireManager(message, db);
  if (denied) return denied;
  if (!args[0]) {
    return reply(message, { embeds: [argumentFailure('Use a @role/role ID or @user/user ID bro.')] });
  }
  const target = await resolveUserOrRole(message.guild, args[0]);
  if (!target) {
    return reply(message, { embeds: [argumentFailure("I couldn't find that role or user bro.")] });
  }
  if (target.type === 'role') {
    db.setPaidVerifiedRole(message.guild.id, target.id, message.author.id);
    return reply(message, {
      embeds: [success(`${mentionRole(target.id)} can now whitelist paid-role users.`, 'Verified role saved')]
    });
  }
  db.addPaidVerifiedUser(message.guild.id, target.id, message.author.id);
  return reply(message, {
    embeds: [success(`${mentionUser(target.id)} can now whitelist paid-role users.`, 'Verified user saved')]
  });
}

async function whitelistPaidUser(message, args, db) {
  if (!canManagePaidWhitelist(message.member, db)) {
    return reply(message, {
      embeds: [failure('Only verified paid-role users, OS, Owner Allow users, or the Guild Owner can use `-paid`.')]
    });
  }
  if (!args[0]) return reply(message, { embeds: [argumentFailure('Use a @user or user ID bro.')] });
  const member = await getMember(message.guild, args[0]);
  if (!member) return reply(message, { embeds: [argumentFailure("I couldn't find that user bro.")] });
  const result = db.addPaidWhitelistUser(message.guild.id, member.id, message.author.id);
  return reply(message, {
    embeds: [success(
      result.changes
        ? `${mentionUser(member.id)} can now receive and keep all configured paid roles.`
        : `${mentionUser(member.id)} is already whitelisted for paid roles.`,
      'Paid whitelist updated'
    )]
  });
}

async function listPaidConfiguration(message, db) {
  const paidRoleIds = db.getPaidRoles(message.guild.id).map((row) => row.role_id);
  const whitelistUserIds = db.getPaidWhitelistUsers(message.guild.id).map((row) => row.user_id);
  const verifiedRoleId = db.getPaidVerifiedRole(message.guild.id);
  const verifiedUserIds = db.getPaidVerifiedUsers(message.guild.id).map((row) => row.user_id);
  const description = [
    `**Paid roles:** ${compactMentions(paidRoleIds, mentionRole)}`,
    `**Whitelisted users:** ${compactMentions(whitelistUserIds, mentionUser)}`,
    `**Verified role:** ${verifiedRoleId ? mentionRole(verifiedRoleId) : 'None'}`,
    `**Verified users:** ${compactMentions(verifiedUserIds, mentionUser)}`
  ].join('\n');
  return reply(message, { embeds: [embed('Paid role whitelist', description)] });
}

module.exports = { setPaidRole, setVerifiedRole, whitelistPaidUser, listPaidConfiguration };
