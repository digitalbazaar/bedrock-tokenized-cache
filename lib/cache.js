/*!
 * Copyright (c) 2020-2024 Digital Bazaar, Inc. All rights reserved.
 */
import * as base64url from 'base64url-universal';
import * as bedrock from '@bedrock/core';
import * as database from '@bedrock/mongodb';
import assert from 'assert-plus';
import canonicalize from 'canonicalize';
import crypto from 'node:crypto';
import {LruCache} from '@digitalbazaar/lru-memoize';
import {tokenizers} from '@bedrock/tokenizer';

const {util: {BedrockError}} = bedrock;

const TEXT_ENCODER = new TextEncoder();

const COLLECTION_NAME = 'tokenized-cache-entry';

// in-memory entries cache
export let ENTRY_CACHE;
// exported for testing purposes only
export {ENTRY_CACHE as _ENTRY_CACHE};

bedrock.events.on('bedrock.init', async () => {
  _createEntryCache();
});

/* Note on TTL index grace periods:

Records that match a TTL index are auto-removed from a mongodb collection based
on the index option `expireAfterSeconds`. This option can be interpreted as a
grace period prior to the removal of records. Using a value other than `0`
provides better resiliency for decision making processes that must retrieve
records, make decisions about them (based on their existence) and then update
them to extend their expiration period.

If there is no sufficiently long grace period, then such a process could
retrieve an imminently expiring record, make a decision, and then try to
update the record to extend its expiration period and fail to find it.

Processes could be modified to account for these exceptions, but that
approach is more complex than ensuring that the record persists long enough
for its expiration period to be extended.

The grace period chosen is considered long enough to ensure an expectation
that there will be no processes that experience these exceptions. */
bedrock.events.on('bedrock-mongodb.ready', async () => {
  await database.openCollections([COLLECTION_NAME]);

  const indexes = [{
    // `tokenizedId` should be a shard key
    collection: COLLECTION_NAME,
    fields: {'entry.tokenizedId': 1},
    options: {unique: true, background: false}
  }];

  // only create TTL expiration records if configured to do so
  const {autoRemoveExpiredRecords} = bedrock.config['tokenized-cache'];
  if(autoRemoveExpiredRecords) {
    indexes.push({
      // automatically expire entries using `expires` date field
      collection: COLLECTION_NAME,
      fields: {'entry.expires': 1},
      options: {
        unique: false,
        background: false,
        // grace period of 24 hours
        expireAfterSeconds: 60 * 60 * 24
      }
    });
  }

  await database.createIndexes(indexes);
});

/**
 * Creates a cache entry ID from a document. This utility function is useful
 * for applications that want to generate cache entries for JSON documents
 * without storing the documents in the cache.
 *
 * @param {object} options - Options to use.
 * @param {object} [options.document] - The document to generate an ID from.
 *
 * @returns {Promise<object>} Resolves to an object with `id`.
 */
export async function createId({document} = {}) {
  assert.object(document, 'document');

  // canonicalize document to a string
  const string = canonicalize(document);
  // hash string
  const digest = await _sha256({string});
  // express digest as multibase-multihash string
  // 18 = 0x12 means sha2-256
  // 32 is the digest length in bytes
  const mh = Buffer.concat([Buffer.from([18, 32]), Buffer.from(digest)]);
  const id = base64url.encode(mh);
  return {id};
}

/**
 * Retrieves a cache entry record (if it exists).
 *
 * @param {object} options - Options to use.
 * @param {string} [options.id] - The ID of the entry to retrieve.
 * @param {Buffer} [options.tokenizedId] - The already tokenized ID, if
 *   `id` has been externally tokenized.
 * @param {object} [options.tokenizer] - Optional tokenizer to use.
 * @param {boolean} [options.explain=false] - Set to true to return database
 *   query explain information instead of executing database queries.
 *
 * @returns {Promise<object | ExplainObject>} Resolves with the cache entry
 *   database record or an ExplainObject if `explain=true`.
 */
export async function get({id, tokenizedId, tokenizer, explain = false} = {}) {
  assert.optionalString(id, 'id');
  assert.optionalBuffer(tokenizedId, 'tokenizedId');
  assert.optionalObject(tokenizer, 'tokenizer');

  if(id !== undefined && tokenizedId !== undefined) {
    throw new Error('Only one of "id" and "tokenizedId" must be given.');
  }

  if(tokenizedId === undefined) {
    if(id === undefined) {
      throw new Error('Either "id" or "tokenizedId" are required.');
    }
    // tokenize ID
    ({tokenizedId, tokenizer} = await tokenizeId({id, tokenizer}));
  }

  // do not use in-memory cache when explaining database query
  if(explain) {
    return _getUncachedEntry({tokenizedId, explain});
  }

  const key = tokenizedId.toString('base64url');
  const fn = () => _getUncachedEntry({tokenizedId});
  // memoize but fetch promise directly to compare below whilst avoiding race
  // condition where the cache could be updated during `await`
  await ENTRY_CACHE.memoize({key, fn});
  const promise = ENTRY_CACHE.cache.peek(key);
  const record = await promise;

  // clear expired record from cache (if it hasn't already changed) and retry
  const now = new Date();
  if(record.entry.expires < now) {
    if(ENTRY_CACHE.cache.peek(key) === promise) {
      ENTRY_CACHE.delete(key);
    }
    return get({tokenizedId});
  }

  return record;
}

/**
 * Adds an entry to the cache, overwriting any existing entry.
 *
 * A `tokenizedId` will be generated by tokenizing the given `id` (unless
 * `tokenizedId` is passed directly). This `tokenizedId` will be the result of
 * an HMAC operation that should use key material that resides in an external
 * system. This approach ensures that a stolen database on its own will not
 * reveal the correlation between a particular `id` and `tokenizedId`.
 *
 * @param {object} options - Options to use.
 * @param {string} [options.id] - The ID of the entry to cache.
 * @param {Buffer} [options.tokenizedId] - The already tokenized ID, if
 *   `id` has been externally tokenized.
 * @param {object} [options.tokenizer] - Optional tokenizer to use.
 * @param {*} [options.value] - The value to cache.
 * @param {number} [options.ttl] - The number of milliseconds until the
 *   cache entry should expire.
 * @param {boolean} [options.explain=false] - Set to true to return database
 *   query explain information instead of executing database queries.
 *
 * @returns {Promise<object>} An object with the cache entry record.
 */
export async function upsert({
  id, tokenizedId, tokenizer, ttl, value, explain = false
} = {}) {
  assert.optionalString(id, 'id');
  assert.optionalBuffer(tokenizedId, 'tokenizedId');
  assert.optionalObject(tokenizer, 'tokenizer');
  assert.optionalNumber(ttl, 'ttl');

  if(id !== undefined && tokenizedId !== undefined) {
    throw new Error('Only one of "id" and "tokenizedId" must be given.');
  }

  if(tokenizedId === undefined) {
    if(tokenizedId === undefined) {
      if(id === undefined) {
        throw new Error('Either "id" or "tokenizedId" are required.');
      }
      // tokenize ID
      ({tokenizedId, tokenizer} = await tokenizeId({id, tokenizer}));
    }
  }

  const now = Date.now();
  const collection = database.collections[COLLECTION_NAME];
  const meta = {created: now, updated: now};
  const expires = new Date(now + ttl);
  const entry = {
    tokenizedId,
    expires,
    value
  };

  const query = {'entry.tokenizedId': entry.tokenizedId};
  // overwrite every field except `tokenizedId` on update
  const $set = {
    'entry.expires': entry.expires,
    'entry.value': value,
    'meta.created': meta.created,
    'meta.updated': meta.updated
  };
  // include tokenized ID on insert
  const $setOnInsert = {
    'entry.tokenizedId': entry.tokenizedId
  };
  const update = {$set, $setOnInsert};
  const record = {entry, meta};
  // FIXME: determine if `database.writeOptions` is still required
  const upsertOptions = {...database.writeOptions, upsert: true};

  if(explain) {
    // 'find().limit(1)' is used here because 'updateOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query).limit(1);
    return cursor.explain('executionStats');
  }

  // this upsert cannot trigger duplicate error; no try/catch needed
  await collection.updateOne(query, update, upsertOptions);

  // clear any in-memory cache entry
  const key = entry.tokenizedId.toString('base64url');
  ENTRY_CACHE.delete(key);

  return record;
}

/**
 * Tokenizes the given ID.
 *
 * @param {object} options - Options to use.
 * @param {string} options.id - The ID to tokenize.
 * @param {object} [options.tokenizer] - Optional tokenizer to use.
 *
 * @returns {Promise<object>} The tokenized ID as `tokenizedId`.
 */
export async function tokenizeId({id, tokenizer} = {}) {
  assert.string(id, 'id');
  assert.optionalObject(tokenizer, 'tokenizer');

  // 1. Get the current tokenizer and its HMAC API.
  if(!tokenizer) {
    tokenizer = await tokenizers.getCurrent();
  }
  const {hmac} = tokenizer;

  // 2. HMAC the `id` to help mitigate against the threat of a stolen database.
  // Once HMAC'd, dictionary attacks may be more difficult -- particularly if
  // the HMAC material is in an HSM.
  const tokenizedId = await _hmacString({hmac, value: id});
  return {tokenizedId, tokenizer};
}

// exposed for testing purposes only
function _createEntryCache({ttl} = {}) {
  const cfg = bedrock.config['tokenized-cache'];
  const options = {
    ...cfg.caches.entry
  };
  if(ttl !== undefined) {
    options.maxAge = ttl;
  }
  ENTRY_CACHE = new LruCache(options);
}

async function _getUncachedEntry({tokenizedId, explain = false} = {}) {
  const query = {'entry.tokenizedId': tokenizedId};
  const collection = database.collections[COLLECTION_NAME];
  const projection = {_id: 0};

  if(explain) {
    // 'find().limit(1)' is used here because 'findOne()' doesn't return a
    // cursor which allows the use of the explain function.
    const cursor = await collection.find(query, {projection}).limit(1);
    return cursor.explain('executionStats');
  }

  let record = await collection.findOne(query, {projection});
  if(record) {
    // explicitly check `expires` against current time to handle cases where
    // the database record just hasn't been expunged yet
    const now = new Date();
    if(now > record.entry.expires) {
      record = null;
    }
  }
  if(!record) {
    const details = {
      httpStatusCode: 404,
      public: true
    };
    throw new BedrockError(
      'Entry not found.',
      'NotFoundError', details);
  }
  return record;
}

// exported for testing purposes only
export async function _hmacString({hmac, value}) {
  const data = TEXT_ENCODER.encode(value);
  const signature = await hmac.sign({data});
  // multibase encode hash for future proofing
  // 18 = 0x12 means sha2-256
  // 32 is the digest length in bytes
  return Buffer.concat([Buffer.from([18, 32]), signature]);
}

/**
 * SHA-256 hashes a string. Exported for testing purposes only.
 *
 * @param {object} options - The options to use.
 * @param {string} options.string - The string to hash.
 *
 * @returns {Uint8Array} The hash digest.
 */
export async function _sha256({string}) {
  return new Uint8Array(crypto.createHash('sha256').update(string).digest());
}

/**
 * An object containing information on the query plan.
 *
 * @typedef {object} ExplainObject
 */
