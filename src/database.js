async function initialize(db) {
  await Promise.all([
    db.collection('challenges').createIndex({ id: 1 }, { unique: true }),
    db.collection('challenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('limits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('transfers').createIndex({ owner: 1, createdAt: -1 }),
    db.collection('transfers').createIndex({ recipient: 1, createdAt: -1 }),
    db.collection('transfers').createIndex({ expiresAt: 1, status: 1 }),
    db.collection('transfers').createIndex({ orgId: 1, status: 1 }),
    db.collection('organizations').createIndex({ 'members.email': 1 }),
    db.collection('audit').createIndex({ orgId: 1, _id: 1 }),
    db.collection('usage').createIndex({ orgId: 1, at: -1 }),
    db.collection('workers').createIndex({ heartbeat: 1 }, { expireAfterSeconds: 86400 }),
  ]);
}
module.exports = { initialize };
