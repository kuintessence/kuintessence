import { resolve } from "node:path";
import { createOfflineDeliveryFixture } from "../../packages/registry/src/services/offline-delivery.fixture";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: bun deploy/offline-delivery/create-fixture.ts <new-output-directory>");
await createOfflineDeliveryFixture(resolve(directory));
