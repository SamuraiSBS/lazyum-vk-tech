import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOCKBOX_SECRET_ID_ENV = "VK_HACKATHON_LOCKBOX_SECRET_ID";
const DEMO_USER_ENV = "VK_HACKATHON_DEMO_AUTH_USER";
const DEMO_PASSWORD_ENV = "VK_HACKATHON_DEMO_AUTH_PASSWORD";
const METADATA_TOKEN_URL =
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const LOCKBOX_PAYLOAD_URL = "https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets";
const NEXT_CLI_PATH = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const METADATA_TIMEOUT_MS = 5_000;
const LOCKBOX_TIMEOUT_MS = 15_000;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;

async function getJson(url, options, timeoutMs) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("request_failed");
  }

  if (!response.ok) throw new Error("request_rejected");

  try {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_JSON_RESPONSE_BYTES) {
      throw new Error("response_too_large");
    }
    return JSON.parse(body);
  } catch {
    throw new Error("invalid_json");
  }
}

function readSecretId() {
  const secretId = process.env[LOCKBOX_SECRET_ID_ENV];
  if (!secretId || !/^[A-Za-z0-9_-]{1,50}$/.test(secretId)) {
    throw new Error("secret_id_missing_or_invalid");
  }
  return secretId;
}

async function getVmIamToken() {
  const tokenResponse = await getJson(
    METADATA_TOKEN_URL,
    {
      headers: {
        Accept: "application/json",
        "Metadata-Flavor": "Google",
      },
      redirect: "error",
    },
    METADATA_TIMEOUT_MS,
  );

  if (typeof tokenResponse?.access_token !== "string" || !tokenResponse.access_token) {
    throw new Error("iam_token_missing");
  }
  return tokenResponse.access_token;
}

async function getDemoCredentials(secretId, iamToken) {
  const payloadUrl = `${LOCKBOX_PAYLOAD_URL}/${encodeURIComponent(secretId)}/payload`;
  const payload = await getJson(
    payloadUrl,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${iamToken}`,
      },
      redirect: "error",
    },
    LOCKBOX_TIMEOUT_MS,
  );

  if (!Array.isArray(payload?.entries) || payload.entries.length > 32) {
    throw new Error("lockbox_payload_invalid");
  }

  const values = new Map();
  for (const entry of payload.entries) {
    if (entry?.key !== DEMO_USER_ENV && entry?.key !== DEMO_PASSWORD_ENV) continue;
    if (
      values.has(entry.key) ||
      typeof entry.textValue !== "string" ||
      Object.hasOwn(entry, "binaryValue")
    ) {
      throw new Error("lockbox_credentials_invalid");
    }
    values.set(entry.key, entry.textValue);
  }

  const user = values.get(DEMO_USER_ENV);
  const password = values.get(DEMO_PASSWORD_ENV);
  if (
    typeof user !== "string" ||
    user.length === 0 ||
    user.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(user) ||
    typeof password !== "string" ||
    password.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(password)
  ) {
    throw new Error("lockbox_credentials_invalid");
  }

  return { user, password };
}

async function loadDemoCredentials(setPhase) {
  setPhase("configuration");
  const secretId = readSecretId();
  setPhase("vm_identity");
  let iamToken = await getVmIamToken();
  try {
    setPhase("lockbox_payload");
    return await getDemoCredentials(secretId, iamToken);
  } finally {
    iamToken = "";
  }
}

function startNext(credentials) {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      [DEMO_USER_ENV]: credentials.user,
      [DEMO_PASSWORD_ENV]: credentials.password,
    };
    let child;
    try {
      child = spawn(process.execPath, [NEXT_CLI_PATH, "start", "-p", "3030"], {
        cwd: process.cwd(),
        env: childEnv,
        stdio: "inherit",
      });
    } finally {
      delete childEnv[DEMO_USER_ENV];
      delete childEnv[DEMO_PASSWORD_ENV];
      credentials.user = "";
      credentials.password = "";
    }

    const forwardSignal = (signal) => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    const removeSignalHandlers = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    child.once("error", () => {
      removeSignalHandlers();
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      removeSignalHandlers();
      if (signal === "SIGINT") return resolve(130);
      if (signal === "SIGTERM") return resolve(143);
      resolve(code ?? 1);
    });
  });
}

async function main() {
  let phase = "configuration";
  try {
    const credentials = await loadDemoCredentials((nextPhase) => {
      phase = nextPhase;
    });
    phase = "next_start";
    process.exitCode = await startNext(credentials);
  } catch {
    console.error(`[lockbox-bootstrap] Startup failed during ${phase}; application was not started.`);
    process.exitCode = 1;
  }
}

await main();
