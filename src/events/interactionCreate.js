const { failure } = require('../utils/embeds');
const forceManagement = require('../commands/forceManagement');
const vouchCommands = require('../commands/vouchCommands');

async function handleInteraction(interaction, db) {
  try {
    if (await vouchCommands.handleInteraction(interaction, db)) return;
    await forceManagement.handleInteraction(interaction, db);
  } catch (error) {
    console.error('Force Management interaction failed:', error);
    const response = { embeds: [failure('That Force Management action could not be completed.')], allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) await interaction.followUp({ ...response, ephemeral: true }).catch(() => null);
    else await interaction.reply({ ...response, ephemeral: true }).catch(() => null);
  }
}

module.exports = { handleInteraction };