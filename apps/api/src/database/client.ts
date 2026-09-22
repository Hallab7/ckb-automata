import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "./schema.ts";

export type AutomataDatabase = PostgresJsDatabase<typeof schema>;

export class DatabaseClient {
  readonly database: AutomataDatabase;
  readonly #client: postgres.Sql;
  #closed = false;

  private constructor(connectionString: string) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("database connection must use postgresql://");
    }
    this.#client = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 10,
      onnotice: () => undefined,
    });
    this.database = drizzle(this.#client, { schema });
  }

  static open(connectionString: string): DatabaseClient {
    return new DatabaseClient(connectionString);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client.end({ timeout: 5 });
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  return DatabaseClient.open(connectionString);
}
