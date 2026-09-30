const { isGuildOwner, isOs, isForceManager } = require('../services/permissions');

const catalog = [
  { command: '-vouch give @user [reason]', summary: 'Give an active vouch within your allowance. Givers default to 2 active vouches and OS to 5; the Guild Owner is uncapped unless given a giver limit.', category: 'Vouch', permission: 'giver' },
  { command: '-vouch take @user [reason]', summary: 'Remove a vouch you gave, or remove any vouch as OS or Guild Owner. Frees one allowance slot for the original giver.', category: 'Take Vouch', permission: 'taker' },
  { command: '-vouch check [@user]', summary: 'Check active vouch and giver allowance details.', category: 'Vouch Information', permission: 'everyone' },
  { command: '-vouch list [page]', summary: 'Browse active vouches, ten per page.', category: 'Vouch Information', permission: 'everyone' },
  { command: '-vouchblacklist add @user', summary: 'Block a member from receiving a vouch.', category: 'Blacklist', permission: 'os' },
  { command: '-vouchblacklist remove @user', summary: 'Remove a member from the vouch blacklist.', category: 'Blacklist', permission: 'os' },
  { command: '-vouchblacklist list [page]', summary: 'Browse the vouch blacklist.', category: 'Blacklist', permission: 'os' },
  { command: '-setlimit @role|ROLE_ID number', summary: 'Set a maximum member count for a role. Excess assignments are reversed; separate from vouch limits.', category: 'Limited Roles', permission: 'owner' },
  { command: '-setrole @role limit [number]', summary: 'Legacy alias for setting a separate role member limit.', category: 'Limited Roles', permission: 'owner', aliasOf: '-setlimit @role|ROLE_ID number' },
  { command: '-limitedroles', summary: 'Show every limited role with its live member count, for example 12/20 (LIMITED).', category: 'Limited Roles', permission: 'everyone' },
  { command: '-setrole stripstaff @role', summary: 'Optional legacy setting. STRIPSTAFF runs automatically without it by removing only staff-permission roles.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-setrole os @role', summary: 'Configure the OS role.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-setrole os @user', summary: 'Grant OS access to a user.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-setrole os remove @user', summary: 'Remove OS access from a user.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-setrole os remove @role', summary: 'Unset the configured OS role.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-setlog #channel', summary: 'Configure the event log channel.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-vouch setrole @role', summary: 'Set the vouch role. Members without an active vouch have it removed automatically.', category: 'Vouch Roles', permission: 'owner' },
  { command: '-vouch unsetrole', summary: 'Unset the vouch role. Existing vouches and limited-role settings are kept.', category: 'Vouch Roles', permission: 'owner' },
  { command: '-vouch setreward @role', summary: 'Set the reward role granted when a vouch succeeds.', category: 'Reward Roles', permission: 'owner' },
  { command: '-vouch addgiver @user', summary: 'Authorize a vouch giver with the default allowance.', category: 'Giver Management', permission: 'owner' },
  { command: '-vouch removegiver @user', summary: 'Remove a member’s giver access. Their existing vouches are kept.', category: 'Giver Management', permission: 'owner' },
  { command: '-vouch limit [number]', summary: 'Set the default allowance for vouch givers without a custom limit.', category: 'Giver Management', permission: 'owner' },
  { command: '-vouch limit @user [number]', summary: 'Set a custom allowance for a vouch giver or OS member.', category: 'Giver Management', permission: 'owner' },
  { command: '-vouch limit remove @user', summary: 'Remove a custom allowance; givers return to the giver default and OS to 5.', category: 'Giver Management', permission: 'owner' },
  { command: '-vouch wipeall', summary: 'Remove all active vouches and the vouch/reward roles tied to them. Giver and limited-role settings are kept.', category: 'Vouch Administration', permission: 'owner' },
  { command: '-vouchhelp [category|page]', summary: 'Open the paginated help dashboard with category pages and navigation buttons.', category: 'Vouch Information', permission: 'everyone' },
  { command: '-forcemanage', summary: 'Open the private Force Management panel.', category: 'Management', permission: 'force' },
  { command: '-forcenickname @user [nickname]', summary: 'Create and apply a persistent nickname rule.', category: 'Force Nicknames', permission: 'force' },
  { command: '-unforcenickname @user', summary: 'Remove a forced nickname rule.', category: 'Force Nicknames', permission: 'force' },
  { command: '-forcerolestrip @user @role', summary: 'Prevent one member from keeping a role.', category: 'Force Role Strips', permission: 'force' },
  { command: '-unforcerolestrip @user', summary: 'Remove all forced role strips for a member.', category: 'Force Role Strips', permission: 'force' },
  { command: '-rolestrip @role-name/id', summary: 'Confirm a persistent global role strip.', category: 'Global Role Strips', permission: 'force' },
  { command: '-forcestrip @user @role', summary: 'Alias for the member-specific role strip.', category: 'Force Role Strips', permission: 'force', aliasOf: '-forcerolestrip @user @role' },
  { command: '-forcestrip @role-name/id', summary: 'Alias for the global role strip.', category: 'Global Role Strips', permission: 'force', aliasOf: '-rolestrip @role-name/id' },
  { command: '-unforcestrip @user', summary: 'Alias for removing a member’s role-strip rules.', category: 'Force Role Strips', permission: 'force', aliasOf: '-unforcerolestrip @user' },
  { command: '-foreverban @user [reason]', summary: 'Store and apply an account-ID forever-ban rule.', category: 'Forever Bans', permission: 'owner' },
  { command: '-unforeverban @user', summary: 'Remove the record without changing current ban status.', category: 'Forever Bans', permission: 'owner' },
  { command: '-foreverbanlist [page]', summary: 'Browse active forever-ban records.', category: 'Forever Bans', permission: 'owner' },
  { command: '-vouchcommands', summary: 'Open the public Vouch and Management command dashboard with category pages and navigation buttons.', category: 'Vouch Information', permission: 'everyone' }
];

function allowed(item, member, db) {
  if (item.permission === 'everyone') return true;
  if (item.permission === 'owner') return isGuildOwner(member);
  if (item.permission === 'os') return isGuildOwner(member) || isOs(member, db);
  if (item.permission === 'force') return isForceManager(member, db);
  if (item.permission === 'giver') return isGuildOwner(member) || isOs(member, db) || Boolean(db.getGiver(member.guild.id, member.id));
  // Mirrors takeVouch: original givers keep removal rights even after giver access is removed.
  if (item.permission === 'taker') return isGuildOwner(member) || isOs(member, db) || Boolean(db.getGiver(member.guild.id, member.id)) || db.countGiverVouches(member.guild.id, member.id) > 0;
  return false;
}

async function execute(message, args, db) {
  // Lazy require avoids a circular import: the dashboard reads this module's catalog.
  return require('./vouchCommands').executeHelp(message, args, db);
}

module.exports = { execute, catalog, allowed };