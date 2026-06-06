import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli/app.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";

test("CLI init scaffolds a policy + runnable agent and refuses accidental overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const first = await runCli(["init"], { cwd: dir, ...output.io });
    const second = await runCli(["init"], { cwd: dir, ...output.io });

    assert.equal(first, 0);
    assert.equal(second, 1);
    assert.equal(existsSync(join(dir, "warden.yaml")), true);
    assert.equal(existsSync(join(dir, "agent.ts")), true);
    assert.match(readFileSync(join(dir, "warden.yaml"), "utf8"), /method: telegram/);
    assert.match(readFileSync(join(dir, "agent.ts"), "utf8"), /guardTools/);
    assert.match(output.stdout(), /Created .*agent\.ts/);
    assert.match(output.stderr(), /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI init --policy-only writes only warden.yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(["init", "--policy-only"], { cwd: dir, ...output.io });

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, "warden.yaml")), true);
    assert.equal(existsSync(join(dir, "agent.ts")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI init --force overwrites existing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    await runCli(["init"], { cwd: dir, ...output.io });
    const code = await runCli(["init", "--force"], { cwd: dir, ...output.io });

    assert.equal(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI init applies approval method and timeout overrides without touching comments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(
      ["init", "--policy-only", "--approval-method", "callback", "--approval-timeout", "30s"],
      { cwd: dir, ...output.io },
    );
    const policy = readFileSync(join(dir, "warden.yaml"), "utf8");

    assert.equal(code, 0);
    assert.match(policy, /^\s+method: callback$/m);
    assert.match(policy, /^\s+timeout: 30s$/m);
    // The option comment lines must survive the substitution.
    assert.match(policy, /#\s+method:\s+deny \| callback \| telegram/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI init rejects an invalid approval method", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    const code = await runCli(
      ["init", "--policy-only", "--approval-method", "local"],
      { cwd: dir, ...output.io },
    );

    assert.equal(code, 1);
    assert.match(output.stderr(), /--approval-method must be one of/);
    assert.equal(existsSync(join(dir, "warden.yaml")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI policy test emits JSON decisions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFileSync(
      join(dir, "call.json"),
      JSON.stringify({
        tool: "filesystem.write_file",
        description: "Write a file",
        arguments: { path: "src/config.ts", content: "x" },
      }),
    );

    const code = await runCli(
      ["policy", "test", "call.json", "--json"],
      { cwd: dir, ...output.io },
    );
    const result = JSON.parse(output.stdout()) as {
      decision: { decision: string };
      classification: { labels: string[] };
    };

    assert.equal(code, 0);
    assert.equal(result.decision.decision, "require_approval");
    assert.deepEqual(result.classification.labels, ["write", "file_mutation"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI policy test can write an audit event and audit tail can read it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const output = createOutput();

  try {
    writeFileSync(
      join(dir, "call.json"),
      JSON.stringify({
        tool: "slack.send_message",
        description: "Send a Slack message",
        arguments: { channel: "C123", text: "hello", token: "secret" },
      }),
    );

    const policyCode = await runCli(
      ["policy", "test", "call.json", "--audit"],
      { cwd: dir, ...output.io },
    );
    assert.equal(policyCode, 0);

    const tailOutput = createOutput();
    const tailCode = await runCli(
      ["audit", "tail", "--json"],
      { cwd: dir, ...tailOutput.io },
    );

    const events = JSON.parse(tailOutput.stdout()) as Array<{
      tool: string;
      requestArguments: { token: string };
      decision: string;
    }>;

    assert.equal(tailCode, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.tool, "slack.send_message");
    assert.equal(events[0]?.decision, "deny");
    assert.equal(events[0]?.requestArguments.token, "[REDACTED]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI help lists only the supported commands", async () => {
  const output = createOutput();
  const code = await runCli(["help"], { cwd: process.cwd(), ...output.io });

  assert.equal(code, 0);
  assert.match(output.stdout(), /warden init/);
  assert.match(output.stdout(), /warden policy test/);
  assert.match(output.stdout(), /warden audit tail/);
  assert.match(output.stdout(), /warden login/);
  assert.doesNotMatch(output.stdout(), /proxy|serve|inspect|doctor|exec/);
});

test("CLI login pairs a Telegram device and saves credentials with 0600 perms", async () => {
  const fake = await startFakeTelegram({ botUsername: "warden_test_bot" });
  const dir = mkdtempSync(join(tmpdir(), "warden-cli-"));
  const credPath = join(dir, "telegram.json");
  const output = createOutput();

  try {
    const loginPromise = runCli(
      ["login", "--token", "T", "--api-base-url", fake.url, "--credentials", credPath, "--timeout", "10"],
      { cwd: dir, ...output.io },
    );

    const code = await waitForMatch(output, /start=([0-9a-f]+)/);
    fake.enqueueUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        text: `/start ${code}`,
        chat: { id: 999, type: "private" },
        from: { id: 5 },
      },
    });

    const exit = await loginPromise;
    assert.equal(exit, 0);

    const creds = JSON.parse(readFileSync(credPath, "utf8")) as {
      token: string;
      chatId: number;
    };
    assert.equal(creds.token, "T");
    assert.equal(creds.chatId, 999);
    assert.equal(statSync(credPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await fake.close();
  }
});

async function waitForMatch(
  output: { stdout: () => string },
  pattern: RegExp,
): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const match = output.stdout().match(pattern);
    if (match?.[1]) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("pairing link was not printed");
}

function createOutput(): {
  io: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
  stdout: () => string;
  stderr: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}
