import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../src/proxy";
import {
  authorizeDemoRequest,
  DEMO_ACCESS_PASSWORD_ENV,
  DEMO_ACCESS_USER_ENV,
} from "../src/lib/demo-access";

const demoUser = "restricted-demo";
const demoPassword = "local-smoke-password:with-colon";

const protectedPaths = [
  "/",
  "/api/ready",
  "/api/analyze",
  "/api/generate",
  "/api/jobs/job-does-not-exist",
  "/api/artifacts/job-does-not-exist/presentation.pptx",
  "/api/export",
  "/api/export/pdf",
  "/api/export/html",
];

function createAuthorization(user = demoUser, password = demoPassword) {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

function createRequest(path: string, authorization?: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: authorization ? { authorization } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("demo access credentials", () => {
  it("fails closed when either credential is missing or invalid", () => {
    const authorization = createAuthorization();

    expect(
      authorizeDemoRequest(authorization, {
        VK_HACKATHON_DEMO_AUTH_USER: "",
        VK_HACKATHON_DEMO_AUTH_PASSWORD: demoPassword,
      }),
    ).toBe("unconfigured");
    expect(
      authorizeDemoRequest(authorization, {
        VK_HACKATHON_DEMO_AUTH_USER: demoUser,
        VK_HACKATHON_DEMO_AUTH_PASSWORD: "",
      }),
    ).toBe("unconfigured");
    expect(
      authorizeDemoRequest(authorization, {
        VK_HACKATHON_DEMO_AUTH_USER: "invalid:user",
        VK_HACKATHON_DEMO_AUTH_PASSWORD: demoPassword,
      }),
    ).toBe("unconfigured");
  });

  it("accepts only the configured UTF-8 Basic credentials", () => {
    const credentials = {
      VK_HACKATHON_DEMO_AUTH_USER: "демо",
      VK_HACKATHON_DEMO_AUTH_PASSWORD: "пароль:с-разделителем",
    };
    const authorization = createAuthorization(
      credentials.VK_HACKATHON_DEMO_AUTH_USER,
      credentials.VK_HACKATHON_DEMO_AUTH_PASSWORD,
    );

    expect(authorizeDemoRequest(authorization, credentials)).toBe("authorized");
    expect(authorizeDemoRequest(createAuthorization(demoUser, "wrong"), credentials)).toBe("unauthorized");
    expect(authorizeDemoRequest("Bearer token", credentials)).toBe("unauthorized");
    expect(authorizeDemoRequest("Basic !!!", credentials)).toBe("unauthorized");
    expect(authorizeDemoRequest(null, credentials)).toBe("unauthorized");
  });

  it("keeps comparison scoped to the two deployment environment variables", () => {
    expect(DEMO_ACCESS_USER_ENV).toBe("VK_HACKATHON_DEMO_AUTH_USER");
    expect(DEMO_ACCESS_PASSWORD_ENV).toBe("VK_HACKATHON_DEMO_AUTH_PASSWORD");
  });
});

describe("Next.js demo access proxy", () => {
  it.each(protectedPaths)("challenges unauthenticated access to %s", (path) => {
    vi.stubEnv(DEMO_ACCESS_USER_ENV, demoUser);
    vi.stubEnv(DEMO_ACCESS_PASSWORD_ENV, demoPassword);

    const response = proxy(createRequest(path));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic realm=");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("passes valid credentials to the requested route", () => {
    vi.stubEnv(DEMO_ACCESS_USER_ENV, demoUser);
    vi.stubEnv(DEMO_ACCESS_PASSWORD_ENV, demoPassword);

    const response = proxy(createRequest("/api/export", createAuthorization(), "POST"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("returns an unavailable response instead of opening routes without configured credentials", () => {
    vi.stubEnv(DEMO_ACCESS_USER_ENV, "");
    vi.stubEnv(DEMO_ACCESS_PASSWORD_ENV, "");

    const response = proxy(createRequest("/api/artifacts/job-1/presentation.pptx"));

    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves only the safe liveness route public for the container healthcheck", () => {
    vi.stubEnv(DEMO_ACCESS_USER_ENV, "");
    vi.stubEnv(DEMO_ACCESS_PASSWORD_ENV, "");

    const response = proxy(createRequest("/api/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico).*)"]);
  });
});
