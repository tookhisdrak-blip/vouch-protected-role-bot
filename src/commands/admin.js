const { EmbedBuilder } = require('discord.js');
const { COLORS, embed, success, failure, mentionRole, mentionUser } = require('../utils/embeds');
const { hasOwnerAccess, isOs, isOwnerOrOs } = require('../services/permissions');
const { logEvent } = require('../services/eventLogger');
const { reconcileLimitedRole } = require('../services/roleProtection');
const { getMember, roleIdFrom, userIdFrom, isRoleMention, isUserMention } = require('./utils');

function ownerOnly(member, db) {
  return hasOwnerAccess(member, db);
}

async function setRole(message, args, db) {
  if (!ownerOnly(message.member, db)) return message.reply({ embeds: [failure('Only the Guild Owner can configure roles or OS.')], allowedMentions: { parse: [] } });
  const [first, second, third] = args;
  const guildId = message.guild.id;

  if (first?.toLowerCase() === 'os') {
    if (second?.toLowerCase() === 'remove' && args[2]) {
      const target = args[2];
      const userId = userIdFrom(target);
      const roleId = roleIdFrom(target);
      if (userId) db.removeOsUser(guildId, userId);
      else if (roleId && roleId === db.getSettings(guildId).os_role_id) db.setSetting(guildId, 'os_role_id', null);
      else return message.reply({ embeds: [failure('Provide an OS user or the configured OS role to remove.')], allowedMentions: { parse: [] } });
      await logEvent(message.guild, db, {
        event_type: 'OS ACCESS UPDATED', executor_id: message.author.id, affected_user_id: userId,
        role_id: roleId, reason: null, action_taken: 'OS access removed', punishment: null
      });
      return message.reply({ embeds: [success('OS access removed.')], allowedMentions: { parse: [] } });
    }

    if (isRoleMention(second)) {
      const roleId = roleIdFrom(second);
      if (!message.guild.roles.cache.has(roleId) || roleId === message.guild.id) {
        return message.reply({ embeds: [failure('That role is not available for OS configuration.')], allowedMentions: { parse: [] } });
      }
      db.setSetting(guildId, 'os_role_id', roleId);
      await logEvent(message.guild, db, {
        event_type: 'OS ACCESS UPDATED', executor_id: message.author.id, affected_user_id: null,
        role_id: roleId, reason: null, action_taken: 'OS role configured', punishment: null
      });
      return message.reply({ embeds: [success(`${mentionRole(roleId)} is now the OS role.`)], allowedMentions: { parse: [] } });
    }

    const target = await getMember(message.guild, second);
    if (!target || target.user.bot) return message.reply({ embeds: [failure('Mention a server member or role.')], allowedMentions: { parse: [] } });
    db.addOsUser(guildId, target.id);
    await logEvent(message.guild, db, {
      event_type: 'OS ACCESS UPDATED', executor_id: message.author.id, affected_user_id: target.id,
      role_id: null, reason: null, action_taken: 'User granted OS access', punishment: null
    });
    return message.reply({ embeds: [success(`${mentionUser(target.id)} is now OS.`)], allowedMentions: { parse: [] } });
  }

  if (first?.toLowerCase() === 'stripstaff' && isRoleMention(second)) {
    const roleId = roleIdFrom(second);
    if (!message.guild.roles.cache.has(roleId) || roleId === message.guild.id) {
      return message.reply({ embeds: [failure('That role does not exist.')], allowedMentions: { parse: [] } });
    }
    db.setSetting(guildId, 'stripstaff_role_id', roleId);
    await logEvent(message.guild, db, {
      event_type: 'ROLE PROTECTION CONFIGURED', executor_id: message.author.id, affected_user_id: null,
      role_id: roleId, reason: null, action_taken: 'STRIPSTAFF role configured', punishment: null
    });
    return message.reply({ embeds: [success(`${mentionRole(roleId)} is now the STRIPSTAFF role.`)], allowedMentions: { parse: [] } });
  }

  if (isRoleMention(first) && second?.toLowerCase() === 'limit') {
    return configureLimitedRole(message, first, third, db);
  }

  return message.reply({ embeds: [failure('Use `-setrole os @role`, `-setrole os @user`, `-setrole os remove @user`, `-setrole stripstaff @role`, or `-setlimit @role|ROLE_ID number`.')], allowedMentions: { parse: [] } });
}

async function configureLimitedRole(message, roleValue, limitValue, db) {
  if (!ownerOnly(message.member, db)) return message.reply({ embeds: [failure('Only the Guild Owner can configure role member limits.')], allowedMentions: { parse: [] } });
  const roleId = roleIdFrom(roleValue);
  const role = roleId && message.guild.roles.cache.get(roleId);
  if (!role || roleId === message.guild.id) return message.reply({ embeds: [failure('That role does not exist.')], allowedMentions: { parse: [] } });
  const limit = Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    return message.reply({ embeds: [failure('The limit must be a whole number greater than or equal to zero. Use `-setlimit @role|ROLE_ID number`.')], allowedMentions: { parse: [] } });
  }
  try {
    await message.guild.members.fetch();
  } catch (error) {
    console.error(`Could not refresh members before configuring role limit ${roleId} in ${message.guild.id}:`, error);
    return message.reply({ embeds: [failure('I could not refresh the current server members, so the role limit was not changed.')], allowedMentions: { parse: [] } });
  }

  db.setLimitedRole(message.guild.id, roleId, limit);
  const reconciliation = await reconcileLimitedRole(message.guild, db, roleId, 'Limited role limit configured');
  await logEvent(message.guild, db, {
    event_type: 'ROLE LIMIT CONFIGURED', executor_id: message.author.id, affected_user_id: null,
    role_id: roleId, reason: null,
    action_taken: `Member limit set to ${limit}${reconciliation.removed.length ? `; removed ${reconciliation.removed.length} excess assignment(s)` : ''}${reconciliation.remainingExcess ? `; ${reconciliation.remainingExcess} excess assignment(s) could not be safely attributed` : ''}`,
    punishment: null
  });
  if (reconciliation.remainingExcess) {
    return message.reply({ embeds: [failure(`${mentionRole(roleId)} is limited to ${limit}, but the role remains ${reconciliation.remainingExcess} member(s) over the limit because the excess assignment could not be reliably identified.`, 'Limit configured; reconciliation incomplete')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(`${mentionRole(roleId)} now has a member limit of ${limit}.`)], allowedMentions: { parse: [] } });
}

async function setLimit(message, args, db) {
  if (!args[0] || args[1] === undefined) {
    return message.reply({ embeds: [failure('Use `-setlimit @role|ROLE_ID number`.')], allowedMentions: { parse: [] } });
  }
  return configureLimitedRole(message, args[0], args[1], db);
}

async function limitedRoles(message, db) {
  const roles = db.getLimitedRoles(message.guild.id);
  if (!roles.length) return message.reply({ embeds: [embed('Limited roles', 'No roles have member limits configured.')], allowedMentions: { parse: [] } });
  try {
    await message.guild.members.fetch();
  } catch (error) {
    console.error(`Could not refresh member counts for limited roles in ${message.guild.id}:`, error);
    return message.reply({ embeds: [failure('I could not refresh the current server member counts. Please try again.')], allowedMentions: { parse: [] } });
  }
  const lines = roles.map(({ role_id: roleId, member_limit: limit }) => {
    const role = message.guild.roles.cache.get(roleId);
    const count = role?.members.size ?? 0;
    return `${mentionRole(roleId)} — members on this role: ${count}/${limit} (LIMITED)`;
  });
  const pages = [];
  let pageLines = [];
  let pageLength = 0;
  for (const line of lines) {
    if (pageLines.length && pageLength + line.length + 1 > 3800) {
      pages.push(pageLines.join('\n'));
      pageLines = [];
      pageLength = 0;
    }
    pageLines.push(line);
    pageLength += line.length + 1;
  }
  if (pageLines.length) pages.push(pageLines.join('\n'));

  for (let index = 0; index < pages.length; index += 1) {
    await message.reply({
      embeds: [embed(pages.length === 1 ? 'Limited roles' : `Limited roles ${index + 1}/${pages.length}`, pages[index])],
      allowedMentions: { parse: [] }
    });
  }
  return undefined;
}

async function setLog(message, args, db) {
  if (!ownerOnly(message.member, db)) return message.reply({ embeds: [failure('Only the Guild Owner can configure event logging.')], allowedMentions: { parse: [] } });
  const channelId = args[0]?.match(/^<#([0-9]+)>$/)?.[1];
  if (!channelId) return message.reply({ embeds: [failure('Use `-setlog #channel`.')], allowedMentions: { parse: [] } });
  const channel = message.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased() || !channel.send) return message.reply({ embeds: [failure('That is not a usable text channel.')], allowedMentions: { parse: [] } });
  db.setSetting(message.guild.id, 'log_channel_id', channelId);
  await logEvent(message.guild, db, {
    event_type: 'EVENT LOGGING CONFIGURED', executor_id: message.author.id, affected_user_id: null,
    role_id: null, reason: null, action_taken: `Log channel set to <#${channelId}>`, punishment: null
  });
  return message.reply({ embeds: [success(`Event logs will be sent to <#${channelId}>.`)], allowedMentions: { parse: [] } });
}

async function blacklist(message, args, db) {
  if (!isOwnerOrOs(message.member, db)) return message.reply({ embeds: [failure('Only the Guild Owner or OS can manage the vouch blacklist.')], allowedMentions: { parse: [] } });
  const [action, targetText] = args;
  if (action?.toLowerCase() === 'list') {
    const rows = db.getBlacklist(message.guild.id);
    const page = Math.max(1, Number(targetText) || 1);
    const pageRows = rows.slice((page - 1) * 10, page * 10);
    const description = pageRows.length
      ? pageRows.map((row) => `${mentionUser(row.user_id)} added by ${mentionUser(row.added_by)}`).join('\n')
      : 'No blacklist entries on this page.';
    const result = new EmbedBuilder().setColor(COLORS.info).setTitle(`Vouch blacklist ${page}/${Math.max(1, Math.ceil(rows.length / 10))}`).setDescription(description).setTimestamp();
    return message.reply({ embeds: [result], allowedMentions: { parse: [] } });
  }

  const target = await getMember(message.guild, targetText);
  if (!target || target.user.bot) return message.reply({ embeds: [failure('Mention a server member.')], allowedMentions: { parse: [] } });
  if (action?.toLowerCase() === 'add') {
    db.addBlacklist(message.guild.id, target.id, message.author.id, new Date().toISOString());
    await logEvent(message.guild, db, {
      event_type: 'VOUCH BLACKLIST UPDATED', executor_id: message.author.id, affected_user_id: target.id,
      role_id: null, reason: null, action_taken: 'Member added to vouch blacklist', punishment: null
    });
    return message.reply({ embeds: [success(`${mentionUser(target.id)} cannot receive vouches.`)], allowedMentions: { parse: [] } });
  }
  if (action?.toLowerCase() === 'remove') {
    db.removeBlacklist(message.guild.id, target.id);
    await logEvent(message.guild, db, {
      event_type: 'VOUCH BLACKLIST UPDATED', executor_id: message.author.id, affected_user_id: target.id,
      role_id: null, reason: null, action_taken: 'Member removed from vouch blacklist', punishment: null
    });
    return message.reply({ embeds: [success(`${mentionUser(target.id)} was removed from the blacklist.`)], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [failure('Use `-vouchblacklist add @user`, `remove @user`, or `list [page]`.')], allowedMentions: { parse: [] } });
}

module.exports = { setRole, setLimit, limitedRoles, setLog, blacklist };