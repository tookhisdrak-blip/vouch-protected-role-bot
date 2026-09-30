const { failure } = require('../utils/embeds');
const vouch = require('../commands/vouch');
const help = require('../commands/help');
const admin = require('../commands/admin');
const forceManagement = require('../commands/forceManagement');
const vouchCommands = require('../commands/vouchCommands');
const fakePermissions = require('../commands/fakePermissions');
const aliases = require('../commands/aliases');
const roleLocks = require('../commands/roleLocks');
const paidRoles = require('../commands/paidRoles');

const defaultAliases = new Map([
  ['vg', ['vouch', 'give']],
  ['vag', ['vouch', 'addgiver']]
]);

const handlers = new Map([
  ['vouch', (message, args, db) => vouch.execute(message, args, db)],
  ['vouchblacklist', (message, args, db) => admin.blacklist(message, args, db)],
  ['setrole', (message, args, db) => admin.setRole(message, args, db)],
  ['setlimit', (message, args, db) => admin.setLimit(message, args, db)],
  ['limitedroles', (message, _args, db) => admin.limitedRoles(message, db)],
  ['setlog', (message, args, db) => admin.setLog(message, args, db)],
  ['vouchlogsetup', (message, _args, db, client) => admin.setupVouchLogs(message, db, client)],
  ['vouchhelp', (message, args, db) => help.execute(message, args, db)],
  ['vouchcommands', (message, args, db) => vouchCommands.execute(message, args, db)],
  ['forcemanage', (message, args, db) => forceManagement.execute(message, ['forcemanage', ...args], db)],
  ['forcenickname', (message, args, db) => forceManagement.execute(message, ['forcenickname', ...args], db)],
  ['unforcenickname', (message, args, db) => forceManagement.execute(message, ['unforcenickname', ...args], db)],
  ['forcerolestrip', (message, args, db) => forceManagement.execute(message, ['forcerolestrip', ...args], db)],
  ['unforcerolestrip', (message, args, db) => forceManagement.execute(message, ['unforcerolestrip', ...args], db)],
  ['rolestrip', (message, args, db) => forceManagement.execute(message, ['rolestrip', ...args], db)],
  ['forcestrip', (message, args, db) => forceManagement.execute(message, ['forcestrip', ...args], db)],
  ['unforcestrip', (message, args, db) => forceManagement.execute(message, ['unforcestrip', ...args], db)],
  ['foreverban', (message, args, db) => forceManagement.execute(message, ['foreverban', ...args], db)],
  ['unforeverban', (message, args, db) => forceManagement.execute(message, ['unforeverban', ...args], db)],
  ['foreverbanlist', (message, args, db) => forceManagement.execute(message, ['foreverbanlist', ...args], db)],
  ['fp', (message, args, db) => fakePermissions.execute(message, args, db)],
  ['alias', (message, args, db) => aliases.execute(message, args, db, { handlers, defaultAliases })],
  ['lockrole', (message, args, db) => roleLocks.lockRole(message, args, db)],
  ['unlockrole', (message, args, db) => roleLocks.unlockRole(message, args, db)],
  ['lockroles', (message, _args, db) => roleLocks.listRoleLocks(message, db)],
  ['setpaidrole', (message, args, db) => paidRoles.setPaidRole(message, args, db)],
  ['paid', (message, args, db) => paidRoles.whitelistPaidUser(message, args, db)],
  ['paidlist', (message, _args, db) => paidRoles.listPaidConfiguration(message, db)],
  ['setverifiedrole', (message, args, db) => paidRoles.setVerifiedRole(message, args, db)]
]);

function resolveCommand(guildId, commandName, args, db) {
  const normalizedName = commandName.toLowerCase();
  const defaultAlias = defaultAliases.get(normalizedName);
  if (defaultAlias) return { commandName: defaultAlias[0], args: [...defaultAlias.slice(1), ...args] };

  const customAlias = db.getCommandAlias(guildId, normalizedName);
  if (!customAlias) return { commandName: normalizedName, args };
  const [resolvedName, ...fixedArgs] = customAlias.command.split(/\s+/);
  return { commandName: resolvedName, args: [...fixedArgs, ...args] };
}

async function handleMessageCreate(message, client, db, prefix) {
  if (!message.guild || message.author.bot || !message.content.startsWith(prefix)) return;
  db.ensureGuild(message.guild.id);
  const [requestedName, ...requestedArgs] = message.content.slice(prefix.length).trim().split(/\s+/);
  if (!requestedName) return;
  const resolved = resolveCommand(message.guild.id, requestedName, requestedArgs, db);
  const handler = handlers.get(resolved.commandName);
  if (!handler) return;

  try {
    await handler(message, resolved.args, db, client);
  } catch (error) {
    console.error(`Command ${requestedName} failed in ${message.guild.id}:`, error);
    await message.reply({ embeds: [failure('The command could not be completed. Check bot permissions and role configuration.')], allowedMentions: { parse: [] } }).catch(() => null);
  }
}

async function handleMessageUpdate(oldMessage, newMessage, client, db, prefix) {
  if (!newMessage.partial && oldMessage.content === newMessage.content) return;
  let message = newMessage;
  if (newMessage.partial) {
    try {
      message = await newMessage.fetch();
    } catch (error) {
      console.error('Could not fetch an edited command message:', error);
      return;
    }
  }
  return handleMessageCreate(message, client, db, prefix);
}

module.exports = { handleMessageCreate, handleMessageUpdate, handlers, defaultAliases, resolveCommand };