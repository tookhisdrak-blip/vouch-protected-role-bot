const { EmbedBuilder } = require('discord.js');
const { COLORS, mentionRole, mentionUser } = require('../utils/embeds');

function categoryForEvent(eventType) {
  const normalizedType = eventType.replace(/^FORCE:\s*/, '');
  if (/^FOREVER BAN/.test(normalizedType)) return 'ban';
  if (/^VOUCH (GIVEN|REMOVED|WIPE|LIMIT VIOLATION|ROLE RESTORED|ROLE VIOLATION)$/.test(normalizedType)) return 'vouch';
  if (/VIOLATION|STRIPSTAFF/.test(normalizedType)) return 'main';
  return 'admin';
}

async function logEvent(guild, db, entry) {
  const createdAt = entry.created_at || new Date().toISOString();
  const fullEntry = { ...entry, reward: entry.reward || null, guild_id: guild.id, created_at: createdAt };
  db.addEventLog(fullEntry);

  const category = entry.log_category || categoryForEvent(entry.event_type);
  const dedicatedChannelId = db.getLogChannel(guild.id, category);
  const legacyChannelId = db.getSettings(guild.id).log_channel_id;
  let channelId = dedicatedChannelId || legacyChannelId;
  if (!channelId) return;

  let channel = guild.channels.cache.get(channelId);
  if ((!channel || !channel.isTextBased() || !channel.send)
    && dedicatedChannelId && legacyChannelId && dedicatedChannelId !== legacyChannelId) {
    console.warn(`Configured ${category} log channel ${dedicatedChannelId} is unavailable in ${guild.id}; using the legacy log channel.`);
    channelId = legacyChannelId;
    channel = guild.channels.cache.get(channelId);
  }
  if (!channel || !channel.isTextBased() || !channel.send) {
    console.warn(`Configured log channel ${channelId} is unavailable in ${guild.id}; event ${entry.event_type} was stored but not sent.`);
    return;
  }

  const result = `${entry.action_taken || 'Unknown'}${entry.role_id ? ` (${mentionRole(entry.role_id)})` : ''}`.slice(0, 1024);
  const embed = new EmbedBuilder()
    .setColor(COLORS.log)
    .setTitle(entry.event_type.slice(0, 256))
    .addFields(
      { name: 'Who', value: entry.executor_id ? mentionUser(entry.executor_id) : 'Unknown', inline: true },
      { name: 'Target', value: entry.affected_user_id ? mentionUser(entry.affected_user_id) : entry.event_type === 'VOUCH WIPE' ? 'All active vouch recipients' : 'None', inline: true },
      { name: 'Result', value: result, inline: true },
      { name: 'Punishment', value: (entry.punishment || 'None').slice(0, 1024), inline: true },
      { name: 'Reward', value: (fullEntry.reward || 'None').slice(0, 1024), inline: true }
    )
    .setTimestamp(new Date(createdAt));

  try {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`Could not send an event log in ${guild.id}:`, error.message);
  }
}

module.exports = { logEvent, categoryForEvent };