// KCode - E2E Test Harness
// Barrel exports for the test infrastructure module

export { FakeProvider } from "./fake-provider";

export {
  createFakeBash,
  createFakeEdit,
  createFakeGlob,
  createFakeGrep,
  createFakeRead,
  createFakeToolRegistry,
  createFakeWrite,
  type FakeBashOptions,
  type FakeReadOptions,
  type FakeToolRegistryOptions,
} from "./fake-tools";

export {
  collectEvents,
  collectText,
  createTestEnv,
  type TestEnv,
  type TestEnvOptions,
} from "./test-env";
