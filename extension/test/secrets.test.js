import assert from "node:assert/strict";
import { test } from "node:test";
import { hideSecrets } from "../lib/secrets.js";

// Fake keys are joined at runtime so no key-shaped string exists in this file
// (GitHub push protection blocks those, even in tests).
const fake = (...parts) => parts.join("");

const JWT = fake("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
const AWS_KEY = fake("AKIA", "IOSFODNN7", "EXAMPLE");
const AWS_TEMP_KEY = fake("ASIA", "IOSFODNN7", "EXAMPLE");
const GITHUB_TOKEN = fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123456789");
const GITHUB_PAT = fake("github_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz");
const OPENAI_KEY = fake("sk-", "proj-", "abcdefghijklmnopqrstuvwxyz012345");
const STRIPE_KEY = fake("sk_", "live_", "abcdefghijklmnopqrstuvwx");
const STRIPE_TEST_KEY = fake("sk_", "test_", "abcdefghijklmnopqrstuvwx");
const SLACK_TOKEN = fake("xox", "b-", "123456789012-abcdefghijklmnop");
const GOOGLE_KEY = fake("AIza", "SyA1234567890abcdefghijklmnopqrstuv"); // AIza + 35 characters

test("returns an empty string for empty input", () => {
  assert.equal(hideSecrets(""), "");
  assert.equal(hideSecrets(null), "");
  assert.equal(hideSecrets(undefined), "");
});

test("leaves ordinary text alone", () => {
  const text = 'GET /api/cart?page=2&sort=price returned {"items": 3, "total": "12.50"}';
  assert.equal(hideSecrets(text), text);
});

test("masks JWTs", () => {
  const result = hideSecrets(`session=${JWT}; path=/`);
  assert.equal(result, "session=[HIDDEN_JWT_TOKEN]; path=/");
});

test("masks AWS access keys", () => {
  assert.equal(hideSecrets(`key ${AWS_KEY} and ${AWS_TEMP_KEY}`), "key [HIDDEN_AWS_KEY] and [HIDDEN_AWS_KEY]");
});

test("masks GitHub, OpenAI, Stripe, Slack, and Google keys", () => {
  for (const key of [GITHUB_TOKEN, GITHUB_PAT, OPENAI_KEY, STRIPE_KEY, STRIPE_TEST_KEY, SLACK_TOKEN, GOOGLE_KEY]) {
    const result = hideSecrets(`config: ${key}, done`);
    assert.equal(result, "config: [HIDDEN_API_KEY], done", `not masked: ${key.slice(0, 8)}…`);
  }
});

test("masks bearer tokens and keeps the scheme", () => {
  assert.equal(hideSecrets("Authorization: Bearer abc.DEF-123_xyz=="), "Authorization: Bearer [HIDDEN_TOKEN]");
  assert.equal(hideSecrets("authorization: bearer abcdef"), "authorization: bearer [HIDDEN_TOKEN]");
});

test("masks secrets in URL query strings", () => {
  assert.equal(
    hideSecrets("https://api.example.com/v1/items?page=2&api_key=abc123&sort=asc"),
    "https://api.example.com/v1/items?page=2&api_key=[HIDDEN]&sort=asc"
  );
  assert.equal(hideSecrets("/callback?token=abc123#section"), "/callback?token=[HIDDEN]#section");
  assert.equal(hideSecrets("/login?user=sam&password=hunter2"), "/login?user=sam&password=[HIDDEN]");
});

test("masks secrets in form bodies", () => {
  assert.equal(hideSecrets("password=hunter2&remember=1"), "password=[HIDDEN]&remember=1");
});

test("does not treat every parameter ending in a secret name as a secret", () => {
  assert.equal(hideSecrets("/search?monkey=1&sortkey=name"), "/search?monkey=1&sortkey=name");
});

test("masks secrets in JSON bodies", () => {
  assert.equal(
    hideSecrets('{"email":"sam@example.com","password":"hunter2","token" : "abc"}'),
    '{"email":"sam@example.com","password":"[HIDDEN]","token" : "[HIDDEN]"}'
  );
  assert.equal(hideSecrets('{"apiKey":"abc","API_KEY":"def"}'), '{"apiKey":"[HIDDEN]","API_KEY":"[HIDDEN]"}');
});

test("masks several secrets in one text", () => {
  const result = hideSecrets(`{"jwt":"${JWT}","note":"use ${STRIPE_KEY}"} Bearer abc123`);
  assert.equal(result, '{"jwt":"[HIDDEN_JWT_TOKEN]","note":"use [HIDDEN_API_KEY]"} Bearer [HIDDEN_TOKEN]');
});

test("converts non-string input to text", () => {
  assert.equal(hideSecrets(42), "42");
});
