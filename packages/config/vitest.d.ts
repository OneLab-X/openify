import type { UserConfig } from "vitest/config";
type TestOptions = NonNullable<UserConfig["test"]>;
export declare function shopkitVitest(overrides?: TestOptions): UserConfig;
