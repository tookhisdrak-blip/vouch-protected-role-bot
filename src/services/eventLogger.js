const { EmbedBuilder } = require('discord.js');
const { COLORS, mentionRole, mentionUser } = require('../utils/embeds');

async function logEvent(guild, db, entry) {
  const createdAt = entry.created_at || new Date().toISOString();
  const fullEntry = { ...entry, guild_id: guild.id, created_at: createdAt };
  db.addEventLog(fullEntry);

  const channelId = db.getSettings(guild.id).log_channel_id;
  if (!channelId) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased() || !channel.send) return;

  const valueOrUnknown = (value) => value || 'Unknown';
  const embed = new EmbedBuilder()
    .setColor(COLORS.log)
    .setTitle(entry.event_type)
    .addFields(
      { name: 'Executor', value: entry.executor_id ? mentionUser(entry.executor_id) : 'Unknown', inline: true },
      { name: 'Affected', value: entry.affected_user_id ? mentionUser(entry.affected_user_id) : 'Unknown', inline: true },
      { name: 'Role', value: entry.role_id ? mentionRole(entry.role_id) : 'None', inline: true },
      { name: 'Reason', value: valueOrUnknown(entry.reason), inline: true },
      { name: 'Action', value: entry.action_taken, inline: true },
      { name: 'Punishment', value: entry.punishment || 'None', inline: true }
    )
    .setTimestamp(new Date(createdAt));

  try {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`Could not send an event log in ${guild.id}:`, error.message);
  }
}

module.exports = { logEvent };