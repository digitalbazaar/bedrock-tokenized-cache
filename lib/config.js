/*!
 * Copyright (c) 2020-2024 Digital Bazaar, Inc. All rights reserved.
 */
import {config} from '@bedrock/core';

const cfg = config['tokenized-cache'] = {};

// expire cache records by default
cfg.autoRemoveExpiredRecords = true;

cfg.defaults = {
  // time to live in milliseconds, default to 24 hours
  ttl: 1 * 24 * 60 * 60 * 1000
};

// in-memory caches
cfg.caches = {
  entry: {
    // 1000 means 1000 of the most popular cached entries can stay in memory
    maxSize: 1000,
    // default to 24 hours; actual age will be based on entry expiry
    maxAge: 24 * 60 * 60 * 1000
  }
};
