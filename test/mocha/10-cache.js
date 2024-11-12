/*!
 * Copyright (c) 2020-2024 Digital Bazaar, Inc. All rights reserved.
 */
import {cleanDB, insertRecord} from './helpers.js';
import {mockEntryRecord1, mockEntryRecord2} from './mock.data.js';
import {cache} from '@bedrock/tokenized-cache';
import crypto from 'node:crypto';
import {tokenizers} from '@bedrock/tokenizer';

describe('Cache', function() {
  describe('cache.upsert()', () => {
    it('should insert and get a cache entry', async () => {
      const id = crypto.randomUUID();
      const record1 = await cache.upsert({
        id,
        value: {},
        ttl: 30000
      });
      const record2 = await cache.get({id});
      record1.should.eql(record2);
    });

    it('should replace an existing cache entry', async () => {
      const id = crypto.randomUUID();
      const record1 = await cache.upsert({
        id,
        value: {},
        ttl: 30000
      });
      // first fetch should hit database, second in-memory cache
      const record1a = await cache.get({id});
      record1.should.eql(record1a);
      const record1b = await cache.get({id});
      record1a.should.eql(record1b);

      const record2 = await cache.upsert({
        id,
        value: {},
        ttl: 40000
      });
      // first fetch should hit database, second in-memory cache
      const record2a = await cache.get({id});
      const record2b = await cache.get({id});
      record1.should.not.eql(record2);
      record2.should.eql(record2a);
      record2b.should.eql(record2a);
    });

    it('should error when no "id" is passed', async () => {
      let err;
      try {
        await cache.upsert();
      } catch(e) {
        err = e;
      }
      err.message.should.include('Either "id" or "tokenizedId"');
    });
  });

  describe('cache.get()', () => {
    it('should error when no "id" is passed', async () => {
      let err;
      try {
        await cache.get();
      } catch(e) {
        err = e;
      }
      err.message.should.include('Either "id" or "tokenizedId"');
    });
  });

  describe('cache._hmacString()', () => {
    let hmac;
    before(async () => {
      ({hmac} = await tokenizers.getCurrent());
    });

    it('should produce a 34 byte Buffer give a small value', async () => {
      let result;
      let error;
      const value = '670dbcb1-164a-4d47-8d54-e3e89f5831f9';
      try {
        result = await cache._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);
      result.should.be.instanceOf(Buffer);
      result.should.have.length(34);
    });

    it('should produce a 34 byte Buffer given a large value', async () => {
      let result;
      let error;
      const value = crypto.randomBytes(4096).toString('hex');
      try {
        result = await cache._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);
      result.should.be.instanceOf(Buffer);
      result.should.have.length(34);
    });

    it('should produce the same output given the same value', async () => {
      let result1;
      let error;
      const value = '294c9caa-707a-4758-ae5c-fe7306c25cc2';
      try {
        result1 = await cache._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      let result2;
      error = undefined;
      try {
        result2 = await cache._hmacString({hmac, value});
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      result1.should.eql(result2);
    });

    it('should produce different output given different values', async () => {
      let result1;
      let error;
      try {
        result1 = await cache._hmacString({
          hmac,
          value: '294c9caa-707a-4758-ae5c-fe7306c25cc2'
        });
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      let result2;
      error = undefined;
      try {
        result2 = await cache._hmacString({
          hmac,
          value: '0e26c923-84e6-4918-9337-f82c56951007'
        });
      } catch(e) {
        error = e;
      }
      assertNoError(error);

      result1.should.not.eql(result2);
    });
  });
});

describe('Cache Entry Database Tests', function() {
  describe('Indexes', function() {
    beforeEach(async () => {
      const collectionName = 'tokenized-cache-entry';
      await cleanDB({collectionName});

      await insertRecord({record: mockEntryRecord1, collectionName});
      // second record is inserted here in order to do proper assertions for
      // 'nReturned', 'totalKeysExamined' and 'totalDocsExamined'.
      await insertRecord({record: mockEntryRecord2, collectionName});
    });
    it('is properly indexed for query of ' +
      `'entry.tokenizedId' in get()`, async function() {
      const {tokenizedId} = mockEntryRecord1.entry;
      const {executionStats} = await cache.get({tokenizedId, explain: true});
      executionStats.nReturned.should.equal(1);
      executionStats.totalKeysExamined.should.equal(1);
      executionStats.totalDocsExamined.should.equal(1);
      executionStats.executionStages.inputStage.inputStage.inputStage.stage
        .should.equal('IXSCAN');
      executionStats.executionStages.inputStage.inputStage.inputStage
        .keyPattern.should.eql({'entry.tokenizedId': 1});
    });
  });
});
