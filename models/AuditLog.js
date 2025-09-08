const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
    enum: [
      'OTP_REQUESTED',
      'OTP_SENT',
      'OTP_VERIFIED',
      'OTP_FAILED',
      'OTP_VERIFICATION_ERROR',
      'EMAIL_SENT',
      'EMAIL_ERROR',
      'FILE_UPLOADED',
      'FILE_DOWNLOADED',
      'FILE_DELETED',
      'FILE_EXPIRED',
      'LOGIN_SUCCESS',
      'LOGIN_FAILED',
      'SESSION_CREATED',
      'SESSION_EXPIRED',
      'SECURITY_VIOLATION',
      'RATE_LIMIT_EXCEEDED',
      'INVALID_ACCESS_ATTEMPT',
      'UPLOAD_NOTIFICATION_SENT',
      'DOWNLOAD_NOTIFICATION_SENT', 
      'SECURITY_ALERT_SENT',
      'NOTIFICATION_ERROR',
      'SESSION_CLEANUP',
      'API_REQUEST',
      'API_RESPONSE',
      'API_ERROR',
      'AUTH_ERROR',
      'FILE_COMPRESSED',
      'FILE_DECOMPRESSED',
      'COMPRESSION_ERROR',
      'DECOMPRESSION_ERROR',
      'IPFS_INITIALIZED',
      'FILE_UPLOADED_IPFS',
      'FILE_DOWNLOADED_IPFS',
      'IPFS_UPLOAD_ERROR',
      'IPFS_DOWNLOAD_ERROR',
      'FILE_PINNED_IPFS',
      'FILE_UNPINNED_IPFS',
      'BLOCKCHAIN_INITIALIZED',
      'CONTRACT_DEPLOYED',
      'CONTRACT_DEPLOYMENT_ERROR',
      'FILE_METADATA_UPLOADED',
      'BLOCKCHAIN_UPLOAD_ERROR',
      'ACCESS_VERIFIED',
      'DOWNLOAD_RECORDED',
      'SYSTEM_ERROR'
    ],
    index: true
  },
  level: {
    type: String,
    enum: ['INFO', 'WARN', 'ERROR', 'CRITICAL'],
    default: 'INFO',
    index: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  sessionId: {
    type: String,
    index: true
  },
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FileMetadata'
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  metadata: {
    ipAddress: {
      type: String,
      required: true,
      index: true
    },
    userAgent: String,
    method: String,
    url: String,
    statusCode: Number,
    responseTime: Number,
    requestSize: Number,
    responseSize: Number,
    location: {
      country: String,
      city: String,
      coordinates: {
        lat: Number,
        lng: Number
      }
    }
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  severity: {
    type: Number,
    min: 1,
    max: 10,
    default: 5
  },
  tags: [String],
  correlationId: {
    type: String,
    index: true
  }
});

// Indexes for performance and queries
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ level: 1, timestamp: -1 });
auditLogSchema.index({ email: 1, timestamp: -1 });
auditLogSchema.index({ 'metadata.ipAddress': 1, timestamp: -1 });
auditLogSchema.index({ severity: -1, timestamp: -1 });

// TTL index for automatic cleanup (keep logs for 90 days)
auditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Static methods
auditLogSchema.statics.logAction = function(action, data = {}) {
  const logEntry = new this({
    action,
    level: data.level || 'INFO',
    email: data.email,
    userId: data.userId,
    sessionId: data.sessionId,
    fileId: data.fileId,
    details: data.details || {},
    metadata: {
      ipAddress: data.ipAddress || 'unknown',
      userAgent: data.userAgent,
      method: data.method,
      url: data.url,
      statusCode: data.statusCode,
      responseTime: data.responseTime,
      requestSize: data.requestSize,
      responseSize: data.responseSize,
      location: data.location
    },
    severity: data.severity || 5,
    tags: data.tags || [],
    correlationId: data.correlationId
  });
  
  return logEntry.save();
};

auditLogSchema.statics.getSecurityEvents = function(timeRange = 24) {
  const since = new Date(Date.now() - timeRange * 60 * 60 * 1000);
  return this.find({
    timestamp: { $gte: since },
    $or: [
      { level: { $in: ['WARN', 'ERROR', 'CRITICAL'] } },
      { action: { $in: ['SECURITY_VIOLATION', 'RATE_LIMIT_EXCEEDED', 'INVALID_ACCESS_ATTEMPT'] } },
      { severity: { $gte: 7 } }
    ]
  }).sort({ timestamp: -1 });
};

auditLogSchema.statics.getUserActivity = function(email, limit = 100) {
  return this.find({ email: email.toLowerCase() })
             .sort({ timestamp: -1 })
             .limit(limit);
};

auditLogSchema.statics.getSystemStats = function(timeRange = 24) {
  const since = new Date(Date.now() - timeRange * 60 * 60 * 1000);
  return this.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: {
          action: '$action',
          level: '$level'
        },
        count: { $sum: 1 },
        avgSeverity: { $avg: '$severity' },
        lastOccurrence: { $max: '$timestamp' }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

auditLogSchema.statics.getFailedAttempts = function(ipAddress, timeRange = 1) {
  const since = new Date(Date.now() - timeRange * 60 * 60 * 1000);
  return this.countDocuments({
    'metadata.ipAddress': ipAddress,
    timestamp: { $gte: since },
    $or: [
      { action: 'OTP_FAILED' },
      { action: 'LOGIN_FAILED' },
      { action: 'INVALID_ACCESS_ATTEMPT' }
    ]
  });
};

auditLogSchema.statics.detectAnomalies = function(timeRange = 24) {
  const since = new Date(Date.now() - timeRange * 60 * 60 * 1000);
  return this.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: '$metadata.ipAddress',
        requestCount: { $sum: 1 },
        uniqueEmails: { $addToSet: '$email' },
        failedAttempts: {
          $sum: {
            $cond: [
              { $in: ['$action', ['OTP_FAILED', 'LOGIN_FAILED', 'INVALID_ACCESS_ATTEMPT']] },
              1,
              0
            ]
          }
        },
        avgSeverity: { $avg: '$severity' }
      }
    },
    {
      $match: {
        $or: [
          { requestCount: { $gt: 1000 } }, // High request volume
          { failedAttempts: { $gt: 10 } }, // Many failed attempts
          { avgSeverity: { $gt: 7 } } // High average severity
        ]
      }
    },
    { $sort: { requestCount: -1 } }
  ]);
};

// Virtual for formatted timestamp
auditLogSchema.virtual('formattedTimestamp').get(function() {
  return this.timestamp.toISOString();
});

// Virtual for human-readable details
auditLogSchema.virtual('summary').get(function() {
  const base = `${this.action} by ${this.email || 'unknown'} from ${this.metadata.ipAddress}`;
  if (this.details && Object.keys(this.details).length > 0) {
    return `${base} - ${JSON.stringify(this.details)}`;
  }
  return base;
});

// Ensure virtual fields are serialized
auditLogSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
