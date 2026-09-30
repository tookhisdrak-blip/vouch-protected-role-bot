const { embed, success, failure, argumentFailure, mentionRole } = require('../utils/embeds');
const { isOwnerOrOs } = require('../services/permissions');
const { getRole } = require('./utils');

function reply(message, payload) {
  return message.reply({ ...payload, allowedMentions: { parse: [] } });
}

function requireManager(message, db) {
  if (isOwnerOrOs(message.member, db)) return null;
  return reply(message, { embeds: [failure('Only the Guild Owner, Owner Allow users, or OS can manage role locks.')] });
}

async function lockRole(message, args, db) {
  const denied = requireManager(message, db);
  if (denied) return denied;
  if (!args.length) {
    return reply(message, { embeds: [argumentFailure('use a role mention or role ID bro')] });
  }

  const input = args.join(' ').trim();
  const separator = input.match(/^(\S+)\s+to(?:\s+(.*))?$/i);
  if (!separator) {
    return reply(message, { embeds: [argumentFailure('use: -lockrole @role to @role, @role')] });
  }
  const [, lockedInput, authorizationInput = ''] = separator;
  if (!authorizationInput.trim()) {
    return reply(message, { embeds: [argumentFailure('use at least one role after "to"')] });
  }

  const lockedRole = await getRole(message.guild, lockedInput);
  if (!lockedRole) {
    return reply(message, { embeds: [argumentFailure("I couldn't find that role bro")] });
  }

  const authorizationInputs = authorizationInput.split(',').map((value) => value.trim());
  if (authorizationInputs.some((value) => !value)) {
    return reply(message, { embeds: [argumentFailure("I couldn't find one of the authorization roles bro")] });
  }
  const authorizationRoles = [];
  for (const value of authorizationInputs) {
    const role = await getRole(message.guild, value);
    if (!role) {
      return reply(message, { embeds: [argumentFailure("I couldn't find one of the authorization roles bro")] });
    }
    authorizationRoles.push(role);
  }

  const authorizationRoleIds = [...new Set(authorizationRoles.map((role) => role.id))];
  db.setRoleLock(message.guild.id, lockedRole.id, authorizationRoleIds, message.author.id);
  return reply(message, {
    embeds: [success(
      `${mentionRole(lockedRole.id)} can now be manually managed by members with any of: ${authorizationRoleIds.map(mentionRole).join(', ')}.`,
      'Role lock saved'
    )]
  });
}

async function unlockRole(message, args, db) {
  const denied = requireManager(message, db);
  if (denied) return denied;
  if (!args[0]) {
    return reply(message, { embeds: [argumentFailure('use a role mention or role ID bro')] });
  }
  const role = await getRole(message.guild, args[0]);
  if (!role) return reply(message, { embeds: [argumentFailure("I couldn't find that role bro")] });
  const result = db.removeRoleLock(message.guild.id, role.id);
  if (!result.changes) {
    return reply(message, { embeds: [argumentFailure('That role is not locked bro.')] });
  }
  return reply(message, { embeds: [success(`${mentionRole(role.id)} is no longer role-locked.`, 'Role lock removed')] });
}

async function listRoleLocks(message, db) {
  const locks = db.getRoleLocks(message.guild.id);
  if (!locks.length) {
    return reply(message, { embeds: [embed('Role locks', 'No role locks are configured.')] });
  }
  const description = locks.map((lock) =>
    `${mentionRole(lock.locked_role_id)} \u2192 ${lock.authorization_role_ids.map(mentionRole).join(', ')}`
  ).join('\n');
  return reply(message, { embeds: [embed('Role locks', description)] });
}

module.exports = { lockRole, unlockRole, listRoleLocks };
