class ThrottleManager {
  constructor(options = {}) {
    this.maxUpdatesPerSecond = options.maxUpdatesPerSecond || 5;
    this.windowMs = options.windowMs || 1000;
    this.userBuckets = new Map();
    this.penaltyBuckets = new Map();
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  getBucket(userId) {
    const now = Date.now();
    let bucket = this.userBuckets.get(userId);
    
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      bucket = {
        count: 0,
        windowStart: now,
        violations: 0
      };
      this.userBuckets.set(userId, bucket);
    }
    
    return bucket;
  }

  getPenaltyBucket(userId) {
    let bucket = this.penaltyBuckets.get(userId);
    if (!bucket) {
      bucket = {
        violationCount: 0,
        lastViolation: 0,
        penaltyUntil: 0
      };
      this.penaltyBuckets.set(userId, bucket);
    }
    return bucket;
  }

  checkLimit(userId) {
    const bucket = this.getBucket(userId);
    const penaltyBucket = this.getPenaltyBucket(userId);
    const now = Date.now();

    if (penaltyBucket.penaltyUntil > now) {
      return {
        allowed: false,
        reason: 'penalty',
        retryAfter: penaltyBucket.penaltyUntil - now
      };
    }

    bucket.count++;
    
    if (bucket.count > this.maxUpdatesPerSecond) {
      bucket.violations++;
      penaltyBucket.violationCount++;
      penaltyBucket.lastViolation = now;
      
      if (penaltyBucket.violationCount >= 3) {
        penaltyBucket.penaltyUntil = now + 5000;
        return {
          allowed: false,
          reason: 'throttled',
          retryAfter: 5000,
          violationCount: penaltyBucket.violationCount
        };
      }
      
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfter: this.windowMs - (now - bucket.windowStart)
      };
    }
    
    return { allowed: true };
  }

  resetUser(userId) {
    this.userBuckets.delete(userId);
    this.penaltyBuckets.delete(userId);
  }

  cleanup() {
    const now = Date.now();
    for (const [userId, bucket] of this.userBuckets.entries()) {
      if (now - bucket.windowStart > this.windowMs * 2) {
        this.userBuckets.delete(userId);
      }
    }
    for (const [userId, bucket] of this.penaltyBuckets.entries()) {
      if (now - bucket.lastViolation > 300000 && bucket.penaltyUntil < now) {
        this.penaltyBuckets.delete(userId);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.userBuckets.clear();
    this.penaltyBuckets.clear();
  }
}

module.exports = { ThrottleManager };