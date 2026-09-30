const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const { COLORS, embed, success, failure, mentionRole, mentionUser } = require('../utils/embeds');
const { isForceManager } = require('../services/permissions');
const { hasFakePermission } = require('../services/fakePermissions');
const { logForceEvent } = require('../services/forceLogger');
const {
  setForcedNickname,
  removeForcedNickname,
  createForcedRoleStrip,
  removeForcedRoleStripsForUser,
  runGlobalRoleStrip,
  isProtectedGlobalStripRole
} = require('../services/forceRules');
const { createForeverBan, removeForeverBan } = require('../services/foreverBans');
const { getMember, getRole, userIdFrom } = require('./utils');

const panelCategories = [
  ['nicknames', 'Forced Nicknames'],
  ['user-strips', 'Forced Role Strips'],
  ['global-strips', 'Global Role Strips'],
  ['forever-bans', 'Forever Bans'],
  ['active', 'Active Force Rules'],
  ['help', 'Force Management Help']
];
const pendingGlobalStrips = new Map();

function denial(message, ownerRequired = false) {
  return message.reply({
    embeds: [failure(ownerRequired ? 'You need the fake `ban_members` permission to use forever-ban commands. OS and the Guild Owner have it automatically.' : 'Only OS or the Guild Owner can use Force Management commands.')],
    allowedMentions: { parse: [] }
  });
}

async function resolveRole(guild, input) {
  const role = await getRole(guild, input);
  if (role) return role;
  const exactName = guild.roles.cache.filter((role) => role.name === input);
  return exactName.size === 1 ? exactName.first() : null;
}

function pageControls(guildId, category, page, pageCount, globalRoles = []) {
  const categoryMenu = new StringSelectMenuBuilder()
    .setCustomId(`force-panel-category:${guildId}`)
    .setPlaceholder('Select a force-management section')
    .addOptions(panelCategories.map(([value, label]) => ({ label, value, default: value === category })));
  const rows = [new ActionRowBuilder().addComponents(categoryMenu)];
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`force-panel-page:${guildId}:${category}:${Math.max(1, page - 1)}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
      new ButtonBuilder().setCustomId(`force-panel-page:${guildId}:${category}:${Math.min(pageCount, page + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount)
    ));
  }
  if (category === 'global-strips' && globalRoles.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`force-panel-remove-global:${guildId}`)
        .setPlaceholder('Disable a global role-strip rule')
        .addOptions(globalRoles.slice(0, 25).map((row) => ({
          label: (row.role_name || row.role_id).slice(0, 100),
          description: `Role ID ${row.role_id}`.slice(0, 100),
          value: row.role_id
        })))
    ));
  }
  return rows;
}

function panelData(guild, category, requestedPage, db, owner) {
  const guildId = guild.id;
  let records = [];
  let lines = [];
  let title = panelCategories.find(([value]) => value === category)?.[1] || 'Active Force Rules';

  if (category === 'nicknames') {
    records = db.getForcedNicknames(guildId);
    lines = records.map((row) => `${mentionUser(row.user_id)}: ${row.nickname || '(default account name)'} | added <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d>`);
  } else if (category === 'user-strips') {
    records = db.getForcedRoleStrips(guildId);
    lines = records.map((row) => `${mentionUser(row.user_id)} cannot have ${mentionRole(row.role_id)}`);
  } else if (category === 'global-strips') {
    records = db.getGlobalRoleStrips(guildId).map((row) => ({ ...row, role_name: guild.roles.cache.get(row.role_id)?.name }));
    lines = records.map((row) => `${mentionRole(row.role_id)} | added <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d>`);
  } else if (category === 'forever-bans') {
    records = owner ? db.getForeverBans(guildId) : [];
    lines = records.map((row) => `
      [0m${row.username || 'Unknown user'} (${row.user_id}) | ${row.reason} | <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d> | executor ${row.executor_id}`.trim());
  } else if (category === 'active') {
    const nicknames = db.getForcedNicknames(guildId).length;
    const userStrips = db.getForcedRoleStrips(guildId).length;
    const globalStrips = db.getGlobalRoleStrips(guildId).length;
    const foreverBans = db.getForeverBans(guildId).length;
    records = [{ summary: true }];
    lines = [`Forced nicknames: ${nicknames}`, `Forced role strips: ${userStrips}`, `Global role strips: ${globalStrips}`, `Forever bans: ${owner ? foreverBans : 'Owner-only'}`];
  } else {
    const help = [
      '-forcemanage', '-forcenickname @user [nickname]', '-unforcenickname @user',
      '-forcerolestrip @user @role', '-unforcerolestrip @user', '-rolestrip @role-name/id',
      '-forcestrip @user @role', '-forcestrip @role-name/id', '-unforcestrip @user'
    ];
    if (owner) help.push('-foreverban @user [reason]', '-unforeverban @user', '-foreverbanlist');
    records = help;
    lines = help;
  }

  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const pageLines = category === 'active'
    ? lines
    : lines.slice((page - 1) * pageSize, page * pageSize);
  const description = pageLines.length ? pageLines.join('\n').replace(/\u001b\[0m/g, '').slice(0, 4000) : 'No active rules in this section.';
  const result = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`Force Management | ${title}`)
    .setDescription(description)
    .setFooter({ text: `Page ${page} of ${pageCount}` })
    .setTimestamp();
  return { embed: result, page, pageCount, globalRoles: category === 'global-strips' ? records : [] };
}

function panelPayload(guild, category, page, db, owner) {
  const data = panelData(guild, category, page, db, owner);
  return {
    embeds: [data.embed],
    components: pageControls(guild.id, category, data.page, data.pageCount, data.globalRoles.slice((data.page - 1) * 10, data.page * 10)),
    allowedMentions: { parse: [] }
  };
}

async function forceManage(message, db) {
  if (!isForceManager(message.member, db)) return denial(message);
  const guild = message.guild;
  const owner = hasFakePermission(message.member, db, 'ban_members');
  try {
    await message.author.send(panelPayload(guild, 'active', 1, db, owner));
    return message.reply({ embeds: [success('The permission-filtered Force Management panel was sent to your direct messages.')], allowedMentions: { parse: [] } });
  } catch {
    return message.reply({ embeds: [failure('I could not send the private panel. Enable direct messages from server members and try again.')], allowedMentions: { parse: [] } });
  }
}

async function forcedNickname(message, args, db) {
  if (!isForceManager(message.member, db)) return denial(message);
  const member = await getMember(message.guild, args[0]);
  if (!member) return message.reply({ embeds: [failure('Use `-forcenickname @user [nickname]`.')], allowedMentions: { parse: [] } });
  const nickname = args.slice(1).join(' ').trim();
  if (nickname.length > 32) return message.reply({ embeds: [failure('Nicknames must be 32 characters or fewer.')], allowedMentions: { parse: [] } });
  const { result } = await setForcedNickname(member, nickname, message.author.id, db);
  if (result.status === 'failed') {
    return message.reply({ embeds: [failure('The forced nickname rule was saved, but I could not apply it. Check Manage Nicknames and role hierarchy.')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(result.status === 'already-correct' ? `${mentionUser(member.id)} already has the forced nickname.` : `Forced nickname saved for ${mentionUser(member.id)}.`)], allowedMentions: { parse: [] } });
}

async function unforcedNickname(message, args, db) {
  if (!isForceManager(message.member, db)) return denial(message);
  const userId = userIdFrom(args[0]);
  if (!userId) return message.reply({ embeds: [failure('Use `-unforcenickname @user`.')], allowedMentions: { parse: [] } });
  const result = await removeForcedNickname(message.guild, userId, message.author.id, db);
  if (!result.removed) return message.reply({ embeds: [failure('That member has no forced nickname rule.')], allowedMentions: { parse: [] } });
  return message.reply({ embeds: [success(`The forced nickname rule for ${mentionUser(userId)} was removed. Their current nickname was left unchanged.`)], allowedMentions: { parse: [] } });
}

async function forcedRoleStrip(message, args, db) {
  if (!isForceManager(message.member, db)) return denial(message);
  const member = await getMember(message.guild, args[0]);
  const role = await resolveRole(message.guild, args[1]);
  if (!member || !role) return message.reply({ embeds: [failure('Use `-forcerolestrip @user @role`.')], allowedMentions: { parse: [] } });
  const result = await createForcedRoleStrip(member, role.id, message.author.id, db);
  if (result.removal.status === 'failed') {
    return message.reply({ embeds: [failure('The rule was saved, but I could not remove the role immediately. Check Manage Roles and role hierarchy.')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(result.created ? `The rule is active; ${mentionRole(role.id)} was removed when present.` : 'That forced role-strip rule already exists.')], allowedMentions: { parse: [] } });
}

async function unforcedRoleStrip(message, args, db) {
  if (!isForceManager(message.member, db)) return denial(message);
  const userId = userIdFrom(args[0]);
  if (!userId) return message.reply({ embeds: [failure('Use `-unforcerolestrip @user`.')], allowedMentions: { parse: [] } });
  const count = await removeForcedRoleStripsForUser(message.guild, userId, message.author.id, db);
  return message.reply({ embeds: [success(`${count} forced role-strip rule(s) were removed for ${mentionUser(userId)}.`)], allowedMentions: { parse: [] } });
}

function clearExpiredPending() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [nonce, pending] of pendingGlobalStrips) {
    if (pending.createdAt < cutoff) pendingGlobalStrips.delete(nonce);
  }
}

async function globalRoleStrip(message, roleInput, db) {
  if (!isForceManager(message.member, db)) return denial(message);
  const role = await resolveRole(message.guild, roleInput);
  if (!role) return message.reply({ embeds: [failure('Role not found. Use a role mention, ID, or exact role name.')], allowedMentions: { parse: [] } });
  if (isProtectedGlobalStripRole(message.guild, role.id, db)) {
    return message.reply({ embeds: [failure('The configured OS and official vouch roles cannot be globally stripped.')], allowedMentions: { parse: [] } });
  }

  let members;
  try {
    members = await message.guild.members.fetch();
  } catch (error) {
    await logForceEvent(message.guild, db, {
      action: 'GLOBAL ROLE STRIP PREVIEW FAILED', role_id: role.id, executor_id: message.author.id,
      result: 'Confirmation not created; member list could not be fetched', failure_reason: error.message
    });
    return message.reply({ embeds: [failure('I could not fetch the server member list, so no role changes were started.')], allowedMentions: { parse: [] } });
  }

  const affected = [...members.values()].filter((member) => member.roles.cache.has(role.id));
  const eligibleCount = affected.filter((member) => member.id !== message.guild.ownerId && !member.user.bot).length;
  clearExpiredPending();
  const nonce = randomUUID();
  pendingGlobalStrips.set(nonce, { guildId: message.guild.id, roleId: role.id, executorId: message.author.id, createdAt: Date.now() });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`force-global-confirm:${nonce}`).setLabel('Confirm role strip').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`force-global-cancel:${nonce}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  return message.reply({
    embeds: [embed('Confirm global role strip', `Role: ${mentionRole(role.id)}\nMembers found: ${affected.length}\nRemoval attempts: ${eligibleCount}\nThe Guild Owner and bot accounts will be skipped.`, COLORS.info)],
    components: [row],
    allowedMentions: { parse: [] }
  });
}

async function foreverBan(message, args, db) {
  if (!hasFakePermission(message.member, db, 'ban_members')) return denial(message, true);
  const userId = userIdFrom(args[0]);
  if (!userId) return message.reply({ embeds: [failure('Use `-foreverban @user [reason]`.')], allowedMentions: { parse: [] } });
  const targetMember = await message.guild.members.fetch(userId).catch(() => null);
  const targetUser = targetMember?.user || await message.client.users.fetch(userId).catch(() => null);
  if (!targetUser) return message.reply({ embeds: [failure('I could not resolve that Discord account.')], allowedMentions: { parse: [] } });
  const result = await createForeverBan(message.guild, targetUser, args.slice(1).join(' ').trim(), message.author.id, db);
  if (result.failureReason) {
    return message.reply({ embeds: [failure('The forever-ban rule was saved, but the immediate ban failed. The rule remains active and will be retried if this account joins.')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(`${targetUser.tag || targetUser.username} is covered by an active forever-ban rule.`)], allowedMentions: { parse: [] } });
}

async function unForeverBan(message, args, db) {
  if (!hasFakePermission(message.member, db, 'ban_members')) return denial(message, true);
  const userId = userIdFrom(args[0]);
  if (!userId) return message.reply({ embeds: [failure('Use `-unforeverban @user`.')], allowedMentions: { parse: [] } });
  const result = await removeForeverBan(message.guild, userId, message.author.id, db);
  if (!result.removed) return message.reply({ embeds: [failure('That account has no active forever-ban rule.')], allowedMentions: { parse: [] } });
  return message.reply({ embeds: [success(`The forever-ban record for account ${userId} was removed. Their current Discord ban was not changed.`)], allowedMentions: { parse: [] } });
}

async function foreverBanList(message, args, db) {
  if (!hasFakePermission(message.member, db, 'ban_members')) return denial(message, true);
  const page = Number(args[0] || 1);
  if (!Number.isSafeInteger(page) || page < 1) return message.reply({ embeds: [failure('Page must be a positive whole number.')], allowedMentions: { parse: [] } });
  const records = db.getForeverBans(message.guild.id);
  const pageCount = Math.max(1, Math.ceil(records.length / 10));
  const currentPage = Math.min(page, pageCount);
  const lines = records.slice((currentPage - 1) * 10, currentPage * 10).map((row) =>
    `ID ${row.user_id} | ${row.username || 'Unknown user'} | ${row.reason} | <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:d> | executor ${row.executor_id}`
  );
  const result = embed(`Forever bans ${currentPage}/${pageCount}`, lines.join('\n').slice(0, 4000) || 'No active forever-ban records.');
  return message.reply({ embeds: [result], allowedMentions: { parse: [] } });
}

async function execute(message, args, db) {
  const command = args[0]?.toLowerCase();
  if (command === 'forcemanage') return forceManage(message, db);
  if (command === 'forcenickname') return forcedNickname(message, args.slice(1), db);
  if (command === 'unforcenickname') return unforcedNickname(message, args.slice(1), db);
  if (command === 'forcerolestrip') return forcedRoleStrip(message, args.slice(1), db);
  if (command === 'unforcerolestrip') return unforcedRoleStrip(message, args.slice(1), db);
  if (command === 'rolestrip') return globalRoleStrip(message, args.slice(1).join(' '), db);
  if (command === 'forcestrip') {
    if (args.length >= 3 && userIdFrom(args[1])) return forcedRoleStrip(message, args.slice(1), db);
    return globalRoleStrip(message, args.slice(1).join(' '), db);
  }
  if (command === 'unforcestrip') return unforcedRoleStrip(message, args.slice(1), db);
  if (command === 'foreverban') return foreverBan(message, args.slice(1), db);
  if (command === 'unforeverban') return unForeverBan(message, args.slice(1), db);
  if (command === 'foreverbanlist') return foreverBanList(message, args.slice(1), db);
  return message.reply({ embeds: [failure('Unknown Force Management command.')], allowedMentions: { parse: [] } });
}

async function handleInteraction(interaction, db) {
  if (!interaction.customId?.startsWith('force-')) return false;
  const [action, guildId, ...values] = interaction.customId.split(':');
  if (action === 'force-global-confirm' || action === 'force-global-cancel') {
    const nonce = guildId;
    const pending = pendingGlobalStrips.get(nonce);
    if (pending && pending.createdAt < Date.now() - 10 * 60 * 1000) pendingGlobalStrips.delete(nonce);
    if (!pending || pending.createdAt < Date.now() - 10 * 60 * 1000 || pending.executorId !== interaction.user.id || pending.guildId !== interaction.guildId) {
      await interaction.reply({ embeds: [failure('This confirmation expired or belongs to another user.')], ephemeral: true, allowedMentions: { parse: [] } });
      return true;
    }
    pendingGlobalStrips.delete(nonce);
    if (action === 'force-global-cancel') {
      await interaction.update({ embeds: [embed('Global role strip cancelled', 'No role changes were made.')], components: [], allowedMentions: { parse: [] } });
      return true;
    }
    const guild = interaction.guild;
    const actor = await guild?.members.fetch(interaction.user.id).catch(() => null);
    if (!guild || !actor || !isForceManager(actor, db)) {
      await interaction.update({ embeds: [failure('You are no longer authorized to confirm this role strip.')], components: [], allowedMentions: { parse: [] } });
      return true;
    }
    const role = guild.roles.cache.get(pending.roleId);
    if (!role) {
      await interaction.update({ embeds: [failure('That role no longer exists; no changes were made.')], components: [], allowedMentions: { parse: [] } });
      return true;
    }
    await interaction.deferUpdate();
    const result = await runGlobalRoleStrip(guild, role, interaction.user.id, db);
    const output = result.ok
      ? embed(result.failed ? 'Global role strip incomplete' : 'Global role strip complete', `Members found: ${result.found}\nSuccessfully stripped: ${result.stripped}\nFailed removals: ${result.failed}\nMembers skipped: ${result.skipped}${result.queued ? `\nQueued after Discord rate limit: ${result.queued}` : ''}`, result.failed ? COLORS.error : COLORS.success)
      : failure(result.busy ? 'A global strip for that role is already running.' : result.protected ? 'That role is protected and cannot be globally stripped.' : 'The operation was incomplete. No success is claimed.');
    await interaction.message.edit({ embeds: [output], components: [], allowedMentions: { parse: [] } });
    return true;
  }

  if (action === 'force-panel-category' || action === 'force-panel-page' || action === 'force-panel-remove-global') {
    const guild = interaction.client.guilds.cache.get(guildId);
    const member = await guild?.members.fetch(interaction.user.id).catch(() => null);
    if (!guild || !member || !isForceManager(member, db)) {
      await interaction.update({ embeds: [failure('You are no longer authorized to view this panel.')], components: [], allowedMentions: { parse: [] } });
      return true;
    }
    const owner = hasFakePermission(member, db, 'ban_members');
    let category = 'active';
    let page = 1;
    if (action === 'force-panel-category') category = interaction.values[0];
    if (action === 'force-panel-page') {
      category = values[0] || 'active';
      page = Number(values[1]) || 1;
    }
    if (action === 'force-panel-remove-global') {
      const roleId = interaction.values[0];
      const removed = db.removeGlobalRoleStrip(guild.id, roleId).changes > 0;
      if (removed) {
        await logForceEvent(guild, db, {
          action: 'GLOBAL ROLE STRIP DISABLED', role_id: roleId, executor_id: interaction.user.id,
          result: 'Global role-strip rule disabled; existing member roles were not changed'
        });
      }
      category = 'global-strips';
      await interaction.update({ ...panelPayload(guild, category, page, db, owner), embeds: [success(removed ? `Global strip rule for ${mentionRole(roleId)} was disabled.` : 'That global strip rule no longer exists.'), panelData(guild, category, page, db, owner).embed] });
      return true;
    }
    await interaction.update(panelPayload(guild, category, page, db, owner));
    return true;
  }
  return false;
}

module.exports = { execute, handleInteraction };