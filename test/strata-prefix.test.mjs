import test from "node:test";
import assert from "node:assert/strict";
import {
  STRATA_PREFIX_ENV,
  STRATA_PROVIDER_ENV,
  StrataPrefixController,
} from "../strata-prefix.ts";

const model = {
  provider: "strata-local",
  api: "openai-completions",
  id: "qwen",
  baseUrl: "http://127.0.0.1:8080/v1",
};
const env = { [STRATA_PROVIDER_ENV]: model.provider };
const rootRunId = "test-root";

function request() {
  return {
    model: model.id,
    messages: [
      { role: "system", content: "Identical system prompt." },
      { role: "user", content: "Inherited history.".repeat(1_000) },
    ],
    tools: [{ type: "function", function: { name: "subagent", parameters: { type: "object" } } }],
    reasoning_effort: "high",
  };
}

function extended(payload, text = "Child task.") {
  const result = structuredClone(payload);
  result.messages.push(
    { role: "assistant", content: "Delegating." },
    { role: "user", content: text },
  );
  return result;
}

function rootBoundary() {
  const root = new StrataPrefixController(rootRunId, false, env);
  const payload = request();
  assert.equal(root.beforeRequest(payload, model), undefined);
  return { root, payload, boundary: root.prepareChild(model) };
}

function childController(boundary, options = {}) {
  return new StrataPrefixController(rootRunId, true, {
    ...env,
    [STRATA_PREFIX_ENV]: JSON.stringify(boundary),
    ...options,
  });
}

test("pinning is disabled by default and never leaks to another provider", () => {
  const payload = request();
  const disabled = new StrataPrefixController(rootRunId, false, {});
  assert.equal(disabled.beforeRequest(payload, model), undefined);
  assert.equal(disabled.prepareChild(model), undefined);
  const enabled = new StrataPrefixController(rootRunId, false, env);
  const cloud = { ...model, provider: "openai" };
  assert.equal(enabled.beforeRequest(payload, cloud), undefined);
  assert.equal(enabled.prepareChild(cloud), undefined);
  assert.equal(payload.strata_prefix, undefined);
});

test("children and nested workers keep the serialized outer-parent boundary after long child work", () => {
  const { root, payload, boundary } = rootBoundary();
  const child = childController(boundary);
  const childPayload = extended(payload);
  const original = structuredClone(childPayload);
  assert.deepEqual(child.beforeRequest(childPayload, model), {
    ...childPayload,
    strata_prefix: { messages: payload.messages.length },
  });
  assert.deepEqual(childPayload, original);
  for (let turn = 0; turn < 60; turn++) {
    childPayload.messages.push(
      { role: "assistant", content: "computed token ".repeat(1_000) },
      { role: "tool", content: "Tool output.", tool_call_id: `tool-${turn}` },
    );
    assert.deepEqual(child.beforeRequest(childPayload, model).strata_prefix, { messages: 2 });
  }
  const nestedBoundary = child.prepareChild(model);
  assert.deepEqual(nestedBoundary, boundary);
  const worker = childController(nestedBoundary);
  assert.deepEqual(worker.beforeRequest(extended(childPayload), model).strata_prefix, { messages: 2 });
  assert.deepEqual(worker.prepareChild(model), boundary);
  const returned = extended(payload, "Compact receipt.");
  assert.deepEqual(root.beforeRequest(returned, model).strata_prefix, { messages: 2 });
  assert.equal(root.beforeRequest(extended(returned), model), undefined);
});

test("a manager can delegate multiple sequential workers without moving the outer pin", () => {
  const { payload, boundary } = rootBoundary();
  const manager = childController(boundary);
  let managerBody = extended(payload, "Manager task.");
  for (let sequence = 0; sequence < 5; sequence++) {
    assert.deepEqual(manager.beforeRequest(managerBody, model).strata_prefix, { messages: 2 });
    const workerBoundary = manager.prepareChild(model);
    assert.deepEqual(workerBoundary, boundary);
    const workerBody = extended(managerBody, `Worker ${sequence} task.`);
    const worker = childController(workerBoundary);
    assert.deepEqual(worker.beforeRequest(workerBody, model).strata_prefix, { messages: 2 });
    managerBody = extended(managerBody, `Worker ${sequence} report.`);
    assert.deepEqual(manager.beforeRequest(managerBody, model).strata_prefix, { messages: 2 });
  }
  assert.ok(managerBody.messages.length > boundary.messages);
});

test("the next root delegation selects a newer boundary, not the old pin", () => {
  const { root, payload } = rootBoundary();
  const returned = extended(payload);
  assert.deepEqual(root.beforeRequest(returned, model).strata_prefix, { messages: 2 });
  const next = root.prepareChild(model);
  assert.equal(next.messages, returned.messages.length);
  assert.deepEqual(childController(next).beforeRequest(extended(returned), model).strata_prefix, { messages: 4 });
});

test("session reset discards stale root candidates and pending resumes", () => {
  const { root, payload } = rootBoundary();
  root.reset();
  assert.throws(() => root.prepareChild(model), /session changed/);
  assert.equal(root.beforeRequest(extended(payload), model), undefined);
  assert.equal(root.prepareChild(model).messages, 4);
});

test("root ignores stale inherited state and replaces a changed parent prefix after return", () => {
  const root = new StrataPrefixController(rootRunId, false, { ...env, [STRATA_PREFIX_ENV]: "bad JSON" });
  const payload = request();
  root.beforeRequest(payload, model);
  root.prepareChild(model);
  const changed = extended(payload);
  changed.messages[0].content = "Compacted/new session prompt.";
  assert.equal(root.beforeRequest(changed, model), undefined);
  assert.equal(root.prepareChild(model).messages, changed.messages.length);
});

test("missing, malformed, and cross-run child state fail closed", () => {
  const { payload, boundary } = rootBoundary();
  for (const raw of [
    "",
    "not JSON",
    "null",
    JSON.stringify({ ...boundary, rootRunId: "another-root" }),
    JSON.stringify({ ...boundary, provider: "openai" }),
    JSON.stringify({ ...boundary, messages: 0 }),
    JSON.stringify({ ...boundary, messages: 2.5 }),
    JSON.stringify({ ...boundary, sha256: "not-a-hash" }),
    "x".repeat(16_385),
  ]) {
    const child = childController(boundary, { [STRATA_PREFIX_ENV]: raw });
    assert.throws(() => child.beforeRequest(extended(payload), model), /Strata|JSON/);
    assert.throws(() => child.prepareChild(model), /Strata|JSON/);
  }
});

test("inherited prefix validation covers history, tools, thinking, model, and endpoint", () => {
  const { payload, boundary } = rootBoundary();
  for (const mutate of [
    (body) => { body.messages[0].content = "Changed system."; },
    (body) => { body.messages[1].content = "Changed history."; },
    (body) => { body.tools = []; },
    (body) => { body.reasoning_effort = "low"; },
    (body) => { body.chat_template_kwargs = { enable_thinking: false }; },
    (body) => { body.model = "different-wire-model"; },
  ]) {
    const changed = extended(payload);
    mutate(changed);
    assert.throws(() => childController(boundary).beforeRequest(changed, model), /prefix.*changed/);
  }
  for (const changedModel of [
    { ...model, id: "another-model" },
    { ...model, baseUrl: "http://127.0.0.1:9000/v1" },
    { ...model, provider: "openai" },
    { ...model, api: "openai-responses" },
  ]) {
    assert.throws(() => childController(boundary).beforeRequest(extended(payload), changedModel), /Strata/);
  }
  assert.throws(() => childController(boundary).beforeRequest(payload, model), /prefix.*changed/);
});

test("unsupported requests leave main inference alone but prevent an unpinned Strata child", () => {
  for (const payload of [
    null,
    [],
    { input: "Responses payload" },
    { messages: [] },
    { messages: ["not a message"] },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "image" } }] }] },
    { ...request(), strata_checkpoint: false },
    { ...request(), strata_prefix: { tokens: 100 } },
  ]) {
    const root = new StrataPrefixController(rootRunId, false, env);
    assert.equal(root.beforeRequest(payload, model), undefined);
    assert.throws(() => root.prepareChild(model), /Cannot pin/);
  }
  const root = new StrataPrefixController(rootRunId, false, env);
  const responsesModel = { ...model, api: "openai-responses" };
  assert.equal(root.beforeRequest(request(), responsesModel), undefined);
  assert.throws(() => root.prepareChild(responsesModel), /openai-completions/);
});

test("image and checkpoint-disabled child requests abort instead of silently losing protection", () => {
  const { payload, boundary } = rootBoundary();
  const image = extended(payload);
  image.messages.at(-1).content = [{ type: "image_url", image_url: { url: "image" } }];
  assert.throws(() => childController(boundary).beforeRequest(image, model), /text-only/);
  assert.throws(
    () => childController(boundary).beforeRequest({ ...extended(payload), strata_checkpoint: false }, model),
    /strata_checkpoint=false/,
  );
});

test("existing pin selectors cannot be silently overwritten", () => {
  const { payload, boundary } = rootBoundary();
  const body = extended(payload);
  const child = childController(boundary);
  assert.deepEqual(
    child.beforeRequest({ ...body, strata_prefix: { messages: 2 } }, model).strata_prefix,
    { messages: 2 },
  );
  assert.throws(
    () => child.beforeRequest({ ...body, strata_prefix: { messages: 3 } }, model),
    /conflicts/,
  );
});

test("host metadata contains only bounded identifiers, counts, and a hash, not the prompt", () => {
  const { boundary } = rootBoundary();
  const encoded = JSON.stringify(boundary);
  assert.ok(encoded.length < 1_024);
  assert.doesNotMatch(encoded, /Inherited history|Identical system/);
});

test("diagnostic records distinguish selection from requests without claiming engine acknowledgement", () => {
  const records = [];
  const root = new StrataPrefixController(rootRunId, false, env, (event, detail) => records.push({ event, ...detail }));
  const body = request();
  root.beforeRequest(body, model);
  root.prepareChild(model);
  root.beforeRequest(extended(body), model);
  assert.deepEqual(records, [
    { event: "boundary_selected", messages: 2, inherited: false },
    { event: "pin_requested", messages: 2, inherited: false },
  ]);
});
