/*!
 * Copyright (c) 2020-2024 Digital Bazaar, Inc. All rights reserved.
 */
import * as database from '@bedrock/mongodb';

export async function cleanDB({collectionName}) {
  await database.collections[collectionName].deleteMany({});
}

export async function insertRecord({record, collectionName}) {
  const collection = database.collections[collectionName];
  await collection.insertOne(record);
}
