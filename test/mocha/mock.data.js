/*!
 * Copyright (c) 2021-2024 Digital Bazaar, Inc. All rights reserved.
 */
export const mockData = {};

// mock product IDs and reverse lookup for webkms/edv/etc service products
mockData.productIdMap = new Map();

const products = [{
  // Use default webkms dev `id` and `serviceId`
  id: 'urn:uuid:80a82316-e8c2-11eb-9570-10bf48838a29',
  name: 'Example KMS',
  service: {
    // default dev `id` configured in `bedrock-kms-http`
    id: 'did:key:z6MkwZ7AXrDpuVi5duY2qvVSx1tBkGmVnmRjDvvwzoVnAzC4',
    type: 'webkms',
  }
}];

for(const product of products) {
  mockData.productIdMap.set(product.id, product);
  mockData.productIdMap.set(product.name, product);
}

const now = Date.now();
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);

export const mockEntryRecord1 = {
  meta: {
    created: now,
    updated: now
  },
  entry: {
    tokenizedId: Buffer.from('43f14128-3b42-11ec-8d3d-0242ac130003'),
    value: {},
    expires: tomorrow
  }
};

export const mockEntryRecord2 = {
  meta: {
    created: now,
    updated: now
  },
  registration: {
    tokenizedId: Buffer.from('448de567-5e19-4a54-8b0e-1d0e2128f13d'),
    value: {},
    expires: new Date(now + 3000)
  }
};
