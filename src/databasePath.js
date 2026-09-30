const path = require('node:path');

const LOCAL_DEFAULT = './data/moderation.sqlite';
const DATABASE_FILE = 'moderation.sqlite';

function isInside(child, parent) {
  const relative = path.posix.relative(path.posix.resolve(parent), path.posix.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

// Priority: DATABASE_PATH, then the attached Railway volume, then the local development default.
// On Railway the database must live on the attached volume, otherwise redeploys would wipe it.
function resolveDatabasePath(env = process.env) {
  const onRailway = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_ID);
  const volumePath = env.RAILWAY_VOLUME_MOUNT_PATH;
  const explicit = env.DATABASE_PATH && env.DATABASE_PATH.trim();

  if (!onRailway) return { path: explicit || LOCAL_DEFAULT, error: null };

  if (!volumePath) {
    return {
      path: null,
      error: 'No Railway Volume is attached. Attach a Volume mounted at /app/data so the SQLite database persists across deploys.'
    };
  }

  const databasePath = explicit || path.posix.join(volumePath, DATABASE_FILE);
  const absolute = path.posix.isAbsolute(databasePath) ? databasePath : path.posix.join('/app', databasePath);
  if (!isInside(absolute, volumePath)) {
    return {
      path: null,
      error: `DATABASE_PATH (${databasePath}) is outside the Railway Volume (${volumePath}). Data there would be lost on redeploy.`
    };
  }
  return { path: databasePath, error: null };
}

module.exports = { resolveDatabasePath, LOCAL_DEFAULT };
