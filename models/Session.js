const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
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
  otp: {
    code: {
      type: String,
      required: true,
      length: 6
    },
    attempts: {
      type: Number,
      default: 0,
      max: 5
    },
    verified: {
      type: Boolean,
      default: false
    },
    generatedAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
    }
  },
  jwt: {
    token: String,
    issuedAt: Date,
    expiresAt: Date
  },
  metadata: {
    ipAddress: {
      type: String,
      required: true
    },
    userAgent: String,
    deviceFingerprint: String,
    location: {
      country: String,
      city: String,
      coordinates: {
        lat: Number,
        lng: Number
      }
    }
  },
  status: {
    type: String,
    enum: ['pending', 'verified', 'expired', 'blocked'],
    default: 'pending',
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  lastActivityAt: {
    type: Date,
    default: Date.now
  }
});

// TTL index for automatic cleanup
sessionSchema.index({ 'otp.expiresAt': 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 }); // 24 hours

// Compound indexes
sessionSchema.index({ email: 1, status: 1 });
sessionSchema.index({ sessionId: 1, status: 1 });

// Pre-save middleware
sessionSchema.pre('save', function(next) {
  this.lastActivityAt = new Date();
  
  // Update status based on expiration
  if (this.otp.expiresAt < new Date()) {
    this.status = 'expired';
  }
  
  next();
});

// Instance methods
sessionSchema.methods.isOTPValid = function() {
  return !this.isOTPExpired() && 
         this.otp.attempts < 5 && 
         this.status !== 'blocked';
};

sessionSchema.methods.isOTPExpired = function() {
  return this.otp.expiresAt < new Date();
};

sessionSchema.methods.verifyOTP = function(inputOTP) {
  if (!this.isOTPValid()) {
    return { success: false, reason: 'OTP expired or blocked' };
  }
  
  this.otp.attempts += 1;
  
  if (this.otp.code !== inputOTP) {
    if (this.otp.attempts >= 5) {
      this.status = 'blocked';
    }
    return { success: false, reason: 'Invalid OTP' };
  }
  
  this.otp.verified = true;
  this.status = 'verified';
  return { success: true };
};

sessionSchema.methods.generateNewOTP = function() {
  this.otp.code = Math.floor(100000 + Math.random() * 900000).toString();
  this.otp.attempts = 0;
  this.otp.verified = false;
  this.otp.generatedAt = new Date();
  this.otp.expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  this.status = 'pending';
  return this.otp.code;
};

sessionSchema.methods.setJWT = function(token, expiresIn = '1h') {
  this.jwt.token = token;
  this.jwt.issuedAt = new Date();
  
  // Parse expiresIn (e.g., '1h', '30m', '24h')
  const timeValue = parseInt(expiresIn);
  const timeUnit = expiresIn.slice(-1);
  let milliseconds;
  
  switch(timeUnit) {
    case 'h':
      milliseconds = timeValue * 60 * 60 * 1000;
      break;
    case 'm':
      milliseconds = timeValue * 60 * 1000;
      break;
    case 'd':
      milliseconds = timeValue * 24 * 60 * 60 * 1000;
      break;
    default:
      milliseconds = 60 * 60 * 1000; // Default 1 hour
  }
  
  this.jwt.expiresAt = new Date(Date.now() + milliseconds);
};

sessionSchema.methods.invalidate = function() {
  this.status = 'expired';
  this.jwt.token = null;
  return this.save();
};

// Static methods
sessionSchema.statics.findBySessionId = function(sessionId) {
  return this.findOne({ sessionId, status: { $ne: 'expired' } });
};

sessionSchema.statics.findActiveByEmail = function(email) {
  return this.find({ 
    email: email.toLowerCase(), 
    status: { $in: ['pending', 'verified'] },
    'otp.expiresAt': { $gt: new Date() }
  }).sort({ createdAt: -1 });
};

sessionSchema.statics.cleanupExpired = function() {
  return this.deleteMany({
    $or: [
      { 'otp.expiresAt': { $lt: new Date() } },
      { status: 'expired' },
      { createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    ]
  });
};

sessionSchema.statics.getSessionStats = function() {
  return this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);
};

// Virtual for remaining OTP time
sessionSchema.virtual('otpTimeRemaining').get(function() {
  const now = new Date();
  const expiry = this.otp.expiresAt;
  const diff = expiry - now;
  
  if (diff <= 0) return 0;
  return Math.floor(diff / 1000); // Return seconds
});

// Ensure virtual fields are serialized
sessionSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    delete ret.otp.code; // Don't expose OTP in JSON
    delete ret.jwt.token; // Don't expose JWT in JSON
    return ret;
  }
});

module.exports = mongoose.model('Session', sessionSchema);
