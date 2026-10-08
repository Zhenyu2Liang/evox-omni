import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';

/** A model and the provider collection that owns its streaming/authentication path. */
export interface ModelRuntime {
  model: Model<any>;
  streamFn: StreamFn;
}
