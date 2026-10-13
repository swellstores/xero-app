import { vi } from "vitest";

type Row = Record<string, any>;

// Ids stay unique across the stores of one test, which hand records on to each other
let sequence = 0;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) {
    return true;
  }
  return Object.entries(where).every(([field, expected]) => {
    if (field === "$or") {
      return (expected as Row[]).some((branch) => matches(row, branch));
    }
    if (field === "$and") {
      return (expected as Row[]).every((branch) => matches(row, branch));
    }
    const actual = row[field] ?? null;
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return Object.entries(expected).every(([operator, value]) => {
        switch (operator) {
          case "$ne":
            return actual !== (value ?? null);
          case "$in":
            return (value as unknown[]).includes(actual);
          case "$gt":
            return actual > (value as any);
          case "$lt":
            return actual !== null && actual < (value as any);
          default:
            throw new Error(`Operator ${operator} is not supported by the test store`);
        }
      });
    }
    return actual === (expected ?? null);
  });
}

/**
 * An in-memory stand-in for the store API, as far as the app uses it: the app's two
 * collections, orders by id, their payments, the app's settings, and the start of a workflow run.
 */
export function createStore(
  seed: { settings?: Row; orders?: Row[]; payments?: Row[]; documents?: Row[]; alerts?: Row[] } = {},
) {
  const collections: Record<string, Row[]> = {
    documents: (seed.documents || []).map((row) => ({ ...row })),
    alerts: (seed.alerts || []).map((row) => ({ ...row })),
    payments: (seed.payments || []).map((row) => ({ ...row })),
  };
  const orders = new Map((seed.orders || []).map((order) => [order.id, order]));
  let settings: Row = seed.settings || {};
  /** The writes that asked for their events to be raised. In a workflow, no others raise any */
  const events: string[] = [];
  /** Set to make the next write to a collection fail, as the store API would */
  const failures: { post?: Error } = {};

  function nextId(): string {
    sequence += 1;
    return sequence.toString(16).padStart(24, "0");
  }

  const swell = {
    settings: vi.fn(async () => settings),
    get: vi.fn(async (path: string, query: Row = {}) => {
      const [, name, id] = path.split("/");
      if (name === "orders" && id) {
        return orders.get(id) || "";
      }
      const rows = name === "orders" ? [...orders.values()] : collections[name];
      if (!rows) {
        throw new Error(`Unexpected read of ${path}`);
      }
      if (id) {
        return rows.find((row) => row.id === id) || "";
      }
      const where = { ...(query.where || {}), ...(query.$and ? { $and: query.$and } : {}), ...(query.$or ? { $or: query.$or } : {}) };
      let found = rows.filter((row) => matches(row, where));
      if (query.sort === "date_created desc") {
        found = [...found].reverse();
      }
      if (query.sort === "id asc") {
        found = [...found].sort((a, b) => (a.id < b.id ? -1 : 1));
      }
      return { count: found.length, results: found.slice(0, query.limit || 15) };
    }),
    post: vi.fn(async (path: string, { $events, $notify, ...data }: Row) => {
      if ($events === true) {
        events.push(`created ${path}`);
      }
      const rows = collections[path.slice(1)];
      if (!rows) {
        throw new Error(`Unexpected write to ${path}`);
      }
      if (failures.post) {
        const failure = failures.post;
        failures.post = undefined;
        throw failure;
      }
      if (rows.some((row) => row.key === data.key)) {
        throw Object.assign(new Error("Validation failed"), { status: 400, body: { key: { code: "UNIQUE" } } });
      }
      const row = { id: nextId(), date_created: new Date().toISOString(), ...data };
      rows.push(row);
      return { ...row };
    }),
    put: vi.fn(async (path: string, data: Row) => {
      const [, name, id] = path.split("/");
      if (name === "settings") {
        settings = { ...settings, ...data, connection: { ...settings.connection, ...data.connection } };
        return settings;
      }
      const row = collections[name]?.find((item) => item.id === id);
      if (!row) {
        throw new Error(`Unexpected write to ${path}`);
      }
      const { $inc, $events, $notify, ...changes } = data;
      if ($events === true) {
        events.push(`updated ${path}`);
      }
      for (const [field, by] of Object.entries($inc || {})) {
        row[field] = (row[field] || 0) + (by as number);
      }
      if (changes.pdf?.data) {
        // The store keeps the file and answers with its address
        changes.pdf = { id: nextId(), filename: changes.pdf.filename, url: `https://cdn.test/${changes.pdf.filename}` };
      }
      Object.assign(row, changes);
      return { ...row };
    }),
    delete: vi.fn(async (path: string) => {
      const [, name, id] = path.split("/");
      const rows = collections[name];
      const index = rows?.findIndex((row) => row.id === id) ?? -1;
      if (index >= 0) {
        rows.splice(index, 1);
      }
      return {};
    }),
  };

  /** The runs the app asked for */
  const runs: { name: string; data: Row }[] = [];
  const workflows = {
    create: vi.fn(async (name: string, data: Row) => {
      runs.push({ name, data });
      return { id: `wf_inst_${runs.length}`, status: "active" };
    }),
  };

  return {
    swell: { ...swell, workflows },
    documents: collections.documents,
    alerts: collections.alerts,
    payments: collections.payments,
    runs,
    events,
    failures,
    setSettings(next: Row) {
      settings = next;
    },
    get settings() {
      return settings;
    },
  };
}
