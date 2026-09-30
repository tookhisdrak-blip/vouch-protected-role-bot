const { embed, success, failure, mentionRole, mentionUser } = require('../utils/embeds');
const { isOwnerOrOs } = require('../services/permissions');
const { FAKE_PERMISSIONS, normalizeFakePermission } = require('../services/fakePermissions');
const { logEvent } = require('../services/eventLogger');
const { resolveUserOrRole } = require('./utils');

const USAGE = 'Use `-fp add @user/id or @role/id <permission>`, `-fp remove @user/id or @role/id <permission>` or `-fp list`.';

function reply(message, payload) {
  return message.reply({ ...payload, allowedMentions: { parse: [] } });
}

async function resolveTarget(guild, client, input) {
  const target = await resolveUserOrRole(guild, input);
  if (target) return { type: target.type, id: target.id };
  if (!/^[0-9]{17,20}$/.test(input || '')) return null;
  const user = await client?.users?.fetch(input).catch(() => null);
  return user ? { type: 'user', id: user.id } : null;
}

function targetText(target) {
  return target.type === 'role' ? mentionRole(target.id) : mentionUser(target.id);
}

async function change(message, args, db, adding) {
  const [targetInput, permissionInput] = args;
  if (!targetInput || !permissionInput) return reply(message, { embeds: [failure(USAGE)] });
  const permission = normalizeFakePermission(permissionInput);
  if (!permission) {
    return reply(message, { embeds: [failure(`Unknown fake permission. Available: ${Object.keys(FAKE_PERMISSIONS).map((key) => `\`${key}\``).join(', ')}.`)] });
  }
  const target = await resolveTarget(message.guild, message.client, targetInput);
  if (!target) return reply(message, { embeds: [failure('I could not resolve that user or role.')] });

  const guildId = message.guild.id;
  const changed = adding
    ? db.addFakePermission(guildId, target.type, target.id, permission, message.author.id).changes > 0
    : db.removeFakePermission(guildId, target.type, target.id, permission).changes > 0;
  if (!changed) {
    return reply(message, { embeds: [failure(adding
      ? `${targetText(target)} already has fake \`${permission}\`.`
      : `${targetText(target)} does not have fake \`${permission}\`.`)] });
  }
  await logEvent(message.guild, db, {
    event_type: 'FAKE PERMISSION UPDATED',
    executor_id: message.author.id,
    affected_user_id: target.type === 'user' ? target.id : null,
    role_id: target.type === 'role' ? target.id : null,
    reason: permission,
    action_taken: adding ? 'Fake permission granted' : 'Fake permission removed',
    punishment: null
  });
  return reply(message, { embeds: [success(adding
    ? `${targetText(target)} now has fake \`${permission}\`. Discord permissions were not changed.`
    : `Fake \`${permission}\` removed from ${targetText(target)}.`)] });
}

function list(message, db) {
  const rows = db.getFakePermissions(message.guild.id);
  const lines = Object.keys(FAKE_PERMISSIONS).map((permission) => {
    const holders = rows.filter((row) => row.permission === permission)
      .map((row) => targetText({ type: row.target_type, id: row.target_id }));
    return `\`${permission}\`: ${holders.length ? holders.join(', ') : 'none'}`;
  });
  lines.push('OS and Guild Owner have every fake permission automatically.');
  return reply(message, { embeds: [embed('Fake permissions', lines.join('\n').slice(0, 4000))] });
}

async function execute(message, args, db) {
  if (!isOwnerOrOs(message.member, db)) {
    return reply(message, { embeds: [failure('Only OS or the Guild Owner can manage fake permissions.')] });
  }
  const sub = args[0]?.toLowerCase();
  if (sub === 'add') return change(message, args.slice(1), db, true);
  if (sub === 'remove') return change(message, args.slice(1), db, false);
  if (sub === 'list') return list(message, db);
  return reply(message, { embeds: [failure(USAGE)] });
}

module.exports = { execute, resolveTarget };
