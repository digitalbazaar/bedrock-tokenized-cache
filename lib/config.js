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
