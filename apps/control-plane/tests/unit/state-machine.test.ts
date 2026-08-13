import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStateMachine,
  InvalidTransitionError,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type StateMachine,
} from "../../src/state/state-machine.js";
import type { TaskStatus } from "../../src/task/types.js";

function machine(from: TaskStatus): StateMachine {
  return createStateMachine(from);
}

test("初始狀態為 CREATED，且非終態", () => {
  const sm = createStateMachine();
  assert.equal(sm.state, "CREATED");
  assert.ok(!sm.isTerminal());
});

test("§9 正常路徑：CREATED → … → COMPLETE", () => {
  const path: TaskStatus[] = [
    "CREATED",
    "ANALYZING",
    "POLICY_CHECK",
    "RESEARCH_REQUIRED",
    "RESEARCHING",
    "EVIDENCE_VALIDATION",
    "PLANNING",
    "WORKER_SELECTION",
    "IMPLEMENTING",
    "ARTIFACT_VALIDATION",
    "VERIFYING",
    "COMPLETE",
  ];
  let sm = machine("CREATED");
  for (const s of path.slice(1)) {
    sm = machine(sm.transition(s));
  }
  assert.equal(sm.state, "COMPLETE");
  assert.ok(sm.isTerminal());
});

test("EVIDENCE_VALIDATION 四分支皆可轉移（§9）", () => {
  assert.equal(machine("EVIDENCE_VALIDATION").transition("PLANNING"), "PLANNING"); // PASS
  assert.equal(machine("EVIDENCE_VALIDATION").transition("RESEARCHING"), "RESEARCHING"); // RESEARCH_AGAIN
  assert.equal(machine("EVIDENCE_VALIDATION").transition("ASK_USER"), "ASK_USER"); // BLOCK → ask_user
  assert.equal(machine("EVIDENCE_VALIDATION").transition("STOP"), "STOP"); // BLOCK → stop
  assert.equal(machine("EVIDENCE_VALIDATION").transition("PLANNING"), "PLANNING"); // DEGRADED → PLANNING
});

test("非法轉移拋 InvalidTransitionError（RESEARCHING 不可直接跳 IMPLEMENTING）", () => {
  const sm = machine("RESEARCHING");
  assert.throws(() => sm.transition("VERIFYING"), InvalidTransitionError);
  assert.throws(
    () => sm.transition("IMPLEMENTING"),
    (e: unknown) =>
      e instanceof InvalidTransitionError &&
      e.from === "RESEARCHING" &&
      e.to === "IMPLEMENTING",
  );
});

test("所有狀態皆可被 CANCELLED 中斷（非終態）", () => {
  const states = Object.keys(TRANSITIONS) as TaskStatus[];
  for (const s of states) {
    if (TERMINAL_STATUSES.has(s)) continue;
    assert.ok(
      TRANSITIONS[s]!.has("CANCELLED"),
      `expected ${s} to allow CANCELLED`,
    );
  }
});

test("model_limitation → STOP（Phase 1–5 硬限制，§24）", () => {
  const sm = machine("REFLECTION");
  assert.equal(sm.transition("STOP"), "STOP");
  assert.ok(sm.isTerminal());
});

test("終態不可再轉移", () => {
  for (const t of [...TERMINAL_STATUSES]) {
    const sm = machine(t);
    assert.ok(sm.isTerminal());
    assert.ok(!sm.canTransition("CREATED"));
    assert.throws(() => sm.transition("CREATED"), InvalidTransitionError);
  }
});

test("Reflection 動作分支（§22/§23）", () => {
  assert.equal(machine("REFLECTION").transition("IMPLEMENTING"), "IMPLEMENTING"); // coding_error → retry
  assert.equal(machine("REFLECTION").transition("RESEARCH_REQUIRED"), "RESEARCH_REQUIRED"); // knowledge_error → research
  assert.equal(machine("REFLECTION").transition("ASK_USER"), "ASK_USER"); // requirement_error
  assert.equal(machine("REFLECTION").transition("ARTIFACT_VALIDATION"), "ARTIFACT_VALIDATION"); // environment_error → repair
  assert.equal(machine("REFLECTION").transition("STOP"), "STOP"); // model_limitation
});

test("轉移紀錄含 from/to/時間戳（供 event log，§32）", () => {
  const sm = machine("CREATED");
  sm.transition("ANALYZING");
  sm.transition("POLICY_CHECK");
  assert.equal(sm.history.length, 2);
  assert.deepEqual(sm.history[0], { from: "CREATED", to: "ANALYZING", ts: sm.history[0]!.ts });
  assert.ok(!Number.isNaN(Date.parse(sm.history[1]!.ts)));
});

test("ASK_USER：批准 → PLANNING；拒絕 → STOP（§45.5 approve）", () => {
  const a = machine("ASK_USER");
  assert.equal(a.transition("PLANNING"), "PLANNING");
  const b = machine("ASK_USER");
  assert.equal(b.transition("STOP"), "STOP");
});