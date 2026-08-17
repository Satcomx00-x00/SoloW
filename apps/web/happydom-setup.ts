import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register a DOM (window/document) for React component tests under the Bun test runner.
// Harmless for non-DOM tests. Paired with ./test-setup.ts in bunfig.toml [test].
GlobalRegistrator.register();
