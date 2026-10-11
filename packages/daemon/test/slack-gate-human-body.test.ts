// #1013 — a workflow gate row routed to a person posts the AGENT PACKET to Slack:
// the `### Workflow gate/entry` heading, instance/step lines, objective and the
// `Continuation:` block are written for the seat that resumes the workflow after
// sign-off, while the person needs only the headline (gate.summary) and the
// ask/evidence. The outbound projection must carry the human-facing body; the row
// itself stays byte-identical for the seat. Both legitimate gate targets are
// pinned: a human seat session (kind "human", parked blocked_on the seat) and a
// declared role such as human@external (the role branch, routed to its target).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { writeProjection, type HumanFragment } from "../src/domain/gateway/human-registry.js";

// SettingsStore captures its default path at import time. Keep real setting
// resolution, but bind each caller to this test's registry/config directory.
vi.mock("../src/domain/user-settings/settings-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/domain/user-settings/settings-store.js")>();
  return { ...actual, SettingsStore: class extends actual.SettingsStore {
    constructor(configPath?: string) { super(configPath ?? join(process.env["OPENRIG_HOME"]!, "config.json")); }
  } };
});

const entities: HumanFragment[] = [{
  entityId: "human",
  class: "human",
  displayName: "External Human",
  address: "human@external",
  connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "fixture", role: "primary" }],
  prefs: { deliveryClass: "A" },
}];
const registry = () => ({ ok: true, entities } as const);

// Gated ENTRY steps keep the fixture one instantiate() per gate kind: the entry
// twin of the projector's mid-flow gate write path (same compile, same tags).
const HUMAN_SEAT_SPEC = `workflow:
  id: gate-human-seat
  version: 1
  roles:
    producer:
      preferred_targets: [producer@rig]
  steps:
    - id: plan_signoff
      actor_role: producer
      gate:
        target: human@kernel
        summary: "Sign off the mission plan"
        evidence_ref: proof/plan.md
`;

// human@external is NOT a human seat session (the exact pattern admits only
// @kernel/@host), so this compiles through the declared-role branch: the packet
// routes to the role's preferred target — here the registered human address.
const EXTERNAL_ROLE_SPEC = `workflow:
  id: gate-external-role
  version: 1
  roles:
    producer:
      preferred_targets: [producer@rig]
    "human@external":
      preferred_targets: [human@external]
  steps:
    - id: plan_signoff
      actor_role: producer
      gate:
        target: human@external
        summary: "Sign off the mission plan"
        evidence_ref: proof/plan.md
`;

describe("#1013 — a gate row posted to a person carries the ask, not the agent packet", () => {
  let dir: string;
  let db: ReturnType<typeof createDb>;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-gate-human-body-"));
    vi.stubEnv("OPENRIG_HOME", dir);
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "");
    expect(writeProjection()).toMatchObject({ ok: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: registry });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
  });

  afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  const instantiate = async (name: string, spec: string) => {
    const specPath = join(dir, name);
    writeFileSync(specPath, spec);
    return runtime.instantiate({ specPath, rootObjective: "private fixture", createdBySession: "ops@rig" });
  };

  const assertHumanFacingAlert = async (name: string, spec: string, workflowId: string, gateLine: string) => {
    const inst = await instantiate(name, spec);
    const row = queueRepo.getById(inst.entryQitemId)!;
    expect(row.tags).toContain("gate");

    // SEAT-FACING GOLDEN: the packet stays on the row byte-for-byte — the seat
    // that picks the work up after sign-off reads exactly these lines.
    const seatGolden = row.body!;
    expect(seatGolden).toContain(`### Workflow entry: ${workflowId}@1 step plan_signoff`);
    expect(seatGolden).toContain(`Workflow instance: ${inst.instance.instanceId}`);
    expect(seatGolden).toContain(gateLine);
    expect(seatGolden).toContain("Ask: Sign off the mission plan");
    expect(seatGolden).toContain("Continuation: rig workflow project --instance");

    const ports = makeQueuePorts(queueRepo, { loadHumanRegistry: registry });
    const alerts = await ports.listHumanAlerts({});
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    // The headline (gate.summary) and evidence ride their structured fields.
    expect(alert.summary).toBe("Sign off the mission plan");
    expect(alert.evidenceRef).toBe("proof/plan.md");
    // HUMAN-FACING BODY: the ask and the evidence — never the seat's packet.
    expect(alert.body).toContain("Ask: Sign off the mission plan");
    expect(alert.body).toContain("Evidence: proof/plan.md");
    expect(alert.body).not.toContain("### Workflow");
    expect(alert.body).not.toContain(`Workflow instance: ${inst.instance.instanceId}`);
    expect(alert.body).not.toContain("Root objective");
    expect(alert.body).not.toContain("Continuation: rig workflow project");
    // The row body is untouched by the projection.
    expect(queueRepo.getById(inst.entryQitemId)!.body).toBe(seatGolden);
  };

  it("a human-seat gate (kind human, parked on the seat) renders the person the ask, not the packet", async () => {
    await assertHumanFacingAlert("human-seat.yaml", HUMAN_SEAT_SPEC, "gate-human-seat",
      "Gate: human sign-off — the workflow is PARKED (waiting)");
    const rows = queueRepo.db.prepare(`SELECT qitem_id, state, blocked_on FROM queue_items WHERE tags LIKE '%"gate"%'`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "blocked", blocked_on: "human@kernel" });
  });

  it("a human@external role gate (declared-role branch) renders the person the ask, not the packet", async () => {
    await assertHumanFacingAlert("external-role.yaml", EXTERNAL_ROLE_SPEC, "gate-external-role",
      "Gate: handler-role check — the workflow is PARKED (waiting)");
  });
});
