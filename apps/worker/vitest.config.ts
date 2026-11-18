import { shopkitVitest } from "@shopkit/config/vitest";

export default shopkitVitest({ fileParallelism: false, globalSetup: ["./test/global-setup.ts"] });
