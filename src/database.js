async function initialize(db) {
  await Promise.all([
    db.collection('challenges').createIndex({ id: 1 }, { unique: true }),
    db.collection('challenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('transfers').createIndex({ owner: 1, createdAt: -1 }),
    db.collection('transfers').createIndex({ recipient: 1, createdAt: -1 }),
    db.collection('transfers').createIndex({ expiresAt: 1, status: 1 }),
  ]);
}
module.exports = { initialize };
