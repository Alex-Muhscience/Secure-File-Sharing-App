const mongoose = require('mongoose');

const fileMetadataSchema = new mongoose.Schema({
  originalName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255
  },
  sanitizedName: {
    type: String,
    required: true,
    trim: true
  },
  encryptedPath: {
    type: String,
    required: true,
    unique: true
  },
  iv: {
    type: String,
    required: true,
    length: 32 // 16 bytes in hex
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  fileSize: {
    type: Number,
    required: true,
    min: 0
  },
  mimeType: {
    type: String,
    required: true,
    trim: true
  },
  fileHash: {
    type: String,
    required: true,
    unique: true // Prevent duplicate uploads
  },
  uploadDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
  },
  downloadCount: {
    type: Number,
    default: 0,
    min: 0
  },
  maxDownloads: {
    type: Number,
    default: null // null means unlimited
  },
  lastDownloadAt: {
    type: Date
  },
  status: {
    type: String,
    enum: ['uploading', 'active', 'expired', 'deleted'],
    default: 'active',
    index: true
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    uploadSource: {
      type: String,
      enum: ['web', 'api', 'mobile'],
      default: 'web'
    }
  },
  security: {
    passwordProtected: {
      type: Boolean,
      default: false
    },
    passwordHash: String,
    accessRestrictions: {
      allowedIPs: [String],
      requireOTP: {
        type: Boolean,
        default: true
      }
    }
  },
  tags: [String],
  description: {
    type: String,
    maxlength: 500
  }
});

// Compound indexes for performance
fileMetadataSchema.index({ email: 1, uploadDate: -1 });
fileMetadataSchema.index({ expiresAt: 1, status: 1 });
fileMetadataSchema.index({ status: 1, uploadDate: -1 });
fileMetadataSchema.index({ fileHash: 1 });

// TTL index for automatic cleanup of expired files
fileMetadataSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Pre-save middleware
fileMetadataSchema.pre('save', function(next) {
  // Sanitize filename
  if (this.isModified('originalName')) {
    this.sanitizedName = this.originalName.replace(/[^a-zA-Z0-9.-]/g, '_');
  }
  
  // Update status based on expiration
  if (this.expiresAt < new Date()) {
    this.status = 'expired';
  }
  
  next();
});

// Instance methods
fileMetadataSchema.methods.incrementDownloadCount = function() {
  this.downloadCount += 1;
  this.lastDownloadAt = new Date();
  return this.save();
};

fileMetadataSchema.methods.isExpired = function() {
  return this.expiresAt < new Date() || this.status === 'expired';
};

fileMetadataSchema.methods.canDownload = function() {
  if (this.isExpired()) return false;
  if (this.maxDownloads && this.downloadCount >= this.maxDownloads) return false;
  return this.status === 'active';
};

fileMetadataSchema.methods.extendExpiration = function(hours = 24) {
  this.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  return this.save();
};

fileMetadataSchema.methods.markAsDeleted = function() {
  this.status = 'deleted';
  return this.save();
};

// Static methods
fileMetadataSchema.statics.findByEmail = function(email) {
  return this.find({ email: email.toLowerCase(), status: { $ne: 'deleted' } })
             .sort({ uploadDate: -1 });
};

fileMetadataSchema.statics.findExpired = function() {
  return this.find({
    $or: [
      { expiresAt: { $lt: new Date() } },
      { status: 'expired' }
    ]
  });
};

fileMetadataSchema.statics.findByHash = function(hash) {
  return this.findOne({ fileHash: hash, status: { $ne: 'deleted' } });
};

fileMetadataSchema.statics.getStorageStats = function() {
  return this.aggregate([
    { $match: { status: { $ne: 'deleted' } } },
    {
      $group: {
        _id: null,
        totalFiles: { $sum: 1 },
        totalSize: { $sum: '$fileSize' },
        activeFiles: {
          $sum: {
            $cond: [{ $eq: ['$status', 'active'] }, 1, 0]
          }
        }
      }
    }
  ]);
};

// Virtual for file size in human readable format
fileMetadataSchema.virtual('fileSizeFormatted').get(function() {
  const bytes = this.fileSize;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
});

// Virtual for time until expiration
fileMetadataSchema.virtual('timeUntilExpiration').get(function() {
  const now = new Date();
  const expiry = this.expiresAt;
  const diff = expiry - now;
  
  if (diff <= 0) return 'Expired';
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
});

// Ensure virtual fields are serialized
fileMetadataSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    delete ret.iv; // Don't expose encryption IV in JSON
    return ret;
  }
});

module.exports = mongoose.model('FileMetadata', fileMetadataSchema);
