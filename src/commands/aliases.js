const { embed, success, failure, argumentFailure } = require('../utils/embeds');
const { isOwnerOrOs } = require('../services/permissions');
const { logEvent } = require('../services/eventLogger');

const SHORTCUT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function reply(message, payload) {
  return message.reply({ ...payload, allowedMentions: { parse: [] } });
}

function normalizeShortcut(value) {
  return value?.toLowerCase().replace(/^-+/, '') || '';
}

function validateCommand(command, handlers) {
  if (!command || command.startsWith('-') || command.length > 200) return false;
  const [root] = command.toLowerCase().split(/\s+/);
  return root !== 'alias' && handlers.has(root);
}

async function execute(message, args, db, options) {
  if (!isOwnerOrOs(message.member, db)) {
    return reply(message, { embeds: [failure('Only OS or the Guild Owner can manage command aliases.')] });
  }

  const action = args[0]?.toLowerCase();
  if (action === 'list') {
    const aliases = db.getCommandAliases(message.guild.id);
    const lines = aliases.map((row) => `\`-${row.shortcut}\` -> \`-${row.command}\``);
    return reply(message, { embeds: [embed('Custom aliases', lines.join('\n') || 'No custom aliases configured.')] });
  }

  const shortcut = normalizeShortcut(args[1]);
  if (!SHORTCUT_PATTERN.test(shortcut)) {
    return reply(message, { embeds: [argumentFailure('Add a valid shortcut bro.')] });
  }
  if (action === 'remove') {
    const removed = db.removeCommandAlias(message.guild.id, shortcut).changes > 0;
    if (!removed) return reply(message, { embeds: [argumentFailure('Use an existing custom alias bro.')] });
    await logEvent(message.guild, db, {
      event_type: 'COMMAND ALIAS UPDATED',
      executor_id: message.author.id,
      affected_user_id: null,
      role_id: null,
      reason: shortcut,
      action_taken: 'Custom alias removed',
      punishment: null
    });
    return reply(message, { embeds: [success(`Custom alias \`-${shortcut}\` was removed.`)] });
  }

  if (action !== 'add') {
    return reply(message, { embeds: [argumentFailure('Use `add`, `remove`, or `list` bro.')] });
  }
  if (options.handlers.has(shortcut) || options.defaultAliases.has(shortcut)) {
    return reply(message, { embeds: [argumentFailure('That shortcut is already reserved bro.')] });
  }

  const command = args.slice(2).join(' ').trim().toLowerCase();
  if (!command) return reply(message, { embeds: [argumentFailure('Add the original command bro.')] });
  if (!validateCommand(command, options.handlers)) {
    return reply(message, { embeds: [argumentFailure('Use an existing original command bro.')] });
  }
  db.setCommandAlias(message.guild.id, shortcut, command, message.author.id);
  await logEvent(message.guild, db, {
    event_type: 'COMMAND ALIAS UPDATED',
    executor_id: message.author.id,
    affected_user_id: null,
    role_id: null,
    reason: shortcut,
    action_taken: `Custom alias saved for -${command}`,
    punishment: null
  });
  return reply(message, { embeds: [success(`\`-${shortcut}\` now runs \`-${command}\`.`)] });
}

module.exports = { execute, normalizeShortcut, validateCommand, SHORTCUT_PATTERN };
