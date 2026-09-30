const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDatabasePath, LOCAL_DEFAULT } = require('../src/databasePath');

const railway = { RAILWAY_PROJECT_ID: 'project', RAILWAY_ENVIRONMENT_NAME: 'production' };

test('local development uses DATABASE_PATH or the ./data default', () => {
  assert.deepEqual(resolveDatabasePath({}), { path: LOCAL_DEFAULT, error: null });
  assert.deepEqual(resolveDatabasePath({ DATABASE_PATH: './custom.sqlite' }), { path: './custom.sqlite', error: null });
});

test('Railway stores the database on the attached Volume', () => {
  assert.deepEqual(resolveDatabasePath({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }),
    { path: '/app/data/moderation.sqlite', error: null });
  assert.deepEqual(resolveDatabasePath({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/app/data', DATABASE_PATH: '/app/data/moderation.sqlite' }),
    { path: '/app/data/moderation.sqlite', error: null });
  assert.deepEqual(resolveDatabasePath({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/app/data', DATABASE_PATH: './data/moderation.sqlite' }),
    { path: './data/moderation.sqlite', error: null }, 'relative path resolves from /app into the Volume');
});

test('Railway refuses ephemeral storage', () => {
  const missingVolume = resolveDatabasePath({ ...railway, DATABASE_PATH: '/app/data/moderation.sqlite' });
  assert.equal(missingVolume.path, null);
  assert.match(missingVolume.error, /No Railway Volume/);
  const outside = resolveDatabasePath({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/app/data', DATABASE_PATH: '/tmp/moderation.sqlite' });
  assert.equal(outside.path, null);
  assert.match(outside.error, /outside the Railway Volume/);
  const sibling = resolveDatabasePath({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: '/app/data', DATABASE_PATH: '/app/data-old/moderation.sqlite' });
  assert.equal(sibling.path, null);
});
