const { handleGuildMemberUpdate } = require('../services/roleProtection');
const { handleForceMemberUpdate } = require('../services/forceRules');
const { handleRoleLockUpdate } = require('../services/roleLocks');

async function handleMemberUpdate(oldMember, newMember, db) {
  if (!oldMember.guild) return;
  db.ensureGuild(newMember.guild.id);
  try {
    await handleRoleLockUpdate(oldMember, newMember, db);
    const handledRoleIds = await handleGuildMemberUpdate(oldMember, newMember, db);
    await handleForceMemberUpdate(oldMember, newMember, db, handledRoleIds);
  } catch (error) {
    console.error(`Role protection failed in ${newMember.guild.id}:`, error);
  }
}

module.exports = { handleMemberUpdate };