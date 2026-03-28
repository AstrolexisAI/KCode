// KCode - E2E Test Harness
// Barrel exports for the test infrastructure module

export { FakeProvider } from "./fake-provider";

export {
  createFakeRead,
  createFakeWrite,
  createFakeBash,
  createFakeEdit,
  createFakeGlob,
  createFakeGrep,
  createFakeToolRegistry,
  type FakeReadOptions,
  type FakeBashOptions,
  type FakeToolRegistryOptions,
} from "./fake-tools";

export {
  createTestEnv,
  collectEvents,
  collectText,
  type TestEnv,
  type TestEnvOptions,
} from "./test-env";
