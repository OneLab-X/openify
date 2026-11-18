import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { smtp } from "../src/email/smtp.js";
import { ctx } from "./helpers.js";

let mailpit: StartedTestContainer;
beforeAll(async () => {
  mailpit = await new GenericContainer("axllent/mailpit:v1.27")
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/livez", 8025))
    .start();
});
afterAll(async () => {
  await mailpit?.stop();
});

const make = (port?: number) =>
  smtp.create(ctx({
    host: mailpit.getHost(), port: port ?? mailpit.getMappedPort(1025), secure: false,
    fromEmail: "shop@example.com", fromName: 'My "Shop"', replyTo: "help@example.com",
  }, {}, "live"));

describe("smtp", () => {
  it("verifies the connection and sends", async () => {
    const p = make();
    expect(await p.testCredentials()).toEqual({ ok: true });
    const { id } = await p.send({ to: "buyer@example.com", subject: "Hi", html: "<b>Hi</b>", text: "Hi", idempotencyKey: "k1" });
    expect(id).toBeTruthy();
    const api = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/messages`;
    const list = (await (await fetch(api)).json()) as { messages: { Subject: string; From: { Name: string; Address: string }; ReplyTo: { Address: string }[] }[] };
    expect(list.messages[0]).toMatchObject({ Subject: "Hi", From: { Name: "My Shop", Address: "shop@example.com" } });
    expect(list.messages[0]!.ReplyTo[0]!.Address).toBe("help@example.com");
  });

  it("reports connection failures", async () => {
    const res = await make(1).testCredentials();
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/^SMTP:/) });
  });
});
