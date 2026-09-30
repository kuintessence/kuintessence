import { defineConfig } from "patchright/test";
import artifacts from "./material-artifacts.config";

export default defineConfig({
  ...artifacts,
  testMatch: "cp-spack-install.acceptance.ts",
  timeout: 1_200_000,
  outputDir: "../test-results/cp-spack-install",
});
