import { Queue } from "bullmq";

import { AUTOMATA_QUEUES } from "@ckb-automata/telemetry";

import { PostgresDeadLetterStore } from "./dead-letter-store.ts";
import { DeadLetterOperations } from "./dead-letter.ts";
import { DEFAULT_QUEUE_PREFIX, DurableQueueRegistry, parseRedisConnection } from "./queues.ts";

interface Command {
  readonly action: "inspect" | "replay" | "close";
  readonly id: string;
  readonly operator: string;
  readonly reason?: string;
}

function parseCommand(arguments_: readonly string[]): Command {
  const [action, id, ...options] = arguments_;
  if (action !== "inspect" && action !== "replay" && action !== "close") {
    throw new TypeError("command must be inspect, replay, or close");
  }
  if (id === undefined) throw new TypeError("dead-letter ID is required");
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new TypeError("dead-letter command options are invalid");
    }
    values.set(name, value);
  }
  const operator = values.get("--operator");
  if (operator === undefined) throw new TypeError("--operator is required");
  const reason = values.get("--reason");
  const allowed =
    action === "inspect" ? new Set(["--operator"]) : new Set(["--operator", "--reason"]);
  if ([...values.keys()].some((name) => !allowed.has(name))) {
    throw new TypeError("dead-letter command contains an unsupported option");
  }
  if (action !== "inspect" && reason === undefined) throw new TypeError("--reason is required");
  return Object.freeze({ action, id, operator, ...(reason === undefined ? {} : { reason }) });
}

function requiredEnvironment(input: NodeJS.ProcessEnv, name: "DATABASE_URL" | "REDIS_URL"): string {
  const value = input[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function runDeadLetterCommand(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const command = parseCommand(arguments_);
  const databaseUrl = requiredEnvironment(environment, "DATABASE_URL");
  const redisUrl = requiredEnvironment(environment, "REDIS_URL");
  const queues = AUTOMATA_QUEUES.map(
    (name) =>
      new Queue(name, {
        connection: parseRedisConnection(redisUrl),
        prefix: DEFAULT_QUEUE_PREFIX,
      }),
  );
  const registry = new DurableQueueRegistry(queues);
  const store = new PostgresDeadLetterStore(databaseUrl);
  const operations = new DeadLetterOperations(store, registry);
  try {
    await registry.ready();
    if (command.action === "inspect") return operations.inspect(command.id, command.operator);
    if (command.action === "replay") {
      return operations.replay(command.id, command.operator, command.reason!);
    }
    return operations.close(command.id, command.operator, command.reason!);
  } finally {
    await Promise.all([store.closeConnection(), ...queues.map((queue) => queue.close())]);
  }
}

runDeadLetterCommand(process.argv.slice(2))
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "dead-letter command failed";
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  });
