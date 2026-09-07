import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Sandbox, SandboxUser } from "@vercel/sandbox";
import { afterEach, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({ getOrCreate: vi.fn() }));
vi.mock("@vercel/sandbox", async (original) => ({
  ...(await original<typeof import("@vercel/sandbox")>()),
  Sandbox: sandboxApi,
}));

import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function localProvider(
  brokenGateway: boolean,
  dockerState: "ready" | "stale-pid" | "starting" = "ready",
) {
  const root = await mkdtemp(join(tmpdir(), "facility-vercel-bootstrap-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "run"));
  // Own the colliding PID, so even a regression that signals it cannot touch
  // an unrelated host process. /proc itself remains a deterministic fake.
  const colliding = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const dockerPid = colliding.pid;
  if (!dockerPid) throw new Error("missing fixture process PID");
  cleanups.push(async () => {
    colliding.kill();
  });
  await mkdir(join(root, "proc", String(dockerPid)), { recursive: true });
  if (dockerState !== "ready") {
    await writeFile(join(root, "run/docker.pid"), String(dockerPid));
    await writeFile(join(root, "run/docker.sock"), "existing socket");
    await mkdir(join(root, "run/docker/containerd"), { recursive: true });
    await writeFile(join(root, "run/docker/containerd/containerd.pid"), String(dockerPid));
    await writeFile(
      join(root, "proc", String(dockerPid), "comm"),
      dockerState === "starting" ? "dockerd\n" : "unrelated\n",
    );
  }
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_req, res) => res.end("preview app"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server missing port");
  // Reserve a separate local port for the provider's mapped gateway port.
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const reserved = reserve.address();
  if (!reserved || typeof reserved === "string") throw new Error("test gateway missing port");
  const gatewayPort = reserved.port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const scripts: Record<string, string> = {
    docker:
      dockerState === "ready"
        ? "exit 0"
        : dockerState === "stale-pid"
          ? `test -f '${root}/docker-ready'`
          : `if test -f '${root}/docker-waited'; then exit 0; fi; touch '${root}/docker-waited'; exit 1`,
    dockerd: `test ! -d '${root}/run/docker/containerd' || exit 8\ntest ! -f '${root}/run/docker.pid' || { echo 'stale daemon PID' >&2; exit 1; }\necho started > '${root}/docker-started'\ntouch '${root}/docker-ready'`,
    // Model the ownership boundary: recursively reassigning a persisted Docker
    // tree would corrupt container UIDs, even when daemon startup succeeds.
    chown: 'test "$1" != -R || { echo "recursive ownership reset" >&2; exit 1; }',
    chmod: "exit 0",
    // Model the provider's environment reset; the real SDK must inject env after this transition.
    sudo: 'test "$1" = -u; shift 3; exec /usr/bin/env -i PATH="$PATH" "$@"',
    runuser: 'test "$1" = --user; shift 4; exec "$@"',
    // Ignore host login profiles while executing the unchanged bootstrap in its temporary root.
    sh: 'if test "$1" = -lc; then shift; exec /bin/sh -c "$@"; fi; exec /bin/sh "$@"',
    "facility-preview-gateway": brokenGateway
      ? "exit 2"
      : `test -z "$UNRELATED_SECRET" || exit 7\nexec '${process.execPath}' '${fileURLToPath(new URL("../../../runner/facility-preview-gateway.mjs", import.meta.url))}' "$@"`,
  };
  for (const [name, script] of Object.entries(scripts))
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const fixture = {
    name: "ws_0123456789abcdef",
    status: "running",
    currentSnapshotId: "snapshot",
    currentSession: () => ({ sessionId: "compute" }),
    domain: () => `http://127.0.0.1:${gatewayPort}`,
    stop: vi.fn(async () => {
      fixture.status = "stopped";
    }),
    asUser: (username: string): SandboxUser =>
      new SandboxUser({ sandbox: fixture as unknown as Sandbox, username }),
    runCommand: async (params: {
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
      sudo?: boolean;
    }) => {
      const args = (params.args ?? []).map((arg) =>
        arg
          .replaceAll("/workspace", root)
          .replaceAll("/var/run", join(root, "run"))
          .replaceAll("/proc/", `${root}/proc/`)
          .replaceAll("65535", String(gatewayPort)),
      );
      return new Promise<{ exitCode: number; stderr: () => Promise<string> }>((resolve, reject) => {
        const child = spawn(params.cmd, args, {
          env: { PATH: `${bin}:${process.env.PATH}`, ...(params.sudo ? {} : params.env) },
        });
        let stderr = "";
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.stdout.resume();
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr: async () => stderr }));
      });
    },
  };
  cleanups.push(async () => {
    const pid = Number(
      await readFile(join(root, `.facility/preview-${gatewayPort}.pid`), "utf8").catch(() => ""),
    );
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
  });
  sandboxApi.getOrCreate.mockImplementation(async (options) => {
    await options.onCreate?.(fixture);
    return fixture;
  });
  return { fixture, gatewayPort, appPort: address.port, root, dockerPid, colliding };
}

it("starts the real authenticated gateway through the SDK user switch without exposing a bare app", async () => {
  const { gatewayPort, appPort, fixture } = await localProvider(false);
  const token = 'credential-with-$()-and-quote-"-characters';
  await new VercelWorkspaceRuntime().create({
    id: fixture.name,
    image: "runner:test",
    ports: [{ service: "web", port: appPort }],
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: token, UNRELATED_SECRET: "must-not-forward" },
  });
  const url = `http://127.0.0.1:${gatewayPort}/`;
  for (const value of [undefined, "malformed", "another-workspace-credential-0000000000"]) {
    expect(
      (await fetch(url, { headers: value ? { "x-facility-preview-token": value } : {} })).status,
    ).toBe(401);
  }
  const response = await fetch(url, { headers: { "x-facility-preview-token": token } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("preview app");
  expect(fixture.stop).not.toHaveBeenCalled();
});

it("fails initialization and stops newly allocated compute when the background gateway exits", async () => {
  const { appPort, fixture } = await localProvider(true);
  await expect(
    new VercelWorkspaceRuntime().create({
      id: fixture.name,
      image: "runner:test",
      ports: [{ service: "web", port: appPort }],
      environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
    }),
  ).rejects.toMatchObject({
    code: "workspace_initialize_failed",
    message: expect.stringContaining("did not start"),
  });
  expect(fixture.stop).toHaveBeenCalledOnce();
});

it("starts Docker after a restored PID collides with an unrelated process, preserving the volume tree", async () => {
  const { fixture, appPort, root, dockerPid, colliding } = await localProvider(false, "stale-pid");
  await mkdir(join(root, ".facility/docker/volumes/database"), { recursive: true });
  await writeFile(join(root, ".facility/docker/volumes/database/retained"), "seeded database");
  await new VercelWorkspaceRuntime().create({
    id: fixture.name,
    image: "runner:test",
    ports: [{ service: "web", port: appPort }],
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
  });
  expect(await readFile(join(root, "docker-started"), "utf8")).toBe("started\n");
  expect(await readFile(join(root, "proc", String(dockerPid), "comm"), "utf8")).toBe("unrelated\n");
  expect(colliding.exitCode).toBeNull();
  expect(colliding.signalCode).toBeNull();
  expect(await readFile(join(root, ".facility/docker/volumes/database/retained"), "utf8")).toBe(
    "seeded database",
  );
  expect(fixture.stop).not.toHaveBeenCalled();
});

it("waits for an existing Docker daemon without removing its PID or launching another", async () => {
  const { fixture, appPort, root, dockerPid } = await localProvider(false, "starting");
  await new VercelWorkspaceRuntime().create({
    id: fixture.name,
    image: "runner:test",
    ports: [{ service: "web", port: appPort }],
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
  });
  expect(await readFile(join(root, "run/docker.pid"), "utf8")).toBe(String(dockerPid));
  expect(await readFile(join(root, "run/docker.sock"), "utf8")).toBe("existing socket");
  expect(await readFile(join(root, "run/docker/containerd/containerd.pid"), "utf8")).toBe(
    String(dockerPid),
  );
  await expect(readFile(join(root, "docker-started"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(fixture.stop).not.toHaveBeenCalled();
});

it.each([
  "unrelated",
  "different-port",
  "malformed",
])("preserves a process referenced by a %s preview PID file", async (kind) => {
  const { fixture, appPort, root, gatewayPort, dockerPid, colliding } = await localProvider(false);
  await mkdir(join(root, ".facility"));
  await writeFile(
    join(root, `.facility/preview-${gatewayPort}.pid`),
    kind === "malformed" ? "-1" : String(dockerPid),
  );
  const args =
    kind === "different-port"
      ? [
          "node",
          "/usr/local/bin/facility-preview-gateway",
          "--listen",
          "1",
          "--target",
          String(appPort),
          "",
        ]
      : ["node", "/workspace/native-agent.js", ""];
  await writeFile(join(root, "proc", String(dockerPid), "cmdline"), args.join("\0"));
  await new VercelWorkspaceRuntime().create({
    id: fixture.name,
    image: "runner:test",
    ports: [{ service: "web", port: appPort }],
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
  });
  expect(colliding.exitCode).toBeNull();
  expect(colliding.signalCode).toBeNull();
});

it("replaces only the recorded gateway invocation for this port", async () => {
  const { fixture, appPort, root, gatewayPort, dockerPid, colliding } = await localProvider(false);
  await mkdir(join(root, ".facility"));
  await writeFile(join(root, `.facility/preview-${gatewayPort}.pid`), String(dockerPid));
  await writeFile(
    join(root, "proc", String(dockerPid), "cmdline"),
    [
      "node",
      "/usr/local/bin/facility-preview-gateway",
      "--listen",
      String(gatewayPort),
      "--target",
      String(appPort),
      "",
    ].join("\0"),
  );
  await new VercelWorkspaceRuntime().create({
    id: fixture.name,
    image: "runner:test",
    ports: [{ service: "web", port: appPort }],
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
  });
  expect(colliding.signalCode).toBe("SIGTERM");
});
