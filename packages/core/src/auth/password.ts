import argon2 from "argon2";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as en from "@zxcvbn-ts/language-en";
import { AppError } from "../errors.js";

// OWASP 2024 argon2id baseline: m=19 MiB, t=2, p=1.
const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, ARGON);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns the same CPU as a real check so unknown emails are not distinguishable by timing. */
export async function verifyDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("shopkit-dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}

let zxcvbn: ZxcvbnFactory | undefined;
function estimator(): ZxcvbnFactory {
  zxcvbn ??= new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs,
    translations: en.translations,
  });
  return zxcvbn;
}

export const MIN_PASSWORD_SCORE = 3;

/** zxcvbn score ≥ 3 (SPEC §5 step 1), penalising passwords built from the user's own details. */
export async function assertStrongPassword(password: string, userInputs: string[] = []): Promise<void> {
  if (password.length < 10) {
    throw new AppError("validation_failed", "Password must be at least 10 characters", { field: "password" });
  }
  if (password.length > 256) {
    throw new AppError("validation_failed", "Password must be at most 256 characters", { field: "password" });
  }
  const result = await estimator().checkAsync(password, userInputs.filter(Boolean));
  if (result.score < MIN_PASSWORD_SCORE) {
    const hint = result.feedback.warning || result.feedback.suggestions[0] || "Use a longer, less predictable password.";
    throw new AppError("validation_failed", `Password is too weak. ${hint}`, { field: "password", score: result.score });
  }
}
