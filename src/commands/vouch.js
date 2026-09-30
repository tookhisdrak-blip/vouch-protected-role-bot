const { EmbedBuilder } = require('discord.js');
const { COLORS, embed, success, failure, mentionRole, mentionUser } = require('../utils/embeds');
const {
  isGuildOwner, hasOwnerAccess, hasVouchAdminAccess, isOs, isOwnerOrOs, isVouchAdmin, remainingVouches
} = require('../services/permissions');
const { logEvent } = require('../services/eventLogger');
const { giveVouch, takeVouch, wipeVouches } = require('../services/vouches');
const { reconcileVouchRole } = require('../services/roleProtection');
const { getMember, getRole, userIdFrom } = require('./utils');

function ownerReply(message) {
  return message.reply({ embeds: [failure('Only the Guild Owner can use this command.')], allowedMentions: { parse: [] } });
}

function denyReply(message, text) {
  return message.reply({ embeds: [failure(text)], allowedMentions: { parse: [] } });
}

async function give(message, args, db) {
  const recipient = await getMember(message.guild, args[0]);
  if (!recipient) return message.reply({ embeds: [failure('Use `-vouch give @user [reason]`.')], allowedMentions: { parse: [] } });
  const result = await giveVouch(message.member, recipient, args.slice(1).join(' ').trim(), db);
  if (!result.ok) return message.reply({ embeds: [failure(result.message, 'Vouch not given')], allowedMentions: { parse: [] } });
  const balance = result.remaining === null ? '' : ` Remaining vouches: ${result.remaining}.`;
  const queued = result.deferredRoleIds?.length
    ? ' Discord is rate limiting role changes; the vouch role will be assigned automatically shortly.'
    : '';
  return message.reply({ embeds: [success(`${mentionUser(recipient.id)} received a vouch.${balance}${queued}`, 'Vouch recorded')], allowedMentions: { parse: [] } });
}

async function take(message, args, db, usage = '-vouch take @user [reason]') {
  const recipient = await getMember(message.guild, args[0]);
  if (!recipient) return message.reply({ embeds: [failure(`Use \`${usage}\`.`)], allowedMentions: { parse: [] } });
  const result = await takeVouch(message.member, recipient, args.slice(1).join(' ').trim(), db);
  if (!result.ok) return message.reply({ embeds: [failure(result.message, 'Vouch not removed')], allowedMentions: { parse: [] } });
  if (result.cleanupFailures.length) {
    return message.reply({ embeds: [failure(`The vouch was removed, but the bot could not remove ${result.cleanupFailures.length} configured role(s). Check Manage Roles and role hierarchy.`, 'Role cleanup incomplete')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(`The active vouch for ${mentionUser(recipient.id)} was removed.`, 'Vouch removed')], allowedMentions: { parse: [] } });
}

async function check(message, args, db) {
  const member = args[0] ? await getMember(message.guild, args[0]) : message.member;
  if (!member) return message.reply({ embeds: [failure('Mention a server member to check.')], allowedMentions: { parse: [] } });
  const vouch = db.getVouch(message.guild.id, member.id);
  const fields = [{ name: 'Member', value: mentionUser(member.id), inline: true }];
  if (vouch) {
    fields.push(
      { name: 'Status', value: 'Active', inline: true },
      { name: 'Giver', value: mentionUser(vouch.giver_id), inline: true },
      { name: 'Reason', value: (vouch.reason || 'No reason provided').slice(0, 900), inline: false },
      { name: 'Date', value: `<t:${Math.floor(new Date(vouch.created_at).getTime() / 1000)}:f>`, inline: true }
    );
  } else {
    fields.push({ name: 'Status', value: 'No active vouch', inline: true });
  }
  const allowance = remainingVouches(message.guild.id, member.id, db, member);
  if (allowance !== null) fields.push({ name: 'Remaining giver allowance', value: String(allowance), inline: true });
  const result = new EmbedBuilder().setColor(COLORS.info).setTitle('Vouch check').addFields(fields).setTimestamp();
  return message.reply({ embeds: [result], allowedMentions: { parse: [] } });
}

async function list(message, args, db) {
  const vouches = db.getVouches(message.guild.id);
  const page = Number(args[0] || 1);
  if (!Number.isSafeInteger(page) || page < 1) return message.reply({ embeds: [failure('Page must be a positive whole number.')], allowedMentions: { parse: [] } });
  const pageCount = Math.max(1, Math.ceil(vouches.length / 10));
  const rows = vouches.slice((page - 1) * 10, page * 10);
  const description = rows.length
    ? rows.map((vouch) => `${mentionUser(vouch.recipient_id)} by ${mentionUser(vouch.giver_id)}: ${(vouch.reason || 'No reason').slice(0, 120)}`).join('\n')
    : 'No active vouches on this page.';
  const result = new EmbedBuilder().setColor(COLORS.info).setTitle(`Active vouches ${page}/${pageCount}`).setDescription(description).setTimestamp();
  return message.reply({ embeds: [result], allowedMentions: { parse: [] } });
}

async function setRole(message, args, db, usage = '-vouch setrole @role') {
  if (!isOwnerOrOs(message.member, db)) return denyReply(message, 'Only OS or the Guild Owner can manage the vouch role.');
  const role = await getRole(message.guild, args[0]);
  if (!role) return message.reply({ embeds: [failure(`Use \`${usage}\`.`)], allowedMentions: { parse: [] } });
  const roleId = role.id;
  db.setSetting(message.guild.id, 'vouch_role_id', roleId);
  const reconciliation = await reconcileVouchRole(message.guild, db, 'Vouch role configured: no active vouch');
  const reconciliationIncomplete = reconciliation.cleanupFailures.length > 0 || reconciliation.memberFetchFailed;
  const cleanupDescription = [
    reconciliation.cleanupFailures.length
      ? `cleanup failed for ${reconciliation.cleanupFailures.length} invalid role assignment(s)`
      : null,
    reconciliation.memberFetchFailed ? 'the server member list could not be fetched' : null
  ].filter(Boolean).join('; ');
  await logEvent(message.guild, db, {
    event_type: 'VOUCH ROLE CONFIGURED', executor_id: message.author.id, affected_user_id: null,
    role_id: roleId, reason: null,
    action_taken: reconciliationIncomplete
      ? `Official vouch role configured; ${cleanupDescription}`
      : 'Official vouch role configured',
    punishment: null
  });
  if (reconciliationIncomplete) {
    return message.reply({ embeds: [failure(`${mentionRole(roleId)} is configured, but ${cleanupDescription}. Check Manage Roles and role hierarchy.`, 'Role cleanup incomplete')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(`${mentionRole(roleId)} is now the official vouch role.`)], allowedMentions: { parse: [] } });
}

async function unsetRole(message, db) {
  if (!isOwnerOrOs(message.member, db)) return denyReply(message, 'Only OS or the Guild Owner can manage the vouch role.');
  const roleId = db.getSettings(message.guild.id).vouch_role_id;
  db.setSetting(message.guild.id, 'vouch_role_id', null);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH ROLE CONFIGURED', executor_id: message.author.id, affected_user_id: null,
    role_id: roleId, reason: null, action_taken: 'Official vouch role unset', punishment: null
  });
  return message.reply({ embeds: [success('The official vouch role was unset.')], allowedMentions: { parse: [] } });
}

async function setReward(message, args, db) {
  if (!hasOwnerAccess(message.member, db)) return ownerReply(message);
  const role = await getRole(message.guild, args[0]);
  if (!role) return message.reply({ embeds: [failure('Use `-vouch setreward @role|ROLE_ID`.')], allowedMentions: { parse: [] } });
  const roleId = role.id;
  db.setSetting(message.guild.id, 'reward_role_id', roleId);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH REWARD CONFIGURED', executor_id: message.author.id, affected_user_id: null,
    role_id: roleId, reason: null, action_taken: 'Vouch reward role configured', punishment: null
  });
  return message.reply({ embeds: [success(`${mentionRole(roleId)} is now assigned with a vouch.`)], allowedMentions: { parse: [] } });
}

async function addGiver(message, args, db) {
  if (!hasVouchAdminAccess(message.member, db)) return denyReply(message, 'Only Vouch Admins, OS, or the Guild Owner can manage vouch givers.');
  const target = await getMember(message.guild, args[0]);
  if (!target || target.user.bot) return message.reply({ embeds: [failure('Mention a human server member.')], allowedMentions: { parse: [] } });
  db.addGiver(message.guild.id, target.id);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH GIVER UPDATED', executor_id: message.author.id, affected_user_id: target.id,
    role_id: null, reason: null, action_taken: 'Vouch giver added with default allowance', punishment: null
  });
  return message.reply({ embeds: [success(`${mentionUser(target.id)} can give vouches with the default allowance.`)], allowedMentions: { parse: [] } });
}

async function removeGiver(message, args, db) {
  if (!hasVouchAdminAccess(message.member, db)) return denyReply(message, 'Only Vouch Admins, OS, or the Guild Owner can manage vouch givers.');
  const target = await getMember(message.guild, args[0]);
  if (!target) return message.reply({ embeds: [failure('Mention a server member.')], allowedMentions: { parse: [] } });
  db.removeGiver(message.guild.id, target.id);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH GIVER UPDATED', executor_id: message.author.id, affected_user_id: target.id,
    role_id: null, reason: null, action_taken: 'Vouch giver permission removed', punishment: null
  });
  return message.reply({ embeds: [success(`${mentionUser(target.id)} can no longer give vouches.`)], allowedMentions: { parse: [] } });
}

async function setLimit(message, args, db) {
  if (!hasOwnerAccess(message.member, db)) return ownerReply(message);
  const guildId = message.guild.id;
  if (args[0]?.toLowerCase() === 'remove') {
    const target = await getMember(message.guild, args[1]);
    const registeredGiver = target && db.getGiver(guildId, target.id);
    const os = target && isOs(target, db);
    const admin = target && isVouchAdmin(target, db);
    if (!target || (!registeredGiver && !os && !admin)) return message.reply({ embeds: [failure('Mention a registered vouch giver, Vouch Admin, or OS member.')], allowedMentions: { parse: [] } });
    db.setGiverLimit(guildId, target.id, null);
    db.setVouchAdminLimit(guildId, target.id, null);
    db.removeOsVouchLimit(guildId, target.id);
    await logEvent(message.guild, db, {
      event_type: 'VOUCH ALLOWANCE UPDATED', executor_id: message.author.id, affected_user_id: target.id,
      role_id: null, reason: null, action_taken: os
        ? 'Custom allowance removed; OS default of five restored'
        : admin ? 'Custom allowance removed; Vouch Admin default of five restored'
          : 'Custom allowance removed; giver default restored',
      punishment: null
    });
    return message.reply({ embeds: [success(`${mentionUser(target.id)} now uses the ${os ? 'OS' : admin ? 'Vouch Admin' : 'giver'} default allowance.`)], allowedMentions: { parse: [] } });
  }

  if (userIdFrom(args[0]) && args[1] !== undefined) {
    const target = await getMember(message.guild, args[0]);
    const limit = Number(args[1]);
    const registeredGiver = target && db.getGiver(guildId, target.id);
    const os = target && isOs(target, db);
    const admin = target && isVouchAdmin(target, db);
    if (!target || (!registeredGiver && !os && !admin)) return message.reply({ embeds: [failure('Mention a registered vouch giver, Vouch Admin, or OS member.')], allowedMentions: { parse: [] } });
    if (!Number.isSafeInteger(limit) || limit < 0) return message.reply({ embeds: [failure('Allowance must be a whole number greater than or equal to zero.')], allowedMentions: { parse: [] } });
    if (registeredGiver) db.setGiverLimit(guildId, target.id, limit);
    if (admin) db.setVouchAdminLimit(guildId, target.id, limit);
    if (os) db.setOsVouchLimit(guildId, target.id, limit);
    await logEvent(message.guild, db, {
      event_type: 'VOUCH ALLOWANCE UPDATED', executor_id: message.author.id, affected_user_id: target.id,
      role_id: null, reason: null, action_taken: `Custom allowance set to ${limit}`, punishment: null
    });
    return message.reply({ embeds: [success(`${mentionUser(target.id)} can have up to ${limit} active vouch(es).`)], allowedMentions: { parse: [] } });
  }

  const limit = Number(args[0]);
  if (!Number.isSafeInteger(limit) || limit < 0) return message.reply({ embeds: [failure('Allowance must be a whole number greater than or equal to zero. Use `-vouch limit number`, `-vouch limit @user number`, or `-vouch limit remove @user`.')], allowedMentions: { parse: [] } });
  db.setSetting(guildId, 'default_giver_limit', limit);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH ALLOWANCE UPDATED', executor_id: message.author.id, affected_user_id: null,
    role_id: null, reason: null, action_taken: `Default giver allowance set to ${limit}`, punishment: null
  });
  return message.reply({ embeds: [success(`Default giver allowance is now ${limit}.`)], allowedMentions: { parse: [] } });
}

async function wipe(message, db) {
  if (!hasOwnerAccess(message.member, db)) return ownerReply(message);
  const result = await wipeVouches(message.guild, db, message.author.id);
  if (result.cleanupFailures.length) {
    return message.reply({ embeds: [failure(`${result.count} active vouch(es) were removed, but role cleanup failed for ${result.cleanupFailures.length} assignment(s). Check Manage Roles and role hierarchy.`, 'Role cleanup incomplete')], allowedMentions: { parse: [] } });
  }
  return message.reply({ embeds: [success(`${result.count} active vouch(es) were removed and giver allowances restored.`, 'Vouches wiped')], allowedMentions: { parse: [] } });
}

async function grantVouchAdmin(message, args, db) {
  if (!isOwnerOrOs(message.member, db)) return denyReply(message, 'Only OS or the Guild Owner can manage Vouch Admins.');
  const target = await getMember(message.guild, args[0]);
  if (!target || target.user.bot) return denyReply(message, 'Use `-vouch admin allow @user` with a human server member.');
  db.addVouchAdmin(message.guild.id, target.id, message.author.id);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH ADMIN UPDATED', executor_id: message.author.id, affected_user_id: target.id,
    role_id: null, reason: null, action_taken: 'Vouch Admin access granted', punishment: null
  });
  return message.reply({ embeds: [success(`${mentionUser(target.id)} is now a Vouch Admin.`)], allowedMentions: { parse: [] } });
}

async function revokeVouchAdmin(message, args, db) {
  if (!isOwnerOrOs(message.member, db)) return denyReply(message, 'Only OS or the Guild Owner can manage Vouch Admins.');
  const target = await getMember(message.guild, args[0]);
  if (!target) return denyReply(message, 'Use `-vouch admin remove @user`.');
  if (!isVouchAdmin(target, db)) return denyReply(message, 'That member is not a Vouch Admin.');
  db.removeVouchAdmin(message.guild.id, target.id);
  await logEvent(message.guild, db, {
    event_type: 'VOUCH ADMIN UPDATED', executor_id: message.author.id, affected_user_id: target.id,
    role_id: null, reason: null, action_taken: 'Vouch Admin access removed; existing vouches kept', punishment: null
  });
  return message.reply({ embeds: [success(`${mentionUser(target.id)} is no longer a Vouch Admin. Their existing vouches were kept.`)], allowedMentions: { parse: [] } });
}

async function adminCommand(message, args, db) {
  const action = args[0]?.toLowerCase();
  const rest = args.slice(1);
  if (action === 'take') {
    if (!hasVouchAdminAccess(message.member, db)) return denyReply(message, 'Only Vouch Admins, OS, or the Guild Owner can use `-vouch admin take`.');
    return take(message, rest, db, '-vouch admin take @user [reason]');
  }
  if (action === 'allow') return grantVouchAdmin(message, rest, db);
  if (action === 'remove') return revokeVouchAdmin(message, rest, db);
  return denyReply(message, 'Use `-vouch admin take @user`, `-vouch admin allow @user`, or `-vouch admin remove @user`.');
}

async function ownerCommand(message, args, db) {
  if (!isGuildOwner(message.member)) return denyReply(message, 'Only the Guild Owner can grant or remove Owner Allow.');
  const action = args[0]?.toLowerCase();
  if (action !== 'allow' && action !== 'remove') return denyReply(message, 'Use `-vouch owner allow @user` or `-vouch owner remove @user`.');
  const target = await getMember(message.guild, args[1]);
  if (!target || target.user.bot) return denyReply(message, `Use \`-vouch owner ${action} @user\` with a human server member.`);
  if (target.id === message.guild.ownerId) return denyReply(message, 'The Guild Owner already has full access.');
  if (action === 'allow') db.addOwnerAllowed(message.guild.id, target.id, message.author.id);
  else {
    if (!db.isOwnerAllowed(message.guild.id, target.id)) return denyReply(message, 'That member does not have Owner Allow.');
    db.removeOwnerAllowed(message.guild.id, target.id);
  }
  await logEvent(message.guild, db, {
    event_type: 'OWNER ALLOW UPDATED', executor_id: message.author.id, affected_user_id: target.id,
    role_id: null, reason: null,
    action_taken: action === 'allow' ? 'Owner Allow granted: full Guild Owner bot access' : 'Owner Allow removed',
    punishment: null
  });
  return message.reply({
    embeds: [success(action === 'allow'
      ? `${mentionUser(target.id)} now has full Guild Owner access to this bot.`
      : `${mentionUser(target.id)} no longer has Owner Allow.`)],
    allowedMentions: { parse: [] }
  });
}

async function roleCommand(message, args, db) {
  const action = args[0]?.toLowerCase();
  if (action === 'add') return setRole(message, args.slice(1), db, '-vouch role add @role');
  if (action === 'remove') return unsetRole(message, db);
  if (!isOwnerOrOs(message.member, db)) return denyReply(message, 'Only OS or the Guild Owner can manage the vouch role.');
  return denyReply(message, 'Use `-vouch role add @role` or `-vouch role remove`.');
}

async function execute(message, args, db) {
  const subcommand = args[0]?.toLowerCase();
  const rest = args.slice(1);
  switch (subcommand) {
    case 'give': return give(message, rest, db);
    case 'take': return take(message, rest, db);
    case 'check': return check(message, rest, db);
    case 'list': return list(message, rest, db);
    case 'setrole': return setRole(message, rest, db);
    case 'unsetrole': return unsetRole(message, db);
    case 'setreward': return setReward(message, rest, db);
    case 'addgiver': return addGiver(message, rest, db);
    case 'removegiver': return removeGiver(message, rest, db);
    case 'limit': return setLimit(message, rest, db);
    case 'wipeall': return wipe(message, db);
    case 'reset': return wipe(message, db);
    case 'admin': return adminCommand(message, rest, db);
    case 'owner': return ownerCommand(message, rest, db);
    case 'role': return roleCommand(message, rest, db);
    default:
      return message.reply({ embeds: [embed('Vouch', 'Use `-vouch give`, `take`, `check`, `list`, or an authorized configuration command.')], allowedMentions: { parse: [] } });
  }
}

module.exports = { execute };