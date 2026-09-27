import { timingSafeEqual } from "node:crypto";

export const DEMO_ACCESS_USER_ENV = "VK_HACKATHON_DEMO_AUTH_USER" as const;
export const DEMO_ACCESS_PASSWORD_ENV = "VK_HACKATHON_DEMO_AUTH_PASSWORD" as const;

export type DemoAccessResult = "authorized" | "unauthorized" | "unconfigured";

type DemoAccessEnvironment = Readonly<Record<string, string | undefined>>;

export function authorizeDemoRequest(
  authorization: string | null,
  env: DemoAccessEnvironment = process.env,
): DemoAccessResult {
  const expectedUser = env[DEMO_ACCESS_USER_ENV];
  const expectedPassword = env[DEMO_ACCESS_PASSWORD_ENV];

  if (
    !expectedUser ||
    !expectedPassword ||
    expectedUser.includes(":") ||
    hasControlCharacters(expectedUser) ||
    hasControlCharacters(expectedPassword)
  ) {
    return "unconfigured";
  }

  const credentials = decodeBasicCredentials(authorization);
  if (!credentials) return "unauthorized";

  const userMatches = constantTimeEqual(credentials.user, expectedUser);
  const passwordMatches = constantTimeEqual(credentials.password, expectedPassword);
  return userMatches && passwordMatches ? "authorized" : "unauthorized";
}

function decodeBasicCredentials(authorization: string | null) {
  if (!authorization) return null;

  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization.trim());
  if (!match) return null;

  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) return null;

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;

  return {
    user: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function constantTimeEqual(candidate: string, expected: string) {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  const comparisonLength = Math.max(candidateBytes.length, expectedBytes.length, 1);
  const paddedCandidate = Buffer.alloc(comparisonLength);
  const paddedExpected = Buffer.alloc(comparisonLength);
  candidateBytes.copy(paddedCandidate);
  expectedBytes.copy(paddedExpected);

  const bytesMatch = timingSafeEqual(paddedCandidate, paddedExpected);
  return bytesMatch && candidateBytes.length === expectedBytes.length;
}

function hasControlCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value);
}
