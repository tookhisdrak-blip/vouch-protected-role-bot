const { Collection } = require('discord.js');

const MEMBER_PAGE_SIZE = 1000;

async function listAllGuildMembers(guild) {
  if (typeof guild.members.list !== 'function') {
    return guild.members.fetch();
  }

  const members = new Collection();
  let after;
  while (true) {
    const page = await guild.members.list({
      limit: MEMBER_PAGE_SIZE,
      after,
      cache: true
    });
    for (const [memberId, member] of page) members.set(memberId, member);
    if (page.size < MEMBER_PAGE_SIZE) break;

    const nextAfter = page.lastKey();
    if (!nextAfter || nextAfter === after) {
      throw new Error(`Member pagination did not advance for guild ${guild.id}.`);
    }
    after = nextAfter;
  }
  return members;
}

function membersWithRole(members, roleId) {
  return members.filter((member) => member.roles.cache.has(roleId));
}

function countMembersByRole(members, roleIds) {
  const counts = new Map(roleIds.map((roleId) => [roleId, 0]));
  for (const member of members.values()) {
    for (const roleId of member.roles.cache.keys()) {
      if (counts.has(roleId)) counts.set(roleId, counts.get(roleId) + 1);
    }
  }
  return counts;
}

module.exports = { listAllGuildMembers, membersWithRole, countMembersByRole, MEMBER_PAGE_SIZE };
